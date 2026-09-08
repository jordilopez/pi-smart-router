import { describe, expect, it } from "vitest";
import { checkModelCapabilities, classifierThresholds, resolveRoute, tierForScore } from "../src/route-resolver.js";
import { RouterError } from "../src/types.js";
import type { PromptFeatures, RouteConfig, SmartRouterConfig } from "../src/types.js";
import { FakeRegistry, makeContext, makeModel } from "./helpers.js";

function features(overrides: Partial<PromptFeatures> = {}): PromptFeatures {
  return {
    promptTokens: 50,
    contextTokens: 1000,
    codeLikelihood: 0,
    reasoningLikelihood: 0,
    keywordSignal: 0,
    toolSignal: 0,
    imageSignal: 0,
    hasTools: false,
    hasImages: false,
    complexityScore: 0.5,
    ...overrides,
  };
}

function config(overrides: Partial<SmartRouterConfig> = {}): SmartRouterConfig {
  return {
    version: 1,
    defaultRoute: "balanced",
    routes: {
      fast: { model: "openai/gpt-4o-mini" },
      "cheap-code": { model: "opencode-go/mimo-v2.5" },
      balanced: { model: "anthropic/claude-sonnet-4-5" },
      powerful: { model: "anthropic/claude-opus-4-5", reasoning: "high" },
    },
    // powerful intentionally never appears in fallbacks.
    fallbacks: ["fast", "cheap-code"],
    ...overrides,
  };
}

const ctx = makeContext();

describe("checkModelCapabilities", () => {
  const route: RouteConfig = { model: "p/m" };

  it("rejects image requests on text-only models", () => {
    const model = makeModel({ provider: "p", id: "m", input: ["text"] });
    const result = checkModelCapabilities(model, features({ hasImages: true }), route);
    expect(result.compatible).toBe(false);
    expect(result.reason).toContain("image");
  });

  it("accepts image requests on multimodal models", () => {
    const model = makeModel({ provider: "p", id: "m", input: ["text", "image"] });
    expect(checkModelCapabilities(model, features({ hasImages: true }), route).compatible).toBe(true);
  });

  it("rejects contexts exceeding 80% of the context window", () => {
    const model = makeModel({ provider: "p", id: "m", contextWindow: 1000 });
    expect(checkModelCapabilities(model, features({ contextTokens: 801 }), route).compatible).toBe(false);
    expect(checkModelCapabilities(model, features({ contextTokens: 800 }), route).compatible).toBe(true);
  });

  it("rejects explicit reasoning on non-reasoning models", () => {
    const model = makeModel({ provider: "p", id: "m", reasoning: false });
    expect(checkModelCapabilities(model, features(), { model: "p/m", reasoning: "high" }).compatible).toBe(false);
    expect(checkModelCapabilities(model, features(), { model: "p/m", reasoning: "off" }).compatible).toBe(true);
    expect(checkModelCapabilities(model, features(), { model: "p/m", reasoning: "preserve" }).compatible).toBe(true);
  });

  it("rejects maxTokens above the model limit", () => {
    const model = makeModel({ provider: "p", id: "m", maxTokens: 8192 });
    expect(checkModelCapabilities(model, features(), { model: "p/m", maxTokens: 9999 }).compatible).toBe(false);
    expect(checkModelCapabilities(model, features(), { model: "p/m", maxTokens: 8192 }).compatible).toBe(true);
  });
});

describe("resolveRoute: rules", () => {
  it("highest priority matching rule wins", () => {
    const cfg = config({
      rules: [
        { id: "low", priority: 1, match: { anyKeywords: ["deploy"] }, route: "balanced" },
        { id: "high", priority: 10, match: { anyKeywords: ["deploy"] }, route: "powerful" },
      ],
    });
    const registry = new FakeRegistry({
      models: [
        makeModel({ provider: "openai", id: "gpt-4o-mini" }),
        makeModel({ provider: "opencode-go", id: "mimo-v2.5" }),
        makeModel({ provider: "anthropic", id: "claude-sonnet-4-5" }),
        makeModel({ provider: "anthropic", id: "claude-opus-4-5" }),
      ],
    });
    const decision = resolveRoute(registry, cfg, features(), makeContext({ messages: [{ role: "user", content: "please deploy", timestamp: 0 }] }));
    expect(decision.matchedRule).toBe("high");
    expect(decision.route).toBe("powerful");
  });

  it("skips rules whose route is unavailable and falls through", () => {
    const cfg = config({
      rules: [
        { id: "first", priority: 10, match: { anyKeywords: ["deploy"] }, route: "missing-route" },
        { id: "second", priority: 1, match: { anyKeywords: ["deploy"] }, route: "balanced" },
      ],
      routes: { balanced: { model: "anthropic/claude-sonnet-4-5" } },
    });
    const registry = new FakeRegistry({ models: [makeModel({ provider: "anthropic", id: "claude-sonnet-4-5" })] });
    const decision = resolveRoute(registry, cfg, features(), makeContext({ messages: [{ role: "user", content: "please deploy", timestamp: 0 }] }));
    expect(decision.reason).toBe("rule");
    expect(decision.matchedRule).toBe("second");
  });

  it("unauthenticated backends are treated as unavailable", () => {
    const cfg = config({ rules: [{ id: "r", match: {}, route: "balanced" }] });
    const registry = new FakeRegistry({
      models: [makeModel({ provider: "anthropic", id: "claude-sonnet-4-5" })],
      unauthenticated: ["anthropic"],
    });
    expect(() => resolveRoute(registry, cfg, features(), ctx)).toThrow(RouterError);
  });
});

