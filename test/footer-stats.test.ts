import { describe, expect, it } from "vitest";
import { formatDecisionStatus } from "../src/provider.js";
import { BUILTIN_DEFAULTS } from "../src/types.js";
import type { RouteDecision } from "../src/types.js";

function makeDecision(overrides: Partial<RouteDecision> = {}): RouteDecision {
  return {
    route: "balanced",
    backendModel: "hyper/glm-5.3-flash",
    routeConfig: BUILTIN_DEFAULTS.routes.balanced,
    reason: "default",
    complexityScore: 0.25,
    isFallback: false,
    explanation: "test",
    ...overrides,
  };
}

describe("formatDecisionStatus with classifier stats", () => {
  it("appends elapsed ms and token usage when present", () => {
    const line = formatDecisionStatus(
      makeDecision({
        classifierVerdict: "balanced",
        classifierStats: { elapsedMs: 742, inputTokens: 350, outputTokens: 47 },
      }),
    );
    expect(line).toContain("classifier");
    expect(line).toContain("· 742ms/350i/47o");
  });

  it("omits the stats suffix when classifierStats is absent", () => {
    const line = formatDecisionStatus(makeDecision({ classifierVerdict: "balanced" }));
    expect(line).toContain("· classifier");
    expect(line).not.toMatch(/ms\//);
  });

  it("omits the stats suffix when only the default route was used", () => {
    const line = formatDecisionStatus(makeDecision());
    expect(line).toContain("· default");
    expect(line).not.toMatch(/ms\//);
  });

  it("renders ms-only stats when the backend reports no token usage", () => {
    const line = formatDecisionStatus(
      makeDecision({
        classifierVerdict: "powerful",
        classifierStats: { elapsedMs: 1500 },
      }),
    );
    expect(line).toContain("· 1500ms");
    expect(line).not.toContain("tok");
  });
});
