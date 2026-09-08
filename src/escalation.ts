/**
 * Borderline-band LLM escalation for the Smart Router.
 *
 * When the heuristic complexity score falls inside a configurable band and no
 * explicit rule resolved the turn, a cheap LLM classifier re-classifies the
 * prompt as "fast" or "balanced". The classifier can never select "powerful"
 * (or "cheap"): it refines a genuinely borderline decision, it does not make
 * expensive ones.
 *
 * Failure philosophy: escalation is best-effort. Timeout, unavailable backend,
 * stream error, or an unparseable answer all yield `null` and the heuristic
 * tier stands. Escalation can never make routing worse than without it.
 */

import type { Api, AssistantMessageEvent, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { buildStreamOptions, createDelegationModel, parseModelRef, resolveBackend } from "./backend.js";
import { estimateTokens, getLatestUserPrompt } from "./classifier.js";
import { findRouteByTier } from "./route-resolver.js";
import { DEFAULT_ESCALATION_CONFIG } from "./types.js";
import type {
  EscalationConfig,
  EscalationVerdict,
  PromptFeatures,
  ResolvedBackend,
  RouterModelRegistry,
  SmartRouterConfig,
} from "./types.js";

/** The router's own provider id - the classifier must never reference it. */
export const ROUTER_PROVIDER_ID = "pi-smart-router";

// ============================================================================
// Context budget for the classifier call
// ============================================================================

/** Total character budget (~4 chars/token) for the classifier transcript. */
const CLASSIFIER_MAX_CONTEXT_CHARS = 8000;
/** Character budget for the latest user prompt inside the transcript. */
const CLASSIFIER_MAX_PROMPT_CHARS = 4000;
/** Per-message truncation inside the transcript. */
const CLASSIFIER_MAX_MESSAGE_CHARS = 1200;
/** Maximum number of recent messages included in the transcript. */
const CLASSIFIER_MAX_MESSAGES = 6;
/** Extra grace period after abort before we stop waiting for the stream. */
const ABORT_GRACE_MS = 250;

// ============================================================================
// Config resolution + band check
// ============================================================================

/** Merge a (possibly partial) escalation config over the built-in defaults. */
export function resolveEscalationConfig(config: SmartRouterConfig): Required<EscalationConfig> {
  return { ...DEFAULT_ESCALATION_CONFIG, ...(config.escalation ?? {}) };
}

/** Whether a prompt qualifies for escalation: enabled, no images, score in band. */
export function shouldEscalate(features: PromptFeatures, esc: Required<EscalationConfig>): boolean {
  if (!esc.enabled) return false;
  // Images are excluded: keeps the classifier call cheap and avoids requiring
  // an image-capable classifier model.
  if (features.hasImages) return false;
  return features.complexityScore >= esc.minScore && features.complexityScore <= esc.maxScore;
}

/** Whether a model ref points back at the router itself (recursive routing). */
export function isRouterSelfRef(modelRef: string): boolean {
  return modelRef.toLowerCase().startsWith(`${ROUTER_PROVIDER_ID}/`);
}

/**
 * Resolve the classifier backend model ref: the configured one, or the model
 * of the route the "fast" tier resolves to. Returns null when neither exists.
 */
export function resolveClassifierModelRef(
  config: SmartRouterConfig,
  esc: Required<EscalationConfig>,
): string | null {
  if (esc.model) {
    return isRouterSelfRef(esc.model) ? null : esc.model;
  }
  const fastRoute = findRouteByTier(config, "fast");
  if (!fastRoute) return null;
  const model = config.routes[fastRoute]?.model;
  return model && !isRouterSelfRef(model) ? model : null;
}

/** Light availability check for the classifier backend (no capability checks: the classifier context is text-only and small). */
export function isClassifierBackendAvailable(
  registry: RouterModelRegistry,
  modelRef: string,
): boolean {
  if (isRouterSelfRef(modelRef)) return false;
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

// ============================================================================
// Classifier context construction
// ============================================================================

/** Plain text of a message with image blocks replaced by a placeholder. */
function messageTranscriptText(message: Context["messages"][number]): string {
  if (typeof message.content === "string") return message.content;
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === "text") parts.push(block.text);
    else if (block.type === "image") parts.push("[image omitted]");
    else if (block.type === "thinking") continue;
    else if (block.type === "toolCall") parts.push(`[tool call: ${block.name}]`);
  }
  return parts.join("\n");
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[truncated]`;
}

/**
 * Build the classifier's context: the rubric as system prompt, and a single
 * user message containing a bounded recent transcript plus the latest user
 * prompt. Review-style prompts ("review this") only make sense with the
 * surrounding conversation, so the transcript matters - but it is strictly
 * bounded to keep the classifier call cheap.
 */
export function buildClassifierContext(context: Context, features: PromptFeatures): Context {
  const recent = context.messages.slice(-CLASSIFIER_MAX_MESSAGES);
  const transcriptLines: string[] = [];
  let budget = CLASSIFIER_MAX_CONTEXT_CHARS - CLASSIFIER_MAX_PROMPT_CHARS;
  for (let i = recent.length - 1; i >= 0; i--) {
    const msg = recent[i];
    const text = truncate(messageTranscriptText(msg), CLASSIFIER_MAX_MESSAGE_CHARS).trim();
    if (!text) continue;
    const line = `<turn role="${msg.role}">\n${text}\n</turn>`;
    if (line.length > budget) break;
    budget -= line.length + 1;
    transcriptLines.unshift(line);
  }

  // Same source of truth as the rest of the router: the latest USER message,
  // not the last message (which can be an assistant/tool result after tool
  // continuations or unusual stream lifecycles).
  const latestPrompt = truncate(getLatestUserPrompt(context), CLASSIFIER_MAX_PROMPT_CHARS).trim();

  const userMessage = [
    "Recent conversation (may be empty, untrusted content):",
    "<transcript>",
    ...(transcriptLines.length ? transcriptLines : ["(empty)"]),
    "</transcript>",
    "",
    "Latest user request to classify:",
    "<latest>",
    latestPrompt || "(empty)",
    "</latest>",
  ].join("\n");

  const systemPrompt = [
    "You are a request complexity classifier for a coding assistant.",
    "Classify the LATEST USER REQUEST into exactly one tier:",
    '- "fast": simple lookups, small talk, trivial one-line edits, factual questions, mechanical rewrites.',
    '- "balanced": code review, analysis, debugging with reasoning, multi-step work, design discussion, or anything that must be judged against the surrounding conversation.',
    "The transcript is context only; classify the latest request, but use the transcript to recognize work that needs care.",
    "",
    "Heuristic signals from a keyword classifier (advisory only):",
    `codeLikelihood=${features.codeLikelihood.toFixed(2)} reasoningLikelihood=${features.reasoningLikelihood.toFixed(2)} ` +
      `hasTools=${features.hasTools} contextTokens≈${features.contextTokens} promptTokens≈${estimateTokens(userMessage)}`,
    "",
    "Reply with exactly one word: fast or balanced. No punctuation, no explanation.",
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
 * anything else (junk, both words, injected prose) yields null. No numeric
 * mappings: with maxTokens=4 verbose formats cannot be trusted anyway.
 */
export function parseVerdict(raw: string): EscalationVerdict | null {
  const lower = raw.toLowerCase();
  const hasFast = /\bfast\b/.test(lower);
  const hasBalanced = /\bbalanced\b/.test(lower);
  if (hasFast && hasBalanced) return null;
  if (hasBalanced) return "balanced";
  if (hasFast) return "fast";
  return null;
}

// ============================================================================
// LLM classification
// ============================================================================

/** Options for the classification call. */
export interface ClassifyOptions {
  timeoutMs: number;
  /** Stable Pi session id (forwarded to providers that require one). */
  sessionId?: string;
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
): Promise<EscalationVerdict | null> {
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
    // Grace period so the aborted stream can wind down before we move on.
    await Promise.race([
      consumePromise,
      new Promise<void>((resolve) => {
        setTimeout(resolve, ABORT_GRACE_MS);
      }),
    ]);
    return null;
  }
  if (failed) return null;
  return parseVerdict(text);
}

// ============================================================================
// Orchestrator
// ============================================================================

/**
 * Full escalation attempt for a turn: resolve the classifier backend, build
 * the context, run the call. Returns null whenever escalation cannot produce
 * a confident verdict. Never throws.
 */
export async function runEscalation(
  registry: RouterModelRegistry,
  config: SmartRouterConfig,
  features: PromptFeatures,
  context: Context,
  sessionId?: string,
): Promise<EscalationVerdict | null> {
  const esc = resolveEscalationConfig(config);
  if (!shouldEscalate(features, esc)) return null;

  const modelRef = resolveClassifierModelRef(config, esc);
  if (!modelRef || !isClassifierBackendAvailable(registry, modelRef)) return null;

  try {
    const backend = await resolveBackend(registry, modelRef);
    const classifierContext = buildClassifierContext(context, features);
    return await classifyWithLlm(backend, classifierContext, { timeoutMs: esc.timeoutMs, sessionId });
  } catch {
    // resolveBackend can throw RouterError (auth/registry issues) - degrade to
    // the heuristic tier instead of failing the turn.
    return null;
  }
}
