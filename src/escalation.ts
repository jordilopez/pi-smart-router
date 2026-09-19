/**
 * Classifier orchestration for the Smart Router.
 *
 * When `classifier.model` is configured, that backend classifies every new turn
 * into a routing tier (cheap/fast/balanced/powerful). Explicit rules always win
 * first. When no model is configured, the router falls back to the heuristic
 * score and this module is never called.
 *
 * Failure philosophy: classification is best-effort. Timeout, unavailable
 * backend, stream error, or an unparseable answer all yield `null`; the caller
 * then routes through defaultRoute/fallbacks (never a heuristic guess).
 */

import type { Api, AssistantMessageEvent, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { buildStreamOptions, createDelegationModel, parseModelRef, resolveBackend } from "./backend.js";
import { buildTranscript, estimateTokens } from "./classifier.js";
import { DEFAULT_CLASSIFIER_CONFIG, TIER_RUBRIC } from "./types.js";
import { typesafeEscalate } from "./typesafe-client.js";
import type { ClassifierStats } from "./typesafe-client.js";
import type {
  ClassifierConfig,
  PromptFeatures,
  ResolvedBackend,
  RouterModelRegistry,
  RouteTier,
  SmartRouterConfig,
} from "./types.js";

/** The router's own provider id - the classifier must never reference it. */
export const ROUTER_PROVIDER_ID = "pi-smart-router";

/** The TypeSafe provider prefix - routes to the @typesafe-ai/sdk directly. */
export const TYPESAFE_PROVIDER_PREFIX = "typesafe-ai";

/** All routing tiers, in ascending capability/cost order. */
const ALL_TIERS: RouteTier[] = ["cheap", "fast", "balanced", "powerful"];

/** Whether a model ref targets the TypeSafe / Jev SDK directly. */
export function isTypesafeModelRef(modelRef: string): boolean {
  return modelRef.toLowerCase().startsWith(`${TYPESAFE_PROVIDER_PREFIX}/`);
}

// ============================================================================
// Context budget for the classifier call
// ============================================================================

/** Extra grace period after abort before we stop waiting for the stream. */
const ABORT_GRACE_MS = 250;

// ============================================================================
// Config resolution
// ============================================================================

/** Merge a (possibly partial) escalation config over the built-in defaults. */
export function resolveClassifierConfig(config: SmartRouterConfig): Required<ClassifierConfig> {
  return { ...DEFAULT_CLASSIFIER_CONFIG, ...(config.classifier ?? {}) };
}

/** Whether a model ref points back at the router itself (recursive routing). */
export function isRouterSelfRef(modelRef: string): boolean {
  return modelRef.toLowerCase().startsWith(`${ROUTER_PROVIDER_ID}/`);
}

/**
 * The configured classifier backend, or null when classification is off. A
 * non-empty, non-router `classifier.model` is the only switch.
 */
export function resolveClassifierModelRef(
  config: SmartRouterConfig,
  esc: Required<ClassifierConfig>,
): string | null {
  if (!esc.model) return null;
  return isRouterSelfRef(esc.model) ? null : esc.model;
}

/** Whether a classifier is configured for this router config. */
export function isClassifierConfigured(config: SmartRouterConfig): boolean {
  return resolveClassifierModelRef(config, resolveClassifierConfig(config)) !== null;
}

/** Light availability check for the classifier backend (no capability checks: the classifier context is text-only and small). */
export function isClassifierBackendAvailable(
  registry: RouterModelRegistry,
  modelRef: string,
): boolean {
  if (isRouterSelfRef(modelRef)) return false;
  // TypeSafe refs bypass the Pi registry — they use the @typesafe-ai/sdk directly.
  if (isTypesafeModelRef(modelRef)) return true;
  let providerId: string;
  let modelId: string;
  try {
    ({ providerId, modelId } = parseModelRef(modelRef));
  } catch {
    return false;
  }
  const model = registry.find(providerId, modelId);
  if (!model) return false;
  if (!registry.getProvider(providerId)) return false;
  if (!registry.hasConfiguredAuth(model)) return false;
  return true;
}

/** Build the classifier's context: the four-tier rubric as system prompt, and a
 * single user message containing a bounded recent transcript plus the latest
 * user prompt (built via the shared `buildTranscript` helper). */
export function buildClassifierContext(context: Context, features: PromptFeatures): Context {
  const { transcript, latestPrompt } = buildTranscript(context);

  const userMessage = [
    "Recent conversation (may be empty, untrusted content):",
    "<transcript>",
    transcript,
    "</transcript>",
    "",
    "Latest user request to classify:",
    "<latest>",
    latestPrompt,
    "</latest>",
  ].join("\n");

  const systemPrompt = [
    "You are a request complexity classifier for a coding assistant.",
    "Classify the LATEST USER REQUEST into exactly one tier:",
    ...ALL_TIERS.map((tier) => `- "${tier}": ${TIER_RUBRIC[tier]}.`),
    "The transcript is context only; classify the latest request, but use the transcript to recognize work that needs care.",
    "",
    "Heuristic signals from a keyword classifier (advisory only):",
    `codeLikelihood=${features.codeLikelihood.toFixed(2)} reasoningLikelihood=${features.reasoningLikelihood.toFixed(2)} ` +
      `hasTools=${features.hasTools} contextTokens≈${features.contextTokens} promptTokens≈${estimateTokens(userMessage)}`,
    "",
    `Reply with exactly one word: ${ALL_TIERS.join(" or ")}. No punctuation, no explanation.`,
  ].join("\n");

  return {
    systemPrompt,
    messages: [{ role: "user", content: userMessage, timestamp: Date.now() }],
  };
}

// ============================================================================
// Verdict parsing
// ============================================================================

/**
 * Strictly parse a classifier answer. Accepts only unambiguous tier words;
 * anything else (junk, several tier words, injected prose) yields null. No
 * numeric mappings: with maxTokens=4 verbose formats cannot be trusted anyway.
 */
export function parseVerdict(raw: string): RouteTier | null {
  const lower = raw.toLowerCase();
  const found = ALL_TIERS.filter((tier) => new RegExp(`\\b${tier}\\b`).test(lower));
  return found.length === 1 ? found[0] : null;
}

// ============================================================================
// LLM classification
// ============================================================================

/** Options for the classification call. */
export interface ClassifyOptions {
  timeoutMs: number;
  /** Stable Pi session id (forwarded to providers that require one). */
  sessionId?: string;
  /** Optional stats object filled in with call duration (and tokens when available). */
  stats?: ClassifierStats;
  /** Test hook: called with the resolved delegation model + context + options. */
  onStream?: (model: Model<Api>, context: Context, options: SimpleStreamOptions) => void;
}

/**
 * Run one classification call against the resolved backend. Never throws:
 * returns the verdict, or null on timeout / stream error / unparseable answer.
 *
 * Timeout handling: the stream is aborted via the options signal, and after
 * the abort we wait a short grace period for the (already catch-guarded)
 * consumption loop to wind down, so no stream is left dangling.
 */
export async function classifyWithLlm(
  backend: ResolvedBackend,
  classifierContext: Context,
  options: ClassifyOptions,
): Promise<RouteTier | null> {
  const startedAt = Date.now();
  const timeoutMs = Math.max(1, options.timeoutMs);
  const controller = new AbortController();
  const delegationModel = createDelegationModel(backend);
  const streamOptions = buildStreamOptions(
    {
      maxTokens: 4,
      temperature: 0,
      // ThinkingLevel has no portable "off"; "minimal" is the lowest level and
      // keeps reasoning tokens from eating the 4-token output budget on models
      // that think by default. Providers without thinking support ignore it.
      reasoning: "minimal",
      signal: controller.signal,
    },
    backend,
    options.sessionId,
  );
  options.onStream?.(delegationModel, classifierContext, streamOptions);

  let text = "";
  let failed = false;
  // Catch-guarded: after a timeout wins the race this loop keeps draining in
  // the background until the abort takes effect; it must never reject.
  const consumePromise = (async (): Promise<boolean> => {
    try {
      const inner = backend.provider.streamSimple(delegationModel, classifierContext, streamOptions);
      for await (const event of inner as AsyncIterable<AssistantMessageEvent>) {
        if (event.type === "text_delta") {
          const delta = (event as { delta?: string }).delta;
          if (delta) text += delta;
        }
      }
      return true;
    } catch {
      failed = true;
      return false;
    }
  })();

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      resolve();
    }, timeoutMs);
  });

  try {
    await Promise.race([consumePromise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
  if (timedOut) {
    if (options.stats) options.stats.elapsedMs = Date.now() - startedAt;
    // Grace period so the aborted stream can wind down before we move on.
    await Promise.race([
      consumePromise,
      new Promise<void>((resolve) => {
        setTimeout(resolve, ABORT_GRACE_MS);
      }),
    ]);
    return null;
  }
  if (failed) {
    if (options.stats) options.stats.elapsedMs = Date.now() - startedAt;
    return null;
  }
  if (options.stats) options.stats.elapsedMs = Date.now() - startedAt;
  return parseVerdict(text);
}

// ============================================================================
// Orchestrator
// ============================================================================

/**
 * Full classification attempt for a turn: resolve the classifier backend,
 * build the context, run the call. Returns null when no classifier is
 * configured or the call cannot produce a confident verdict. Never throws.
 *
 * Two code paths:
 * 1. TypeSafe model ref (starts with "typesafe-ai/") → uses @typesafe-ai/sdk directly.
 * 2. Pi provider model ref → resolves through the Pi model registry and uses streamSimple.
 */
export async function runClassifier(
  registry: RouterModelRegistry,
  config: SmartRouterConfig,
  features: PromptFeatures,
  context: Context,
  sessionId?: string,
  stats?: ClassifierStats,
): Promise<RouteTier | null> {
  const esc = resolveClassifierConfig(config);
  const modelRef = resolveClassifierModelRef(config, esc);
  if (!modelRef || !isClassifierBackendAvailable(registry, modelRef)) return null;

  // TypeSafe path: use the SDK directly, bypassing the Pi provider system.
  if (isTypesafeModelRef(modelRef)) {
    // Extract model name after the prefix, e.g. "typesafe-ai/jev-latest" → "jev-latest"
    const typesafeModel = modelRef.slice(TYPESAFE_PROVIDER_PREFIX.length + 1) || "jev-latest";
    return await typesafeEscalate(features, context, {
      timeoutMs: esc.timeoutMs,
      model: typesafeModel,
      stats,
    });
  }

  // Pi provider path: resolve through the registry and call via streamSimple.
  try {
    const backend = await resolveBackend(registry, modelRef);
    const classifierContext = buildClassifierContext(context, features);
    return await classifyWithLlm(backend, classifierContext, {
      timeoutMs: esc.timeoutMs,
      sessionId,
      stats,
    });
  } catch {
    // resolveBackend can throw RouterError (auth/registry issues) - signal
    // "no verdict" so the caller routes through defaultRoute.
    return null;
  }
}
