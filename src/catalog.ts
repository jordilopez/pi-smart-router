/**
 * Catalog helpers for the smart-router tools.
 *
 * Turns `pi --list-models` output into classifier-ready requests, builds model
 * descriptions (pricing, positioning, AA enrichment), and validates proposed
 * routes. Kept separate from `tools.ts` so that `tier-classification.ts` can
 * reuse these helpers without importing the tool-registration module, which
 * would create an import cycle (`tools.ts` -> `tier-classification.ts` ->
 * `tools.ts`).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TIER_RUBRIC, type RouteTier } from "./types.js";
import { augmentModelDescription, getTierWeighting, computeTaskCost } from "./aa-enrichment.js";
import { normalizeModelId, type AaModelMetrics } from "./aa-client.js";

const execFileAsync = promisify(execFile);

/**
 * Shared fetch: list models for the given providers (exec `pi --list-models`),
 * attach per-million-token pricing from the model registry, and return parsed
 * catalog entries. Used by both smart-router-catalog and smart-router-setup-tiers.
 */
export async function fetchCatalogModels(
  providers: string[],
  signal: AbortSignal | undefined,
  registry?: { find: (p: string, m: string) => any },
): Promise<CatalogModel[]> {
  const results = await Promise.all(providers.map((provider) =>
    execFileAsync(
      "pi",
      ["--list-models", provider],
      { encoding: "utf-8", timeout: 15000, signal },
    ).then(({ stdout }) => parseModelsTable(stdout)),
  ));
  const allModels = results.flat();
  if (registry?.find) {
    for (const m of allModels) {
      const found = registry.find(m.provider, m.model);
      const cost = found?.cost;
      if (cost && typeof cost.input === "number" && typeof cost.output === "number") {
        m.costIn = cost.input;
        m.costOut = cost.output;
      }
    }
  }
  return allModels;
}

/**
 * Parsed model entry from the Pi registry.
 */
export interface CatalogModel {
  provider: string;
  model: string;
  context: number; // in tokens
  maxOut: number; // in tokens
  thinking: boolean;
  images: boolean;
  /** $ per million input tokens, read from the model registry (optional). */
  costIn?: number;
  /** $ per million output tokens, read from the model registry (optional). */
  costOut?: number;
}

/**
 * Parse the tabular output of `pi --list-models <provider>`.
 *
 * Columns: provider  model  context  max-out  thinking  images
 * Context and max-out may have suffixes like "1M", "256K", "131.1K".
 */
export function parseTokenValue(value: string): number {
  const match = value.match(/^(\d+(?:\.\d+)?)\s*([KkMm]?)$/);
  if (!match) return 0;
  const num = parseFloat(match[1]);
  if (!Number.isFinite(num) || num < 0) return 0;
  const suffix = match[2].toUpperCase();
  if (suffix === "K") return Math.round(num * 1000);
  if (suffix === "M") return Math.round(num * 1_000_000);
  return Math.round(num);
}

export function parseModelsTable(output: string): CatalogModel[] {
  const lines = output.split("\n").filter((line) => line.trim());
  if (lines.length < 2) return []; // header + at least one row

  const models: CatalogModel[] = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(/\s+/);
    if (parts.length < 6) continue;
    const [provider, model, contextStr, maxOutStr, thinkingStr, imagesStr] = parts;
    models.push({
      provider,
      model,
      context: parseTokenValue(contextStr),
      maxOut: parseTokenValue(maxOutStr),
      thinking: thinkingStr.toLowerCase() === "yes",
      images: imagesStr.toLowerCase() === "yes",
    });
  }
  return models;
}

/**
 * Slugify a model ID for use as a state field key.
 * "hyper/glm-5.3-flash" → "hyper_glm_53_flash"
 */
export function slugify(modelId: string): string {
  return modelId.replace(/[\/\.\-]/g, "_").toLowerCase();
}

/**
 * Format a token count for display (e.g., 1500000 → "1.5M", 256000 → "256K")
 */
function formatTokenCount(tokens: number): string {
  return tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : `${Math.round(tokens / 1000)}K`;
}

/** Format a $/M-tokens price, trimming needless trailing zeros (0.3 → "0.3", 3.2664 → "3.27"). */
function formatMoney(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  return rounded % 1 === 0 ? rounded.toFixed(0) : String(rounded);
}

/**
 * True when the model carries registry pricing — the only tier-relevant cost
 * signal the catalog exposes (pi --list-models has no price column).
 */
export function hasCost(m: CatalogModel): boolean {
  return m.costIn != null && m.costOut != null;
}

/**
 * Deduplicate models across providers: when multiple providers offer the same
 * model ID, keep only the cheapest entry (by blended input+output cost).
 * Models without pricing retain their entry as-is (first encountered wins).
 */
