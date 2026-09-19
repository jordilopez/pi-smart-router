/**
 * Unit tests for the TypeSafe / Jev escalation client.
 *
 * The @typesafe-ai/sdk is fully mocked: these tests verify the request shape
 * we send (state, Choice question, model, timeout), the verdict handling, and
 * the never-throws failure philosophy. No network access.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mocks so the vi.mock factory below can reference them.
const mocks = vi.hoisted(() => ({
  systemOne: vi.fn(),
  clientConstructor: vi.fn(),
}));

vi.mock("@typesafe-ai/sdk", () => {
  class TypeSafeClient {
    constructor(config?: unknown) {
      mocks.clientConstructor(config);
    }
    systemOne(request: unknown, options?: unknown) {
      return mocks.systemOne(request, options);
    }
  }
  return {
    TypeSafeClient,
    choice: (instructions: unknown, criteria: unknown) => ({ type: "choice", instructions, criteria }),
  };
});

import { buildTypesafeClassifierState, resetTypesafeClient, typesafeEscalate } from "../src/typesafe-client.js";
import type { PromptFeatures } from "../src/types.js";
import { makeContext } from "./helpers.js";

// ============================================================================
// Fixtures
// ============================================================================

function makeFeatures(overrides: Partial<PromptFeatures> = {}): PromptFeatures {
  return {
    promptTokens: 10,
    contextTokens: 100,
    codeLikelihood: 0.1,
    reasoningLikelihood: 0.2,
    keywordSignal: 0.1,
    toolSignal: 0,
    imageSignal: 0,
    hasTools: false,
    hasImages: false,
    complexityScore: 0.2,
    ...overrides,
  };
}

/** Resolve systemOne with a Choice verdict. */
function resolveSystemOne(choiceLabel: string): void {
  mocks.systemOne.mockResolvedValue({
    model: "jev-latest",
    usage: { input_tokens: 12, output_tokens: 1 },
    answers: {
      tier: {
        type: "choice",
        choice: choiceLabel,
        confidence: 0.9,
        probabilities: { fast: choiceLabel === "fast" ? 0.9 : 0.1, balanced: choiceLabel === "balanced" ? 0.9 : 0.1 },
      },
    },
  });
}

beforeEach(() => {
  resetTypesafeClient();
  mocks.systemOne.mockReset();
  mocks.clientConstructor.mockReset();
});

// ============================================================================
// buildTypesafeClassifierState
// ============================================================================

describe("buildTypesafeClassifierState", () => {
  it("includes the latest user prompt and a role-tagged transcript", () => {
    const context = makeContext({
      messages: [
        { role: "user", content: "first question", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "an answer" }], api: "x", provider: "p", model: "m", usage: {} as never, stopReason: "stop", timestamp: 2 },
        { role: "user", content: "review this cache design", timestamp: 3 },
      ],
    });

    const state = buildTypesafeClassifierState(context, makeFeatures());

    expect(state.prompt).toContain("review this cache design");
    expect(state.transcript).toContain('role="user"');
    expect(state.transcript).toContain('role="assistant"');
    expect(state.transcript).toContain("first question");
    expect(state.transcript).toContain("an answer");
  });

  it("strips harness-injected skill bodies from the prompt", () => {
    const context = makeContext({
      messages: [
        {
          role: "user",
          content:
            '<skill name="planning" location="/x">HUGE SKILL BODY WITH CODE</skill>\n\njust rename the variable',
          timestamp: 1,
        },
      ],
    });

    const state = buildTypesafeClassifierState(context, makeFeatures());

    expect(state.prompt).toContain("just rename the variable");
    expect(state.prompt).not.toContain("HUGE SKILL BODY");
  });

  it("uses a placeholder when the prompt is empty", () => {
    const context = makeContext({ messages: [{ role: "user", content: "   ", timestamp: 1 }] });
    const state = buildTypesafeClassifierState(context, makeFeatures());
    expect(state.prompt).toBe("(empty)");
  });

  it("truncates an over-budget prompt", () => {
    const context = makeContext({
      messages: [{ role: "user", content: "x".repeat(6000), timestamp: 1 }],
    });
    const state = buildTypesafeClassifierState(context, makeFeatures());
    expect(state.prompt.endsWith("[truncated]")).toBe(true);
    expect(state.prompt.length).toBeLessThan(6000);
  });

  it("serializes heuristic signals as JSON", () => {
    const state = buildTypesafeClassifierState(
      makeContext(),
      makeFeatures({ codeLikelihood: 0.42, reasoningLikelihood: 0.77, hasTools: true }),
    );
    const signals = JSON.parse(state.heuristic_signals) as Record<string, unknown>;
    expect(signals.codeLikelihood).toBe(0.42);
    expect(signals.reasoningLikelihood).toBe(0.77);
    expect(signals.hasTools).toBe(true);
  });
});

