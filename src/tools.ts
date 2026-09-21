/**
 * Tools for the model-tier-setup skill.
 *
 * Extracts manual work from the skill into reusable tools:
 * - smart-router-catalog: retrieves models, applies filters, prepares classifier input
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

const execFileAsync = promisify(execFile);

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
 * Build a short description for a model to use in the classifier state.
 * Includes per-million-token pricing when available, since cost is a real
 * tier signal (cheap/fast tiers are price-driven) and the listing command
 * does not expose it.
 */
export function modelDescription(m: CatalogModel, positioning?: string): string {
  const contextLabel = formatTokenCount(m.context);
  const maxOutLabel = formatTokenCount(m.maxOut);
  const prefix = positioning ? `${m.provider}/${m.model} — ${positioning} | ` : `${m.provider}/${m.model} | `;
  const cost = hasCost(m) ? `, $${formatMoney(m.costIn!)}/$${formatMoney(m.costOut!)} per M tokens` : "";
  return `${prefix}context ${contextLabel}, maxOut ${maxOutLabel}, thinking ${m.thinking ? "yes" : "no"}, images ${m.images ? "yes" : "no"}${cost}`;
}

/**
 * Family/positioning name hints per tier, used by the optional `narrow` mode to
 * cut each tier's candidate pool to the models plausibly suited to it (mirrors
 * the sharpening guidance in the model-tier-setup skill).
 */
const TIER_NAME_HINTS: Record<RouteTier, RegExp[]> = {
  cheap: [/flash/i, /mini/i, /haiku/i, /lite/i, /nano/i],
  fast: [/flash/i, /mini/i, /haiku/i, /air/i],
  balanced: [/plus/i, /sonnet/i, /\d+b/i],
  powerful: [/pro/i, /max/i, /opus/i, /ultra/i],
};

/** Short factual positioning clause derived from the model's family naming. */
function positioningClause(m: CatalogModel): string {
  if (/pro|max|opus|ultra/i.test(m.model)) return "flagship/reasoning tier of its family";
  if (/plus|sonnet/i.test(m.model)) return "mid-size tier of its family";
  if (/flash|mini|lite|nano|haiku|air/i.test(m.model)) return "lightweight, fast tier of its family";
  if (/thinking/i.test(m.model)) return "reasoning-focused variant";
  return "";
}

/** Capability order: thinking models first, then larger context, then larger output. */
function byCapability(a: CatalogModel, b: CatalogModel): number {
  return Number(b.thinking) - Number(a.thinking) || b.context - a.context || b.maxOut - a.maxOut;
}

/**
 * Narrow the full candidate list to at most 8 models plausibly suited to a tier:
 * name-hint matches first, then filled from the rest. For the low tiers the fill
 * is cheapest-first (blended $/M tokens, falling back to smallest output only
 * when a model has no price); for the high tiers it is strongest-capability-first.
 * `powerful` always keeps the most capable candidates this way.
 */
export function narrowPool(tier: RouteTier, models: CatalogModel[]): CatalogModel[] {
  const hints = TIER_NAME_HINTS[tier];
  const matched = models.filter((m) => hints.some((h) => h.test(m.model)));
  const rest = models.filter((m) => !matched.includes(m));
  const fill = tier === "cheap" || tier === "fast"
    ? [...rest].sort((a, b) => {
        const pa = hasCost(a) ? (a.costIn! + a.costOut!) : Infinity;
        const pb = hasCost(b) ? (b.costIn! + b.costOut!) : Infinity;
        return pa === pb ? a.maxOut - b.maxOut : pa - pb;
      })
    : [...rest].sort(byCapability);
  return [...matched, ...fill].slice(0, 8);
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
 * (family/positioning naming) and each description gains a short positioning
 * clause, which sharpens the first Jev pass so the skill's bounded re-run
 * rarely triggers.
 */
export function prepareClassifierRequest(models: CatalogModel[], narrow = false) {
  const descriptions = new Map<string, string>();
  for (const m of models) {
    descriptions.set(slugify(`${m.provider}/${m.model}`),
      narrow ? modelDescription(m, positioningClause(m)) : modelDescription(m));
  }
  const allDescriptions = Object.fromEntries(descriptions);
  const hasPricing = models.some(hasCost);

  const questions: Record<string, any> = {};
  const tiers: RouteTier[] = ["cheap", "fast", "balanced", "powerful"];

  for (const tier of tiers) {
    const criteria = narrow
      ? Object.fromEntries(narrowPool(tier, models).map((m) => [slugify(`${m.provider}/${m.model}`), descriptions.get(slugify(`${m.provider}/${m.model}`))!]))
      : allDescriptions;
    const costClause = hasPricing && (tier === "cheap" || tier === "fast")
      ? " This tier is cost-sensitive: among the candidates that can still do the job, prefer the lowest per-token price."
      : "";
    questions[tier] = {
      type: "choice",
      instructions: `Which model best fits the "${tier}" tier? ${TIER_RUBRIC[tier]}. Pick the single best-fitting model from the candidates.${costClause}`,
      criteria,
    };
  }

  return { state: allDescriptions, questions };
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
      emoji: { type: "string" },
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
            "With prepareClassifier: cut each tier's candidate pool to ≤ 8 plausible fits (family/positioning naming) and add positioning clauses to the descriptions. Sharpens the first Jev pass so a re-run rarely triggers. Default false (full pool, spec-only descriptions).",
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
      const allModels: CatalogModel[] = [];
      for (const provider of providers) {
        const { stdout } = await execFileAsync(
          "pi",
          ["--list-models", provider],
          { encoding: "utf-8", timeout: 15000, signal },
        );
        const models = parseModelsTable(stdout);
        allModels.push(...models);
      }

      // Attach per-million-token pricing from the same model registry the router
      // resolves routes against. pi --list-models exposes no price column, and
      // cost is the real cheap/fast tier signal — without it the classifier can
      // only guess. Lookups that fail (e.g. a name the registry doesn't know) are
      // left without cost rather than dropping the model.
      const registry = ctx?.modelRegistry;
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
        result.classifierRequest = prepareClassifierRequest(filtered, narrow === true);
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
        routes: Record<string, { model: string; reasoning?: string; emoji?: string }>;
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
}
