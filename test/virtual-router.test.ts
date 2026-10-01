/**
 * Tests for the virtual-model route handler (src/virtual-router.ts).
 *
 * Task 1 scope: the `reason` matrix for the happy path — user prompts run the
 * full pipeline (rules → classifier → thresholds), continuations stick to
 * `request.previous`, and thinking levels pass through per route config.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializeRouterState, routeRequest, shutdownRouterState } from "../src/virtual-router.js";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { BUILTIN_DEFAULTS, type SmartRouterConfig } from "../src/types.js";
import { FakeRegistry, makeContext, makeFakeProvider, makeModel } from "./helpers.js";

function testConfig(overrides: Partial<SmartRouterConfig> = {}): SmartRouterConfig {
  return {
    ...BUILTIN_DEFAULTS,
    routes: {
      fast: { model: "opencode-go/deepseek-v4-flash", reasoning: "preserve" },
      "cheap-code": { model: "opencode-go/mimo-v2.5", reasoning: "low" },
      balanced: { model: "opencode-go/gpt-5.6-luna", reasoning: "medium" },
      powerful: { model: "opencode-go/kimi-k3", reasoning: "high" },
      ...overrides.routes,
    },
    ...overrides,
  };
}

function makeCtx(registry: FakeRegistry) {
  return { modelRegistry: registry } as never;
}

function makeRequest(overrides: Record<string, unknown> = {}) {
  const fast = makeModel({ provider: "opencode-go", id: "deepseek-v4-flash" });
  return {
    model: makeModel({ provider: "pi-smart-router", id: "auto" }),
    thinkingLevel: "medium" as const,
    reason: "user" as const,
    messages: makeContext().messages,
    ...overrides,
    // Allow tests to omit `previous`/`failed` entirely.
  };
}

describe("routeRequest — reason: user", () => {
  beforeEach(() => {
    initializeRouterState({ config: testConfig() });
  });

  afterEach(() => {
    shutdownRouterState();
  });

  it("routes a simple prompt to the fast tier via heuristic thresholds", async () => {
    // Deterministic thresholds: any positive score lands in the cheap band.
    initializeRouterState({
      config: testConfig({ classifier: { thresholds: { cheapMax: 1, simpleMax: 1, mediumMax: 1 } } }),
    });
    const registry = new FakeRegistry({
      models: [
        makeModel({ provider: "opencode-go", id: "mimo-v2.5" }),
        makeModel({ provider: "opencode-go", id: "gpt-5.6-luna" }),
      ],
    });
    const route = await routeRequest(makeRequest(), makeCtx(registry));
    expect(route.model.id).toBe("mimo-v2.5");
    expect(route.model.provider).toBe("opencode-go");
    // Cheap-code route config reasoning "low" is returned as the thinking level.
    expect(route.thinkingLevel).toBe("low");
  });

  it("routes via the threshold band into the balanced route", async () => {
    // Deterministic thresholds: any positive score lands in the balanced band.
    initializeRouterState({
      config: testConfig({ classifier: { thresholds: { cheapMax: 0, simpleMax: 0, mediumMax: 1 } } }),
    });
    const registry = new FakeRegistry({
      models: [
        makeModel({ provider: "opencode-go", id: "deepseek-v4-flash" }),
        makeModel({ provider: "opencode-go", id: "gpt-5.6-luna" }),
      ],
    });
    const route = await routeRequest(
      makeRequest({
        messages: makeContext({
          messages: [
            {
              role: "user",
              timestamp: Date.now(),
              content: "We need to redesign the authentication architecture of the system.",
            },
          ],
        }).messages,
      }),
      makeCtx(registry),
    );
    expect(route.model.id).toBe("gpt-5.6-luna");
  });

  it("an explicit rule beats the threshold tier", async () => {
    // Deterministic thresholds: any positive score lands in the cheap band.
    initializeRouterState({
      config: testConfig({
        classifier: { thresholds: { cheapMax: 1, simpleMax: 1, mediumMax: 1 } },
        rules: [{ id: "typos", priority: 10, match: { anyKeywords: ["typo"] }, route: "cheap-code" }],
      }),
    });
    const registry = new FakeRegistry({
      models: [
        makeModel({ provider: "opencode-go", id: "deepseek-v4-flash" }),
        makeModel({ provider: "opencode-go", id: "mimo-v2.5" }),
        makeModel({ provider: "opencode-go", id: "gpt-5.6-luna" }),
      ],
    });
    const route = await routeRequest(
      makeRequest({
        messages: makeContext({
          messages: [{ role: "user", timestamp: Date.now(), content: "fix this typo in the readme please" }],
        }).messages,
      }),
      makeCtx(registry),
    );
    expect(route.model.id).toBe("mimo-v2.5");
    // Route config reasoning "low" is returned as the thinking level.
    expect(route.thinkingLevel).toBe("low");
  });

  it("a route with reasoning 'preserve' passes the selected level through", async () => {
    initializeRouterState({
      config: testConfig({
        rules: [{ id: "docs", priority: 10, match: { anyKeywords: ["readme"] }, route: "fast" }],
      }),
    });
    const registry = new FakeRegistry({
      models: [makeModel({ provider: "opencode-go", id: "deepseek-v4-flash" })],
    });
    const route = await routeRequest(
      makeRequest({
        thinkingLevel: "high",
        messages: makeContext({
          messages: [{ role: "user", timestamp: Date.now(), content: "update the readme" }],
        }).messages,
      }),
      makeCtx(registry),
    );
    expect(route.model.id).toBe("deepseek-v4-flash");
    expect(route.thinkingLevel).toBe("high");
  });

  it("returns a JSON-serializable router state describing the decision", async () => {
    // Deterministic thresholds: any positive score lands in the cheap band.
    initializeRouterState({
      config: testConfig({ classifier: { thresholds: { cheapMax: 1, simpleMax: 1, mediumMax: 1 } } }),
    });
    const registry = new FakeRegistry({
      models: [makeModel({ provider: "opencode-go", id: "mimo-v2.5" })],
    });
    const route = await routeRequest(makeRequest(), makeCtx(registry));
    expect(route.state).toBeDefined();
    expect(() => JSON.stringify(route.state)).not.toThrow();
    expect((route.state as Record<string, unknown>).backendModel).toBe("opencode-go/mimo-v2.5");
  });
});

describe("routeRequest — reason: continuation", () => {
  beforeEach(() => {
    initializeRouterState({ config: testConfig() });
  });

  afterEach(() => {
    shutdownRouterState();
  });

  it("sticks to request.previous without re-routing", async () => {
    const previousModel = makeModel({ provider: "opencode-go", id: "kimi-k3" });
    const registry = new FakeRegistry({
      models: [previousModel, makeModel({ provider: "opencode-go", id: "deepseek-v4-flash" })],
      onFind: () => {
        throw new Error("routeRequest must not consult the registry for continuations");
      },
    });
    const route = await routeRequest(
      makeRequest({
        reason: "continuation",
        previous: { model: previousModel, thinkingLevel: "high" },
        state: { backendModel: "opencode-go/kimi-k3", route: "powerful" },
      }),
      makeCtx(registry),
    );
    expect(route.model).toBe(previousModel);
    expect(route.thinkingLevel).toBe("high");
    expect(route.state).toEqual({ backendModel: "opencode-go/kimi-k3", route: "powerful" });
  });

  it("falls through to a fresh resolution when previous is absent", async () => {
    const registry = new FakeRegistry({
      models: [makeModel({ provider: "opencode-go", id: "deepseek-v4-flash" })],
    });
    const route = await routeRequest(makeRequest({ reason: "continuation" }), makeCtx(registry));
    expect(route.model.id).toBe("deepseek-v4-flash");
  });
});

// ============================================================================
// reason: "retry"
// ============================================================================

describe("routeRequest — reason: retry", () => {
  const balancedModel = makeModel({ provider: "opencode-go", id: "gpt-5.6-luna" });
  const fastModel = makeModel({ provider: "opencode-go", id: "deepseek-v4-flash" });
  const cheapModel = makeModel({ provider: "opencode-go", id: "mimo-v2.5" });

  function retryRegistry(): FakeRegistry {
    return new FakeRegistry({ models: [balancedModel, fastModel, cheapModel] });
  }

  function failedMessage(errorMessage: string) {
    return {
      role: "assistant" as const,
      content: [],
      api: "anthropic-messages" as const,
      provider: "opencode-go",
      model: "gpt-5.6-luna",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "error" as const,
      errorMessage,
      timestamp: Date.now(),
    };
  }

  beforeEach(() => {
    initializeRouterState({ config: testConfig() });
  });

  afterEach(() => {
    shutdownRouterState();
  });

  it("switches to the next fallback on a context-overflow failure", async () => {
    // failed.model is the balanced route's backend; defaultRoute is balanced.
    // On overflow the route must move off the full model to a fallback.
    const route = await routeRequest(
      makeRequest({
        reason: "retry",
        failed: { model: balancedModel, thinkingLevel: "medium", message: failedMessage("maximum context length exceeded") },
      }),
      makeCtx(retryRegistry()),
    );
    expect(route.model.id).not.toBe("gpt-5.6-luna");
    expect(route.model.id).toBe("deepseek-v4-flash"); // first fallback: fast
  });

  it("switches to the next fallback on a provider-overload failure", async () => {
    const route = await routeRequest(
      makeRequest({
        reason: "retry",
        failed: { model: balancedModel, thinkingLevel: "medium", message: failedMessage("provider is overloaded, try again later") },
      }),
      makeCtx(retryRegistry()),
    );
    expect(route.model.id).toBe("deepseek-v4-flash");
  });

  it("sticks to the failed model on a transient failure", async () => {
    const route = await routeRequest(
      makeRequest({
        reason: "retry",
        failed: { model: balancedModel, thinkingLevel: "medium", message: failedMessage("connection reset by peer") },
      }),
      makeCtx(retryRegistry()),
    );
    expect(route.model.id).toBe("gpt-5.6-luna");
  });

  it("keeps the router state when sticking to the failed model", async () => {
    const priorState = { backendModel: "opencode-go/gpt-5.6-luna", route: "balanced" };
    const route = await routeRequest(
      makeRequest({
        reason: "retry",
        state: priorState,
        failed: { model: balancedModel, thinkingLevel: "medium", message: failedMessage("connection reset by peer") },
      }),
      makeCtx(retryRegistry()),
    );
    expect(route.state).toEqual(priorState);
  });

  it("throws NO_FALLBACK_AVAILABLE when the failed model is the only backend", async () => {
    const registry = new FakeRegistry({ models: [balancedModel] });
    await expect(
      routeRequest(
        makeRequest({
          reason: "retry",
          failed: { model: balancedModel, thinkingLevel: "medium", message: failedMessage("provider is overloaded") },
        }),
        makeCtx(registry),
      ),
    ).rejects.toMatchObject({ code: "NO_FALLBACK_AVAILABLE" });
  });

  it("resolves fresh when failed is absent (router itself failed last time)", async () => {
    const route = await routeRequest(makeRequest({ reason: "retry" }), makeCtx(retryRegistry()));
    expect(route.model).toBeDefined();
  });
});

describe("routeRequest — retry footer updates", () => {
  it("publishes the fallback tier when a retry switches backends", async () => {
    const statuses: (string | undefined)[] = [];
    initializeRouterState({
      config: testConfig({
        routes: {
          fast: { model: "opencode-go/deepseek-v4-flash", reasoning: "preserve" },
          balanced: { model: "opencode-go/gpt-5.6-luna", reasoning: "medium" },
        },
        classifier: { thresholds: { cheapMax: 1, simpleMax: 1, mediumMax: 1 } },
      }),
      setStatus: (_key, text) => statuses.push(text),
    });
    const balancedModel = makeModel({ provider: "opencode-go", id: "gpt-5.6-luna" });
    const registry = new FakeRegistry({
      models: [balancedModel, makeModel({ provider: "opencode-go", id: "deepseek-v4-flash" })],
    });
    const route = await routeRequest(
      makeRequest({
        reason: "retry",
        failed: {
          model: balancedModel,
          thinkingLevel: "medium",
          message: {
            role: "assistant", content: [], api: "anthropic-messages", provider: "opencode-go", model: "gpt-5.6-luna",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "error", errorMessage: "maximum context length exceeded", timestamp: Date.now(),
          },
        },
      }),
      makeCtx(registry),
    );
    expect(route.model.id).toBe("deepseek-v4-flash");
    expect(statuses[statuses.length - 1]).toBe("⚡ fast · retry-fallback");
  });
});

// ============================================================================
// Classifier-first semantics: rules yield to the Jev verdict
// ============================================================================

describe("routeRequest — classifier-first rule interaction", () => {
  const ROUTE_MODELS = [
    makeModel({ provider: "opencode-go", id: "mimo-v2.5" }),
    makeModel({ provider: "opencode-go", id: "deepseek-v4-flash" }),
    makeModel({ provider: "opencode-go", id: "gpt-5.6-luna" }),
    makeModel({ provider: "opencode-go", id: "kimi-k3" }),
    makeModel({ provider: "openai", id: "gpt-4o-mini" }),
  ];

  function classifierRegistry(answer: string): FakeRegistry {
    const provider = makeFakeProvider({
      streamFactory: () => {
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "text_delta", contentIndex: 0, delta: answer, partial: { role: "assistant", content: [], api: "x", provider: "p", model: "m", usage: {} as never, stopReason: "pending", timestamp: 0 } });
        stream.end();
        return stream;
      },
    });
    return new FakeRegistry({ models: ROUTE_MODELS, stableProvider: provider });
  }

  function classifierConfig(): SmartRouterConfig {
    return testConfig({
      classifier: { model: "openai/gpt-4o-mini", timeoutMs: 1000 },
      rules: [{ id: "typos", priority: 100, match: { anyKeywords: ["typo"] }, route: "cheap-code" }],
    });
  }

  afterEach(() => shutdownRouterState());

  it("a Jev verdict overrides a matching rule", async () => {
    initializeRouterState({ config: classifierConfig() });
    const route = await routeRequest(
      makeRequest({
        messages: makeContext({ messages: [{ role: "user", timestamp: Date.now(), content: "fix this typo please" }] }).messages,
      }),
      makeCtx(classifierRegistry("powerful")),
    );
    // Rule would say cheap-code/mimo; the verdict says powerful.
    expect(route.model.id).toBe("kimi-k3");
  });

  it("rules apply when the classifier fails to produce a verdict", async () => {
    initializeRouterState({ config: classifierConfig() });
    const route = await routeRequest(
      makeRequest({
        messages: makeContext({ messages: [{ role: "user", timestamp: Date.now(), content: "fix this typo please" }] }).messages,
      }),
      makeCtx(classifierRegistry("I cannot answer that")),
    );
    expect(route.model.id).toBe("mimo-v2.5");
  });
});
