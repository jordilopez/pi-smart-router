/**
 * Virtual-model route handler.
 *
 * Implements the `route()` callback for the "pi-smart-router/auto" virtual
 * model. Selection pipeline, classifier-first: when a classifier is configured
 * and available, its verdict decides and rules never apply; rules drive routing
 * only in heuristic mode (no classifier) or when the classifier fails.
 * Without a classifier: explicit rules → heuristic thresholds →
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
import { RouterError } from "./types.js";
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

/** Footer status key used with ctx.ui.setStatus (cleared with value undefined). */
export const STATUS_KEY = "pi-smart-router";

/** Footer status setter (optional; absent in non-interactive contexts/tests). */
export type SetStatusCallback = (key: string, text: string | undefined) => void;

interface RouterState {
  config: SmartRouterConfig;
  setStatus?: SetStatusCallback;
}

let state: RouterState | null = null;

/** Capture config and footer setter — wired to "session_start". */
export function initializeRouterState(options: { config: SmartRouterConfig; setStatus?: SetStatusCallback }): void {
  state = { config: options.config, setStatus: options.setStatus };
}

/** Clear state — wired to "session_shutdown". Clears the footer status too. */
export function shutdownRouterState(): void {
  state?.setStatus?.(STATUS_KEY, undefined);
  state = null;
}

/** Built-in tier glyphs, shown in the footer status (tier visibility). */
const TIER_GLYPHS: Record<RouteTier, string> = {
  cheap: "🪙",
  fast: "⚡",
  balanced: "🎯",
  powerful: "💎",
};

/** Glyph for a route: built-in tier glyphs by route name (incl. standard aliases), else by resolved tier. */
const ROUTE_NAME_TIERS: Record<string, RouteTier> = {
  cheap: "cheap",
  "cheap-code": "cheap",
  fast: "fast",
  balanced: "balanced",
  powerful: "powerful",
};

function glyphForRoute(route: string, resolvedTier?: RouteTier): string {
  return TIER_GLYPHS[ROUTE_NAME_TIERS[route] ?? resolvedTier ?? "balanced"];
}

function glyphFor(decision: RouteDecision): string {
  return glyphForRoute(decision.route, decision.heuristicTier ?? decision.classifierVerdict);
}

/**
 * Format the compact footer status: tier visibility only.
 *
 * Shape: `<glyph> <route>[ · <source>]` — e.g. `⚡ fast · classifier`.
 * The routed backend model and thinking level come from pi's native
 * virtual-model footer; the complexity score and classifier stats are
 * deliberately omitted.
 */
export function formatTierStatus(decision: RouteDecision): string {
  const glyph = glyphFor(decision);
  let source: string | undefined;
  if (decision.matchedRule) {
    source = `rule:${decision.matchedRule}`;
  } else if (decision.classifierVerdict) {
    source = "classifier";
  } else if (decision.reason !== "threshold") {
    source = decision.reason;
  }
  return source ? `${glyph} ${decision.route} · ${source}` : `${glyph} ${decision.route}`;
}

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
  const classifierActive = isClassifierAvailable(config, registry);

  let decision: RouteDecision;
  const classifierStats: ClassifierStats = {};
  let classifierVerdict: RouteTier | undefined;

  if (classifierActive) {
    // Classifier-first: Jev runs on every new turn and its verdict decides;
    // rules never override it. On transient failure (no verdict) the standard
    // chain applies — rules, defaultRoute, fallbacks — never a heuristic tier.
    state?.setStatus?.(STATUS_KEY, "… classifying");
    const verdict = await runClassifier(registry, config, features, context, undefined, classifierStats);
    if (verdict) {
      classifierVerdict = verdict;
      // Named booleans: no heuristic tier (the verdict decides), rules skipped.
      const useHeuristicTier = false;
      const skipRules = true;
      decision = resolveRoute(registry, config, features, context, verdict, useHeuristicTier, skipRules);
    } else {
      decision = resolveRoute(registry, config, features, context, undefined, false);
    }
  } else {
    // Heuristic mode: rules first, then the score thresholds.
    decision = resolveRoute(registry, config, features, context, undefined, true);
  }

  if (!classifierActive) decision.heuristicTier = tierForScore(features.complexityScore, classifierThresholds(config));
  decision.classifierVerdict = classifierVerdict;
  if (classifierVerdict && (classifierStats.elapsedMs !== undefined || classifierStats.inputTokens !== undefined)) {
    decision.classifierStats = classifierStats;
  }

  // Footer: tier visibility (glyph + route + source). Backend model and
  // thinking level are shown by pi's native virtual-model footer.
  state?.setStatus?.(STATUS_KEY, formatTierStatus(decision));

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
    // Footer: the tier just changed under the user's feet — reflect it.
    state?.setStatus?.(STATUS_KEY, `${glyphForRoute(name)} ${name} · retry-fallback`);
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

/** Build a plain Context for the resolver/classifier from a route request. */
function contextFrom(request: ModelRouteRequest): Context {
  return { systemPrompt: "", messages: request.messages } as Context;
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
    return routeRetry(ctx.modelRegistry, config, request, contextFrom(request));
  }

  // Direct requests (compaction summaries, extension calls) take a fresh
  // resolution; pi ignores state returned for direct requests.
  return resolveFresh(ctx.modelRegistry, config, request, contextFrom(request));
}