describe("resolveRoute: thresholds", () => {
  const registry = () =>
    new FakeRegistry({
      models: [
        makeModel({ provider: "openai", id: "gpt-4o-mini" }),
        makeModel({ provider: "opencode-go", id: "mimo-v2.5" }),
        makeModel({ provider: "anthropic", id: "claude-sonnet-4-5" }),
        makeModel({ provider: "anthropic", id: "claude-opus-4-5" }),
      ],
    });

  it("very low score routes to the cheap tier", () => {
    const decision = resolveRoute(registry(), config(), features({ complexityScore: 0.1 }), ctx);
    expect(decision.reason).toBe("threshold");
    expect(decision.route).toBe("cheap-code");
  });

  it("low score routes to the fast tier (above cheapMax)", () => {
    const decision = resolveRoute(registry(), config(), features({ complexityScore: 0.25 }), ctx);
    expect(decision.reason).toBe("threshold");
    expect(decision.route).toBe("fast");
  });

  it("medium score routes to the balanced tier", () => {
    const decision = resolveRoute(registry(), config(), features({ complexityScore: 0.5 }), ctx);
    expect(decision.route).toBe("balanced");
  });

  it("high score routes to the powerful tier", () => {
    const decision = resolveRoute(registry(), config(), features({ complexityScore: 0.9 }), ctx);
    expect(decision.route).toBe("powerful");
  });

  it("tier lookup matches name segments, not substrings", () => {
    // "fastest" contains "fast" as a substring but its segments do not
    // include "fast", so it must not hijack the fast tier.
    const cfg = config({
      routes: {
        fastest: { model: "anthropic/claude-opus-4-5" },
        fast: { model: "openai/gpt-4o-mini" },
        "cheap-code": { model: "opencode-go/mimo-v2.5" },
        balanced: { model: "anthropic/claude-sonnet-4-5" },
        powerful: { model: "anthropic/claude-opus-4-5", reasoning: "high" },
      },
    });
    expect(resolveRoute(registry(), cfg, features({ complexityScore: 0.25 }), ctx).route).toBe("fast");
  });

  it("tier lookup matches compound route names containing the alias", () => {
    // "my-cheap-code-route" has "cheap"+"code" as consecutive segments,
    // matching the "cheap" tier alias "cheap-code".
    const cfg = config({
      routes: {
        "my-cheap-code-route": { model: "opencode-go/mimo-v2.5" },
        balanced: { model: "anthropic/claude-sonnet-4-5" },
        powerful: { model: "anthropic/claude-opus-4-5", reasoning: "high" },
      },
      classifier: { thresholds: { cheapMax: 0.2 } },
    });
    expect(resolveRoute(registry(), cfg, features({ complexityScore: 0.1 }), ctx).route).toBe("my-cheap-code-route");
  });

  it("uses default thresholds when cheapMax is omitted (compat)", () => {
    // No classifier.thresholds at all: cheap <= 0.15, fast <= 0.30,
    // balanced <= 0.80, powerful above.
    const cfg = config();
    delete cfg.classifier;
    expect(resolveRoute(registry(), cfg, features({ complexityScore: 0.05 }), ctx).route).toBe("cheap-code");
    expect(resolveRoute(registry(), cfg, features({ complexityScore: 0.15 }), ctx).route).toBe("cheap-code");
    expect(resolveRoute(registry(), cfg, features({ complexityScore: 0.16 }), ctx).route).toBe("fast");
    expect(resolveRoute(registry(), cfg, features({ complexityScore: 0.30 }), ctx).route).toBe("fast");
    expect(resolveRoute(registry(), cfg, features({ complexityScore: 0.31 }), ctx).route).toBe("balanced");
    expect(resolveRoute(registry(), cfg, features({ complexityScore: 0.80 }), ctx).route).toBe("balanced");
    expect(resolveRoute(registry(), cfg, features({ complexityScore: 0.81 }), ctx).route).toBe("powerful");
  });

  it("a lower cheapMax shrinks the cheap band", () => {
    const cfg = config({ classifier: { thresholds: { cheapMax: 0.1 } } });
    expect(resolveRoute(registry(), cfg, features({ complexityScore: 0.1 }), ctx).route).toBe("cheap-code");
    expect(resolveRoute(registry(), cfg, features({ complexityScore: 0.2 }), ctx).route).toBe("fast");
  });

  it("respects custom thresholds", () => {
    const cfg = config({ classifier: { thresholds: { cheapMax: 0.05, simpleMax: 0.1, mediumMax: 0.2 } } });
    expect(resolveRoute(registry(), cfg, features({ complexityScore: 0.06 }), ctx).route).toBe("fast");
    expect(resolveRoute(registry(), cfg, features({ complexityScore: 0.15 }), ctx).route).toBe("balanced");
    expect(resolveRoute(registry(), cfg, features({ complexityScore: 0.25 }), ctx).route).toBe("powerful");
  });

  it("powerful only above mediumMax=0.8 absent explicit rules", () => {
    const cfg = config();
    delete cfg.rules;
    for (const score of [0.3, 0.5, 0.65, 0.8]) {
      const decision = resolveRoute(registry(), cfg, features({ complexityScore: score }), ctx);
      expect(decision.route).not.toBe("powerful");
    }
    expect(resolveRoute(registry(), cfg, features({ complexityScore: 0.80001 }), ctx).route).toBe("powerful");
  });

  it("falls back to defaultRoute when the tier route is unavailable", () => {
    const cfg = config({ routes: { powerful: { model: "anthropic/claude-opus-4-5" }, balanced: { model: "anthropic/claude-sonnet-4-5" } } });
    // Cheap/fast tiers have no routes; defaultRoute "balanced" exists.
    const reg = new FakeRegistry({ models: [makeModel({ provider: "anthropic", id: "claude-sonnet-4-5" })] });
    expect(resolveRoute(reg, cfg, features({ complexityScore: 0.9 }), ctx).route).toBe("balanced");
  });

  it("falls back to defaultRoute when the tier route is unavailable", () => {
    const cfg = config({ routes: { powerful: { model: "anthropic/claude-opus-4-5" }, balanced: { model: "anthropic/claude-sonnet-4-5" } } });
    // No "powerful"-matching backend; defaultRoute "balanced" exists.
    const reg = new FakeRegistry({ models: [makeModel({ provider: "anthropic", id: "claude-sonnet-4-5" })] });
    expect(resolveRoute(reg, cfg, features({ complexityScore: 0.9 }), ctx).route).toBe("balanced");
  });
});

