/**
 * Smart Router provider - the main streamSimple handler.
 *
 * Classifies each new turn's prompt once, resolves a route, and delegates to
 * the selected backend through pi's model registry. The route decision is
 * cached for the whole turn (tool-call continuations reuse it); turn_start
 * resets the cache. Fallbacks only happen before any content is streamed.
 */

import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Message,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { buildStreamOptions, createDelegationModel, delegateToBackend, resolveBackend } from "./backend.js";
import { classifyPrompt } from "./classifier.js";
import { resolveEscalationConfig, runEscalation, shouldEscalate } from "./escalation.js";
import { debugLog } from "./log.js";
import { classifierThresholds, resolveRoute, tierForScore } from "./route-resolver.js";
import { RouterError } from "./types.js";
import type { PromptFeatures, RouteDecision, RouterModelRegistry, SmartRouterConfig } from "./types.js";

// ============================================================================
// Router state (module-level; lifecycle managed from index.ts)
// ============================================================================

/** Footer status key used with ctx.ui.setStatus (cleared with value undefined). */
export const STATUS_KEY = "pi-smart-router";

/** Footer status setter (bound to ctx.ui.setStatus). */
export type SetStatusCallback = (key: string, text: string | undefined) => void;

export interface RouterState {
  config: SmartRouterConfig;
  registry: RouterModelRegistry | null;
  turnNumber: number;
  /** Stable Pi session id (captured on session_start) used for backend requests. */
  sessionId?: string;
  /** Footer status setter (optional; absent in non-interactive contexts/tests). */
  setStatus?: SetStatusCallback;
}

let state: RouterState | null = null;
/** Route decision cached for the current turn; null until classified. */
let currentRoute: RouteDecision | null = null;
/** User-message count when the cached decision was made (fallback turn detection). */
let cachedUserMessageCount = 0;

/** Whether this looks like a tool-call continuation rather than a new prompt. */
function looksLikeToolContinuation(context: Context): boolean {
  const messages: Message[] = context.messages;
  const last = messages[messages.length - 1];
  if (last && last.role === "toolResult") return true;

  const lastAssistantIndex = messages.findLastIndex((m) => m.role === "assistant");
  if (lastAssistantIndex >= 0) {
    const lastAssistant = messages[lastAssistantIndex];
    if (lastAssistant.role === "assistant") {
      const hasToolCalls = lastAssistant.content.some((b) => b.type === "toolCall");
      if (hasToolCalls) {
        const hasUserAfter = messages.slice(lastAssistantIndex + 1).some((m) => m.role === "user");
        if (!hasUserAfter) return true;
      }
    }
  }
  return false;
}

/** Reset the cached route for a new turn (wired to the "turn_start" event). */
export function onTurnStart(): void {
  currentRoute = null;
  if (state) {
    state.turnNumber += 1;
    // Neutral placeholder until the route decision replaces it.
    state.setStatus?.(STATUS_KEY, "router: classifying…");
  }
}

/**
 * Fallback safety for missed turn_start events: re-classify when the context
 * shows a new user prompt rather than a tool-call continuation. The count is
 * compared in both directions so context trimming/compaction (which can drop
 * user messages) also invalidates the cached route.
 */
function invalidateRouteIfNewPrompt(context: Context): void {
  if (!currentRoute) return;
  if (looksLikeToolContinuation(context)) return;
  const userCount = context.messages.filter((m) => m.role === "user").length;
  if (userCount !== cachedUserMessageCount) currentRoute = null;
}

/** Capture the model registry and load config (wired to "session_start"). */
export function initializeRouter(options: {
  registry: RouterModelRegistry;
  config: SmartRouterConfig;
  /** Stable Pi session id from ctx.sessionManager.getSessionId(). */
  sessionId?: string;
  /** Footer status setter (ctx.ui.setStatus). */
  setStatus?: SetStatusCallback;
  /** Initial turn number (defaults to 0; config reloads preserve the count). */
  turnNumber?: number;
}): void {
  state = {
    config: options.config,
    registry: options.registry,
    turnNumber: options.turnNumber ?? 0,
    sessionId: options.sessionId,
    setStatus: options.setStatus,
  };
  currentRoute = null;
  cachedUserMessageCount = 0;
}

