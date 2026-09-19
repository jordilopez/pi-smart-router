import { describe, expect, it } from "vitest";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  buildClassifierContext,
  classifyWithLlm,
  isClassifierBackendAvailable,
  isClassifierConfigured,
  isRouterSelfRef,
  parseVerdict,
  resolveClassifierModelRef,
  resolveClassifierConfig,
  runClassifier,
} from "../src/escalation.js";
import { DEFAULT_CLASSIFIER_CONFIG } from "../src/types.js";
import type { PromptFeatures, ResolvedBackend, SmartRouterConfig } from "../src/types.js";
import { FakeRegistry, captureOf, makeContext, makeFakeProvider, makeModel } from "./helpers.js";

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
    complexityScore: 0.25,
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
      powerful: { model: "anthropic/claude-opus-4-5" },
    },
    fallbacks: ["fast", "cheap-code"],
    ...overrides,
  };
}

/** Backend whose stream emits a single text delta (the verdict) then completes. */
function backendWithAnswer(answer: string | "error" | "hang"): ResolvedBackend {
  const provider = makeFakeProvider({
    streamFactory: () => {
      const stream = createAssistantMessageEventStream();
      if (answer === "error") {
        stream.push({
          type: "error",
          reason: "error",
          error: {
            role: "assistant",
            content: [],
            api: "x",
            provider: "p",
            model: "m",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "error",
            errorMessage: "boom",
            timestamp: Date.now(),
          },
        });
        stream.end();
      } else if (answer === "hang") {
        // Never pushes, never ends: the timeout must break the wait.
      } else {
        stream.push({ type: "text_delta", contentIndex: 0, delta: answer, partial: { role: "assistant", content: [], api: "x", provider: "p", model: "m", usage: {} as never, stopReason: "pending", timestamp: 0 } });
        stream.end();
      }
      return stream;
    },
  });
  return { model: makeModel({ provider: "openai", id: "gpt-4o-mini" }), provider: provider as never, apiKey: "k" };
}

// ============================================================================
// resolveClassifierConfig / isClassifierConfigured
// ============================================================================

describe("resolveClassifierConfig", () => {
  it("returns built-in defaults when the block is absent", () => {
    expect(resolveClassifierConfig(config())).toEqual(DEFAULT_CLASSIFIER_CONFIG);
  });

  it("merges partial config field-by-field over the defaults", () => {
    const merged = resolveClassifierConfig(config({ classifier: { model: "openai/gpt-4o-mini" } }));
    expect(merged.model).toBe("openai/gpt-4o-mini");
    expect(merged.timeoutMs).toBe(DEFAULT_CLASSIFIER_CONFIG.timeoutMs);
  });
});

describe("isClassifierConfigured", () => {
  it("is false when no model is configured", () => {
    expect(isClassifierConfigured(config())).toBe(false);
    expect(isClassifierConfigured(config({ classifier: {} }))).toBe(false);
    expect(isClassifierConfigured(config({ classifier: { model: "" } }))).toBe(false);
  });

  it("is true when a model is configured", () => {
    expect(isClassifierConfigured(config({ classifier: { model: "openai/gpt-4o-mini" } }))).toBe(true);
    expect(isClassifierConfigured(config({ classifier: { model: "typesafe-ai/jev" } }))).toBe(true);
  });

  it("is false for a router self-reference", () => {
    expect(isClassifierConfigured(config({ classifier: { model: "pi-smart-router/auto" } }))).toBe(false);
  });
});

// ============================================================================
// Classifier backend resolution
// ============================================================================

describe("isRouterSelfRef / resolveClassifierModelRef", () => {
  it("detects router self-references case-insensitively", () => {
    expect(isRouterSelfRef("pi-smart-router/auto")).toBe(true);
    expect(isRouterSelfRef("Pi-Smart-Router/Auto")).toBe(true);
    expect(isRouterSelfRef("opencode-go/deepseek-v4-flash")).toBe(false);
  });

  it("returns null when no model is configured", () => {
    expect(resolveClassifierModelRef(config(), resolveClassifierConfig(config()))).toBeNull();
  });

  it("uses the configured model when set", () => {
    const cfg = config({ classifier: { model: "opencode-go/mimo-v2.5" } });
    expect(resolveClassifierModelRef(cfg, resolveClassifierConfig(cfg))).toBe("opencode-go/mimo-v2.5");
  });

  it("returns null for a self-referencing configured model", () => {
    const cfg = config({ classifier: { model: "pi-smart-router/auto" } });
    expect(resolveClassifierModelRef(cfg, resolveClassifierConfig(cfg))).toBeNull();
  });
});

