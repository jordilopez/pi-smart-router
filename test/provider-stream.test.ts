import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { buildStreamOptions } from "../src/backend.js";
import { STATUS_KEY } from "../src/provider.js";
import {
  getRouterState,
  onTurnStart,
  setRouterStateForTesting,
  shutdownRouter,
  streamSmartRouter,
} from "../src/provider.js";
import type { SmartRouterConfig } from "../src/types.js";
import { FakeRegistry, captureOf, makeContext, makeModel, makeFakeProvider } from "./helpers.js";
import type { Context } from "@earendil-works/pi-ai";

const CONFIG: SmartRouterConfig = {
  version: 1,
  defaultRoute: "balanced",
  routes: {
    fast: { model: "openai/gpt-4o-mini" },
    "cheap-code": { model: "opencode-go/mimo-v2.5" },
    balanced: { model: "anthropic/claude-sonnet-4-5" },
    powerful: { model: "anthropic/claude-opus-4-5", reasoning: "high", maxTokens: 4096 },
  },
  // powerful intentionally excluded from fallbacks.
  fallbacks: ["fast", "cheap-code"],
  observability: { showRouteStatus: false, logDecisions: false },
};

/** Collect all events from a stream until it terminates. */
async function drain(stream: AsyncIterable<any>): Promise<any[]> {
  const events: any[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

/** Emit a standard successful sequence from a fake backend. */
function emitSequence(stream: ReturnType<typeof createAssistantMessageEventStream>): void {
  const message = {
    role: "assistant" as const,
    content: [],
    api: "anthropic-messages" as const,
    provider: "anthropic" as const,
    model: "claude-sonnet-4-5",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
  stream.push({ type: "start", partial: { ...message, content: [] } });
  stream.push({ type: "thinking_start", contentIndex: 0, partial: { ...message, content: [] } });
  stream.push({ type: "thinking_delta", contentIndex: 0, delta: "hmm", partial: { ...message, content: [] } });
  stream.push({ type: "text_start", contentIndex: 1, partial: { ...message, content: [] } });
  stream.push({ type: "text_delta", contentIndex: 1, delta: "hello", partial: { ...message, content: [] } });
  stream.push({
    type: "toolcall_start",
    contentIndex: 2,
    partial: { ...message, content: [] },
  });
  stream.push({ type: "toolcall_delta", contentIndex: 2, delta: "{}", partial: { ...message, content: [] } });
  stream.push({ type: "done", reason: "stop", message });
  stream.end();
}

let registry: FakeRegistry;
let provider: ReturnType<typeof makeFakeProvider>;

function fullSequenceProvider(): ReturnType<typeof makeFakeProvider> {
  return makeFakeProvider({
    streamFactory: () => {
      const stream = createAssistantMessageEventStream();
      emitSequence(stream);
      return stream;
    },
  });
}

beforeEach(() => {
  const backendModel = makeModel({ provider: "anthropic", id: "claude-sonnet-4-5" });
  provider = fullSequenceProvider();
  registry = new FakeRegistry({
    models: [
      backendModel,
      makeModel({ provider: "openai", id: "gpt-4o-mini" }),
      makeModel({ provider: "opencode-go", id: "mimo-v2.5" }),
      makeModel({ provider: "anthropic", id: "claude-opus-4-5", maxTokens: 8192 }),
    ],
  });
  // Make getProvider return our instrumented fake provider.
  (registry as any).getProvider = () => provider;
  setRouterStateForTesting({ config: CONFIG, registry, turnNumber: 1, sessionId: "pi-session-abc" });
});

describe("route visibility (footer status)", () => {
  const statusCalls: Array<[string, string | undefined]> = [];
  const setStatus = (key: string, text: string | undefined) => void statusCalls.push([key, text]);

  beforeEach(() => {
    statusCalls.length = 0;
    setRouterStateForTesting({
      config: CONFIG,
      registry,
      turnNumber: 1,
      sessionId: "pi-session-abc",
      setStatus,
    });
  });

  it("emits exactly one footer status per route decision, no duplicates", async () => {
    const routerModel = makeModel({ provider: "smart-router", id: "auto" });
    await drain(streamSmartRouter(routerModel, makeContext()));
    await drain(streamSmartRouter(routerModel, makeContext()));
    await drain(streamSmartRouter(routerModel, makeContext()));

    // One status update (the decision), no duplicates across tool-continuation-
    // style repeats of the same turn.
    expect(statusCalls).toHaveLength(1);
    expect(statusCalls[0][0]).toBe(STATUS_KEY);
    expect(statusCalls[0][1]).toContain("cheap-code");
    expect(statusCalls[0][1]).toContain("opencode-go/mimo-v2.5");
    expect(statusCalls[0][1]).not.toContain(makeContext().messages[0].content); // no raw prompt
  });

  it("status fires again on a new turn with the new decision", async () => {
    const routerModel = makeModel({ provider: "smart-router", id: "auto" });
    await drain(streamSmartRouter(routerModel, makeContext()));
    onTurnStart();
    await drain(streamSmartRouter(routerModel, makeContext()));
    expect(statusCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("turn_start sets the neutral classifying status", () => {
    onTurnStart();
    expect(statusCalls.at(-1)).toEqual([STATUS_KEY, "router: classifying…"]);
  });

  it("shutdown clears the footer status", () => {
    shutdownRouter();
    expect(statusCalls.at(-1)).toEqual([STATUS_KEY, undefined]);
    expect(getRouterState()).toBeNull();
  });
});

afterEach(() => {
  setRouterStateForTesting(null);
});

describe("streamSmartRouter: delegation", () => {
  it("forwards the context unchanged and injects apiKey/headers", async () => {
    const context: Context = makeContext({ messages: [{ role: "user", content: "hello there", timestamp: Date.now() }] });
    const events = await drain(streamSmartRouter(makeModel({ provider: "smart-router", id: "auto" }), context, { maxTokens: 1234 }));

    expect(events.map((e) => e.type)).toEqual(["start", "thinking_start", "thinking_delta", "text_start", "text_delta", "toolcall_start", "toolcall_delta", "done"]);

    const cap = captureOf(provider);
    expect(cap.calls).toBe(1);
    // Context object passed through by reference.
    expect(cap.contexts[0]).toBe(context);
    // Auth-injected options.
    const opts = cap.options[0]!;
    expect(opts.apiKey).toBe("test-key");
    expect(opts.headers).toMatchObject({ "x-test": "1" });
    expect(opts.maxTokens).toBe(1234);
    // Delegation model is the backend model with resolved baseUrl. The
    // short "hello there" prompt classifies into the cheap tier.
    expect(cap.models[0].provider).toBe("opencode-go");
    expect(cap.models[0].id).toBe("mimo-v2.5");
  });

  it("merges provider-level headers into options", async () => {
    (provider as any).headers = { "x-provider": "p1" };
    registry.providerHeaders = { "x-provider": "p1" };
    await drain(streamSmartRouter(makeModel({ provider: "smart-router", id: "auto" }), makeContext()));
    const opts = captureOf(provider).options[0]!;
    expect(opts.headers?.["x-provider"]).toBe("p1");
  });

  it("applies route maxTokens and reasoning", async () => {
    // Force the powerful route via a rule.
    const cfg: SmartRouterConfig = {
      ...CONFIG,
      rules: [{ id: "deep", priority: 10, match: { minComplexity: 0 }, route: "powerful" }],
    };
    setRouterStateForTesting({ config: cfg, registry, turnNumber: 1 });
    await drain(streamSmartRouter(makeModel({ provider: "smart-router", id: "auto" }), makeContext(), { maxTokens: 100 }));
    const opts = captureOf(provider).options[0]!;
    expect(opts.maxTokens).toBe(4096); // route override wins
    expect(opts.reasoning).toBe("high");
  });
});

describe("streamSmartRouter: turn route caching", () => {
  it("reuses the same route decision within a turn (single classify)", async () => {
    const findSpy: string[] = [];
    const spyRegistry = new FakeRegistry({
      models: [
        makeModel({ provider: "anthropic", id: "claude-sonnet-4-5" }),
        makeModel({ provider: "openai", id: "gpt-4o-mini" }),
        makeModel({ provider: "opencode-go", id: "mimo-v2.5" }),
      ],
      onFind: (p, m) => findSpy.push(`${p}/${m}`),
    });
    (spyRegistry as any).getProvider = () => provider;
    setRouterStateForTesting({ config: CONFIG, registry: spyRegistry, turnNumber: 1 });

    const routerModel = makeModel({ provider: "smart-router", id: "auto" });
    await drain(streamSmartRouter(routerModel, makeContext()));
    await drain(streamSmartRouter(routerModel, makeContext()));
    await drain(streamSmartRouter(routerModel, makeContext()));

    // classify+resolve runs once (1 registry.find) even though the backend is
    // delegated to three times (resolveBackend does 1 find per call).
    expect(findSpy.length).toBe(4); // 1 resolve + 3 delegations
    expect(captureOf(provider).calls).toBe(3);
    expect(getRouterState()?.turnNumber).toBe(1);
  });

  it("turn_start resets the cached route (re-classifies next call)", async () => {
    const findSpy: string[] = [];
    const spyRegistry = new FakeRegistry({
      models: [
        makeModel({ provider: "anthropic", id: "claude-sonnet-4-5" }),
        makeModel({ provider: "openai", id: "gpt-4o-mini" }),
        makeModel({ provider: "opencode-go", id: "mimo-v2.5" }),
      ],
      onFind: (p, m) => findSpy.push(`${p}/${m}`),
    });
    (spyRegistry as any).getProvider = () => provider;
    setRouterStateForTesting({ config: CONFIG, registry: spyRegistry, turnNumber: 1 });

    const routerModel = makeModel({ provider: "smart-router", id: "auto" });
    await drain(streamSmartRouter(routerModel, makeContext()));
    onTurnStart();
    await drain(streamSmartRouter(routerModel, makeContext()));
    expect(findSpy.length).toBe(4); // (1 resolve + 1 delegation) per turn
    expect(getRouterState()?.turnNumber).toBe(2);
  });

  it("fallback heuristic: a new user prompt without turn_start re-classifies", async () => {
    const findSpy: string[] = [];
    const spyRegistry = new FakeRegistry({
      models: [
        makeModel({ provider: "anthropic", id: "claude-sonnet-4-5" }),
        makeModel({ provider: "openai", id: "gpt-4o-mini" }),
        makeModel({ provider: "opencode-go", id: "mimo-v2.5" }),
      ],
      onFind: (p, m) => findSpy.push(`${p}/${m}`),
    });
    (spyRegistry as any).getProvider = () => provider;
    setRouterStateForTesting({ config: CONFIG, registry: spyRegistry, turnNumber: 1 });

    const routerModel = makeModel({ provider: "smart-router", id: "auto" });
    await drain(streamSmartRouter(routerModel, makeContext()));
    // New turn simulated without onTurnStart: context gains a user message.
    await drain(streamSmartRouter(routerModel, makeContext({ messages: [
      { role: "user", content: "hello", timestamp: Date.now() },
      { role: "assistant", content: [], api: "anthropic-messages", provider: "anthropic", model: "m", usage: {} as never, stopReason: "stop", timestamp: 0 },
      { role: "user", content: "next question", timestamp: Date.now() },
    ] })));
    expect(findSpy.length).toBe(4); // (1 resolve + 1 delegation) per classification
  });
});

describe("streamSmartRouter: errors", () => {
  it("normalizes context-overflow errors with the pi-recognized prefix", async () => {
    const throwing = makeFakeProvider({
      streamFactory: () =>
        (async function* () {
          yield { type: "start", partial: {} as never };
          throw new Error("This model's maximum context length is 200000 tokens");
        })() as never,
    });
    (registry as any).getProvider = () => throwing;

    const events = await drain(streamSmartRouter(makeModel({ provider: "smart-router", id: "auto" }), makeContext()));
    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent.error.errorMessage).toMatch(/^context_length_exceeded: /);
    expect(errorEvent.error.stopReason).toBe("error");
    // No fallback attempted: only one delegation call was made.
    expect(captureOf(throwing).calls).toBe(1);
  });

  it("reports a NO_FALLBACK_AVAILABLE RouterError in the stream", async () => {
    const cfg: SmartRouterConfig = {
      ...CONFIG,
      routes: { balanced: { model: "ghost/missing-model" } },
      fallbacks: [],
    };
    setRouterStateForTesting({ config: cfg, registry, turnNumber: 1 });
    const events = await drain(streamSmartRouter(makeModel({ provider: "smart-router", id: "auto" }), makeContext()));
    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent.error.errorMessage).toContain("No compatible backend model available");
  });

  it("reports failed auth resolution as BACKEND_AUTH_MISSING in the stream", async () => {
    registry.auth = { ok: false, error: "no credentials found" };
    const events = await drain(streamSmartRouter(makeModel({ provider: "smart-router", id: "auto" }), makeContext()));
    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent.error.errorMessage).toContain("Auth resolution failed");
    expect(errorEvent.error.errorMessage).toContain("no credentials found");
  });

  it("does not re-delegate after a mid-stream error (no fallback post-content)", async () => {
    let calls = 0;
    const once = makeFakeProvider({
      streamFactory: () => {
        calls++;
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          stream.push({ type: "start", partial: {} as never });
          stream.push({ type: "text_delta", contentIndex: 0, delta: "partial answer", partial: {} as never });
          stream.push({
            type: "error",
            reason: "error",
            error: {
              role: "assistant",
              content: [],
              api: "anthropic-messages",
              provider: "anthropic",
              model: "claude-sonnet-4-5",
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              stopReason: "error",
              errorMessage: "backend blew up",
              timestamp: Date.now(),
            },
          });
          stream.end();
        });
        return stream;
      },
    });
    (registry as any).getProvider = () => once;

    const events = await drain(streamSmartRouter(makeModel({ provider: "smart-router", id: "auto" }), makeContext()));
    // The backend error event is forwarded as-is; no second delegation/fallback.
    expect(events.some((e) => e.type === "text_delta")).toBe(true);
    expect(events.some((e) => e.type === "error" && e.error.errorMessage === "backend blew up")).toBe(true);
    expect(calls).toBe(1);
  });
});

describe("OpenCode Go session header", () => {
  it("injects x-opencode-session for opencode-go from the captured Pi session id", async () => {
    // The short prompt routes to the cheap tier (opencode-go/mimo-v2.5).
    const ogProvider = makeFakeProvider({ id: "opencode-go" });
    (registry as any).getProvider = () => ogProvider;

    await drain(streamSmartRouter(makeModel({ provider: "smart-router", id: "auto" }), makeContext()));
    const opts = captureOf(ogProvider).options[0]!;
    expect(opts.headers?.["x-opencode-session"]).toBe("pi-session-abc");
    // StreamOptions.sessionId stays aligned with the header value.
    expect(opts.sessionId).toBe("pi-session-abc");
  });

  it("preserves an explicitly supplied x-opencode-session header", async () => {
    const ogProvider = makeFakeProvider({ id: "opencode-go" });
    (registry as any).getProvider = () => ogProvider;

    await drain(
      streamSmartRouter(
        makeModel({ provider: "smart-router", id: "auto" }),
        makeContext(),
        { headers: { "x-opencode-session": "caller-header-id" } },
      ),
    );
    const opts = captureOf(ogProvider).options[0]!;
    expect(opts.headers?.["x-opencode-session"]).toBe("caller-header-id");
  });

  it("prefers an explicit options.sessionId over the captured Pi session id", async () => {
    const ogProvider = makeFakeProvider({ id: "opencode-go" });
    (registry as any).getProvider = () => ogProvider;

    await drain(
      streamSmartRouter(
        makeModel({ provider: "smart-router", id: "auto" }),
        makeContext(),
        { sessionId: "explicit-session-id" },
      ),
    );
    const opts = captureOf(ogProvider).options[0]!;
    expect(opts.headers?.["x-opencode-session"]).toBe("explicit-session-id");
    expect(opts.sessionId).toBe("explicit-session-id");
  });

  it("does not inject the header for non-opencode-go providers", async () => {
    // Force the balanced route (anthropic/claude-sonnet-4-5).
    const cfg: SmartRouterConfig = {
      ...CONFIG,
      rules: [{ id: "to-anthropic", priority: 10, match: { minComplexity: 0 }, route: "balanced" }],
    };
    setRouterStateForTesting({ config: cfg, registry, turnNumber: 1, sessionId: "pi-session-abc" });
    const cap = captureOf(provider);
    await drain(streamSmartRouter(makeModel({ provider: "smart-router", id: "auto" }), makeContext()));
    const opts = cap.options[0]!;
    expect(opts.headers?.["x-opencode-session"]).toBeUndefined();
  });

  it("header value is stable across tool continuations within a turn", async () => {
    const ogProvider = makeFakeProvider({ id: "opencode-go" });
    const spyRegistry = new FakeRegistry({
      models: [
        makeModel({ provider: "anthropic", id: "claude-sonnet-4-5" }),
        makeModel({ provider: "openai", id: "gpt-4o-mini" }),
        makeModel({ provider: "opencode-go", id: "mimo-v2.5" }),
      ],
    });
    (spyRegistry as any).getProvider = () => ogProvider;
    setRouterStateForTesting({ config: CONFIG, registry: spyRegistry, turnNumber: 1, sessionId: "pi-session-abc" });

    const routerModel = makeModel({ provider: "smart-router", id: "auto" });
    await drain(streamSmartRouter(routerModel, makeContext()));
    const ctxB: Context = {
      ...makeContext(),
      messages: [
        { role: "user", content: "hello", timestamp: Date.now() },
        {
          role: "toolResult",
          toolCallId: "t1",
          toolName: "bash",
          content: [{ type: "text", text: "ok" }],
          isError: false,
          timestamp: Date.now(),
        },
      ],
    };
    await drain(streamSmartRouter(routerModel, ctxB));

    const cap = captureOf(ogProvider);
    expect(cap.calls).toBe(2);
    expect(cap.options[0]?.headers?.["x-opencode-session"]).toBe("pi-session-abc");
    expect(cap.options[1]?.headers?.["x-opencode-session"]).toBe("pi-session-abc");
  });

  it("buildStreamOptions produces the same header value on repeated builds", () => {
    const ogBackend = {
      model: makeModel({ provider: "opencode-go", id: "mimo-v2.5" }),
      provider: makeFakeProvider({ id: "opencode-go" }),
      apiKey: "k",
      headers: undefined,
      baseUrl: "https://x",
    };
    const first = buildStreamOptions(undefined, ogBackend, "pi-session-abc");
    const second = buildStreamOptions(undefined, ogBackend, "pi-session-abc");
    expect(first.headers?.["x-opencode-session"]).toBe("pi-session-abc");
    expect(second.headers?.["x-opencode-session"]).toBe("pi-session-abc");
  });
});

describe("streamSmartRouter: uninitialized", () => {
  it("emits an error event when the router has no registry", async () => {
    setRouterStateForTesting(null);
    const events = await drain(streamSmartRouter(makeModel({ provider: "smart-router", id: "auto" }), makeContext()));
    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent.error.errorMessage).toContain("not initialized");
  });
});