export function deduplicateModels(models: CatalogModel[]): CatalogModel[] {
  const byModelId = new Map<string, CatalogModel>();
  for (const m of models) {
    const key = m.model.toLowerCase();
    const existing = byModelId.get(key);
    if (!existing) {
      byModelId.set(key, m);
    } else {
      const existingCost = hasCost(existing) ? (existing.costIn! + existing.costOut!) : Infinity;
      const currentCost = hasCost(m) ? (m.costIn! + m.costOut!) : Infinity;
      if (currentCost < existingCost) {
        byModelId.set(key, m);
      }
    }
  }
  return [...byModelId.values()];
}

/**
 * True when the tier should rank candidates by cost instead of by raw capability.
 * All four tiers rank by cost: cheap/fast/balanced are cost-sensitive by design;
 * powerful prefers cost too since filtering already ensures only capable models
 * enter the pool (500k+ context, thinking required).
 */
function isCostRanked(tier: RouteTier): boolean {
  return true;
}

/**
 * Build a short description for a model to use in the classifier state.
 * Includes per-million-token pricing when available, since cost is a real
 * tier signal (cheap/fast tiers are price-driven) and the listing command
 * does not expose it.
 */
export function modelDescription(
  m: CatalogModel,
  opts?: { positioning?: string; metrics?: AaModelMetrics | null },
): string {
  const contextLabel = formatTokenCount(m.context);
  const maxOutLabel = formatTokenCount(m.maxOut);
  const prefix = opts?.positioning ? `${m.provider}/${m.model} — ${opts.positioning} | ` : `${m.provider}/${m.model} | `;
  const cost = hasCost(m) ? `, $${formatMoney(m.costIn!)}/$${formatMoney(m.costOut!)} per M tokens` : "";

  let desc = `${prefix}context ${contextLabel}, maxOut ${maxOutLabel}, thinking ${m.thinking ? "yes" : "no"}, images ${m.images ? "yes" : "no"}${cost}`;

  if (opts?.metrics) {
    desc = augmentModelDescription(opts.metrics, desc);
    // Solve-adjusted task-cost index: folds price + AA capability into one signal.
    // Only emitted when both registry pricing and AA metrics are present.
    if (hasCost(m)) {
      const tc = computeTaskCost(m.costIn! + m.costOut!, opts.metrics);
      if (tc !== null) {
        desc += ` task-cost ${tc.toFixed(2)} (solve-adjusted)`;
      }
    }
  }

  return desc;
}

/**
 * Family/positioning name hints per tier, used by the optional `narrow` mode to
 * cut each tier's candidate pool to the models plausibly suited to it.
 */
const TIER_NAME_HINTS: Record<RouteTier, RegExp[]> = {
  cheap: [/flash/i, /mini/i, /haiku/i, /lite/i, /nano/i],
  fast: [/flash/i, /mini/i, /haiku/i, /air/i],
  balanced: [/plus/i, /sonnet/i, /\d+b/i],
  powerful: [/pro/i, /max/i, /opus/i, /ultra/i],
};

/**
 * Short factual positioning clause derived from the model's family naming.
 * Covers common model families so that Jev can distinguish candidates that
 * share the same raw specs (context, maxOut, thinking, images).
 *
 * Family-level checks come first so that model-family names containing
 * tier-like substrings (e.g. "mini" inside "minimax") are matched by
 * family before they hit the generic tier patterns.
 * When both a family and a tier pattern match, the clause is composed from
 * both parts (e.g. "DeepSeek model; flagship/reasoning tier").
 */
export function positioningClause(m: CatalogModel): string {
  // --- Family-level identification first (avoids substring collisions) ---
  let family = "";
  if (/^deepseek/i.test(m.model)) family = "DeepSeek model";
  else if (/^glm/i.test(m.model)) family = "Zhipu GLM model";
  else if (/^gemma/i.test(m.model)) family = "Google open-weight Gemma family model";
  else if (/^qwen/i.test(m.model)) family = "Alibaba Qwen model";
  else if (/^kimi/i.test(m.model)) family = "Moonshot Kimi model";
  else if (/^minimax/i.test(m.model)) family = "MiniMax model";
  else if (/^gpt-?oss/i.test(m.model)) family = "OpenAI open-weight GPT-OSS model";
  else if (/^gpt/i.test(m.model)) family = "OpenAI GPT-family model";

  // --- Tier-level patterns (generic across families) ---
  let tier = "";
  if (/pro|opus|ultra/i.test(m.model)) tier = "flagship/reasoning tier";
  else if (/\bmax\b/i.test(m.model)) tier = "largest/most-capable variant";
  else if (/plus|sonnet/i.test(m.model)) tier = "mid-size tier";
  else if (/\bflash\b|\bmini\b|\blite\b|\bnano\b|\bhaiku\b|\bair\b/i.test(m.model)) tier = "lightweight, fast tier";
  else if (/thinking/i.test(m.model)) tier = "reasoning-focused variant";

  if (family && tier) return `${family}; ${tier}`;
  if (family) return family;
  return tier;
}

