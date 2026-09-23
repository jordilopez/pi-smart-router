/**
 * Tier classification: per-tier capability filters, direct Jev classification,
 * and deterministic collision resolution.
 *
 * Separated from tools.ts to keep the tool-registration file under the
 * ~1000-line inspection threshold and make the classification logic
 * independently testable.
 */

import { TypeSafeClient } from "@typesafe-ai/sdk";
import { type RouteTier } from "./types.js";
import { prepareClassifierRequest, slugify, type CatalogModel } from "./tools.js";

// ============================================================================
// Per-tier capability filters
// ============================================================================

/**
 * Capability filters applied to a tier's candidate pool before classification.
 * Not all tiers need the same features: cheap/fast do not need huge context
 * windows or image support, while powerful needs thinking and large context.
 */
export interface TierFilters {
  /** Minimum context window in tokens. 0 = no minimum. */
  minContext: number;
  /** When true, only thinking models are eligible for this tier. */
  requireThinking: boolean;
  /** When true, models without image support are excluded from this tier. */
  requireImages: boolean;
}

/**
 * Sensible per-tier default filters. Cheap/fast tiers are latency- and
 * cost-driven (small context, no thinking or images needed); balanced needs
 * a decent context window and image support is required (the router enforces
 * image compatibility per route); powerful needs thinking and a large window.
 */
export function defaultTierFilters(tier: RouteTier): TierFilters {
  switch (tier) {
    case "cheap":
      return { minContext: 128_000, requireThinking: false, requireImages: false };
    case "fast":
      return { minContext: 100_000, requireThinking: false, requireImages: false };
    case "balanced":
      return { minContext: 200_000, requireThinking: false, requireImages: true };
    case "powerful":
      return { minContext: 500_000, requireThinking: true, requireImages: false };
  }
}

/**
 * Apply a tier's filters to a candidate list. `overrides` are merged on top of
 * the tier defaults (partial: only the given fields are overridden).
 */
export function applyTierFilters(
  tier: RouteTier,
  models: CatalogModel[],
  overrides?: Partial<TierFilters>,
): CatalogModel[] {
  const f = { ...defaultTierFilters(tier), ...overrides };
  return models.filter(
    (m) =>
      m.context >= f.minContext &&
      (!f.requireThinking || m.thinking) &&
      (!f.requireImages || m.images),
  );
}

// ============================================================================
// Jev tier classification (direct SDK call, no re-runs)
// ============================================================================

/** All routing tiers, ascending capability/cost order. */
export const TIERS: RouteTier[] = ["cheap", "fast", "balanced", "powerful"];

/** One tier's classification result from Jev. */
export interface JevTierAssignment {
  tier: RouteTier;
  /** The picked model. `undefined` when the tier had no eligible candidates. */
  model?: CatalogModel;
  /** Jev's confidence in the pick. */
  confidence: number;
  /** Full probability distribution over the tier's candidate slugs. */
  probabilities: Record<string, number>;
}

/** Result of the single Jev classification pass over all four tiers. */
export interface JevTierResult {
  assignments: Record<RouteTier, JevTierAssignment>;
  /** Token usage reported by the API. */
  usage?: { input_tokens: number; output_tokens: number };
}

/** Minimal structural surface of TypeSafeClient.systemOne, for test injection. */
export interface SystemOneCaller {
  systemOne(request: {
    state: Record<string, string>;
    questions: Record<string, unknown>;
    model?: string;
  }, options?: { signal?: AbortSignal; timeout?: number }): Promise<{
    answers: Record<string, { type?: string; choice: string; confidence: number; probabilities: Record<string, number> }>;
    usage?: { input_tokens: number; output_tokens: number };
  }>;
}

/** Options for jevTierClassification. */
export interface JevTierOptions {
  /** Cut each tier's pool to ≤ 8 plausible fits with positioning clauses. Default true. */
  narrow?: boolean;
  /** Jev model name. Default "jev-latest". */
  model?: string;
  /** Abort the call after this many ms. Default 60_000 (four questions in one call). */
  timeoutMs?: number;
  /**
   * Explicit per-tier candidate pools (e.g. after applying per-tier capability
   * filters). Tiers without an entry use the narrow/full pool logic.
   */
  tierPools?: Partial<Record<RouteTier, CatalogModel[]>>;
  /** Test/alternate injection point. Defaults to a lazily-created TypeSafeClient. */
  client?: SystemOneCaller;
}

/** Shared lazy client, created on first use (reads TYPESAFE_API_KEY from env). */
let _tierSetupClient: TypeSafeClient | null = null;
function getTierSetupClient(): TypeSafeClient | null {
  if (!_tierSetupClient) {
    try {
      _tierSetupClient = new TypeSafeClient({ timeout: 60_000 });
    } catch {
      return null;
    }
  }
  return _tierSetupClient;
}

/** Test-only reset of the shared lazy client. */
export function resetTierSetupClient(): void {
  _tierSetupClient = null;
}

/**
 * Classify all four tiers in a single Jev call — one Choice question per tier,
 * with the per-tier candidate pool as criteria. Takes Jev's first response
 * as-is: no sharpening re-runs. Low confidence is surfaced in the result and
 * left for the user to judge.
 *
 * Throws when Jev is unavailable (no API key) or the call fails/times out —
 * the caller decides how to surface the failure.
 */