// ============================================================================
// typesafeEscalate
// ============================================================================

describe("typesafeEscalate", () => {
  it("returns 'fast' when Jev selects the fast tier", async () => {
    resolveSystemOne("fast");
    const verdict = await typesafeEscalate(makeFeatures(), makeContext(), { timeoutMs: 1500 });
    expect(verdict).toBe("fast");
  });

  it("returns 'balanced' when Jev selects the balanced tier", async () => {
    resolveSystemOne("balanced");
    const verdict = await typesafeEscalate(makeFeatures(), makeContext(), { timeoutMs: 1500 });
    expect(verdict).toBe("balanced");
  });

  it("offers all four tiers", async () => {
    resolveSystemOne("fast");
    await typesafeEscalate(makeFeatures(), makeContext(), { timeoutMs: 1500 });

    const request = mocks.systemOne.mock.calls[0][0] as {
      questions: { tier: { type: string; criteria: Record<string, string> } };
      state: Record<string, string>;
    };
    expect(request.questions.tier.type).toBe("choice");
    expect(Object.keys(request.questions.tier.criteria)).toEqual(["cheap", "fast", "balanced", "powerful"]);
    expect(request.state).toHaveProperty("transcript");
    expect(request.state).toHaveProperty("prompt");
  });

  it("accepts a four-tier verdict", async () => {
    resolveSystemOne("powerful");
    await expect(typesafeEscalate(makeFeatures(), makeContext(), { timeoutMs: 1500 })).resolves.toBe("powerful");
  });

  it("uses the configured model and timeout", async () => {
    resolveSystemOne("fast");
    await typesafeEscalate(makeFeatures(), makeContext(), { timeoutMs: 2500, model: "jev-custom" });

    const request = mocks.systemOne.mock.calls[0][0] as { model: string };
    const options = mocks.systemOne.mock.calls[0][1] as { timeout: number; signal: AbortSignal };
    expect(request.model).toBe("jev-custom");
    expect(options.timeout).toBe(2500);
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("defaults the model to jev-latest", async () => {
    resolveSystemOne("fast");
    await typesafeEscalate(makeFeatures(), makeContext(), { timeoutMs: 1500 });
    const request = mocks.systemOne.mock.calls[0][0] as { model: string };
    expect(request.model).toBe("jev-latest");
  });

  it("returns null when the API call rejects (never throws)", async () => {
    mocks.systemOne.mockRejectedValue(new Error("network down"));
    await expect(typesafeEscalate(makeFeatures(), makeContext(), { timeoutMs: 1500 })).resolves.toBeNull();
  });

  it("returns null when the client cannot be created", async () => {
    mocks.clientConstructor.mockImplementation(() => {
      throw new Error("TYPESAFE_API_KEY missing");
    });
    await expect(typesafeEscalate(makeFeatures(), makeContext(), { timeoutMs: 1500 })).resolves.toBeNull();
    expect(mocks.systemOne).not.toHaveBeenCalled();
  });

  it("returns null for an unexpected verdict label", async () => {
    resolveSystemOne("medium");
    await expect(typesafeEscalate(makeFeatures(), makeContext(), { timeoutMs: 1500 })).resolves.toBeNull();
  });

  it("reuses the lazily-created client until reset", async () => {
    resolveSystemOne("fast");
    await typesafeEscalate(makeFeatures(), makeContext(), { timeoutMs: 1500 });
    await typesafeEscalate(makeFeatures(), makeContext(), { timeoutMs: 1500 });
    expect(mocks.clientConstructor).toHaveBeenCalledTimes(1);

    resetTypesafeClient();
    await typesafeEscalate(makeFeatures(), makeContext(), { timeoutMs: 1500 });
    expect(mocks.clientConstructor).toHaveBeenCalledTimes(2);
  });
});