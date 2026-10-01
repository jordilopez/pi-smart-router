/**
 * Virtual-model route handler.
 *
 * Implements the `route()` callback for the "pi-smart-router/auto" virtual
 * model. The selection pipeline is identical to the pre-virtual-model
 * streamSimple handler: explicit rules → Jev classifier (when configured and
 * available; rules are never second-guessed) → heuristic thresholds →
 * defaultRoute → fallbacks → any available route.
 *
 * Dispatch is native: `route()` returns the physical model + thinking level
 * and pi streams from it. Stickiness follows pi's documented recipe —
 * continuations return `request.previous`, keeping prompt caches valid.
 */

import type { Api, Context, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRoute, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { classifyPrompt } from "./classifier.js";
import { isClassifierAvailable, runClassifier } from "./classifier-orchestrator.js";
import { classifierThresholds, isRouteAvailable, resolveRoute, tierForScore } from "./route-resolver.js";
import { isContextOverflowError, parseModelRef } from "./backend.js";
import { ROUTE_EMOJI, RouterError } from "./types.js";
import type { PromptFeatures, RouteDecision, RouteTier, RouterModelRegistry, SmartRouterConfig } from "./types.js";
import type { ClassifierStats } from "./typesafe-client.js";

/** Extension context subset `route()` needs. */
export interface RouteContext {
  modelRegistry: RouterModelRegistry;
}

/**
 * JSON-serializable router state persisted by pi on the session branch.
 * Diagnostics only — continuations dispatch via `request.previous`, not state.
 */
export interface RouterVirtualState {
  route: string;
  backendModel: string;
  tier?: RouteTier;
  matchedRule?: string;
  classifierVerdict?: RouteTier;
}

/** Footer status setter (optional; absent in non-interactive contexts/tests). */
export type SetStatusCallback = (key: string, text: string | undefined) => void;
interface RouterState {
  config: SmartRouterConfig;
  setStatus?: SetStatusCallback;
}

let state: RouterState | null = null;

/** Capture config (and footer setter) — wired to "session_start". */
export function initializeRouterState(options: { config: SmartRouterConfig; setStatus?: SetStatusCallback }): void {
  state = { config: options.config, setStatus: options.setStatus };
}

/** Clear state — wired to "session_shutdown". Clears the footer status too. */
export function shutdownRouterState(): void {
  state?.setStatus?.(STATUS_KEY, undefined);
  state = null;
}

/** Footer status key used with ctx.ui.setStatus (cleared with value undefined). */
export const STATUS_KEY = "pi-smart-router";

/** Thinking level for a routed route config: explicit override, else passthrough. */
function thinkingLevelFor(routeReasoning: SmartRouterConfig["routes"][string]["reasoning"], selected: ModelThinkingLevel): ModelThinkingLevel {
  if (routeReasoning === "off") return "off";
  if (routeReasoning === "low" || routeReasoning === "medium" || routeReasoning === "high") return routeReasoning;
  // "preserve" / undefined: keep the user's selected level; pi clamps it.
  return selected;
}

/** Resolve a "provider/modelId" ref to a registry model. */
function findBackendModel(registry: RouterModelRegistry, modelRef: string): Model<never> {
  const { providerId, modelId } = parseModelRef(modelRef);
  const model = registry.find(providerId, modelId);
  if (!model) {
    throw new RouterError(
      "BACKEND_MODEL_NOT_FOUND",
      `Model not found in registry: ${modelRef}`,
      { modelRef },
    );
  }
  return model as Model<never>;
}

/** Run the full selection pipeline for a fresh decision (reason "user"). */
async function resolveFresh(
  registry: RouterModelRegistry,
  config: SmartRouterConfig,
  request: ModelRouteRequest,
  context: Context,
): Promise<{ model: Model<never>; thinkingLevel: ModelThinkingLevel; state: RouterVirtualState }> {
  const features: PromptFeatures = classifyPrompt(context, config.classifier ?? {});

  // When a usable classifier is configured it decides the tier; the heuristic
  // score never selects it. A transient classifier failure falls through to
  // defaultRoute/fallbacks. Rules still win first.
  const classifierActive = isClassifierAvailable(config, registry);
  const useHeuristicTier = !classifierActive;
  let decision = resolveRoute(registry, config, features, context, undefined, useHeuristicTier);

  const classifierStats: ClassifierStats = {};
  let classifierVerdict: RouteTier | undefined;
  if (classifierActive && decision.reason !== "rule") {
    state?.setStatus?.(STATUS_KEY, "router: classifying…");
    const verdict = await runClassifier(registry, config, features, context, undefined, classifierStats);
    if (verdict) {
      classifierVerdict = verdict;
      decision = resolveRoute(registry, config, features, context, verdict);
    }
  }
  if (useHeuristicTier) decision.heuristicTier = tierForScore(features.complexityScore, classifierThresholds(config));
  decision.classifierVerdict = classifierVerdict;
  if (classifierVerdict && (classifierStats.elapsedMs !== undefined || classifierStats.inputTokens !== undefined)) {
    decision.classifierStats = classifierStats;
  }

  // Footer diagnostics: replace the "classifying…" placeholder with the
  // decision (source + classifier stats). Routed-model display is native.
  state?.setStatus?.(STATUS_KEY, formatDecisionStatus(decision));

  return {
    model: findBackendModel(registry, decision.backendModel),
    thinkingLevel: thinkingLevelFor(decision.routeConfig.reasoning, request.thinkingLevel),
    state: {
      route: decision.route,
      backendModel: decision.backendModel,
      tier: decision.heuristicTier ?? classifierVerdict,
      matchedRule: decision.matchedRule,
      classifierVerdict,
    },
  };
}

/**
 * Format the footer status line for a routing decision.
 *
 * Shape: `<glyph> <route> · <backendModel> · <source>[ · <elapsed>ms/<in>i/<out>o]`,
 * where source is `rule:<id>` for matched rules, `classifier[ <from>→<to>]` when
 * the classifier ran, or the resolver reason otherwise. When the classifier ran
 * and reported stats, its cost is appended. Never includes prompt text.
 *
 * Covers only classifier diagnostics — the routed-model display comes from
 * pi's native virtual-model footer.
 */
export function formatDecisionStatus(decision: RouteDecision): string {
  const glyph = decision.routeConfig.emoji ?? ROUTE_EMOJI[decision.route] ?? "↳";
  let source: string;
  if (decision.matchedRule) {
    source = `rule:${decision.matchedRule}`;
  } else if (decision.classifierVerdict) {
    source = "classifier";
  } else {
    source = decision.reason;
  }
  let stats = "";
  const cs = decision.classifierStats;
  if (cs) {
    const parts: string[] = [];
    if (cs.elapsedMs !== undefined) parts.push(`${cs.elapsedMs}ms`);
    if (cs.inputTokens !== undefined || cs.outputTokens !== undefined) {
      parts.push(`${cs.inputTokens ?? "?"}i/${cs.outputTokens ?? "?"}o`);
    }
    if (parts.length > 0) stats = ` · ${parts.join("/")}`;
  }
  return `${glyph} ${decision.route} · ${decision.backendModel} · ${source}${stats}`;
}

// ============================================================================
// Retry routing
// ============================================================================

/** Error signatures that justify switching backends on an automatic retry. */
const OVERLOAD_PATTERNS = ["overloaded", "rate limit", "rate_limit", "capacity", "529"];

/** Whether a failed request's error suggests a different backend would help. */
function shouldSwitchOnRetry(errorMessage: string | undefined): boolean {
  if (!errorMessage) return false;
  const lower = errorMessage.toLowerCase();
  return isContextOverflowError(lower) || OVERLOAD_PATTERNS.some((p) => lower.includes(p));
}

/**
 * Route a retry: stick to the failed model for transient errors; on overflow
 * or provider overload, advance through the configured route order
 * (defaultRoute, then fallbacks, then any route) skipping the failed model.
 */
function routeRetry(
  registry: RouterModelRegistry,
  config: SmartRouterConfig,
  request: ModelRouteRequest,
  context: Context,
): ModelRoute {
  const failed = request.failed!;
  const failedRef = `${failed.model.provider}/${failed.model.id}`;

  if (!shouldSwitchOnRetry(failed.message.errorMessage)) {
    // Transient failure: same backend, same level, state unchanged.
    return {
      model: failed.model as Model<never>,
      thinkingLevel: failed.thinkingLevel ?? request.thinkingLevel,
      state: request.state,
    };
  }

  const features = classifyPrompt(context, config.classifier ?? {});
  const routeNames = [
    config.defaultRoute,
    ...(config.fallbacks ?? []),
    ...Object.keys(config.routes),
  ];
  for (const name of routeNames) {
    const routeConfig = config.routes[name];
    if (!routeConfig || routeConfig.model === failedRef) continue;
    if (!isRouteAvailable(registry, name, routeConfig, features)) continue;
    return {
      model: findBackendModel(registry, routeConfig.model),
      thinkingLevel: thinkingLevelFor(routeConfig.reasoning, request.thinkingLevel),
      state: request.state,
    };
  }

  throw new RouterError(
    "NO_FALLBACK_AVAILABLE",
    `Retry after failure of ${failedRef}: no other compatible backend available`,
    { failedModel: failedRef },
  );
}

/**
 * The virtual model's route callback. See docs/virtual-models.md for the
 * request contract.
 */
export async function routeRequest(request: ModelRouteRequest, ctx: RouteContext): Promise<ModelRoute> {
  if (!state) {
    throw new RouterError("REGISTRY_UNAVAILABLE", "Smart Router is not initialized (no config captured on session_start)");
  }
  const { config } = state;

  // Continuations (tool follow-ups) stay on the model that handled the turn:
  // prompt caches and thinking signatures stay valid.
  if (request.reason === "continuation" && request.previous) {
    return {
      model: request.previous.model as Model<never>,
      thinkingLevel: request.previous.thinkingLevel ?? request.thinkingLevel,
      state: request.state,
    };
  }

  // Retries: switch backends on overflow/overload, stick on transient errors.
  if (request.reason === "retry" && request.failed) {
    return routeRetry(ctx.modelRegistry, config, request, { systemPrompt: "", messages: request.messages } as Context);
  }

  // Direct requests (compaction summaries, extension calls) take a fresh
  // resolution; pi ignores state returned for direct requests.
  return resolveFresh(ctx.modelRegistry, config, request, { systemPrompt: "", messages: request.messages } as Context);
}