describe("isClassifierBackendAvailable", () => {
  it("accepts a registered, authenticated model", () => {
    const registry = new FakeRegistry({ models: [makeModel({ provider: "openai", id: "gpt-4o-mini" })] });
    expect(isClassifierBackendAvailable(registry, "openai/gpt-4o-mini")).toBe(true);
  });

  it("accepts TypeSafe refs without a Pi provider", () => {
    expect(isClassifierBackendAvailable(new FakeRegistry({}), "typesafe-ai/jev")).toBe(true);
  });

  it("rejects unknown models, unauthenticated providers, malformed refs, and self-refs", () => {
    const registry = new FakeRegistry({
      models: [makeModel({ provider: "openai", id: "gpt-4o-mini" })],
      unauthenticated: ["openai"],
      missingProviders: ["ghost"],
    });
    expect(isClassifierBackendAvailable(registry, "openai/does-not-exist")).toBe(false);
    expect(isClassifierBackendAvailable(new FakeRegistry({ models: [makeModel({ provider: "openai", id: "gpt-4o-mini" })] }), "openai/gpt-4o-mini")).toBe(true);
    expect(isClassifierBackendAvailable(registry, "openai/gpt-4o-mini")).toBe(false);
    expect(isClassifierBackendAvailable(registry, "ghost/gpt")).toBe(false);
    expect(isClassifierBackendAvailable(registry, "no-slash")).toBe(false);
    expect(isClassifierBackendAvailable(registry, "pi-smart-router/auto")).toBe(false);
  });
});

// ============================================================================
// buildClassifierContext
// ============================================================================

describe("buildClassifierContext", () => {
  it("includes recent conversation and the latest prompt", () => {
    const ctx = makeContext({
      messages: [
        { role: "user", content: "first message about the diff", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "here is the code" }], api: "x", provider: "p", model: "m", usage: {} as never, stopReason: "stop", timestamp: 2 },
        { role: "user", content: "review this", timestamp: 3 },
      ],
    });
    const classifier = buildClassifierContext(ctx, features());
    expect(classifier.messages).toHaveLength(1);
    const text = classifier.messages[0].content as string;
    expect(text).toContain("first message about the diff");
    expect(text).toContain("here is the code");
    expect(text).toContain("review this");
    expect(text).toContain("<latest>");
    // All four tiers are offered.
    expect(classifier.systemPrompt).toContain('"cheap"');
    expect(classifier.systemPrompt).toContain('"fast"');
    expect(classifier.systemPrompt).toContain('"balanced"');
    expect(classifier.systemPrompt).toContain('"powerful"');
  });

  it("classifies the latest USER message, not the last message", () => {
    const ctx = makeContext({
      messages: [
        { role: "user", content: "review the auth changes", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "all tests pass" }], api: "x", provider: "p", model: "m", usage: {} as never, stopReason: "stop", timestamp: 2 },
        { role: "user", content: "could you review my changes?", timestamp: 3 },
      ],
    });
    const text = (buildClassifierContext(ctx, features()).messages[0].content) as string;
    expect(text).toContain("could you review my changes?");
    expect(text).toContain("review the auth changes"); // still in the transcript
  });

  it("replaces image blocks with a placeholder", () => {
    const ctx = makeContext({
      messages: [
        { role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: 1 },
      ],
    });
    const text = (buildClassifierContext(ctx, features()).messages[0].content) as string;
    expect(text).toContain("[image omitted]");
    expect(text).not.toContain("AAAA");
  });

  it("truncates oversized transcripts with a marker", () => {
    const ctx = makeContext({
      messages: [
        { role: "user", content: "x".repeat(50_000), timestamp: 1 },
        { role: "user", content: "review this", timestamp: 2 },
      ],
    });
    const classifier = buildClassifierContext(ctx, features());
    const text = classifier.messages[0].content as string;
    expect(text).toContain("[truncated]");
    // Bounded overall: transcript budget + latest prompt + boilerplate.
    expect(text.length).toBeLessThan(12_000);
  });
});

// ============================================================================
// parseVerdict
// ============================================================================

