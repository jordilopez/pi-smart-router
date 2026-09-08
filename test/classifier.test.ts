import { describe, expect, it } from "vitest";
import {
  classifyPrompt,
  estimateTokens,
  extractRawFeatures,
  getLatestUserPrompt,
  matchRule,
} from "../src/classifier.js";
import { DEFAULT_CLASSIFIER_CONFIG } from "../src/types.js";
import { makeModel, makeContext } from "./helpers.js";
import type { Context, Message } from "@earendil-works/pi-ai";

function user(text: string): Message {
  return { role: "user", content: text, timestamp: Date.now() };
}

const BASE_CONFIG = DEFAULT_CLASSIFIER_CONFIG;

describe("estimateTokens", () => {
  it("is chars/4 rounded up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("getLatestUserPrompt", () => {
  it("returns the latest user message text", () => {
    const ctx = makeContext({
      messages: [user("first"), { role: "assistant", content: [], api: "x", provider: "p", model: "m", usage: {} as never, stopReason: "stop", timestamp: 0 }, user("second")],
    });
    expect(getLatestUserPrompt(ctx)).toBe("second");
  });

  it("concatenates text blocks of a user message", () => {
    const ctx = makeContext({
      messages: [{ role: "user", content: [{ type: "text", text: "part1" }, { type: "text", text: "part2" }], timestamp: Date.now() }],
    });
    expect(getLatestUserPrompt(ctx)).toBe("part1\npart2");
  });
});

describe("classifyPrompt (table-driven)", () => {
  const cases: {
    name: string;
    context: () => Context;
    assert: (features: ReturnType<typeof classifyPrompt>) => void;
  }[] = [
    {
      name: "short greeting scores low",
      context: () => makeContext({ messages: [user("hi")] }),
      assert: (f) => {
        expect(f.complexityScore).toBeLessThan(0.3);
        expect(f.codeLikelihood).toBe(0);
        expect(f.reasoningLikelihood).toBe(0);
      },
    },
    {
      name: "simple factual question stays simple",
      context: () => makeContext({ messages: [user("what is the capital of France?")] }),
      assert: (f) => {
        expect(f.complexityScore).toBeLessThan(0.4);
        expect(f.reasoningLikelihood).toBeLessThan(0.5);
      },
    },
    {
      name: "code request has code signal",
      context: () => makeContext({
        messages: [user("write a function `parseConfig` in const typescript that handles async/await errors from an API endpoint")],
      }),
      assert: (f) => {
        expect(f.codeLikelihood).toBeGreaterThan(0.2);
      },
    },
    {
      name: "stack-trace debugging has strong code signal",
      context: () => makeContext({
        messages: [user("fix this crash:\nTraceback (most recent call last):\n  at handler (src/app.ts)\nTypeError: cannot read property 'id' of undefined")],
      }),
      assert: (f) => {
        expect(f.codeLikelihood).toBeGreaterThan(0.3);
        expect(f.hasImages).toBe(false);
      },
    },
    {
      name: "reasoning request has strong reasoning signal",
      context: () => makeContext({
        messages: [user("prove that the halting problem is undecidable, step by step, and analyze the implications")],
      }),
      assert: (f) => {
        expect(f.reasoningLikelihood).toBeGreaterThan(0.5);
        expect(f.complexityScore).toBeGreaterThan(0.3);
      },
    },
    {
      name: "review request gets a reasoning signal",
      context: () => makeContext({
        messages: [user("Could you review my changes and tell me if anything looks wrong?")],
      }),
      assert: (f) => {
        expect(f.reasoningLikelihood).toBeGreaterThan(0);
        // A review request should not be classified as trivially simple.
        expect(f.complexityScore).toBeGreaterThan(0.1);
      },
    },
    {
      name: "long context nudges the score without inflating to the powerful tier",
      context: () => makeContext({
        messages: [user("hi"), user("now summarize")],
        systemPrompt: "x".repeat(40000),
      }),
      assert: (f) => {
        expect(f.contextTokens).toBeGreaterThan(5000);
        // contextTokens weight is intentionally small (0.05): a long session
        // must not make every later prompt look powerful.
        expect(f.complexityScore).toBeGreaterThan(0.03);
        expect(f.complexityScore).toBeLessThan(0.8);
      },
    },
    {
      name: "images set hasImages and imageSignal",
      context: () => makeContext({
        messages: [{ role: "user", content: [{ type: "text", text: "what is in this picture?" }, { type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: Date.now() }],
      }),
      assert: (f) => {
        expect(f.hasImages).toBe(true);
        expect(f.imageSignal).toBeGreaterThan(0);
        expect(f.contextTokens).toBeGreaterThanOrEqual(512);
      },
    },
    {
      name: "tools set hasTools and toolSignal",
      context: () => makeContext({
        messages: [user("list the files")],
        tools: [
          { name: "bash", description: "run bash", parameters: {} as never },
          { name: "read", description: "read file", parameters: {} as never },
        ],
      }),
      assert: (f) => {
        expect(f.hasTools).toBe(true);
        expect(f.toolSignal).toBeGreaterThan(0);
      },
    },
    {
      name: "assistant toolCall blocks count toward context tokens",
      context: () => makeContext({
        messages: [
          { role: "user", content: "run it", timestamp: Date.now() },
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "x".repeat(400) } }],
            api: "anthropic-messages",
            provider: "anthropic",
            model: "m",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "toolUse",
            timestamp: 0,
          },
          { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "done" }], isError: false, timestamp: 0 },
        ],
      }),
      assert: (f) => {
        expect(f.contextTokens).toBeGreaterThan(100);
      },
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      c.assert(classifyPrompt(c.context(), BASE_CONFIG));
    });
  }

  it("default weights match the approved policy (context kept low, imageSignal 0)", () => {
    const w = BASE_CONFIG.weights!;
    expect(w.contextTokens).toBe(0.05);
    expect(w.promptTokens).toBe(0.1);
    expect(w.codeLikelihood).toBe(0.25);
    expect(w.reasoningLikelihood).toBe(0.35);
    expect(w.keywordSignal).toBe(0.15);
    expect(w.toolSignal).toBe(0.1);
    expect(w.imageSignal).toBe(0);
    expect(BASE_CONFIG.thresholds).toEqual({ cheapMax: 0.15, simpleMax: 0.3, mediumMax: 0.8 });
  });

  it("scores ordered: reasoning > code > greeting, with sane tier placement", () => {
    const greeting = classifyPrompt(makeContext({ messages: [user("hi")] }), BASE_CONFIG);
    const code = classifyPrompt(
      makeContext({ messages: [user("write a function `parseConfig` in const typescript that handles async/await errors from an API endpoint")] }),
      BASE_CONFIG,
    );
    const reasoning = classifyPrompt(
      makeContext({ messages: [user("prove that P=NP is independent, derive the complexity analysis, think through the implications step by step")] }),
      BASE_CONFIG,
    );
    expect(greeting.complexityScore).toBeLessThan(code.complexityScore);
    expect(code.complexityScore).toBeLessThan(reasoning.complexityScore);
    // Ordinary code work lands in the balanced band, not the powerful tier.
    expect(code.complexityScore).toBeLessThanOrEqual(0.8);
    expect(greeting.complexityScore).toBeLessThan(0.15);
  });

  it("scores ordered: reasoning > greeting", () => {
    const greeting = classifyPrompt(makeContext({ messages: [user("hi")] }), BASE_CONFIG);
    const reasoning = classifyPrompt(
      makeContext({ messages: [user("prove that P=NP is independent, derive the complexity analysis, think through the implications step by step")] }),
      BASE_CONFIG,
    );
    expect(reasoning.complexityScore).toBeGreaterThan(greeting.complexityScore);
  });

  it("truncates prompt analysis at maxPromptTokens", () => {
    const raw = extractRawFeatures(
      makeContext({ messages: [user("a".repeat(1_000_000))] }),
      { maxPromptTokens: 100 },
    );
    expect(raw.promptTokens).toBeLessThanOrEqual(100);
  });
});

