import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config.js";
import { BUILTIN_DEFAULTS } from "../src/types.js";

const examplesDir = path.resolve(import.meta.dirname, "../examples");

describe("example configs", () => {
  it("examples/pi-smart-router.json passes validation", async () => {
    const raw = JSON.parse(await readFile(path.join(examplesDir, "pi-smart-router.json"), "utf8"));
    const config = validateConfig(raw, "examples/pi-smart-router.json");
    expect(config.defaultRoute).toBe("balanced");
    expect(Object.keys(config.routes).sort()).toEqual(["balanced", "cheap-code", "fast", "powerful"]);
  });

  it("examples/pi-smart-router.json defines provider/model references for every route", async () => {
    const raw = JSON.parse(await readFile(path.join(examplesDir, "pi-smart-router.json"), "utf8"));
    for (const route of Object.values(raw.routes) as Array<{ model: string }>) {
      expect(route.model).toMatch(/^[^/]+\/[^/]+$/);
    }
  });

  it("examples/pi-smart-router.json never falls back to powerful and keeps powerful rules scoped", async () => {
    const raw = JSON.parse(await readFile(path.join(examplesDir, "pi-smart-router.json"), "utf8"));
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

describe("recommended setup structure and documentation", () => {
  it("built-in defaults use valid route references", () => {
    for (const route of Object.values(BUILTIN_DEFAULTS.routes)) {
      expect(route.model).toMatch(/^[^/]+\/[^/]+$/);
    }
    expect(BUILTIN_DEFAULTS.fallbacks).not.toContain("powerful");
  });

  it("README documents the four tiers and footer behavior", async () => {
    const readme = await readFile(path.resolve(examplesDir, "../README.md"), "utf8");
    for (const needle of [
      "cheap-code",
      "mediumMax",
      "0.80",
      "pi-smart-router/auto",
    ]) {
      expect(readme).toContain(needle);
    }
    // cheap-code must be documented as not local.
    expect(/cheap-code[\s\S]{0,400}not local/i.test(readme)).toBe(true);
  });
});
