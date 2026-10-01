/**
 * Tests for the compact tier-visibility footer (formatTierStatus).
 *
 * Shape: `<glyph> <route>[ · <source>]`. The routed backend model and
 * thinking level come from pi's native virtual-model footer and are
 * deliberately not repeated here.
 */

import { describe, expect, it } from "vitest";
import { formatTierStatus } from "../src/virtual-router.js";
import { BUILTIN_DEFAULTS } from "../src/types.js";
import type { RouteDecision } from "../src/types.js";

function makeDecision(overrides: Partial<RouteDecision> = {}): RouteDecision {
  return {
    route: "fast",
    backendModel: "opencode-go/deepseek-v4-flash",
    routeConfig: BUILTIN_DEFAULTS.routes.fast,
    reason: "threshold",
    complexityScore: 0.25,
    isFallback: false,
    explanation: "test",
    ...overrides,
  };
}

describe("formatTierStatus", () => {
  it("shows the tier glyph and route name for a threshold decision", () => {
    expect(formatTierStatus(makeDecision())).toBe("⚡ fast");
  });

  it("omits the source for threshold decisions (the default path)", () => {
    expect(formatTierStatus(makeDecision({ reason: "threshold" }))).not.toContain("·");
  });

  it("names the matched rule", () => {
    const line = formatTierStatus(makeDecision({ reason: "rule", matchedRule: "typos", route: "cheap-code" }));
    expect(line).toBe("🪙 cheap-code · rule:typos");
  });

  it("names the classifier as the source", () => {
    const line = formatTierStatus(makeDecision({ reason: "threshold", classifierVerdict: "powerful", route: "powerful" }));
    expect(line).toBe("💎 powerful · classifier");
  });

  it("names default/fallback reasons", () => {
    expect(formatTierStatus(makeDecision({ reason: "default", route: "balanced" }))).toBe("🎯 balanced · default");
    expect(formatTierStatus(makeDecision({ reason: "fallback", route: "fast", isFallback: true }))).toBe("⚡ fast · fallback");
  });

  it("uses the built-in glyph for standard route names", () => {
    expect(formatTierStatus(makeDecision({ route: "powerful", routeConfig: { model: "opencode-go/kimi-k3" } }))).toBe("💎 powerful");
  });

  it("falls back to the balanced glyph for custom routes without emoji", () => {
    const line = formatTierStatus(
      makeDecision({ route: "custom", routeConfig: { model: "opencode-go/gpt-5.6-luna" } }),
    );
    expect(line).toBe("🎯 custom");
  });

  it("never includes prompt text or classifier stats", () => {
    const line = formatTierStatus(
      makeDecision({
        classifierVerdict: "balanced",
        classifierStats: { elapsedMs: 742, inputTokens: 350, outputTokens: 47 },
        explanation: "user prompt was: secrets",
      }),
    );
    expect(line).not.toContain("secrets");
    expect(line).not.toContain("742");
  });
});