describe("matchRule", () => {
  const features = classifyPrompt(
    makeContext({ messages: [user("please debug this stack trace in the payment service")] }),
    BASE_CONFIG,
  );

  it("matches anyKeywords with user keywords escaped", () => {
    const rule = { id: "r1", match: { anyKeywords: ["stack trace"] }, route: "balanced" };
    expect(matchRule(rule, features, "please debug this stack trace in the payment service")).toBe(true);
    expect(matchRule(rule, features, "nothing relevant here")).toBe(false);
  });

  it("escapes regex metacharacters in user keywords", () => {
    const rule = { id: "r2", match: { anyKeywords: ["c++ (hard)?"] }, route: "balanced" };
    // Literal match, not regex interpretation.
    expect(matchRule(rule, features, "help with c++ (hard)? please")).toBe(true);
    expect(matchRule(rule, features, "cxxxx hard")).toBe(false);
  });

  it("requires allKeywords to all match", () => {
    const rule = { id: "r3", match: { allKeywords: ["debug", "payment"] }, route: "balanced" };
    expect(matchRule(rule, features, "please debug this stack trace in the payment service")).toBe(true);
    expect(matchRule(rule, features, "debug the payment")).toBe(true);
    expect(matchRule(rule, features, "just debug")).toBe(false);
  });

  it("honors numeric and boolean conditions", () => {
    expect(matchRule({ id: "r4", match: { minPromptTokens: 1 }, route: "r" }, features, "x")).toBe(true);
    expect(matchRule({ id: "r5", match: { minPromptTokens: 10_000 }, route: "r" }, features, "x")).toBe(false);
    const codeFeatures = classifyPrompt(
      makeContext({ messages: [user("fix this crash:\nTraceback (most recent call last):\n  at handler (src/app.ts)\nTypeError: cannot read property 'id'")] }),
      BASE_CONFIG,
    );
    expect(matchRule({ id: "r6", match: { code: true }, route: "r" }, codeFeatures, "x")).toBe(true);
    expect(matchRule({ id: "r7", match: { hasImages: true }, route: "r" }, features, "x")).toBe(false);
  });

  it("capability fields derive from features not the prompt", () => {
    const model = makeModel({ provider: "p", id: "m", input: ["text", "image"] });
    void model;
    const imageFeatures = classifyPrompt(
      makeContext({
        messages: [{ role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: "AA", mimeType: "image/png" }], timestamp: Date.now() }],
      }),
      BASE_CONFIG,
    );
    expect(matchRule({ id: "r8", match: { hasImages: true }, route: "r" }, imageFeatures, "look")).toBe(true);
  });
});