/** Capability order: thinking models first, then larger context, then larger output. */
function byCapability(a: CatalogModel, b: CatalogModel): number {
  return Number(b.thinking) - Number(a.thinking) || b.context - a.context || b.maxOut - a.maxOut;
}

/**
 * Narrow the full candidate list to at most 8 models plausibly suited to a tier:
 * name-hint matches first, then filled from the rest. Cost-sensitive tiers
 * (cheap/fast/balanced) fill cheapest-first (blended $/M tokens, falling back
 * to smallest output only when a model has no price); powerful fills
 * strongest-capability-first.
 */
export function narrowPool(tier: RouteTier, models: CatalogModel[]): CatalogModel[] {
  const hints = TIER_NAME_HINTS[tier];
  const matched = models.filter((m) => hints.some((h) => h.test(m.model)));
  const rest = models.filter((m) => !matched.includes(m));
  const fill = isCostRanked(tier)
    ? [...rest].sort((a, b) => {
        const pa = hasCost(a) ? (a.costIn! + a.costOut!) : Infinity;
        const pb = hasCost(b) ? (b.costIn! + b.costOut!) : Infinity;
        return pa === pb ? a.maxOut - b.maxOut : pa - pb;
      })
    : [...rest].sort(byCapability);
  return [...matched, ...fill].slice(0, 8);
}

/**
 * Tier-specific instruction templates that tell Jev *how* to compare candidates
 * (not just *what* the tier is for). Each template weaves the rubric text with
 * prioritization guidance and negative constraints.
 */
const TIER_INSTRUCTIONS: Record<RouteTier, string> = {
  cheap: 'Which model best fits the "cheap" tier? ${RUBRIC}. This tier is cost-sensitive: prefer the cheapest model that can handle trivial tasks. Context window: 128k-256k is sufficient — do not prioritize large context. Thinking capability: not needed for this tier. Image support: not needed. Do not pick a flagship, reasoning-heavy, or otherwise over-powered model.',
  fast: 'Which model best fits the "fast" tier? ${RUBRIC}. This is the routine coding workhorse: prefer a low latency, fast, capable, cost-effective model for clear implementations and bounded fixes. Context window: 100k-300k is ideal — large enough for typical codebases but not excessive. Thinking capability: not critical for routine work. Image support: not critical. Do not promote a task merely because it spans multiple files or uses tools. Do not pick a heavy reasoning or flagship model for routine work; reserve those for genuinely difficult tasks.',
  balanced: 'Which model best fits the "balanced" tier? ${RUBRIC}. This is not the default everyday workhorse; reserve it for meaningful judgment, ambiguity, or non-obvious analysis. Context window: larger context (200k-500k) is important for handling complex codebases and longer conversations. Image support: valuable for tasks involving screenshots, diagrams, or visual debugging — prefer models with image capability. Thinking capability: helpful but not required. Prefer general-purpose capability. Cost-conscious: among equally capable models, prefer the lower-cost option.',
  powerful: 'Which model best fits the "powerful" tier? ${RUBRIC}. This is the strongest tier: prefer the model with the best reasoning capability. Context window: large context (500k+) is essential for architecture-level work and cross-cutting analysis. Thinking capability: required — this tier handles genuinely difficult reasoning, formal analysis, and complex debugging. Image support: optional but welcome. Since all candidates already pass these capability gates, cost is a real signal: prefer the lower-cost option among capable models. Do not pick a lightweight or fast-only model.',
};

/**
 * Ordinal rank label for a model within a tier's candidate pool.
 * All tiers rank by blended cost (cheapest = rank 0).
 */
function rankLabel(rank: number, tier: RouteTier): string {
  if (rank === 0) {
    return isCostRanked(tier)
      ? "(cheapest in pool)"
      : "(most capable in pool)";
  }
  const suffix = ["2nd", "3rd", "4th", "5th", "6th", "7th", "8th"][rank - 1] ?? `${rank + 1}th`;
  return isCostRanked(tier)
    ? `(${suffix} cheapest in pool)`
    : `(${suffix} most capable in pool)`;
}

export interface PrepareClassifierOptions {
  /** Cut each tier's pool to ≤ 8 plausible fits with positioning clauses. */
  narrow?: boolean;
  /** Explicit per-tier candidate pools; unset tiers use the narrow/full logic. */
  perTierPools?: Partial<Record<RouteTier, CatalogModel[]>>;
  /** AA benchmark metrics keyed by `normalizeModelId`; omit for registry-only. */
  aaMetrics?: Map<string, AaModelMetrics>;
}

