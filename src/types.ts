/**
 * Type definitions and shared constants for the Smart Router extension.
 *
 * Defines configuration schemas, classifier feature types, routing decisions,
 * the duck-typed model-registry surface, and the RouterError class used
 * across the extension.
 */

import type { Api, Context, Model, Provider, ProviderHeaders, SimpleStreamOptions } from "@earendil-works/pi-ai";

// ============================================================================
// Configuration types
// ============================================================================

/** Current configuration schema version. */
export const SMART_ROUTER_CONFIG_VERSION = 1;

/** Backend route definition - maps a route name to a specific provider/model. */
export interface RouteConfig {
  /** Provider/model reference in format "provider/modelId" (e.g. "opencode-go/gpt-5.6-luna") */
  model: string;
  /** How to handle reasoning for this route */
  reasoning?: "preserve" | "off" | "low" | "medium" | "high";
  /** Optional max tokens override for this route */
  maxTokens?: number;
}

/** Classifier weight configuration for complexity scoring. */
export interface ClassifierWeights {
  promptTokens?: number;
  contextTokens?: number;
  codeLikelihood?: number;
  reasoningLikelihood?: number;
  keywordSignal?: number;
  toolSignal?: number;
  imageSignal?: number;
}

/**
 * Borderline-band LLM escalation config. When the heuristic complexity score
 * falls inside [minScore, maxScore] and no explicit rule resolved the turn, a
 * cheap LLM classifier re-classifies the prompt as "fast" or "balanced".
 * "powerful" is deliberately not an escalation target: a cheap classifier must
 * never be able to select the expensive backend.
 */
export interface EscalationConfig {
  /** Master switch. Default false (opt-in). */
  enabled?: boolean;
  /** Lower bound of the borderline complexity-score band. Default 0.12 */
  minScore?: number;
  /** Upper bound of the borderline complexity-score band. Default 0.35 */
  maxScore?: number;
  /**
   * Classifier backend as "provider/modelId". Optional: defaults to the model
   * of the route the "fast" tier resolves to. Must never be the router itself
   * ("smart-router/*") - rejected at config validation and guarded at runtime.
   */
  model?: string;
  /** Abort the classification call after this many ms; heuristic tier wins. Default 1500 */
  timeoutMs?: number;
}

/** Escalation tiers the LLM classifier may return. */
export type EscalationVerdict = "fast" | "balanced";

/** Score thresholds for automatic (threshold-based) route selection. */
export interface ClassifierThresholds {
  /** Maximum complexity score routed to the "cheap" tier (0-1). Default 0.15 */
  cheapMax?: number;
  /** Maximum complexity score routed to the "fast" tier (0-1). Default 0.30 */
  simpleMax?: number;
  /** Maximum complexity score routed to the "balanced" tier (0-1). Default 0.80 */
  mediumMax?: number;
}

/** Classifier configuration for prompt analysis. */
export interface ClassifierConfig {
  weights?: ClassifierWeights;
  thresholds?: ClassifierThresholds;
  /** Analysis/truncation limit for the latest user prompt, in estimated tokens. Default 4000 */
  maxPromptTokens?: number;
  /** Analysis limit for whole-context tokens. Default 100000 */
  maxContextTokens?: number;
}

/** Explicit keyword/feature-based routing rule. */
export interface RoutingRule {
  /** Unique rule identifier */
  id: string;
  /** Rule priority (higher = evaluated first). Default 0 */
  priority?: number;
  /** Match conditions (all specified conditions must hold) */
  match: {
    /** Match if ANY of these keywords are present in the latest user prompt */
    anyKeywords?: string[];
    /** Match only if ALL keywords are present in the latest user prompt */
    allKeywords?: string[];
    /** Minimum prompt token estimate to match */
    minPromptTokens?: number;
    /** Minimum complexity score to match (0-1) */
    minComplexity?: number;
    /** Match depending on whether the prompt looks code-related */
    code?: boolean;
    /** Match depending on whether the prompt looks reasoning-heavy */
    reasoningRequired?: boolean;
    /** Match depending on whether tools are attached to the context */
    hasTools?: boolean;
    /** Match depending on whether images are present in the context */
    hasImages?: boolean;
  };
  /** Target route name (must exist in `routes`) */
  route: string;
}

/** Observability options. */
export interface ObservabilityConfig {
  /** Emit the concise one-line route decision log (route/backend/score/turn). Default true */
  showRouteStatus?: boolean;
  /** Emit the detailed decision log line (adds rule, reason, explanation). Default false */
  logDecisions?: boolean;
}

/** Full smart-router configuration (smart-router.json). */
export interface SmartRouterConfig {
  version: number;
  /** Route used when no rule matches and thresholds don't name a route. Must exist in routes. */
  defaultRoute: string;
  /** Named routes; a route is only resolved when actually selected. */
  routes: Record<string, RouteConfig>;
  classifier?: ClassifierConfig;
  /** Borderline-band LLM escalation (opt-in). */
  escalation?: EscalationConfig;
  /** Explicit routing rules, evaluated by descending priority */
  rules?: RoutingRule[];
  /** Ordered fallback route names tried after defaultRoute */
  fallbacks?: string[];
  observability?: ObservabilityConfig;
}

