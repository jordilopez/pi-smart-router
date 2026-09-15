import { describe, expect, it } from "vitest";
import { createDelegationModel, resolveBackend } from "../src/backend.js";
import { FakeRegistry, makeModel } from "./helpers.js";

function registryFor(authBaseUrl?: string): FakeRegistry {
  return new FakeRegistry({
    models: [
      makeModel({
        provider: "github-copilot",
        id: "gpt-5.6-sol",
        baseUrl: "https://api.githubcopilot.com",
      }),
    ],
    auth: { ok: true, apiKey: "test-key", headers: {}, baseUrl: authBaseUrl },
  });
}

describe("resolveBackend: baseUrl precedence", () => {
  it("uses model.baseUrl when auth has no baseUrl", async () => {
    const backend = await resolveBackend(registryFor(undefined), "github-copilot/gpt-5.6-sol");
    expect(backend.baseUrl).toBe("https://api.githubcopilot.com");
  });

  it("prefers auth.baseUrl over model.baseUrl when auth resolves a URL", async () => {
    // GitHub Copilot OAuth may return a dynamic gateway endpoint through auth.
    const backend = await resolveBackend(registryFor("https://copilot-proxy.github.com"), "github-copilot/gpt-5.6-sol");
    expect(backend.baseUrl).toBe("https://copilot-proxy.github.com");
  });

  it("createDelegationModel uses the resolved baseUrl from the backend", async () => {
    const backend = await resolveBackend(registryFor("https://copilot-proxy.github.com"), "github-copilot/gpt-5.6-sol");
    const delegation = createDelegationModel(backend);
    expect(delegation.baseUrl).toBe("https://copilot-proxy.github.com");
  });

  it("createDelegationModel falls back to model.baseUrl when backend has none", async () => {
    const backend = await resolveBackend(registryFor(undefined), "github-copilot/gpt-5.6-sol");
    const delegation = createDelegationModel(backend);
    expect(delegation.baseUrl).toBe("https://api.githubcopilot.com");
  });
});