describe("resolveRoute: fallback ordering and errors", () => {
  it("walks defaultRoute then fallbacks in order", () => {
    // powerful is default: unauthenticated -> fallback "balanced" works.
    const cfg = config({
      defaultRoute: "powerful",
      routes: {
        powerful: { model: "anthropic/claude-opus-4-5" },
        balanced: { model: "anthropic/claude-sonnet-4-5" },
        fast: { model: "openai/gpt-4o-mini" },
      },
    });
    const registry = new FakeRegistry({
      models: [
        makeModel({ provider: "openai", id: "gpt-4o-mini" }),
        makeModel({ provider: "anthropic", id: "claude-sonnet-4-5" }),
      ],
    });
    const decision = resolveRoute(registry, cfg, features({ complexityScore: 0.9 }), ctx);
    // Threshold tier (powerful) unavailable, defaultRoute (powerful) also
    // unavailable -> fallback chain: cheap-code not configured, fast wins.
    expect(decision.route).toBe("fast");
    expect(decision.reason).toBe("fallback");
  });

  it("last-resort: any available route", () => {
    const cfg = config({
      defaultRoute: "powerful",
      routes: { powerful: { model: "anthropic/claude-opus-4-5" }, odd: { model: "openai/gpt-4o-mini" } },
      fallbacks: [],
    });
    const registry = new FakeRegistry({ models: [makeModel({ provider: "openai", id: "gpt-4o-mini" })] });
    const decision = resolveRoute(registry, cfg, features(), ctx);
    expect(decision.route).toBe("odd");
    expect(decision.isFallback).toBe(true);
  });

  it("throws NO_FALLBACK_AVAILABLE when nothing is available", () => {
    const registry = new FakeRegistry({ models: [], unauthenticated: ["anthropic", "openai"] });
    try {
      resolveRoute(registry, config(), features(), ctx);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(RouterError);
      expect((error as RouterError).code).toBe("NO_FALLBACK_AVAILABLE");
    }
  });

  it("capability-incompatible routes are skipped in fallbacks", () => {
    const cfg = config({
      defaultRoute: "powerful",
      routes: {
        powerful: { model: "anthropic/claude-opus-4-5", reasoning: "high" },
        balanced: { model: "anthropic/claude-sonnet-4-5", reasoning: "high" },
        fast: { model: "openai/gpt-4o-mini" },
      },
      fallbacks: ["balanced", "fast"],
    });
    // opus missing entirely; sonnet exists but is non-reasoning while the
    // route demands reasoning "high" -> skipped; fast (no reasoning req) wins.
    const registry = new FakeRegistry({
      models: [
        makeModel({ provider: "anthropic", id: "claude-sonnet-4-5", reasoning: false }),
        makeModel({ provider: "openai", id: "gpt-4o-mini", reasoning: false }),
      ],
    });
    const decision = resolveRoute(registry, cfg, features({ complexityScore: 0.9 }), ctx);
    expect(decision.route).toBe("fast");
  });

  it("image-incompatible fallbacks are skipped", () => {
    const cfg = config({
      routes: {
        fast: { model: "openai/gpt-4o-mini" },
        balanced: { model: "anthropic/claude-sonnet-4-5" },
      },
    });
    const registry = new FakeRegistry({
      models: [
        makeModel({ provider: "openai", id: "gpt-4o-mini", input: ["text"] }),
        makeModel({ provider: "anthropic", id: "claude-sonnet-4-5", input: ["text", "image"] }),
      ],
    });
    const f = features({ hasImages: true, imageSignal: 0.2, contextTokens: 1000 });
    const decision = resolveRoute(registry, cfg, f, ctx);
    expect(decision.route).toBe("balanced");
  });
});

