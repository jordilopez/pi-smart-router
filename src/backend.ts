/**
 * Backend resolution for the Smart Router.
 *
 * Resolves backend models through pi's ModelRegistry (find + getProvider +
 * getApiKeyAndHeaders) for use by route() in the virtual model.
 * No delegation/streaming logic remains — pi streams natively from the
 * returned physical model.
 */

import type { Api, Model, ProviderHeaders, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { RouterError } from "./types.js";
import type { ResolvedBackend, RouterModelRegistry } from "./types.js";

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

/** Build the delegation model: same model with the resolved baseUrl applied. */
export function createDelegationModel(backend: ResolvedBackend): Model<Api> {
  return {
    ...backend.model,
    baseUrl: backend.baseUrl || backend.model.baseUrl,
  };
}

/**
 * Build stream options for delegation: forward all caller options and inject
 * the resolved apiKey/headers plus provider-level headers.
 *
 * Used by the LLM classifier backend (classifyWithLlm). Session attribution
 * headers for opencode/opencode-go providers are injected natively by pi core
 * (provider-attribution.ts), so no session-header handling happens here.
 */
export function buildStreamOptions(
  options: SimpleStreamOptions | undefined,
  backend: ResolvedBackend,
  /** Explicit session id for providers with session-based features (classifier path). */
  sessionId?: string,
): SimpleStreamOptions {
  const headers: ProviderHeaders = {
    ...(options?.headers ?? {}),
    ...(backend.headers ?? {}),
    ...(backend.provider.headers ?? {}),
  };

  return {
    ...(options ?? {}),
    apiKey: backend.apiKey ?? options?.apiKey,
    headers,
    // Keep StreamOptions.sessionId aligned with provider session features
    // (explicit caller value wins). Others ignore it.
    sessionId: options?.sessionId ?? sessionId,
  };
}

// ============================================================================
// Context-overflow detection (used by retry routing)
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

  // Effective base URL: the auth-resolved baseUrl wins when present (e.g.
  // OAuth-dynamic gateway endpoints), falling back to the model's static
  // catalog baseUrl. This matches pi's direct-provider behavior where
  // auth.baseUrl overrides the model URL.
  const baseUrl = auth.baseUrl || model.baseUrl;

  return {
    model,
    provider,
    apiKey: auth.apiKey,
    headers: auth.headers ?? undefined,
    baseUrl,
  };
}