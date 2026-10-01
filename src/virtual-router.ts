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
import { RouterError } from "./types.js";
import type { PromptFeatures, RouteTier, RouterModelRegistry, SmartRouterConfig } from "./types.js";
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

interface RouterState {
  config: SmartRouterConfig;
}

let state: RouterState | null = null;

/** Capture config — wired to "session_start". */
export function initializeRouterState(options: { config: SmartRouterConfig }): void {
  state = { config: options.config };
}

/** Clear state — wired to "session_shutdown". */
export function shutdownRouterState(): void {
  state = null;
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

  // When a usable classifier is configured it decides the tier; the heuristic
  // score never selects it. A transient classifier failure falls through to
  // defaultRoute/fallbacks. Rules still win first.
  const classifierActive = isClassifierAvailable(config, registry);
  const useHeuristicTier = !classifierActive;
  let decision = resolveRoute(registry, config, features, context, undefined, useHeuristicTier);

  const classifierStats: ClassifierStats = {};
  let classifierVerdict: RouteTier | undefined;
  if (classifierActive && decision.reason !== "rule") {
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
