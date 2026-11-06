/**
 * Tools for the model-tier-setup skill.
 *
 * Extracts manual work from the skill into reusable tools:
 * - smart-router-catalog: retrieves models, applies filters, prepares classifier input
 * - smart-router-setup-tiers: end-to-end tier classification (per-tier filters, one Jev
 *   pass, deterministic collision resolution) — proposes routes, does not write config
 * - smart-router-update-routes: updates the config file with validation
 *
 * Catalog parsing / description / classifier-request helpers live in
 * `catalog.ts`; tier filters and Jev classification live in
 * `tier-classification.ts`. This module owns tool registration and the
 * per-provider orchestration that ties those layers together.
 */

import { accessSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { RouteTier } from "./types.js";
import { validateConfig } from "./config.js";
import { jevTierClassification, resolveCollisions, applyTierFilters, type JevTierAssignment, type TierFilters, TIERS } from "./tier-classification.js";
import { getAaBenchmarks, buildAaMetricsMap, normalizeModelId, type AaModelMetrics } from "./aa-client.js";
import { computeTaskCost } from "./aa-enrichment.js";
import { fetchCatalogModels, deduplicateModels, prepareClassifierRequest, slugify, hasCost, validateRouteModels, type CatalogModel } from "./catalog.js";

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

/** Canonical route name for each tier. */
const ROUTE_NAMES: Record<RouteTier, string> = {
  cheap: "cheap-code",
  fast: "fast",
  balanced: "balanced",
  powerful: "powerful",
};

/** One tier's proposed route plus the diagnostics behind the pick. */
interface TierAssignment {
  tier: RouteTier;
  route: string;
  model: string | null;
  confidence: number;
  collisionResolved: boolean;
}

/** A provider's resolved pick for one tier, before cross-provider winner selection. */
interface ProviderPick {
  provider: string;
  tier: RouteTier;
  model: CatalogModel | undefined;
  confidence: number;
  collisionResolved: boolean;
}

/** Inputs shared by every per-provider classification pass. */
interface ProviderClassificationOptions {
  excludeModels?: string[];
  tierOverrides?: Partial<Record<RouteTier, Partial<TierFilters>>>;
  narrow?: boolean;
  aaMetrics: Map<string, AaModelMetrics>;
  signal?: AbortSignal;
  modelRegistry?: { find(provider: string, modelId: string): unknown };
}

/** Format a resolved pick as a route assignment (`model` null when unassigned). */
function toTierAssignment(pick: {
  tier: RouteTier;
  model: CatalogModel | undefined;
  confidence: number;
  collisionResolved: boolean;
}): TierAssignment {
  return {
    tier: pick.tier,
    route: ROUTE_NAMES[pick.tier],
    model: pick.model ? `${pick.model.provider}/${pick.model.model}` : null,
    confidence: pick.confidence,
    collisionResolved: pick.collisionResolved,
  };
}

/**
 * Classify one provider's catalog into the four tiers.
 *
 * Returns the provider's route-shaped assignments plus the raw picks used for
 * cross-provider winner selection, or `null` when the provider has no models
 * left after exclusions. Warnings are appended to the caller-supplied list.
 */
async function classifyProvider(
  provider: string,
  options: ProviderClassificationOptions,
  warnings: string[],
): Promise<{ assignments: TierAssignment[]; picks: ProviderPick[] } | null> {
  const { excludeModels, tierOverrides, narrow, aaMetrics, signal, modelRegistry } = options;

  let models = await fetchCatalogModels([provider], signal, modelRegistry);
  if (excludeModels && excludeModels.length > 0) {
    const excludeSet = new Set(excludeModels.map((id) => id.toLowerCase()));
    models = models.filter((m) => !excludeSet.has(m.model.toLowerCase()));
  }
  models = deduplicateModels(models);

  if (models.length === 0) {
    warnings.push(`provider '${provider}': no models available after filters/exclusions`);
    return null;
  }

  // Per-tier capability filter pools.
  const tierPools = {} as Record<RouteTier, CatalogModel[]>;
  for (const tier of TIERS) {
    const pool = applyTierFilters(tier, models, tierOverrides?.[tier], aaMetrics);
    tierPools[tier] = pool;
    if (pool.length === 0) {
      warnings.push(
        `provider '${provider}' tier '${tier}': no candidate passes capability filters`,
      );
    }
  }

  const jev = await jevTierClassification(models, {
    narrow: narrow !== false,
    tierPools,
    aaMetrics,
  });
  const allPoolModels = [...new Set(TIERS.flatMap((t) => tierPools[t]))];
  const resolved = resolveCollisions(jev.assignments, allPoolModels, tierPools);
  resolved.balanced = rehomeBalancedFromRunnerUpPool(
    jev.assignments.balanced,
    resolved,
    tierPools,
    aaMetrics,
  );

  const picks = TIERS.map((tier): ProviderPick => {
    const pick = resolved[tier];
    return {
      provider,
      tier,
      model: pick.model,
      confidence: pick.confidence,
      collisionResolved: pick.model !== jev.assignments[tier].model,
    };
  });

  return { assignments: picks.map(toTierAssignment), picks };
}

/**
 * Pick the max-confidence provider per tier and build the ready-to-write
 * route table.
 *
 * Sort by Jev confidence descending only — `Array.prototype.sort` is stable
 * (ES2019), so providers declared earlier in the `providers[]` array win ties.
 * Reorder `providers` to change the tiebreak; there's no implicit preference
 * (no cost, alphabetical, or hash fallback).
 *
 * Only candidates with a real (non-null) pick compete for a route — a null
 * pick means the tier lost its only candidate to a collision, so it can't
 * produce one. When nobody fields a real pick, the first null pick is surfaced
 * so the tier's `collisionResolved` signal still reaches the caller.
 */
function selectTierWinners(perTier: Record<RouteTier, ProviderPick[]>): {
  routes: Record<string, { model: string; reasoning: string }>;
  assignments: TierAssignment[];
} {
  const routes: Record<string, { model: string; reasoning: string }> = {};
  const assignments = TIERS.map((tier): TierAssignment => {
    const picks = perTier[tier];
    const withModel = picks
      .filter((p): p is ProviderPick & { model: CatalogModel } => p.model !== undefined)
      .sort((x, y) => y.confidence - x.confidence);

    if (withModel.length === 0) {
      const empty = picks[0];
      return empty
        ? toTierAssignment(empty)
        : toTierAssignment({
            tier,
            model: undefined,
            confidence: 0,
            collisionResolved: false,
          });
    }

    const winner = withModel[0];
    routes[ROUTE_NAMES[tier]] = {
      model: `${winner.model.provider}/${winner.model.model}`,
      reasoning: winner.model.thinking ? (tier === "powerful" ? "high" : "low") : "preserve",
    };
    return toTierAssignment(winner);
  });

  return { routes, assignments };
}

/**
 * Per-provider tier classification + winner selection.
 *
 * Classify each provider's catalog separately and pick the highest-confidence
 * winner per tier; ties resolve to the provider listed earlier in the caller's
 * `providers[]` array (stable sort — no implicit alphabetical or cost-based
 * fallback). Returns:
 *
 * - `routes`: ready-to-write route table keyed by route name, derived from the
 *   per-tier winners.
 * - `assignments`: flat winner list, one entry per tier (max confidence; same
 *   shape as the original combined-pool response).
 * - `perProviderResults`: the side-by-side table — one block per provider with
 *   its per-tier picks (`undefined` when `providers.length === 1` to avoid
 *   redundant output for the single-provider case).
 * - `warnings`: aggregated per-provider warnings.
 *
 * Single-provider behavior is identical to the original combined-pool path:
 * one Jev call, one set of per-tier pools, winner selection is trivial.
 */
async function setupTiersMultiProvider(
  providers: string[],
  excludeModels: string[] | undefined,
  tierOverrides: Partial<Record<RouteTier, Partial<TierFilters>>> | undefined,
  narrow: boolean | undefined,
  aaMetrics: Map<string, AaModelMetrics>,
  signal: AbortSignal | undefined,
  ctx: { modelRegistry?: { find(provider: string, modelId: string): unknown } } | undefined,
): Promise<{
  routes: Record<string, { model: string; reasoning: string }>;
  warnings: string[];
  assignments: TierAssignment[];
  perProviderResults?: Array<{ provider: string; assignments: TierAssignment[] }>;
}> {
  const options: ProviderClassificationOptions = {
    excludeModels,
    tierOverrides,
    narrow,
    aaMetrics,
    signal,
    modelRegistry: ctx?.modelRegistry,
  };
  const warnings: string[] = [];
  const perProviderResults: Array<{ provider: string; assignments: TierAssignment[] }> = [];
  const perTier: Record<RouteTier, ProviderPick[]> = {
    cheap: [],
    fast: [],
    balanced: [],
    powerful: [],
  };

  for (const provider of providers) {
    const classified = await classifyProvider(provider, options, warnings);
    if (!classified) continue;
    perProviderResults.push({ provider, assignments: classified.assignments });
    for (const pick of classified.picks) perTier[pick.tier].push(pick);
  }

  if (perProviderResults.length === 0) {
    throw new Error(`No models found for provider(s): ${providers.join(", ")}`);
  }

  const { routes, assignments } = selectTierWinners(perTier);

  return {
    routes,
    warnings,
    assignments,
    perProviderResults: providers.length > 1 ? perProviderResults : undefined,
  };
}

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
      "Classifies the Pi model catalog into the four smart-router tiers in one call. Single-provider path: fetch its catalog, apply per-tier capability filters (the fast tier also requires measured AA latency when AA data is available), ask TypeSafe Jev (one choice question per tier, single request), resolve duplicate picks deterministically inside each tier's pool, re-home a collision-displaced balanced pick from eligible fast/powerful runner-ups. Multi-provider path: classify each provider's catalog independently in its own Jev call, then pick the highest-confidence winner per tier (callers' `providers[]` order as tiebreak — first-listed provider wins when confidences match); all providers' results are returned in `perProviderResults` so the caller can see which provider won each tier. Either way, returns a proposed assignment with ready-to-write routes. Does NOT write the config — pass the returned routes to smart-router-update-routes after user approval. Takes Jev's first response as-is; low confidence is surfaced as a warning, never re-run.",
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

      // AA benchmark enrichment (fetched before per-provider classification so
      // the fast tier can use measured latency). Never throws; registry-only on failure.
      const warnings: string[] = [];
      const benchmarks = await getAaBenchmarks();
      if (process.env.AA_API_KEY && !benchmarks) {
        warnings.push("AA benchmark data unavailable; classification used registry data only");
      }
      const aaMetrics = buildAaMetricsMap(benchmarks);

      // Per-provider classification + winner selection. Single-provider and
      // multi-provider paths share the same helper; perProviderResults is
      // only attached to the response when more than one provider was passed.
      const { routes, warnings: provWarnings, assignments, perProviderResults } =
        await setupTiersMultiProvider(
          providers,
          excludeModels,
          tierOverrides,
          narrow,
          aaMetrics,
          signal,
          ctx,
        );
      warnings.push(...provWarnings);

      // Surface low-confidence winners; report unfilled tiers.
      for (const a of assignments) {
        if (a.model && a.confidence < 0.6) {
          warnings.push(
            `tier '${a.tier}': low Jev confidence (${a.confidence.toFixed(2)}) — review before applying`,
          );
        }
      }
      const unassigned = assignments.filter((a) => !a.model).map((a) => a.tier);
      if (unassigned.length > 0) {
        warnings.push(`unfilled tiers: ${unassigned.join(", ")} (not included in routes)`);
      }

      const result = { assignments, routes, warnings, perProviderResults };
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