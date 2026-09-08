/**
 * Configuration loading and validation for the Smart Router.
 *
 * Two-file layout:
 * - Backend models/providers stay in pi's standard models.json
 *   (~/.pi/agent/models.json or <project>/.pi/models.json) - NOT handled here.
 * - Routing config lives in ~/.pi/agent/smart-router.json (global) or
 *   <project>/.pi/smart-router.json (project, only when the project is trusted).
 *
 * Precedence: project config (if trusted and present) > global config >
 * built-in defaults. A present config file replaces the lower-priority one
 * entirely (no deep merge) so behavior stays deterministic.
 *
 * Missing files are not an error (defaults are used). Malformed JSON,
 * schema violations, and semantic errors (unknown route references,
 * duplicate rule ids, malformed model refs) throw loudly.
 */

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { RouterError } from "./types.js";
import { BUILTIN_DEFAULTS, DEFAULT_ESCALATION_CONFIG, SMART_ROUTER_CONFIG_VERSION } from "./types.js";
import type { SmartRouterConfig } from "./types.js";

// ============================================================================
// Zod schema
// ============================================================================

const modelRefSchema = z
  .string()
  .min(1)
  .refine((v) => v.includes("/"), { message: "model reference must be in 'provider/modelId' format" });

const routeConfigSchema = z.object({
  model: modelRefSchema,
  reasoning: z.enum(["preserve", "off", "low", "medium", "high"]).optional(),
  maxTokens: z.number().int().positive().optional(),
});

const classifierSchema = z.object({
  weights: z
    .object({
      promptTokens: z.number().min(0).max(1).optional(),
      contextTokens: z.number().min(0).max(1).optional(),
      codeLikelihood: z.number().min(0).max(1).optional(),
      reasoningLikelihood: z.number().min(0).max(1).optional(),
      keywordSignal: z.number().min(0).max(1).optional(),
      toolSignal: z.number().min(0).max(1).optional(),
      imageSignal: z.number().min(0).max(1).optional(),
    })
    .optional(),
  thresholds: z
    .object({
      cheapMax: z.number().min(0).max(1).optional(),
      simpleMax: z.number().min(0).max(1).optional(),
      mediumMax: z.number().min(0).max(1).optional(),
    })
    .optional(),
  maxPromptTokens: z.number().int().positive().optional(),
  maxContextTokens: z.number().int().positive().optional(),
});

const routingRuleSchema = z.object({
  id: z.string().min(1),
  priority: z.number().optional(),
  match: z
    .object({
      anyKeywords: z.array(z.string().min(1)).optional(),
      allKeywords: z.array(z.string().min(1)).optional(),
      minPromptTokens: z.number().int().nonnegative().optional(),
      minComplexity: z.number().min(0).max(1).optional(),
      code: z.boolean().optional(),
      reasoningRequired: z.boolean().optional(),
      hasTools: z.boolean().optional(),
      hasImages: z.boolean().optional(),
    })
    .optional(),
  route: z.string().min(1),
});

