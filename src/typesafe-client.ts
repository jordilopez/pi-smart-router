/**
 * TypeSafe / Jev integration for the Smart Router classifier.
 *
 * Uses the @typesafe-ai/sdk to make a Choice judgment over all four routing tiers.
 * Never throws: returns null on timeout, auth failure, or network error.
 */

import type { Context } from "@earendil-works/pi-ai";
import { choice, TypeSafeClient } from "@typesafe-ai/sdk";
import { buildTranscript } from "./classifier.js";
import { TIER_RUBRIC } from "./types.js";
import type { PromptFeatures, RouteTier } from "./types.js";

/** All routing tiers, in ascending capability/cost order. */
export const ALL_TIERS: RouteTier[] = ["cheap", "fast", "balanced", "powerful"];

// ============================================================================
// Lazy client (one per session, reads TYPESAFE_API_KEY from env)
// ============================================================================

let _client: TypeSafeClient | null = null;

function getClient(): TypeSafeClient | null {
  if (!_client) {
    try {
      _client = new TypeSafeClient({ timeout: 10_000 });
    } catch {
      return null;
    }
  }
  return _client;
}

/** Force-reset the client (for testing or config reload). */
export function resetTypesafeClient(): void {
  _client = null;
}

// ============================================================================
// State construction
// ============================================================================

/**
 * Build the TypeSafe state object: recent transcript, latest user prompt,
 * and heuristic signals the model can use as context.
 * The transcript is built by the shared `buildTranscript` helper.
 */
export function buildTypesafeClassifierState(
  context: Context,
  features: PromptFeatures,
): Record<string, string> {
  const { transcript, latestPrompt } = buildTranscript(context);

  return {
    transcript,
    prompt: latestPrompt,
    heuristic_signals: JSON.stringify({
      codeLikelihood: features.codeLikelihood,
      reasoningLikelihood: features.reasoningLikelihood,
      hasTools: features.hasTools,
      contextTokens: features.contextTokens,
    }),
  };
}

// ============================================================================
// Classification with TypeSafe Choice
// ============================================================================

/** Classifier call stats filled in by the classification backends when available. */
export interface ClassifierStats {
  /** Wall-clock duration of the classification call in milliseconds. */
  elapsedMs?: number;
  /** Input tokens consumed by the classification call. */
  inputTokens?: number;
  /** Output tokens consumed by the classification call. */
  outputTokens?: number;
}

/** Options for the TypeSafe classification call. */
export interface TypesafeClassifyOptions {
  /** Timeout in milliseconds for the API call. */
  timeoutMs: number;
  /** Model name to use (defaults to "jev-latest"). */
  model?: string;
  /** Optional stats object filled in with call duration and token usage. */
  stats?: ClassifierStats;
}

/**
 * Classify a prompt using TypeSafe's Choice primitive.
 *
 * Asks Jev to pick one of the allowed tiers based on the conversation
 * transcript and the latest user prompt. Returns null on any failure (auth,
 * timeout, network, or a verdict outside the allowed set) — the caller falls
 * back to the heuristic tier. Never throws.
 */
export async function typesafeClassify(
  features: PromptFeatures,
  context: Context,
  options: TypesafeClassifyOptions,
): Promise<RouteTier | null> {
  const client = getClient();
  if (!client) return null;

  const state = buildTypesafeClassifierState(context, features);
  const modelName = options.model ?? "jev-latest";
  const timeoutMs = Math.max(1_000, options.timeoutMs);

  const startedAt = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const { answers, usage } = await client.systemOne(
        {
          state,
          questions: {
            tier: choice(
              [
                "You are a request complexity classifier for a coding assistant.",
                "Classify the LATEST USER REQUEST into exactly one tier:",
                "",
                ...ALL_TIERS.map((tier) => `- "${tier}": ${TIER_RUBRIC[tier]}.`),
                "",
                "The transcript is context only; classify the latest request, but use the transcript to recognize work that needs care.",
              ].join("\n"),
              Object.fromEntries(ALL_TIERS.map((tier) => [tier, TIER_RUBRIC[tier]])) as Record<string, string>,
            ),
          },
          model: modelName,
        },
        { signal: controller.signal, timeout: timeoutMs },
      );

      clearTimeout(timer);

      const verdict = answers.tier.choice as RouteTier;
      if (!ALL_TIERS.includes(verdict)) return null;
      if (options.stats) {
        options.stats.elapsedMs = Date.now() - startedAt;
        options.stats.inputTokens = usage.input_tokens;
        options.stats.outputTokens = usage.output_tokens;
      }

      return verdict;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // All errors (auth, timeout, network, abort, parse) → null
    if (options.stats) options.stats.elapsedMs = Date.now() - startedAt;
    return null;
  }
}