describe("resolveRoute: escalation tier override", () => {
  const overrideRegistry = () =>
    new FakeRegistry({
      models: [
        makeModel({ provider: "openai", id: "gpt-4o-mini" }),
        makeModel({ provider: "opencode-go", id: "mimo-v2.5" }),
        makeModel({ provider: "anthropic", id: "claude-sonnet-4-5" }),
        makeModel({ provider: "anthropic", id: "claude-opus-4-5" }),
      ],
    });

  it("override replaces the computed tier at the threshold step", () => {
    // Score 0.25 -> heuristic fast tier; override promotes to balanced.
    const decision = resolveRoute(overrideRegistry(), config(), features({ complexityScore: 0.25 }), ctx, "balanced");
    expect(decision.reason).toBe("threshold");
    expect(decision.route).toBe("balanced");
    expect(decision.explanation).toContain("escalated");
    expect(decision.explanation).toContain("fast");
  });

  it("override can also demote (balanced band -> fast)", () => {
    // Score 0.4 -> heuristic balanced; override demotes to fast.
    const decision = resolveRoute(overrideRegistry(), config(), features({ complexityScore: 0.4 }), ctx, "fast");
    expect(decision.reason).toBe("threshold");
    expect(decision.route).toBe("fast");
  });

  it("rules still beat an override", () => {
    const withRule = config({
      rules: [{ id: "hard", priority: 100, match: { anyKeywords: ["root cause"] }, route: "powerful" }],
    });
    const decision = resolveRoute(
      overrideRegistry(),
      withRule,
      features(),
      makeContext({ messages: [{ role: "user", content: "find the root cause of this", timestamp: 1 }] }),
      "balanced",
    );
    expect(decision.route).toBe("powerful");
    expect(decision.reason).toBe("rule");
  });

  it("override tier falls through to default/fallbacks when the target route is unavailable", () => {
    const noBalanced = new FakeRegistry({
      models: [makeModel({ provider: "openai", id: "gpt-4o-mini" })],
      unauthenticated: ["anthropic"], // balanced + powerful unavailable
    });
    const decision = resolveRoute(noBalanced, config(), features({ complexityScore: 0.25 }), ctx, "balanced");
    // defaultRoute is balanced (unavailable) -> fallback fast.
    expect(decision.route).toBe("fast");
    expect(decision.isFallback).toBe(true);
  });

  it("classifierThresholds + tierForScore match the resolver's tier computation", () => {
    const t = classifierThresholds(config());
    expect(t).toEqual({ cheapMax: 0.15, simpleMax: 0.3, mediumMax: 0.8 });
    expect(tierForScore(0.1, t)).toBe("cheap");
    expect(tierForScore(0.15, t)).toBe("cheap");
    expect(tierForScore(0.25, t)).toBe("fast");
    expect(tierForScore(0.5, t)).toBe("balanced");
    expect(tierForScore(0.9, t)).toBe("powerful");
    const custom = classifierThresholds(config({ classifier: { thresholds: { mediumMax: 0.65 } } }));
    expect(custom.mediumMax).toBe(0.65);
    expect(tierForScore(0.7, custom)).toBe("powerful");
  });
});