describe("route decision reuse", () => {
  it("reuses the exact decision object during the same turn", async () => {
    const spyRegistry = new FakeRegistry({
      models: [
        makeModel({ provider: "anthropic", id: "claude-sonnet-4-5" }),
        makeModel({ provider: "openai", id: "gpt-4o-mini" }),
        makeModel({ provider: "opencode-go", id: "mimo-v2.5" }),
      ],
    });
    (spyRegistry as any).getProvider = () => provider;
    setRouterStateForTesting({ config: CONFIG, registry: spyRegistry, turnNumber: 1 });

    const routerModel = makeModel({ provider: "smart-router", id: "auto" });
    const ctxA = makeContext({ messages: [{ role: "user", content: "write code with a function", timestamp: Date.now() }] });
    await drain(streamSmartRouter(routerModel, ctxA));
    // Second call with toolResult continuation reuses the cached route.
    const ctxB: Context = {
      ...ctxA,
      messages: [
        ...ctxA.messages,
        {
          role: "toolResult",
          toolCallId: "t1",
          toolName: "bash",
          content: [{ type: "text", text: "ok" }],
          isError: false,
          timestamp: Date.now(),
        },
      ],
    };
    await drain(streamSmartRouter(routerModel, ctxB));
    // classify+resolve ran once: the toolResult continuation reused the route
    // (2 delegations + 1 resolve = 3 finds total).
    expect(spyRegistry.findCalls).toBe(3);
  });
});