describe("parseVerdict", () => {
  it("accepts clean tier words", () => {
    expect(parseVerdict("fast")).toBe("fast");
    expect(parseVerdict(" balanced ")).toBe("balanced");
    expect(parseVerdict("Fast.")).toBe("fast");
    expect(parseVerdict("cheap")).toBe("cheap");
    expect(parseVerdict("powerful")).toBe("powerful");
  });

  it("accepts short prefix prose but not ambiguity", () => {
    expect(parseVerdict("balanced is right")).toBe("balanced");
    expect(parseVerdict("fast balanced")).toBeNull();
  });

  it("rejects junk, numbers, and empty answers", () => {
    expect(parseVerdict("")).toBeNull();
    expect(parseVerdict("7")).toBeNull();
    expect(parseVerdict("maybe?")).toBeNull();
    expect(parseVerdict("I cannot classify this request")).toBeNull();
  });
});

// ============================================================================
// classifyWithLlm
// ============================================================================

describe("classifyWithLlm", () => {
  it("parses a successful verdict and sends a tiny, temperature-0 request", async () => {
    const backend = backendWithAnswer("balanced");
    const ctx = makeContext();
    const verdict = await classifyWithLlm(backend, ctx, { timeoutMs: 1000 });
    expect(verdict).toBe("balanced");

    const cap = captureOf(backend.provider);
    expect(cap.calls).toBe(1);
    expect(cap.models[0].id).toBe("gpt-4o-mini");
    expect(cap.contexts[0]).toBe(ctx);
    expect(cap.options[0]?.maxTokens).toBe(4);
    expect(cap.options[0]?.temperature).toBe(0);
    // Lowest portable thinking level: protects the 4-token output budget.
    expect(cap.options[0]?.reasoning).toBe("minimal");
    expect(cap.options[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns null on stream errors", async () => {
    const backend = backendWithAnswer("error");
    expect(await classifyWithLlm(backend, makeContext(), { timeoutMs: 1000 })).toBeNull();
  });

  it("aborts hanging streams and returns null within the timeout", async () => {
    const backend = backendWithAnswer("hang");
    const start = Date.now();
    const verdict = await classifyWithLlm(backend, makeContext(), { timeoutMs: 60 });
    const elapsed = Date.now() - start;
    expect(verdict).toBeNull();
    // Timeout (60ms) + abort grace (250ms) is the upper bound for the wait.
    expect(elapsed).toBeLessThan(1500);
  });

  it("returns null for unparseable answers", async () => {
    const backend = backendWithAnswer("I cannot answer that");
    expect(await classifyWithLlm(backend, makeContext(), { timeoutMs: 1000 })).toBeNull();
  });

  it("forwards the stable session id to the classifier stream", async () => {
    const backend = backendWithAnswer("fast");
    await classifyWithLlm(backend, makeContext(), { timeoutMs: 1000, sessionId: "pi-abc" });
    const cap = captureOf(backend.provider);
    expect(cap.options[0]?.sessionId).toBe("pi-abc");
  });
});

// ============================================================================
// runClassifier (orchestrator)
// ============================================================================

describe("runClassifier", () => {
  it("end-to-end: a configured classifier returns a tier verdict", async () => {
    const cfg = config({ classifier: { model: "openai/gpt-4o-mini" } });
    const provider = makeFakeProvider({
      streamFactory: () => {
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "text_delta", contentIndex: 0, delta: "balanced", partial: { role: "assistant", content: [], api: "x", provider: "p", model: "m", usage: {} as never, stopReason: "pending", timestamp: 0 } });
        stream.end();
        return stream;
      },
    });
    const registry = new FakeRegistry({
      models: [makeModel({ provider: "openai", id: "gpt-4o-mini" })],
    });
    (registry as unknown as { getProvider: () => unknown }).getProvider = () => provider;

    const verdict = await runClassifier(registry, cfg, features(), makeContext(), "pi-abc");
    expect(verdict).toBe("balanced");
  });

  it("returns null when no classifier is configured", async () => {
    const registry = new FakeRegistry({ models: [makeModel({ provider: "openai", id: "gpt-4o-mini" })] });
    expect(await runClassifier(registry, config(), features(), makeContext())).toBeNull();
  });

  it("returns null when the configured backend is unavailable", async () => {
    const emptyRegistry = new FakeRegistry({});
    expect(
      await runClassifier(emptyRegistry, config({ classifier: { model: "openai/gpt-4o-mini" } }), features(), makeContext()),
    ).toBeNull();
  });
});
