/**
 * Shared test helpers: fake ModelRegistry / Provider implementations used to
 * exercise routing and stream delegation without network access.
 */

import type { Api, AssistantMessageEventStream, Context, Model, Provider, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ResolvedRequestAuth, RouterModelRegistry } from "../src/types.js";

export function makeModel(overrides: Partial<Model<Api>> & { provider: string; id: string }): Model<Api> {
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    api: overrides.api ?? "anthropic-messages",
    provider: overrides.provider,
    baseUrl: overrides.baseUrl ?? "https://backend.example.com",
    reasoning: overrides.reasoning ?? true,
    input: overrides.input ?? ["text"],
    cost: overrides.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: overrides.contextWindow ?? 200000,
    maxTokens: overrides.maxTokens ?? 64000,
    headers: overrides.headers,
  };
}

export interface FakeRegistryOptions {
  /** Backend models visible to the registry */
  models?: Model<Api>[];
  /** Providers considered unauthenticated */
  unauthenticated?: string[];
  /** Fixed auth result returned by getApiKeyAndHeaders */
  auth?: ResolvedRequestAuth;
  /** Providers to omit from getProvider */
  missingProviders?: string[];
  /** Observation hook for find() calls (for call-count assertions) */
  onFind?: (provider: string, modelId: string) => void;
  /** Provider headers returned by getProvider */
  providerHeaders?: Record<string, string | null>;
}

export class FakeRegistry implements RouterModelRegistry {
  readonly models: Model<Api>[];
  readonly unauthenticated: Set<string>;
  readonly missingProviders: Set<string>;
  auth: ResolvedRequestAuth;
  readonly onFind?: (provider: string, modelId: string) => void;
  providerHeaders?: Record<string, string | null>;
  findCalls = 0;

  constructor(options: FakeRegistryOptions = {}) {
    this.models = options.models ?? [];
    this.unauthenticated = new Set(options.unauthenticated ?? []);
    this.missingProviders = new Set(options.missingProviders ?? []);
    this.auth = options.auth ?? { ok: true, apiKey: "test-key", headers: { "x-test": "1" } };
    this.onFind = options.onFind;
    this.providerHeaders = options.providerHeaders;
  }

  find(provider: string, modelId: string): Model<Api> | undefined {
    this.findCalls++;
    this.onFind?.(provider, modelId);
    return this.models.find((m) => m.provider === provider && m.id === modelId);
  }

  getProvider(provider: string): Provider | undefined {
    if (this.missingProviders.has(provider)) return undefined;
    return makeFakeProvider({ headers: this.providerHeaders });
  }

  hasConfiguredAuth(model: Model<Api>): boolean {
    return !this.unauthenticated.has(model.provider);
  }

  async getApiKeyAndHeaders(_model: Model<Api>): Promise<ResolvedRequestAuth> {
    return this.auth;
  }

  getAvailable(): Model<Api>[] {
    return this.models;
  }
}

export interface FakeProviderCapture {
  calls: number;
  models: Model<Api>[];
  contexts: Context[];
  options: (SimpleStreamOptions | undefined)[];
  /** Handler producing the events for call N. Set per-test. */
  streamFactory?: (callIndex: number, context: Context) => AssistantMessageEventStream;
}

export function makeFakeProvider(
  capture?: Partial<FakeProviderCapture> & {
    headers?: Record<string, string | null>;
    /** Provider id (e.g. "opencode-go" to exercise session-header injection). */
    id?: string;
  },
): Provider {
  const cap: FakeProviderCapture = {
    calls: 0,
    models: [],
    contexts: [],
    options: [],
    ...capture,
  };
  if (!cap.streamFactory) {
    // Default: immediately emit a minimal successful stream.
    cap.streamFactory = () => {
      const stream = createAssistantMessageEventStream();
      stream.push({
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          content: [],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "m",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
          timestamp: Date.now(),
        },
      });
      stream.end();
      return stream;
    };
  }
  const provider = {
    id: capture?.id ?? "fake",
    name: "Fake",
    headers: capture?.headers,
    auth: {} as Provider["auth"],
    getModels: () => [] as Model<Api>[],
    streamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
      cap.calls++;
      cap.models.push(model);
      cap.contexts.push(context);
      cap.options.push(options);
      return cap.streamFactory ? cap.streamFactory(cap.calls - 1, context) : createAssistantMessageEventStream();
    },
  };
  (provider as unknown as Provider & { _capture: FakeProviderCapture })._capture = cap;
  return provider as unknown as Provider;
}

/** Get the capture object from a fake provider. */
export function captureOf(provider: Provider): FakeProviderCapture {
  return (provider as unknown as Provider & { _capture: FakeProviderCapture })._capture;
}

export function makeContext(overrides: Partial<Context> = {}): Context {
  return {
    systemPrompt: overrides.systemPrompt ?? "You are a helpful coding assistant.",
    messages: overrides.messages ?? [{ role: "user", content: "hello", timestamp: Date.now() }],
    tools: overrides.tools,
  };
}
