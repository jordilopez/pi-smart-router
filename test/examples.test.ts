import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config.js";
import { BUILTIN_DEFAULTS } from "../src/types.js";

const examplesDir = path.resolve(import.meta.dirname, "../examples");

/** The approved model policy: exact route -> backend mapping. */
const POLICY_MODELS: Record<string, string> = {
  fast: "opencode-go/glm-5.3-flash",
  "cheap-code": "opencode-go/mimo-v2.5",
  balanced: "opencode-go/gpt-5.6-luna",
  powerful: "opencode-go/kimi-k3",
};

describe("example configs", () => {
  it("examples/smart-router.json passes validation", async () => {
    const raw = JSON.parse(await readFile(path.join(examplesDir, "smart-router.json"), "utf8"));
    const config = validateConfig(raw, "examples/smart-router.json");
    expect(config.defaultRoute).toBe("balanced");
    expect(Object.keys(config.routes).sort()).toEqual(["balanced", "cheap-code", "fast", "powerful"]);
  });

  it("examples/smart-router.json uses the exact approved model references", async () => {
    const raw = JSON.parse(await readFile(path.join(examplesDir, "smart-router.json"), "utf8"));
    for (const [routeName, modelRef] of Object.entries(POLICY_MODELS)) {
      expect(raw.routes[routeName].model).toBe(modelRef);
    }
    // Exact lowercase model ID for the balanced route.
    expect(raw.routes.balanced.model).toBe("opencode-go/gpt-5.6-luna");
  });

  it("examples/smart-router.json never falls back to powerful and keeps powerful rules scoped", async () => {
    const raw = JSON.parse(await readFile(path.join(examplesDir, "smart-router.json"), "utf8"));
    expect(raw.fallbacks).not.toContain("powerful");
    expect(raw.thresholds?.mediumMax ?? raw.classifier?.thresholds?.mediumMax).toBe(0.8);

    // No broad all-code-to-cheap rule: cheap-code rules must be scoped to
    // explicit mechanical-task phrases.
    const cheapRules = (raw.rules ?? []).filter((r: any) => r.route === "cheap-code");
    for (const rule of cheapRules) {
      const keywords = [...(rule.match?.anyKeywords ?? []), ...(rule.match?.allKeywords ?? [])];
      expect(keywords.length).toBeGreaterThan(0);
      for (const kw of keywords) {
        expect(/^(code|typescript|javascript|refactor$|implement)/i.test(kw)).toBe(false);
      }
    }

    // powerful rules avoid generic single words.
    const powerfulRules = (raw.rules ?? []).filter((r: any) => r.route === "powerful");
    expect(powerfulRules.length).toBeGreaterThan(0);
    for (const rule of powerfulRules) {
      const keywords = [...(rule.match?.anyKeywords ?? []), ...(rule.match?.allKeywords ?? [])];
      for (const kw of keywords) {
        expect(["analyze", "debug", "design", "implement"]).not.toContain(kw.toLowerCase());
      }
    }
  });

  it("examples/models.json references only the standard opencode-go backend", async () => {
    const raw = JSON.parse(await readFile(path.join(examplesDir, "models.json"), "utf8"));
    const providers = Object.keys(raw.providers);
    expect(providers).toEqual(["opencode-go"]);
    expect(JSON.stringify(raw)).not.toMatch(/nemotron/i);
  });
});

describe("no Nemotron anywhere in the recommended setup", () => {
  it("built-in defaults contain no Nemotron and use the approved routes", () => {
    const serialized = JSON.stringify(BUILTIN_DEFAULTS).toLowerCase();
    expect(serialized).not.toContain("nemotron");
    expect(BUILTIN_DEFAULTS.routes.fast.model).toBe("opencode-go/glm-5.3-flash");
    expect(BUILTIN_DEFAULTS.routes["cheap-code"].model).toBe("opencode-go/mimo-v2.5");
    expect(BUILTIN_DEFAULTS.routes.balanced.model).toBe("opencode-go/gpt-5.6-luna");
    expect(BUILTIN_DEFAULTS.routes.powerful.model).toBe("opencode-go/kimi-k3");
    expect(BUILTIN_DEFAULTS.fallbacks).not.toContain("powerful");
  });

  it("examples and README mention no Nemotron", async () => {
    for (const file of ["models.json", "smart-router.json"]) {
      const content = (await readFile(path.join(examplesDir, file), "utf8")).toLowerCase();
      expect(content).not.toContain("nemotron");
    }
    const readme = (await readFile(path.resolve(examplesDir, "../README.md"), "utf8")).toLowerCase();
    expect(readme).not.toContain("nemotron");
  });

  it("README documents the four tiers, the exact model IDs, and the footer behavior", async () => {
    const readme = await readFile(path.resolve(examplesDir, "../README.md"), "utf8");
    for (const needle of [
      "opencode-go/glm-5.3-flash",
      "opencode-go/mimo-v2.5",
      "opencode-go/gpt-5.6-luna",
      "opencode-go/kimi-k3",
      "cheap-code",
      "mediumMax",
      "0.80",
      "smart-router/auto",
    ]) {
      expect(readme).toContain(needle);
    }
    // cheap-code must be documented as not local.
    expect(/cheap-code[\s\S]{0,400}not local/i.test(readme)).toBe(true);
  });
});