/** Update config without resetting the registry (config reload). */
export function setRouterConfig(config: SmartRouterConfig): void {
  if (state) state.config = config;
}

/** Clear all state (wired to "session_shutdown"). */
export function shutdownRouter(): void {
  state?.setStatus?.(STATUS_KEY, undefined);
  state = null;
  currentRoute = null;
  cachedUserMessageCount = 0;
}

/** Test/diagnostic accessor. */
export function getRouterState(): Readonly<RouterState> | null {
  return state;
}

/** Test hook: seed state without a real pi session. */
export function setRouterStateForTesting(next: RouterState | null): void {
  state = next;
  currentRoute = null;
  cachedUserMessageCount = 0;
}

// ============================================================================
// Stream handler
// ============================================================================

/** Map a route's reasoning setting onto stream options. */
function applyReasoning(streamOptions: SimpleStreamOptions, routeConfig: RouteDecision["routeConfig"]): void {
  const reasoning = routeConfig.reasoning;
  if (reasoning === "low" || reasoning === "medium" || reasoning === "high") {
    streamOptions.reasoning = reasoning;
  }
  // "preserve" and "off" leave the caller's options untouched: "off" cannot
  // be forced portably across providers, "preserve" keeps the session level.
}

/** Build the error AssistantMessage pushed on stream failure. */
function makeErrorMessage(model: Model<Api>, message: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: message,
    timestamp: Date.now(),
  };
}

/** Events that count as streamed content (after which no fallback may occur). */
function isDeltaEvent(eventType: string): boolean {
  return (
    eventType === "text_delta" || eventType === "thinking_delta" || eventType === "toolcall_delta"
  );
}

/**
 * The pi-smart-router streamSimple handler: classify once per turn, resolve a
 * route, delegate to the backend provider, and forward all events.
 */
