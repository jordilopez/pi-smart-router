import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getGlobalConfigPath,
  getProjectConfigPath,
  loadSmartRouterConfig,
  validateConfig,
} from "../src/config.js";
import { BUILTIN_DEFAULTS } from "../src/types.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "smart-router-config-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("loadSmartRouterConfig", () => {
  it("missing files -> built-in defaults", async () => {
    const result = await loadSmartRouterConfig({
      globalPath: path.join(dir, "nope.json"),
      projectPath: path.join(dir, "nope2.json"),
      projectTrusted: true,
    });
    expect(result.sourcePath).toBe("builtin");
    expect(result.config).toEqual(BUILTIN_DEFAULTS);
    expect(result.config.defaultRoute).toBe("balanced");
    expect(Object.keys(result.config.routes)).toEqual(["fast", "cheap-code", "balanced", "powerful"]);
  });

  it("global config used when no project config", async () => {
    const globalPath = path.join(dir, "global.json");
    await writeFile(globalPath, JSON.stringify({ version: 1, defaultRoute: "fast", routes: { fast: { model: "openai/gpt-4o-mini" } } }));
    const result = await loadSmartRouterConfig({ globalPath, projectPath: path.join(dir, "nope.json"), projectTrusted: true });
    expect(result.config.defaultRoute).toBe("fast");
    expect(result.sourcePath).toBe(globalPath);
    expect(result.isProjectConfig).toBe(false);
  });

  it("project config wins over global when trusted", async () => {
    const globalPath = path.join(dir, "global.json");
    const projectPath = path.join(dir, "project.json");
    await writeFile(globalPath, JSON.stringify({ version: 1, defaultRoute: "fast", routes: { fast: { model: "openai/gpt-4o-mini" } } }));
    await writeFile(projectPath, JSON.stringify({ version: 1, defaultRoute: "balanced", routes: { balanced: { model: "anthropic/claude-sonnet-4-5" } } }));
    const result = await loadSmartRouterConfig({ globalPath, projectPath, projectTrusted: true });
    expect(result.config.defaultRoute).toBe("balanced");
    expect(result.isProjectConfig).toBe(true);
  });

  it("untrusted project config is ignored", async () => {
    const globalPath = path.join(dir, "global.json");
    const projectPath = path.join(dir, "project.json");
    await writeFile(globalPath, JSON.stringify({ version: 1, defaultRoute: "fast", routes: { fast: { model: "openai/gpt-4o-mini" } } }));
    await writeFile(projectPath, JSON.stringify({ version: 1, defaultRoute: "balanced", routes: { balanced: { model: "anthropic/claude-sonnet-4-5" } } }));
    const result = await loadSmartRouterConfig({ globalPath, projectPath, projectTrusted: false });
    expect(result.config.defaultRoute).toBe("fast");
    expect(result.isProjectConfig).toBe(false);
  });

  it("invalid JSON throws", async () => {
    const globalPath = path.join(dir, "bad.json");
    await writeFile(globalPath, "{not json");
    await expect(
      loadSmartRouterConfig({ globalPath, projectPath: path.join(dir, "nope.json"), projectTrusted: false }),
    ).rejects.toThrow(/not valid JSON/);
  });

  it("schema violations throw with details", async () => {
    const globalPath = path.join(dir, "bad-schema.json");
    await writeFile(globalPath, JSON.stringify({ version: 1, defaultRoute: "fast", routes: { fast: { model: "no-slash", reasoning: "bogus" } } }));
    await expect(
      loadSmartRouterConfig({ globalPath, projectPath: path.join(dir, "nope.json"), projectTrusted: false }),
    ).rejects.toThrow(/smart-router config/);
  });
});

describe("validateConfig semantics", () => {
  const base = { version: 1, defaultRoute: "balanced", routes: { balanced: { model: "anthropic/claude-sonnet-4-5" } } };

  it("unknown defaultRoute throws", () => {
    expect(() => validateConfig({ ...base, defaultRoute: "nope" }, "test")).toThrow(/defaultRoute 'nope' does not exist/);
  });

  it("rule referencing unknown route throws", () => {
    const cfg = { ...base, rules: [{ id: "r", match: {}, route: "ghost" }] };
    expect(() => validateConfig(cfg, "test")).toThrow(/rule 'r' references unknown route 'ghost'/);
  });

  it("fallback referencing unknown route throws", () => {
    const cfg = { ...base, fallbacks: ["ghost"] };
    expect(() => validateConfig(cfg, "test")).toThrow(/fallbacks entry 'ghost'/);
  });

  it("duplicate rule ids throw", () => {
    const cfg = {
      ...base,
      routes: { balanced: { model: "anthropic/claude-sonnet-4-5" }, fast: { model: "openai/gpt-4o-mini" } },
      rules: [
        { id: "dup", match: {}, route: "fast" },
        { id: "dup", match: {}, route: "fast" },
      ],
    };
    expect(() => validateConfig(cfg, "test")).toThrow(/duplicate rule id 'dup'/);
  });

  it("malformed model refs throw", () => {
    expect(() => validateConfig({ ...base, routes: { balanced: { model: "noslash" } } }, "test")).toThrow(/provider\/modelId/);
  });

  it("wrong version throws", () => {
    expect(() => validateConfig({ ...base, version: 99 }, "test")).toThrow(/unsupported version 99/);
  });

  it("full valid config passes", () => {
    const cfg = {
      version: 1,
      defaultRoute: "balanced",
      routes: {
        fast: { model: "openai/gpt-4o-mini", reasoning: "off" },
        balanced: { model: "anthropic/claude-sonnet-4-5", reasoning: "preserve", maxTokens: 8192 },
      },
      rules: [{ id: "deep", priority: 10, match: { minComplexity: 0.5 }, route: "fast" }],
      fallbacks: ["fast", "balanced"],
      classifier: { weights: { reasoningLikelihood: 0.4 }, thresholds: { cheapMax: 0.1, simpleMax: 0.25, mediumMax: 0.7 } },
      observability: { showRouteStatus: true, logDecisions: true },
    };
    expect(() => validateConfig(cfg, "test")).not.toThrow();
  });
});

describe("backward compatibility", () => {
  it("configs that omit cheapMax validate and get the 0.15 default at resolution time", async () => {
    const globalPath = path.join(dir, "legacy.json");
    await writeFile(
      globalPath,
      JSON.stringify({
        version: 1,
        defaultRoute: "balanced",
        routes: {
          fast: { model: "openai/gpt-4o-mini" },
          balanced: { model: "anthropic/claude-sonnet-4-5" },
          powerful: { model: "anthropic/claude-opus-4-5" },
        },
        classifier: { thresholds: { simpleMax: 0.3, mediumMax: 0.65 } },
      }),
    );
    const result = await loadSmartRouterConfig({ globalPath, projectPath: path.join(dir, "nope.json"), projectTrusted: false });
    expect(result.config.classifier?.thresholds?.cheapMax).toBeUndefined();
    // The resolver supplies 0.15 as the effective default (covered in
    // route-resolver tests); loading must not fail.
    expect(result.config.defaultRoute).toBe("balanced");
  });
});

describe("path helpers", () => {
  it("uses ~/.pi/agent/smart-router.json globally and .pi/smart-router.json per project", () => {
    expect(getGlobalConfigPath()).toMatch(/[.]pi[/\\]agent[/\\]smart-router[.]json$/);
    expect(getProjectConfigPath("/tmp/x")).toBe(path.join("/tmp/x", ".pi", "smart-router.json"));
  });
});
