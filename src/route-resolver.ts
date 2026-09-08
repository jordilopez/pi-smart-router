/**
 * Route resolver for the Smart Router.
 *
 * Deterministic resolution order:
 *  1. Explicit rules (sorted by priority desc). First rule whose match holds
 *     AND whose route resolves + backend is available/compatible wins.
 *  2. Score thresholds (<= simpleMax -> fast-tier route, <= mediumMax ->
 *     balanced-tier route, else powerful-tier route), matched by route-name
 *     aliases then partial-name match, falling back to defaultRoute.
 *  3. defaultRoute.
 *  4. fallbacks array, in order.
 *  5. Any available route (declaration order).
 *  6. Throw RouterError("NO_FALLBACK_AVAILABLE").
 *
 * Routes whose backend is missing, unauthenticated, or incompatible with the
 * request (images, context window, reasoning, maxTokens) are skipped.
 */

import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { getLatestUserPrompt, matchRule } from "./classifier.js";
import { RouterError } from "./types.js";
import type { PromptFeatures, RouteConfig, RouteDecision, RouterModelRegistry, SmartRouterConfig } from "./types.js";

// ============================================================================
// Capability checks
// ============================================================================

export interface CapabilityCheck {
  compatible: boolean;
  reason?: string;
}

/** Check a backend model against the request features and route config. */
export function checkModelCapabilities(
  model: Model<Api>,
  features: PromptFeatures,
  routeConfig: RouteConfig,
): CapabilityCheck {
  // Images require explicit image input support.
  if (features.hasImages && !(model.input ?? []).includes("image")) {
    return {
      compatible: false,
      reason: `Model ${model.provider}/${model.id} does not support image input`,
    };
  }

  // Estimated context tokens must fit in 80% of the model's context window.
  if (features.contextTokens > 0 && model.contextWindow > 0) {
    const usableContext = Math.floor(model.contextWindow * 0.8);
    if (features.contextTokens > usableContext) {
      return {
        compatible: false,
        reason: `Estimated context (${features.contextTokens} tokens) exceeds usable window of ${model.provider}/${model.id} (${usableContext} tokens)`,
      };
    }
  }

  // Explicit (non-preserve, non-off) reasoning requires a reasoning model.
  if (
    routeConfig.reasoning &&
    routeConfig.reasoning !== "off" &&
    routeConfig.reasoning !== "preserve" &&
    !model.reasoning
  ) {
    return {
      compatible: false,
      reason: `Model ${model.provider}/${model.id} does not support reasoning (route requests '${routeConfig.reasoning}')`,
    };
  }

  // Route maxTokens override must not exceed the model's output limit.
  if (routeConfig.maxTokens !== undefined && model.maxTokens > 0 && routeConfig.maxTokens > model.maxTokens) {
    return {
      compatible: false,
      reason: `Route maxTokens (${routeConfig.maxTokens}) exceeds model limit of ${model.provider}/${model.id} (${model.maxTokens})`,
    };
  }

  return { compatible: true };
}

/**
 * Whether a route can be used right now: the model exists in the registry,
 * the provider exists, auth is configured, and capabilities are compatible.
 */
export function isRouteAvailable(
  registry: RouterModelRegistry,
  _routeName: string,
  routeConfig: RouteConfig,
  features: PromptFeatures,
): boolean {
  const slashIndex = routeConfig.model.indexOf("/");
  if (slashIndex <= 0) return false;
  const providerId = routeConfig.model.slice(0, slashIndex);
  const modelId = routeConfig.model.slice(slashIndex + 1);
  if (!modelId) return false;

  const model = registry.find(providerId, modelId);
  if (!model) return false;

  if (!registry.getProvider(providerId)) return false;
  if (!registry.hasConfiguredAuth(model)) return false;

  return checkModelCapabilities(model, features, routeConfig).compatible;
}

// ============================================================================
// Route resolution
// ============================================================================

/** Route-name aliases used for threshold-tier lookup. */
const TIER_ALIASES: Record<"cheap" | "fast" | "balanced" | "powerful", string[]> = {
  cheap: ["cheap", "cheap-code", "low-cost", "economy"],
  fast: ["fast", "simple", "quick", "small"],
  balanced: ["balanced", "medium", "standard"],
  powerful: ["powerful", "high", "strong", "best", "large"],
};

/**
 * Whether a route name matches a tier alias: exact name match, or the alias's
 * segments (split on separators) appearing consecutively in the name's
 * segments. Segment matching avoids substring false positives like
 * "fastest" or "breakfast" matching the "fast" tier.
 */