export function streamSmartRouter(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    let contentEmitted = false;
    try {
      if (!state || !state.registry) {
        throw new RouterError(
          "REGISTRY_UNAVAILABLE",
          "Smart Router is not initialized (no model registry captured on session_start)",
        );
      }

      // Classify + resolve only on the first request of a turn; reuse the
      // cached decision for tool-call continuations. turn_start normally
      // resets the cache; the message heuristic is fallback safety only.
      invalidateRouteIfNewPrompt(context);
      if (!currentRoute) {
        const features: PromptFeatures = classifyPrompt(context, state.config.classifier ?? {});
        let decision = resolveRoute(state.registry, state.config, features, context);

        // Borderline-band LLM escalation: only for threshold decisions (rules,
        // defaults, and fallbacks are never second-guessed), only inside the
        // configured band, and only once per turn (the route cache below).
        // The classifier can only return "fast" or "balanced"; null keeps the
        // heuristic tier. state must be re-checked after the await:
        // session_shutdown may have cleared it while the call was in flight.
        let escalatedFromTier: string | undefined;
        let escalationVerdict: string | undefined;
        const esc = resolveEscalationConfig(state.config);
        if (decision.reason === "threshold" && shouldEscalate(features, esc)) {
          state.setStatus?.(STATUS_KEY, "router: escalating…");
          const verdict = await runEscalation(
            state.registry,
            state.config,
            features,
            context,
            state.sessionId,
          );
          if (!state || !state.registry) {
            throw new RouterError(
              "REGISTRY_UNAVAILABLE",
              "Smart Router shut down while escalating",
            );
          }
          const heuristicTier = tierForScore(features.complexityScore, classifierThresholds(state.config));
          if (verdict && verdict !== heuristicTier) {
            escalatedFromTier = heuristicTier;
            escalationVerdict = verdict;
            decision = resolveRoute(state.registry, state.config, features, context, verdict);
          }
        }
        decision.escalatedFromTier = escalatedFromTier;
        currentRoute = decision;
        cachedUserMessageCount = context.messages.filter((m) => m.role === "user").length;

        // Route decision diagnostics (file sink only - never stdout, raw
        // writes are painted over the TUI input line). No prompt text is ever
        // logged. Pi's model footer keeps showing "pi-smart-router/auto"; these
        // lines name the backend that actually served the turn. The session
        // prefix disambiguates parallel pi sessions sharing the log file.
        const baseLine =
          `route=${decision.route} backend=${decision.backendModel} ` +
          `score=${features.complexityScore.toFixed(2)} turn=${state.turnNumber}` +
          ` esc=${escalatedFromTier && escalationVerdict ? `${escalatedFromTier}->${escalationVerdict}` : "-"}` +
          ` session=${state.sessionId ? state.sessionId.slice(0, 8) : "-"}`;
        const observability = state.config.observability;
        if (observability?.logDecisions) {
          // Detailed line: adds the matched rule, decision reason, and
          // explanation (static resolver text, never prompt content).
          debugLog(
            `${baseLine} rule=${decision.matchedRule ?? "-"} reason=${decision.reason} detail="${decision.explanation}"`,
          );
        } else if (observability?.showRouteStatus) {
          debugLog(baseLine);
        }

        // UI visibility: footer status only. Runs only on first
        // classification of the turn (never on tool continuations), and
        // never includes raw prompt text.
        state.setStatus?.(
          STATUS_KEY,
          `↳ ${decision.route} · ${decision.backendModel} (${features.complexityScore.toFixed(2)})`,
        );
      }

      const decision = currentRoute;
      const registry = state.registry;
      // Captured before the first await: session_shutdown may null `state`
      // while backend auth resolution is in flight.
      const sessionId = state.sessionId;

      const backend = await resolveBackend(registry, decision.backendModel);
      if (!state) {
        throw new RouterError("REGISTRY_UNAVAILABLE", "Smart Router shut down while resolving the backend");
      }
      const delegationModel = createDelegationModel(backend);
      // Forward the stable Pi session id so backends that need it (e.g.
      // opencode-go's x-opencode-session) get a consistent value per session;
      // tool continuations reuse the same value.
      const streamOptions = buildStreamOptions(options, backend, sessionId);

      if (decision.routeConfig.maxTokens !== undefined) {
        streamOptions.maxTokens = decision.routeConfig.maxTokens;
      }
      applyReasoning(streamOptions, decision.routeConfig);

      // The backend is fixed from here on; failures are surfaced as stream
      // errors (never retried on another route). contentEmitted is used in
      // the catch to distinguish pre-stream failures from mid-stream ones.
      for await (const event of delegateToBackend(backend.provider, delegationModel, context, streamOptions)) {
        if (isDeltaEvent(event.type)) contentEmitted = true;
        stream.push(event);
      }

      stream.end();
    } catch (error) {
      // Surface the machine-readable code for router-originated failures.
      // Never applied to backend stream errors: those may carry the
      // `context_length_exceeded:` prefix pi's auto-compaction matches on,
      // and RouterErrors never originate from backend delegation.
      const code = error instanceof RouterError ? error.code : undefined;
      const message = error instanceof Error ? error.message : String(error);
      const messageWithCode = code ? `${code}: ${message}` : message;
      if (contentEmitted) {
        // The user already saw partial output; keep a diagnostic trail.
        debugLog(`stream failed after content was emitted: ${messageWithCode}`);
      }
      stream.push({ type: "error", reason: "error", error: makeErrorMessage(model, messageWithCode) });
      stream.end();
    }
  })();

  return stream;
}