export async function jevTierClassification(
  models: CatalogModel[],
  options: JevTierOptions = {},
): Promise<JevTierResult> {
  const { narrow = true, model = "jev-latest", timeoutMs = 60_000 } = options;
  const client = options.client ?? getTierSetupClient();
  if (!client) {
    throw new Error(
      "TypeSafe client unavailable (is TYPESAFE_API_KEY set?). Cannot classify tiers.",
    );
  }

  // With explicit tier pools, the classification state must cover the union of
  // the pools (candidates filtered out of every pool are not judged).
  const classifyModels = options.tierPools
    ? [...new Map(
        Object.values(options.tierPools).flat().map((m) => [slugify(`${m.provider}/${m.model}`), m] as const),
      ).values()]
    : models;
  const { state, questions } = prepareClassifierRequest(classifyModels, narrow, options.tierPools);
  if (Object.keys(state).length === 0) {
    throw new Error("No candidate models to classify.");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1_000, timeoutMs));

  try {
    const { answers, usage } = await client.systemOne(
      { state, questions, model },
      { signal: controller.signal, timeout: Math.max(1_000, timeoutMs) },
    );

    const bySlug = new Map<string, CatalogModel>();
    for (const m of classifyModels) bySlug.set(slugify(`${m.provider}/${m.model}`), m);

    const assignments = {} as Record<RouteTier, JevTierAssignment>;
    for (const tier of TIERS) {
      const answer = answers[tier];
      if (!answer || answer.type !== "choice" || typeof answer.choice !== "string") {
        assignments[tier] = { tier, confidence: 0, probabilities: {} };
        continue;
      }
      assignments[tier] = {
        tier,
        model: bySlug.get(answer.choice),
        confidence: answer.confidence ?? 0,
        probabilities: answer.probabilities ?? {},
      };
    }

    return { assignments, usage };
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================================
// Deterministic collision resolution
// ============================================================================

/** Tier capability rank for tie-breaking (higher = more capable). */
const TIER_RANK: Record<RouteTier, number> = { cheap: 0, fast: 1, balanced: 2, powerful: 3 };

/**
 * Resolve duplicate picks across tiers deterministically:
 *
 * 1. For each contested model (two or more tiers picked it), the winner is
 *    `powerful` if present; otherwise the highest-confidence tier (ties broken
 *    toward the more capable tier).
 * 2. Losers re-pick: each loser, in descending-confidence order, takes the
 *    highest-probability candidate from its own distribution that is not
 *    claimed by a winner or an earlier loser. A loser with no candidate left
 *    stays unassigned (confidence 0).
 * 3. Uncontested picks never change.
 *
 * `powerful` is never displaced. `models` is the full candidate list — used to
 * map probability slugs back to models exactly (slugs are lossy). Mutates
 * nothing; returns new assignment objects.
 */
export function resolveCollisions(
  assignments: Record<RouteTier, JevTierAssignment>,
  models: CatalogModel[],
): Record<RouteTier, JevTierAssignment> {
  const bySlug = new Map<string, CatalogModel>();
  for (const m of models) bySlug.set(slugify(`${m.provider}/${m.model}`), m);
  const slugOf = (a: JevTierAssignment) =>
    a.model ? slugify(`${a.model.provider}/${a.model.model}`) : null;

  const resolved: Record<RouteTier, JevTierAssignment> = { ...assignments };

  // Group tiers by contested slug.
  const groups = new Map<string, RouteTier[]>();
  for (const tier of TIERS) {
    const key = slugOf(resolved[tier]);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(tier);
  }

  const claimed = new Set<string>();
  const losers: RouteTier[] = [];

  for (const [slug, tiers] of groups) {
    if (tiers.length === 1) {
      claimed.add(slug);
      continue; // uncontested — winner keeps its pick
    }
    // Winner: powerful if present, else max confidence (tie -> more capable).
    const winner = [...tiers].sort((x, y) => {
      if (x === "powerful" || y === "powerful") return y === "powerful" ? 1 : -1;
      const ca = resolved[x].confidence, cb = resolved[y].confidence;
      if (ca !== cb) return cb - ca;
      return TIER_RANK[y] - TIER_RANK[x];
    })[0];
    claimed.add(slug);
    for (const tier of tiers) {
      if (tier !== winner) losers.push(tier);
    }
  }

  // Losers re-pick from their own probabilities, best first.
  losers.sort((x, y) => resolved[y].confidence - resolved[x].confidence || TIER_RANK[y] - TIER_RANK[x]);
  for (const tier of losers) {
    const a = resolved[tier];
    const [nextSlug, nextProb] = Object.entries(a.probabilities)
      .filter(([s]) => bySlug.has(s) && !claimed.has(s))
      .sort(([, p1], [, p2]) => p2 - p1)[0] ?? [];
    if (nextSlug) {
      claimed.add(nextSlug);
      resolved[tier] = { ...a, model: bySlug.get(nextSlug), confidence: nextProb ?? 0 };
    } else {
      resolved[tier] = { ...a, model: undefined, confidence: 0 };
    }
  }

  return resolved;
}
