/**
 * Provider/auth compatibility guards shared by catalog setup and runtime routing.
 *
 * Pi's static OpenAI catalog includes API-only model variants even when the
 * provider is authenticated with a ChatGPT OAuth credential. Those models are
 * visible to classification but rejected by the API at request time.
 */

export interface ProviderAuthInfo {
  /** True when the provider is currently backed by OAuth rather than an API key. */
  isUsingOAuth?: (model: any) => boolean;
  /** Resolve the host model so auth detectors that accept Model objects can be used. */
  find?: (provider: string, modelId: string) => any;
}

/**
 * OpenAI's ChatGPT OAuth endpoint does not accept the API-only mini/nano model
 * variants. Keep this deliberately narrow: other providers and OpenAI API-key
 * authentication use the normal catalog unchanged.
 */
const OPENAI_CHATGPT_OAUTH_UNSUPPORTED = /(?:^|[-.])(mini|nano)(?:$|[-.])/i;

/** Whether a provider/model can be used with the currently configured auth. */
export function isModelCompatibleWithCurrentAuth(
  provider: string,
  modelId: string,
  auth?: ProviderAuthInfo,
): boolean {
  return !(
    provider.toLowerCase() === "openai" &&
    auth?.isUsingOAuth?.(auth.find?.(provider, modelId) ?? { provider, id: modelId }) === true &&
    OPENAI_CHATGPT_OAUTH_UNSUPPORTED.test(modelId)
  );
}

/** Remove catalog entries that the current provider credential cannot serve. */
export function filterModelsForCurrentAuth<T extends { provider: string; model: string }>(
  models: T[],
  auth?: ProviderAuthInfo,
): T[] {
  return models.filter((model) =>
    isModelCompatibleWithCurrentAuth(model.provider, model.model, auth),
  );
}
