/**
 * Backend delegation for the Smart Router.
 *
 * Resolves backend models through pi's ModelRegistry (find + getProvider +
 * getApiKeyAndHeaders), builds the delegation model/options, and streams
 * events from the backend provider's streamSimple with error normalization.
 */

import type { Api, AssistantMessageEvent, Context, Model, Provider, ProviderHeaders, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { RouterError } from "./types.js";
import type { ResolvedBackend, RouterModelRegistry } from "./types.js";

// ============================================================================
// OpenCode Go session header
// ============================================================================

/** Provider id that requires the x-opencode-session request header. */
export const OPENCODE_GO_PROVIDER_ID = "opencode-go";
/** Header Console Go requires so requests can be routed efficiently. */
export const OPENCODE_GO_SESSION_HEADER = "x-opencode-session";

/** Case-insensitive header presence check. */
function hasHeaderCaseInsensitive(headers: ProviderHeaders | undefined, name: string): boolean {
  if (!headers) return false;
  const lower = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

/**
 * The stable session id used for backend requests. An explicit
 * `options.sessionId` from the caller wins; otherwise the captured Pi session
 * id is used. Never a random per-request id - the value is stable for the Pi
 * session (and therefore across tool continuations within it).
 */
export function resolveRouterSessionId(
  options: SimpleStreamOptions | undefined,
  routerSessionId: string | undefined,
): string | undefined {
  return options?.sessionId ?? routerSessionId;
}

// ============================================================================
// Backend resolution
// ============================================================================

/** Parse a "provider/modelId" reference. Throws on malformed refs. */
export function parseModelRef(modelRef: string): { providerId: string; modelId: string } {
  const slashIndex = modelRef.indexOf("/");
  const providerId = slashIndex > 0 ? modelRef.slice(0, slashIndex) : "";
  const modelId = slashIndex > 0 ? modelRef.slice(slashIndex + 1) : "";
  if (!providerId || !modelId) {
    throw new RouterError(
      "BACKEND_MODEL_NOT_FOUND",
      `Invalid model reference format: '${modelRef}'. Expected 'provider/modelId'`,
    );
  }
  return { providerId, modelId };
}

/**
 * Resolve a backend model reference through pi's model registry.
 * Throws RouterError when the model/provider is missing or auth is not
 * configured / fails to resolve.
 */
export async function resolveBackend(
  registry: RouterModelRegistry,
  modelRef: string,
): Promise<ResolvedBackend> {
  const { providerId, modelId } = parseModelRef(modelRef);

  const model = registry.find(providerId, modelId);
  if (!model) {
    const available = registry
      .getAvailable()
      .map((m) => `${m.provider}/${m.id}`)
      .join(", ");
    throw new RouterError(
      "BACKEND_MODEL_NOT_FOUND",
      `Model not found in registry: ${providerId}/${modelId}.${available ? ` Available: ${available}` : ""}`,
      { modelRef },
    );
  }

  const provider = registry.getProvider(providerId);
  if (!provider) {
    throw new RouterError("BACKEND_PROVIDER_NOT_FOUND", `Provider not found in registry: ${providerId}`, {
      modelRef,
    });
  }

  if (!registry.hasConfiguredAuth(model)) {
    throw new RouterError(
      "BACKEND_AUTH_MISSING",
      `No credentials configured for provider '${providerId}' (model ${providerId}/${modelId}). Run '/login ${providerId}' or set its API key in models.json/environment.`,
      { modelRef, provider: providerId },
    );
  }

  const auth = await registry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    throw new RouterError(
      "BACKEND_AUTH_MISSING",
      `Auth resolution failed for ${providerId}/${modelId}: ${auth.error}`,
      { modelRef, provider: providerId },
    );
  }

  // Effective base URL: the model's own baseUrl wins, otherwise the
  // auth-resolved baseUrl (e.g. gateway/OAuth endpoints).
  const baseUrl = model.baseUrl || auth.baseUrl;

  return {
    model,
    provider,
    apiKey: auth.apiKey,
    headers: auth.headers ?? undefined,
    baseUrl,
  };
}

/** Build the delegation model: same model with the resolved baseUrl applied. */
export function createDelegationModel(backend: ResolvedBackend): Model<Api> {
  return {
    ...backend.model,
    baseUrl: backend.baseUrl || backend.model.baseUrl,
  };
}

/**
 * Build stream options for delegation: forward all caller options (signal,
 * maxTokens, temperature, samplingParams, sessionId, cacheRetention,
 * onPayload, onResponse, toolChoice, thinkingBudgets, ...) and inject the
 * resolved apiKey/headers plus provider-level headers.
 */
export function buildStreamOptions(
  options: SimpleStreamOptions | undefined,
  backend: ResolvedBackend,
  routerSessionId?: string,
): SimpleStreamOptions {
  const headers: ProviderHeaders = {
    ...(options?.headers ?? {}),
    ...(backend.headers ?? {}),
    ...(backend.provider.headers ?? {}),
  };

  // Stable session id: explicit caller value first, then the captured Pi
  // session id. Console Go (opencode-go) rejects requests without
  // x-opencode-session, so inject it whenever we have a session id and the
  // caller did not already supply one. Other providers are untouched.
  const sessionId = resolveRouterSessionId(options, routerSessionId);
  if (
    backend.provider.id === OPENCODE_GO_PROVIDER_ID &&
    sessionId &&
    !hasHeaderCaseInsensitive(headers, OPENCODE_GO_SESSION_HEADER)
  ) {
    headers[OPENCODE_GO_SESSION_HEADER] = sessionId;
  }

  return {
    ...(options ?? {}),
    apiKey: backend.apiKey ?? options?.apiKey,
    headers,
    // Keep StreamOptions.sessionId aligned with the header value (explicit
    // caller value wins). Providers that support session-based features use
    // it; others ignore it.
    sessionId: options?.sessionId ?? sessionId,
  };
}

// ============================================================================
// Delegation with error normalization
// ============================================================================

const CONTEXT_OVERFLOW_PATTERNS = [
  "context_length_exceeded",
  "exceeds the context window",
  "maximum context length",
  "too many tokens",
];

/** Whether an error message looks like a context-overflow error. */
export function isContextOverflowError(message: string): boolean {
  const lower = message.toLowerCase();
  return CONTEXT_OVERFLOW_PATTERNS.some((p) => lower.includes(p));
}

/** Prefix error messages so pi's auto-compaction recognizes context overflow. */
export function normalizeBackendError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (isContextOverflowError(message)) {
    return new Error(`context_length_exceeded: ${message}`);
  }
  return error instanceof Error ? error : new Error(message);
}

/**
 * Delegate to a backend provider's streamSimple and yield all events.
 * Backend throws are normalized (context-overflow messages get the
 * `context_length_exceeded:` prefix so pi's auto-compaction recognizes them).
 */
export async function* delegateToBackend(
  provider: Provider,
  delegationModel: Model<Api>,
  context: Context,
  streamOptions: SimpleStreamOptions,
): AsyncGenerator<AssistantMessageEvent, void, unknown> {
  try {
    let inner: AsyncIterable<AssistantMessageEvent>;
    try {
      inner = provider.streamSimple(delegationModel, context, streamOptions);
    } catch (error) {
      // Synchronous setup errors (e.g. missing auth) thrown by streamSimple.
      throw normalizeBackendError(error);
    }

    for await (const event of inner) {
      yield event;
    }
  } catch (error) {
    // Normalize mid-stream failures (e.g. context overflow) before they
    // propagate to the router's stream handler.
    throw normalizeBackendError(error);
  }
}