/**
 * Prepare the typesafe_evaluate request for tier classification.
 *
 * Builds one Choice question per tier (4 total).
 *
 * With `narrow: false` (default) every tier's criteria is the full candidate
 * list with spec-only descriptions — state and criteria hold identical data
 * because typesafe_evaluate expects state to hold the data being judged and
 * criteria to hold the options to choose from.
 *
 * With `narrow: true` each tier's criteria is cut to ≤ 8 plausible fits
 * (family/positioning naming), each description gains a short positioning
 * clause and an ordinal capability/cost rank, which sharpens the single Jev
 * pass.
 *
 * `perTierPools` overrides the pool for individual tiers (e.g. after applying
 * per-tier capability filters). Tiers without an entry fall back to the
 * narrow/full behavior above. The pool is capped at 8 entries like narrow.
 */
export function prepareClassifierRequest(
  models: CatalogModel[],
  opts: PrepareClassifierOptions = {},
) {
  const { narrow = false, perTierPools, aaMetrics } = opts;
  // Base descriptions: positioning clause when narrow, plain when not.
  const baseDescriptions = new Map<string, string>();
  for (const m of models) {
    baseDescriptions.set(
      slugify(`${m.provider}/${m.model}`),
      modelDescription(m, {
        positioning: narrow ? positioningClause(m) : undefined,
        metrics: aaMetrics?.get(normalizeModelId(m.model)) ?? null,
      }),
    );
  }
  const hasPricing = models.some(hasCost);
  const tiers: RouteTier[] = ["cheap", "fast", "balanced", "powerful"];

  // When narrow, each tier gets its own description variants with rank labels,
  // because the rank is per-tier (different pool per tier).
  // When not narrow, all tiers share the same descriptions.
  const state: Record<string, string> = Object.fromEntries(baseDescriptions);
  const questions: Record<string, any> = {};

  for (const tier of tiers) {
    let criteria: Record<string, string>;
    const explicitPool = perTierPools?.[tier];
    if (narrow || explicitPool) {
      const pool = (explicitPool ?? narrowPool(tier, models)).slice(0, 8);
      // All tiers rank by cost asc (cheapest first; rank 0 = cheapest).
      const ranked = isCostRanked(tier)
        ? [...pool].sort((a, b) => {
            const pa = hasCost(a) ? (a.costIn! + a.costOut!) : Infinity;
            const pb = hasCost(b) ? (b.costIn! + b.costOut!) : Infinity;
            return pa === pb ? a.maxOut - b.maxOut : pa - pb;
          })
        : [...pool].sort(byCapability);
      criteria = {};
      for (const [i, m] of ranked.entries()) {
        const key = slugify(`${m.provider}/${m.model}`);
        const base = baseDescriptions.get(key)!;
        criteria[key] = `${base} ${rankLabel(i, tier)}`;
        // Merge ranked description into state so all tiers' ranks are visible.
        state[key] = criteria[key];
      }
      // A tier with no eligible candidates gets no question: a Choice question
      // requires at least one criterion, and its callers treat a missing answer
      // as "unassigned".
      if (Object.keys(criteria).length === 0) continue;
    } else {
      criteria = state;
    }

    const rubric = TIER_RUBRIC[tier];
    const weighting = getTierWeighting(tier);
    const costClause = hasPricing
      ? ` Among the candidates that can still do the job, prefer the lowest per-token price. (weighting: intelligence=${weighting.intelligenceWeight}, speed=${weighting.speedWeight})`
      : "";
    questions[tier] = {
      type: "choice",
      instructions: `${TIER_INSTRUCTIONS[tier].replace("${RUBRIC}", rubric)}${costClause} Pick the single best-fitting model from the candidates.`,
      criteria,
    };
  }

  return { state, questions };
}

/**
 * Validate that every route references a well-formed `provider/modelId` that
 * exists in the model registry. Returns a list of human-readable errors
 * (empty when all routes are valid).
 */
export function validateRouteModels(
  routes: Record<string, { model?: string }>,
  findModel: (provider: string, modelId: string) => unknown,
): string[] {
  const errors: string[] = [];
  for (const [tier, route] of Object.entries(routes)) {
    const model = route?.model;
    if (typeof model !== "string") {
      errors.push(`Route '${tier}' is missing a model`);
      continue;
    }
    const slash = model.indexOf("/");
    if (slash <= 0 || slash === model.length - 1) {
      errors.push(`Route '${tier}' has malformed model '${model}' (expected 'provider/modelId')`);
      continue;
    }
    const provider = model.slice(0, slash);
    const modelId = model.slice(slash + 1);
    if (!findModel(provider, modelId)) {
      errors.push(`Route '${tier}' references unknown model '${model}'`);
    }
  }
  return errors;
}