/** Fully-resolved classifier defaults. */
export const DEFAULT_CLASSIFIER_CONFIG: Required<ClassifierConfig> = {
  weights: {
    promptTokens: 0.1,
    contextTokens: 0.05,
    codeLikelihood: 0.25,
    reasoningLikelihood: 0.35,
    keywordSignal: 0.15,
    toolSignal: 0.1,
    // Kept at zero: image compatibility is enforced by capability checks, not
    // by the complexity score (avoids image-heavy prompts inflating the tier).
    imageSignal: 0,
  },
  thresholds: {
    // Scores up to 0.15 route to the cheap tier: greetings, quick questions,
    // and mechanical one-liners land on the cheap code model. The cheap tier
    // is additionally reachable at any score through explicit mechanical-task
    // rules.
    cheapMax: 0.15,
    simpleMax: 0.3,
    mediumMax: 0.8,
  },
  maxPromptTokens: 4000,
  maxContextTokens: 100000,
};

/**
 * Built-in escalation defaults. `model: ""` means "derive from the fast tier
 * route". Partial user config is merged over these (unlike the top-level
 * config files, nested objects merge field-by-field).
 */
export const DEFAULT_ESCALATION_CONFIG: Required<EscalationConfig> = {
  enabled: false,
  // The band is shifted down because the tool baseline is no longer counted
  // as prompt complexity.
  minScore: 0.12,
  maxScore: 0.35,
  model: "",
  timeoutMs: 1500,
};

/** Built-in defaults used when no config file exists. */
export const BUILTIN_DEFAULTS: SmartRouterConfig = {
  version: SMART_ROUTER_CONFIG_VERSION,
  defaultRoute: "balanced",
  routes: {
    fast: { model: "opencode-go/glm-5.3-flash", reasoning: "preserve" },
    "cheap-code": { model: "opencode-go/mimo-v2.5", reasoning: "preserve" },
    balanced: { model: "opencode-go/gpt-5.6-luna", reasoning: "preserve" },
    powerful: { model: "opencode-go/kimi-k3", reasoning: "preserve" },
  },
  // Never include "powerful" here: kimi-k3 is an order of magnitude more
  // expensive than the other tiers and must only be reached deliberately.
  fallbacks: ["fast", "cheap-code"],
  observability: { showRouteStatus: true, logDecisions: false },
};

// ============================================================================
// Classifier types
// ============================================================================

/** Un-normalized features extracted from the prompt/context. */
export interface RawPromptFeatures {
  promptTokens: number;
  contextTokens: number;
  codeIndicators: number;
  reasoningIndicators: number;
  keywordMatches: number;
  toolCount: number;
  imageCount: number;
  hasTools: boolean;
  hasImages: boolean;
}

/** Normalized 0-1 features plus the weighted complexity score. */
export interface PromptFeatures {
  promptTokens: number;
  contextTokens: number;
  codeLikelihood: number;
  reasoningLikelihood: number;
  keywordSignal: number;
  toolSignal: number;
  imageSignal: number;
  hasTools: boolean;
  hasImages: boolean;
  complexityScore: number;
}

// ============================================================================
// Routing decision types
// ============================================================================

export type RouteDecisionReason = "rule" | "threshold" | "default" | "fallback";

/** The routing decision cached for the current turn. */
export interface RouteDecision {
  route: string;
  /** "provider/modelId" reference of the backend */
  backendModel: string;
  routeConfig: RouteConfig;
  reason: RouteDecisionReason;
  matchedRule?: string;
  complexityScore: number;
  isFallback: boolean;
  explanation: string;
  /**
   * Heuristic tier the escalation started from, when an LLM classifier verdict
   * changed the tier (diagnostics only - no behavior attached).
   */
  escalatedFromTier?: string;
}

// ============================================================================
// Model registry surface (duck-typed subset of pi's ModelRegistry)
// ============================================================================

/** Result of pi's ModelRegistry.getApiKeyAndHeaders(). */
export type ResolvedRequestAuth =
  | { ok: true; apiKey?: string; headers?: ProviderHeaders; baseUrl?: string; env?: Record<string, string> }
  | { ok: false; error: string };

/** The subset of pi's ModelRegistry the router depends on. */
export interface RouterModelRegistry {
  find(provider: string, modelId: string): Model<Api> | undefined;
  getProvider(provider: string): Provider | undefined;
  hasConfiguredAuth(model: Model<Api>): boolean;
  getApiKeyAndHeaders(model: Model<Api>): Promise<ResolvedRequestAuth>;
  getAvailable(): Model<Api>[];
}

// ============================================================================
// Errors
// ============================================================================

export type RouterErrorCode =
  | "NO_FALLBACK_AVAILABLE"
  | "BACKEND_MODEL_NOT_FOUND"
  | "BACKEND_PROVIDER_NOT_FOUND"
  | "BACKEND_AUTH_MISSING"
  | "REGISTRY_UNAVAILABLE"
  | "CONFIG_INVALID";

/** Typed error thrown by the router. Carries a stable machine-readable code. */
export class RouterError extends Error {
  readonly code: RouterErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: RouterErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "RouterError";
    this.code = code;
    this.details = details;
  }
}

// ============================================================================
// Backend resolution types
// ============================================================================

/** A backend resolved through the model registry, ready for delegation. */
export interface ResolvedBackend {
  /** The registry model object for the backend */
  model: Model<Api>;
  /** The registry provider exposing streamSimple */
  provider: Provider;
  /** Resolved API key (from auth resolution), if any */
  apiKey?: string;
  /** Resolved extra headers (from auth and provider config) */
  headers?: ProviderHeaders;
  /** Effective base URL for the delegation model */
  baseUrl?: string;
}

/** Stream options actually forwarded to the backend. */
export type BackendStreamOptions = SimpleStreamOptions;
