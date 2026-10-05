/**
 * Tools for the model-tier-setup skill.
 *
 * Extracts manual work from the skill into reusable tools:
 * - smart-router-catalog: retrieves models, applies filters, prepares classifier input
 * - smart-router-setup-tiers: end-to-end tier classification (per-tier filters, one Jev
 *   pass, deterministic collision resolution) — proposes routes, does not write config
 * - smart-router-update-routes: updates the config file with validation
 */

import { execFile } from "node:child_process";
import { accessSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { TIER_RUBRIC, type RouteTier } from "./types.js";
import { validateConfig } from "./config.js";
import { jevTierClassification, resolveCollisions, applyTierFilters, type JevTierAssignment, type TierFilters, TIERS } from "./tier-classification.js";
import { getAaBenchmarks, buildAaMetricsMap, normalizeModelId, type AaModelMetrics } from "./aa-client.js";
import { augmentModelDescription, getTierWeighting, computeTaskCost } from "./aa-enrichment.js";

const execFileAsync = promisify(execFile);

/**
 * Shared fetch: list models for the given providers (exec `pi --list-models`),
 * attach per-million-token pricing from the model registry, and return parsed
 * catalog entries. Used by both smart-router-catalog and smart-router-setup-tiers.
 */
async function fetchCatalogModels(
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
function hasCost(m: CatalogModel): boolean {
  return m.costIn != null && m.costOut != null;
}

/**
 * Deduplicate models across providers: when multiple providers offer the same
 * model ID, keep only the cheapest entry (by blended input+output cost).
 * Models without pricing retain their entry as-is (first encountered wins).
 */
function deduplicateModels(models: CatalogModel[]): CatalogModel[] {
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
/** "provider/model" slug for an assignment's pick, or null when unassigned. */
function assignmentSlug(assignment: JevTierAssignment): string | null {
  return assignment.model ? slugify(`${assignment.model.provider}/${assignment.model.model}`) : null;
}

/** Same for a bare candidate — used when building lookup sets. */
function modelSlug(model: CatalogModel): string {
  return slugify(`${model.provider}/${model.model}`);
}

/**
 * Re-home a collision-displaced balanced pick from the fast/powerful runner-up
 * pool. Candidates must also pass balanced's own filters and must not be held by
 * cheap, fast, or powerful. No AA data or no eligible runner-ups leaves the
 * existing collision result unchanged.
 */
export function rehomeBalancedFromRunnerUpPool(
  initialBalanced: JevTierAssignment,
  resolved: Record<RouteTier, JevTierAssignment>,
  tierPools: Partial<Record<RouteTier, CatalogModel[]>>,
  aaMetrics?: Map<string, AaModelMetrics>,
): JevTierAssignment {
  const initialSlug = assignmentSlug(initialBalanced);
  const resolvedBalanced = resolved.balanced;
  const resolvedSlug = assignmentSlug(resolvedBalanced);

  // Preserve existing behavior unless Jev's balanced pick was actually displaced.
  if (!initialSlug || initialSlug === resolvedSlug || !aaMetrics?.size) return resolvedBalanced;

  const balancedEligible = new Set(
    (tierPools.balanced ?? []).map(modelSlug),
  );
  // Other tiers' resolved picks — the re-homed model must not be a held model.
  const claimed = new Set<string>();
  for (const [tier, assignment] of Object.entries(resolved)) {
    if (tier !== "balanced" && assignment.model) claimed.add(assignmentSlug(assignment)!);
  }
  const runnerUps = new Map<string, CatalogModel>();
  for (const model of [...(tierPools.fast ?? []), ...(tierPools.powerful ?? [])]) {
    const slug = modelSlug(model);
    if (balancedEligible.has(slug) && !claimed.has(slug)) runnerUps.set(slug, model);
  }

  const taskCost = (model: CatalogModel): number => {
    const price = hasCost(model) ? model.costIn! + model.costOut! : Infinity;
    const metrics = aaMetrics.get(normalizeModelId(model.model));
    return computeTaskCost(price, metrics ?? null) ?? Infinity;
  };
  const speed = (model: CatalogModel): number =>
    aaMetrics.get(normalizeModelId(model.model))?.speedTokensPerSec ?? 0;
  // Sort entries so the runner-up's slug travels with it; rank 0 is best.
  const ranked = [...runnerUps.entries()].sort(([, a], [, b]) => {
    const costA = taskCost(a);
    const costB = taskCost(b);
    if (costA !== costB) return costA - costB;
    return speed(b) - speed(a);
  });
  const [bestSlug, best] = ranked[0] ?? [];
  if (!best) return resolvedBalanced;

  return {
    ...resolvedBalanced,
    model: best,
    // The re-home changes candidate choice, not Jev's confidence estimate.
    // Jev may never have scored this model (criteria are capped at 8), so inherit
    // the collision-outcome confidence rather than emitting a misleading 0.
    confidence: initialBalanced.probabilities[bestSlug!] ?? resolvedBalanced.confidence,
  };
}

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

/**
 * Check if a project config exists and return a warning message if it does.
 */
function checkProjectConfig(cwd: string): string | undefined {
  const projectConfigPath = join(cwd, ".pi", "pi-smart-router.json");
  try {
    accessSync(projectConfigPath);
    return `A project config exists at ${projectConfigPath} and shadows the global config in trusted projects; update it too for this project to pick up the change.`;
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
    return undefined;
  }
}

/**
 * Load the global config from disk, or create a clean config from the bundled example.
 */
function loadConfig(configPath: string): any {
  try {
    const raw = readFileSync(configPath, "utf-8");
    return JSON.parse(raw);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
    // Config doesn't exist; start from the bundled example
    const examplePath = fileURLToPath(new URL("../examples/pi-smart-router.json", import.meta.url));
    const exampleRaw = readFileSync(examplePath, "utf-8");
    const example = JSON.parse(exampleRaw);

    // Strip $comment keys and placeholder routes
    const cleanConfig: any = {
      version: example.version || 1,
      defaultRoute: example.defaultRoute || "balanced",
      routes: {},
      classifier: example.classifier || {},
      rules: example.rules || [],
      fallbacks: example.fallbacks || ["fast", "cheap-code"],
    };

    // Copy non-comment keys from example routes
    for (const [key, value] of Object.entries(example.routes || {})) {
      if (!key.startsWith("$")) {
        cleanConfig.routes[key] = value;
      }
    }

    return cleanConfig;
  }
}

/**
 * Register the smart-router tools.
 */
export function registerTools(pi: ExtensionAPI): void {
  // Shared schema for route definitions (all four tiers have the same structure)
  const routeSchema = {
    type: "object",
    properties: {
      model: { type: "string", description: "Provider/model ID (e.g. 'hyper/glm-5.3-flash')" },
      reasoning: { type: "string", enum: ["preserve", "off", "low", "medium", "high"] },
    },
    required: ["model"],
  };

  // Tool 1: smart-router-catalog
  pi.registerTool({
    name: "smart-router-catalog",
    label: "Smart Router Catalog",
    description:
      "Retrieves models from the Pi registry for the given provider(s), applies filters, and optionally prepares the classifier input for typesafe_evaluate. Use this instead of manually running `pi --list-models` and parsing the output.",
    promptSnippet: "Retrieve and filter models from the Pi registry",
    parameters: {
      type: "object",
      properties: {
        providers: {
          type: "array",
          items: { type: "string" },
          description: "Provider name(s) to query (e.g. ['hyper', 'opencode-go'])",
        },
        minContext: {
          type: "number",
          description: "Minimum context window in tokens (e.g. 1000000 for 1M)",
        },
        excludeModels: {
          type: "array",
          items: { type: "string" },
          description: "Model IDs to exclude (exact match, lowercase)",
        },
        prepareClassifier: {
          type: "boolean",
          description: "If true, also prepare the state and questions for typesafe_evaluate",
        },
        narrow: {
          type: "boolean",
          description:
            "With prepareClassifier: cut each tier's candidate pool to ≤ 8 plausible fits (family/positioning naming) and add positioning clauses to the descriptions. Sharpens the single Jev pass. Default false (full pool, spec-only descriptions).",
        },
      },
      required: ["providers"],
    },
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { providers, minContext, excludeModels, prepareClassifier, narrow } = params as {
        providers: string[];
        minContext?: number;
        excludeModels?: string[];
        prepareClassifier?: boolean;
        narrow?: boolean;
      };

      // Query each provider (async with timeout to avoid blocking the event loop)
      const allModels = await fetchCatalogModels(providers, signal, ctx?.modelRegistry);

      // Apply filters
      let filtered = allModels;
      if (minContext !== undefined) {
        filtered = filtered.filter((m) => m.context >= minContext);
      }
      if (excludeModels && excludeModels.length > 0) {
        const excludeSet = new Set(excludeModels.map((id) => id.toLowerCase()));
        filtered = filtered.filter((m) => !excludeSet.has(m.model.toLowerCase()));
      }

      const result: any = {
        models: filtered,
        count: filtered.length,
      };

      if (prepareClassifier && filtered.length > 0) {
        result.classifierRequest = prepareClassifierRequest(filtered, { narrow: narrow === true });
      }

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
    renderCall(args) {
      const providers = (args.providers as string[])?.join(", ") || "?";
      return new Text(`Smart Router Catalog · providers: ${providers}`, 0, 0);
    },
    renderResult(result, { isPartial }) {
      if (isPartial) return new Text("Smart Router Catalog · loading…", 0, 0);
      const count = (result.details as any)?.count ?? 0;
      return new Text(`Smart Router Catalog · ${count} model${count === 1 ? "" : "s"}`, 0, 0);
    },
  });

  // Tool 2: smart-router-update-routes
  pi.registerTool({
    name: "smart-router-update-routes",
    label: "Smart Router Update Routes",
    description:
      "Updates the routes section of the global pi-smart-router config (~/.pi/agent/pi-smart-router.json) with the given tier assignments. Preserves all other config (version, defaultRoute, classifier, rules, fallbacks, observability). Validates the result before writing.",
    promptSnippet: "Update the smart-router config with new tier assignments",
    parameters: {
      type: "object",
      properties: {
        routes: {
          type: "object",
          description: "Route assignments for the four tiers",
          properties: {
            "cheap-code": routeSchema,
            fast: routeSchema,
            balanced: routeSchema,
            powerful: routeSchema,
          },
          required: ["cheap-code", "fast", "balanced", "powerful"],
        },
      },
      required: ["routes"],
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const { routes } = params as {
        routes: Record<string, { model: string; reasoning?: string }>;
      };

      // Reject unknown or malformed models before touching the config
      const modelErrors = validateRouteModels(routes, (provider, modelId) =>
        ctx.modelRegistry.find(provider, modelId),
      );
      if (modelErrors.length > 0) {
        throw new Error(`Refusing to write config: ${modelErrors.join("; ")}`);
      }

      const configPath = join(homedir(), ".pi", "agent", "pi-smart-router.json");
      const projectConfigWarning = checkProjectConfig(ctx.cwd);
      const config = loadConfig(configPath);

      // Replace only the routes section
      config.routes = routes;

      // Validate the config through the canonical validator
      validateConfig(config, "smart-router-update-routes tool");

      // Write the config
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Updated ${configPath} with ${Object.keys(routes).length} routes.` +
              (projectConfigWarning ? ` Warning: ${projectConfigWarning}` : ""),
          },
        ],
        details: { configPath, routes: Object.keys(routes), warning: projectConfigWarning },
      };
    },
    renderCall(args) {
      const routeCount = Object.keys((args.routes as any) || {}).length;
      return new Text(`Smart Router Update Routes · ${routeCount} route${routeCount === 1 ? "" : "s"}`, 0, 0);
    },
    renderResult(result, { isPartial }) {
      if (isPartial) return new Text("Smart Router Update Routes · updating…", 0, 0);
      return new Text("Smart Router Update Routes · config updated", 0, 0);
    },
  });

  // Tool 3: smart-router-setup-tiers — end-to-end tier classification.
  pi.registerTool({
    name: "smart-router-setup-tiers",
    label: "Smart Router Setup Tiers",
    description:
      "Classifies the Pi model catalog into the four smart-router tiers in one call: fetches models, applies per-tier capability filters (the fast tier also requires measured AA latency when AA data is available), asks TypeSafe Jev (one choice question per tier, single request), resolves duplicate picks deterministically inside each tier's pool, re-homes a collision-displaced balanced pick from eligible fast/powerful runner-ups, and returns a proposed assignment with ready-to-write routes. Does NOT write the config — pass the returned routes to smart-router-update-routes after user approval. Takes Jev's first response as-is; low confidence is surfaced as a warning, never re-run.",
    promptSnippet: "Classify models into tiers with Jev and propose routes",
    parameters: {
      type: "object",
      properties: {
        providers: {
          type: "array",
          items: { type: "string" },
          description: "Provider name(s) to classify (e.g. ['hyper', 'opencode-go'])",
        },
        excludeModels: {
          type: "array",
          items: { type: "string" },
          description: "Model IDs to exclude before classification (exact match, lowercase)",
        },
        tierOverrides: {
          type: "object",
          description:
            "Per-tier filter overrides merged on top of defaults. Each key is a tier (cheap, fast, balanced, powerful); each value may set minContext (tokens), requireThinking (bool), requireImages (bool). Omit to use defaults: cheap 128k, fast 100k, balanced 200k+images, powerful 500k+thinking.",
          properties: {
            cheap: {
              type: "object",
              description: "Partial TierFilters for cheap",
              properties: {
                minContext: { type: "number", description: "Minimum context window in tokens" },
                requireThinking: { type: "boolean", description: "Only thinking models eligible" },
                requireImages: { type: "boolean", description: "Only image-capable models eligible" },
                requireLatencyData: { type: "boolean", description: "Only models with measured AA latency (fast tier default)" },
              },
            },
            fast: {
              type: "object",
              description: "Partial TierFilters for fast",
              properties: {
                minContext: { type: "number", description: "Minimum context window in tokens" },
                requireThinking: { type: "boolean", description: "Only thinking models eligible" },
                requireImages: { type: "boolean", description: "Only image-capable models eligible" },
                requireLatencyData: { type: "boolean", description: "Only models with measured AA latency (fast tier default)" },
              },
            },
            balanced: {
              type: "object",
              description: "Partial TierFilters for balanced",
              properties: {
                minContext: { type: "number", description: "Minimum context window in tokens" },
                requireThinking: { type: "boolean", description: "Only thinking models eligible" },
                requireImages: { type: "boolean", description: "Only image-capable models eligible" },
                requireLatencyData: { type: "boolean", description: "Only models with measured AA latency (fast tier default)" },
              },
            },
            powerful: {
              type: "object",
              description: "Partial TierFilters for powerful",
              properties: {
                minContext: { type: "number", description: "Minimum context window in tokens" },
                requireThinking: { type: "boolean", description: "Only thinking models eligible" },
                requireImages: { type: "boolean", description: "Only image-capable models eligible" },
                requireLatencyData: { type: "boolean", description: "Only models with measured AA latency (fast tier default)" },
              },
            },
          },
        },
        narrow: {
          type: "boolean",
          description: "Cap each filtered tier pool at 8 candidates with positioning clauses. Default true.",
        },
      },
      required: ["providers"],
    },
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { providers, excludeModels, tierOverrides, narrow } = params as {
        providers: string[];
        excludeModels?: string[];
        tierOverrides?: Partial<Record<RouteTier, Partial<TierFilters>>>;
        narrow?: boolean;
      };

      // 1. Fetch catalog and drop excluded models.
      let models = await fetchCatalogModels(providers, signal, ctx?.modelRegistry);
      if (excludeModels && excludeModels.length > 0) {
        const excludeSet = new Set(excludeModels.map((id) => id.toLowerCase()));
        models = models.filter((m) => !excludeSet.has(m.model.toLowerCase()));
      }

      // Deduplicate cross-provider: when multiple providers offer the same
      // model ID (e.g. hyper/deepseek-v4-pro and opencode-go/deepseek-v4-pro),
      // keep the cheapest entry so Jev doesn't pick a marked-up version.
      models = deduplicateModels(models);

      const warnings: string[] = [];
      if (models.length === 0) {
        throw new Error(`No models found for provider(s): ${providers.join(", ")}`);
      }

      // 2. Optional AA benchmark enrichment (never throws; registry-only on failure).
      // Fetched before per-tier filtering so tiers can use measured latency.
      const benchmarks = await getAaBenchmarks();
      if (process.env.AA_API_KEY && !benchmarks) {
        warnings.push("AA benchmark data unavailable; classification used registry data only");
      }
      const aaMetrics = buildAaMetricsMap(benchmarks);

      // 3. Per-tier capability pools (the fast tier also drops latency-blind
      // models when AA data is available; see defaultTierFilters).
      const tierPools = {} as Record<RouteTier, CatalogModel[]>;
      for (const tier of TIERS) {
        const pool = applyTierFilters(tier, models, tierOverrides?.[tier], aaMetrics);
        tierPools[tier] = pool;
        if (pool.length === 0) {
          warnings.push(
            `tier '${tier}': no model passes its capability filters; relax via tierOverrides`,
          );
        }
      }
      // 4. Single Jev pass + deterministic collision resolution.
      const jev = await jevTierClassification(models, {
        narrow: narrow !== false,
        tierPools,
        aaMetrics,
      });
      const allPoolModels = [...new Set(TIERS.flatMap((t) => tierPools[t]))];
      // Always pass tierPools: a tier's collision fallback must respect its own
      // filter pool (e.g. the latency-gated fast tier) regardless of AA.
      const resolved = resolveCollisions(jev.assignments, allPoolModels, tierPools);
      resolved.balanced = rehomeBalancedFromRunnerUpPool(
        jev.assignments.balanced,
        resolved,
        tierPools,
        aaMetrics,
      );

      // 5. Build the proposed table and update-routes payload.
      const ROUTE_NAMES: Record<RouteTier, string> = {
        cheap: "cheap-code",
        fast: "fast",
        balanced: "balanced",
        powerful: "powerful",
      };
      const assignments = TIERS.map((tier) => {
        const pick = resolved[tier];
        return {
          tier,
          route: ROUTE_NAMES[tier],
          model: pick.model ? `${pick.model.provider}/${pick.model.model}` : null,
          confidence: pick.confidence,
          collisionResolved:
            pick.model !== jev.assignments[tier].model,
        };
      });
      for (const a of assignments) {
        if (a.confidence < 0.6) {
          warnings.push(`tier '${a.tier}': low Jev confidence (${a.confidence.toFixed(2)}) — review before applying`);
        }
      }
      const unassigned = assignments.filter((a) => !a.model).map((a) => a.tier);
      if (unassigned.length > 0) {
        warnings.push(`unfilled tiers: ${unassigned.join(", ")} (not included in routes)`);
      }

      const routes: Record<string, { model: string; reasoning: string }> = {};
      for (const tier of TIERS) {
        const pick = resolved[tier];
        if (!pick.model) continue;
        const routeName = ROUTE_NAMES[tier];
        const reasoning = pick.model.thinking ? (tier === "powerful" ? "high" : "low") : "preserve";
        routes[routeName] = {
          model: `${pick.model.provider}/${pick.model.model}`,
          reasoning,
        };
      }

      const result = { assignments, routes, warnings };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
    renderCall(args) {
      const providers = (args.providers as string[])?.join(", ") || "?";
      return new Text(`Smart Router Setup Tiers · providers: ${providers}`, 0, 0);
    },
    renderResult(result, { isPartial }) {
      if (isPartial) return new Text("Smart Router Setup Tiers · classifying…", 0, 0);
      const d = result.details as any;
      const n = d?.routes ? Object.keys(d.routes).length : 0;
      return new Text(`Smart Router Setup Tiers · ${n} route${n === 1 ? "" : "s"} proposed`, 0, 0);
    },
  });
}