const escalationSchema = z.object({
  enabled: z.boolean().optional(),
  minScore: z.number().min(0).max(1).optional(),
  maxScore: z.number().min(0).max(1).optional(),
  model: modelRefSchema.optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const smartRouterConfigSchema = z.object({
  version: z.number().int().positive(),
  defaultRoute: z.string().min(1),
  routes: z.record(z.string(), routeConfigSchema),
  classifier: classifierSchema.optional(),
  escalation: escalationSchema.optional(),
  rules: z.array(routingRuleSchema).optional(),
  fallbacks: z.array(z.string().min(1)).optional(),
  observability: z
    .object({
      showRouteStatus: z.boolean().optional(),
      logDecisions: z.boolean().optional(),
    })
    .optional(),
});

/** Raw parsed + schema-validated config before semantic validation. */
export type RawSmartRouterConfig = z.infer<typeof smartRouterConfigSchema>;

// ============================================================================
// Path helpers
// ============================================================================

/** Global routing config path: ~/.pi/agent/smart-router.json */
export function getGlobalConfigPath(): string {
  return path.join(os.homedir(), ".pi", "agent", "smart-router.json");
}

/** Project routing config path: <cwd>/.pi/smart-router.json */
export function getProjectConfigPath(cwd: string): string {
  return path.join(cwd, ".pi", "smart-router.json");
}

// ============================================================================
// Parsing + validation
// ============================================================================

/** Validate the config against the schema and semantic rules. Throws RouterError. */
export function validateConfig(raw: unknown, source: string): SmartRouterConfig {
  const parsed = smartRouterConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    throw new RouterError("CONFIG_INVALID", `Invalid smart-router config (${source}): ${issues}`);
  }
  const config = parsed.data as unknown as SmartRouterConfig;

  // Semantic validation - fail loudly.
  if (!config.routes[config.defaultRoute]) {
    throw new RouterError(
      "CONFIG_INVALID",
      `Invalid smart-router config (${source}): defaultRoute '${config.defaultRoute}' does not exist in routes (${Object.keys(config.routes).join(", ")})`,
    );
  }

  for (const [name, route] of Object.entries(config.routes)) {
    if (!route.model.includes("/")) {
      throw new RouterError(
        "CONFIG_INVALID",
        `Invalid smart-router config (${source}): route '${name}' has malformed model reference '${route.model}' (expected 'provider/modelId')`,
      );
    }
  }

  const seenRuleIds = new Set<string>();
  for (const rule of config.rules ?? []) {
    if (seenRuleIds.has(rule.id)) {
      throw new RouterError(
        "CONFIG_INVALID",
        `Invalid smart-router config (${source}): duplicate rule id '${rule.id}'`,
      );
    }
    seenRuleIds.add(rule.id);
    if (!config.routes[rule.route]) {
      throw new RouterError(
        "CONFIG_INVALID",
        `Invalid smart-router config (${source}): rule '${rule.id}' references unknown route '${rule.route}'`,
      );
    }
  }

  for (const fallback of config.fallbacks ?? []) {
    if (!config.routes[fallback]) {
      throw new RouterError(
        "CONFIG_INVALID",
        `Invalid smart-router config (${source}): fallbacks entry '${fallback}' does not exist in routes`,
      );
    }
  }

  if (config.escalation) {
    // Validate the *effective* band (user values merged over defaults): a
    // config that sets only minScore=0.8 would otherwise silently combine
    // with the default maxScore (0.35) into an impossible, never-firing band.
    const merged = { ...DEFAULT_ESCALATION_CONFIG, ...config.escalation };
    if (merged.minScore > merged.maxScore) {
      throw new RouterError(
        "CONFIG_INVALID",
        `Invalid smart-router config (${source}): escalation band [${merged.minScore}, ${merged.maxScore}] is empty (minScore must not exceed maxScore, defaults applied for omitted fields)`,
      );
    }
    // The classifier must never be the router itself: that would make the
    // escalation call recurse into smart-router's own stream handler.
    if (merged.model && merged.model.toLowerCase().startsWith("smart-router/")) {
      throw new RouterError(
        "CONFIG_INVALID",
        `Invalid smart-router config (${source}): escalation.model '${merged.model}' must not reference the smart-router provider itself (recursive routing)`,
      );
    }
  }

  if (config.version !== SMART_ROUTER_CONFIG_VERSION) {
    throw new RouterError(
      "CONFIG_INVALID",
      `Invalid smart-router config (${source}): unsupported version ${config.version} (expected ${SMART_ROUTER_CONFIG_VERSION})`,
    );
  }

  return config;
}

interface LoadConfigOptions {
  /** Absolute path to the global smart-router.json (defaults to ~/.pi/agent/smart-router.json) */
  globalPath?: string;
  /** Absolute path to the project smart-router.json (defaults to <cwd>/.pi/smart-router.json) */
  projectPath?: string;
  /** Whether the project is trusted (project config only loaded when true) */
  projectTrusted: boolean;
  /** Project cwd used for default project path resolution */
  cwd?: string;
}

export interface ConfigLoadResult {
  config: SmartRouterConfig;
  /** File the config came from, or "builtin" for defaults */
  sourcePath: string;
  isProjectConfig: boolean;
}

/**
 * Load routing config: project (trusted only) > global > built-in defaults.
 * A config file that exists must be fully valid; otherwise this throws.
 */
export async function loadSmartRouterConfig(options: LoadConfigOptions): Promise<ConfigLoadResult> {
  const globalPath = options.globalPath ?? getGlobalConfigPath();
  const projectPath = options.projectPath ?? getProjectConfigPath(options.cwd ?? process.cwd());

  if (options.projectTrusted) {
    const loaded = await tryLoadFile(projectPath);
    if (loaded !== undefined) {
      return { config: validateConfig(loaded, projectPath), sourcePath: projectPath, isProjectConfig: true };
    }
  }

  const loaded = await tryLoadFile(globalPath);
  if (loaded !== undefined) {
    return { config: validateConfig(loaded, globalPath), sourcePath: globalPath, isProjectConfig: false };
  }

  return { config: structuredClone(BUILTIN_DEFAULTS), sourcePath: "builtin", isProjectConfig: false };
}

/** Read and JSON.parse a config file; undefined when the file does not exist. */
async function tryLoadFile(filePath: string): Promise<unknown | undefined> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return undefined;
    throw new RouterError("CONFIG_INVALID", `Cannot read smart-router config at ${filePath}: ${String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new RouterError("CONFIG_INVALID", `Smart-router config at ${filePath} is not valid JSON: ${String(error)}`);
  }
  return parsed;
}

/** Convenience: default config value used when no config files exist. */
export function getDefaultConfig(): SmartRouterConfig {
  return structuredClone(BUILTIN_DEFAULTS);
}