function routeNameMatchesTier(name: string, alias: string): boolean {
  const lowerName = name.toLowerCase();
  const lowerAlias = alias.toLowerCase();
  if (lowerName === lowerAlias) return true;
  const nameParts = lowerName.split(/[^a-z0-9]+/).filter(Boolean);
  const aliasParts = lowerAlias.split(/[^a-z0-9]+/).filter(Boolean);
  if (aliasParts.length === 0) return false;
  for (let i = 0; i <= nameParts.length - aliasParts.length; i++) {
    let matched = true;
    for (let j = 0; j < aliasParts.length; j++) {
      if (nameParts[i + j] !== aliasParts[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

/** Merged classifier thresholds for a config (defaults filled in). */
export function classifierThresholds(config: SmartRouterConfig): {
  cheapMax: number;
  simpleMax: number;
  mediumMax: number;
} {
  return {
    ...{ cheapMax: 0, simpleMax: 0.3, mediumMax: 0.8 },
    ...config.classifier?.thresholds,
  };
}

/** Map a complexity score onto a tier using the given thresholds. */
export function tierForScore(
  score: number,
  thresholds: { cheapMax: number; simpleMax: number; mediumMax: number },
): "cheap" | "fast" | "balanced" | "powerful" {
  if (score <= thresholds.cheapMax) return "cheap";
  if (score <= thresholds.simpleMax) return "fast";
  if (score <= thresholds.mediumMax) return "balanced";
  return "powerful";
}

/** Find a configured route for a tier: exact alias name first, then segment match. */
export function findRouteByTier(
  config: SmartRouterConfig,
  tier: "cheap" | "fast" | "balanced" | "powerful",
): string | null {
  const aliases = TIER_ALIASES[tier];

  for (const alias of aliases) {
    if (config.routes[alias]) return alias;
  }

  for (const name of Object.keys(config.routes)) {
    for (const alias of aliases) {
      if (routeNameMatchesTier(name, alias)) return name;
    }
  }

  return null;
}

/**
 * Resolve the route for a classified prompt. Throws RouterError when nothing is available.
 *
 * `tierOverride` (from LLM escalation) replaces the score-computed tier at the
 * threshold step only; explicit rules still win first, and overrides of the
 * cheap/powerful tiers are impossible by type (a cheap classifier must never
 * select the expensive backend).
 */
export function resolveRoute(
  registry: RouterModelRegistry,
  config: SmartRouterConfig,
  features: PromptFeatures,
  context: Context,
  tierOverride?: "fast" | "balanced",
): RouteDecision {
  const promptText = getLatestUserPrompt(context);
  const score = features.complexityScore;

  // 1. Explicit rules, highest priority first. On match, use the route only
  //    if it is available; otherwise continue to the next rule.
  const sortedRules = [...(config.rules ?? [])].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  for (const rule of sortedRules) {
    if (!matchRule(rule, features, promptText)) continue;
    const routeConfig = config.routes[rule.route];
    if (routeConfig && isRouteAvailable(registry, rule.route, routeConfig, features)) {
      return {
        route: rule.route,
        backendModel: routeConfig.model,
        routeConfig,
        reason: "rule",
        matchedRule: rule.id,
        complexityScore: score,
        isFallback: false,
        explanation: `Matched rule '${rule.id}' -> route '${rule.route}'`,
      };
    }
  }

  // 2. Score thresholds: cheap -> fast -> balanced -> powerful. Configs that
  //    omit cheapMax get the built-in default (0 - the cheap tier is
  //    rule-driven by default). An escalation override
  //    replaces the computed tier (never below fast / above balanced by type).
  const thresholds = classifierThresholds(config);
  const computedTier = tierForScore(score, thresholds);
  const tier = tierOverride ?? computedTier;

  const thresholdRouteName = findRouteByTier(config, tier) ?? config.defaultRoute;
  const thresholdRouteConfig = config.routes[thresholdRouteName];
  if (thresholdRouteConfig && isRouteAvailable(registry, thresholdRouteName, thresholdRouteConfig, features)) {
    return {
      route: thresholdRouteName,
      backendModel: thresholdRouteConfig.model,
      routeConfig: thresholdRouteConfig,
      reason: "threshold",
      complexityScore: score,
      isFallback: false,
      explanation: tierOverride
        ? `Complexity ${score.toFixed(2)} (heuristic tier ${computedTier}) escalated to ${tierOverride} via llm-escalation -> route '${thresholdRouteName}'`
        : `Complexity ${score.toFixed(2)} (${tier} tier) -> route '${thresholdRouteName}'`,
    };
  }

  const tryRoute = (
    name: string,
    reason: RouteDecision["reason"],
    isFallback: boolean,
    explanation: string,
  ): RouteDecision | null => {
    const routeConfig = config.routes[name];
    if (!routeConfig || !isRouteAvailable(registry, name, routeConfig, features)) return null;
    return {
      route: name,
      backendModel: routeConfig.model,
      routeConfig,
      reason,
      complexityScore: score,
      isFallback,
      explanation,
    };
  };

  // 3. defaultRoute.
  const defaultDecision = tryRoute(config.defaultRoute, "default", false, `Default route '${config.defaultRoute}'`);
  if (defaultDecision) return defaultDecision;

  // 4. fallbacks in order.
  for (const fallback of config.fallbacks ?? []) {
    const fallbackDecision = tryRoute(fallback, "fallback", true, `Fallback route '${fallback}'`);
    if (fallbackDecision) return fallbackDecision;
  }

  // 5. Any available route (declaration order).
  for (const name of Object.keys(config.routes)) {
    const lastResort = tryRoute(name, "fallback", true, `Last-resort route '${name}'`);
    if (lastResort) return lastResort;
  }

  // 6. Nothing available.
  throw new RouterError(
    "NO_FALLBACK_AVAILABLE",
    `No compatible backend model available for any configured route (score ${score.toFixed(2)}, images: ${features.hasImages}, contextTokens: ${features.contextTokens})`,
    {
      complexityScore: score,
      hasImages: features.hasImages,
      contextTokens: features.contextTokens,
      configuredRoutes: Object.keys(config.routes),
    },
  );
}
