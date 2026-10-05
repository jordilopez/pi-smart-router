/**
 * Integration tests for the smart-router-setup-tiers tool.
 * Mocks `pi --list-models` (child_process) and the TypeSafe SDK.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() =>
  vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (err: unknown, out: { stdout: string }) => void) => {
    cb(null, { stdout: LIST_TABLE });
  }),
);

const systemOneMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ execFile: execFileMock }));
vi.mock("@typesafe-ai/sdk", () => ({
  TypeSafeClient: class {
    systemOne = systemOneMock;
  },
}));
// Keep tests hermetic: never read the developer's real ~/.pi AA cache.
vi.mock("../src/aa-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/aa-client.js")>();
  return {
    ...actual,
    getAaBenchmarks: vi.fn(async () => aaBenchmarksMock ?? null),
  };
});

/** Set to exercise AA-enriched paths (latency gate, task-cost, balanced re-home). */
let aaBenchmarksMock: Awaited<ReturnType<typeof import("../src/aa-client.js").getAaBenchmarks>> = null;

import { registerTools } from "../src/tools.js";

const LIST_TABLE = [
  "provider  model          context  max-out  thinking  images",
  "hyper     a-flash        1.0M     64K      no        no",
  "hyper     b-plus         256K     64K      no        yes",
  "hyper     c-pro          1.0M     384K     yes       no",
].join("\n");

/** Minimal fake ExtensionAPI that captures registered tools. */
function fakePi() {
  const tools: any[] = [];
  return {
    tools,
    registerTool: (def: any) => tools.push(def),
  } as any;
}

function tierAnswer(choice: string, confidence: number, probabilities: Record<string, number>) {
  return { type: "choice", choice, confidence, probabilities };
}

/** Default Jev answers: cheap/fast→a-flash, balanced→b-plus, powerful→c-pro. */
function defaultAnswers() {
  return {
    cheap: tierAnswer("hyper_a_flash", 0.9, { hyper_a_flash: 0.9, hyper_b_plus: 0.1 }),
    fast: tierAnswer("hyper_a_flash", 0.7, { hyper_a_flash: 0.7, hyper_b_plus: 0.2 }),
    balanced: tierAnswer("hyper_b_plus", 0.85, { hyper_b_plus: 0.85, hyper_a_flash: 0.1 }),
    powerful: tierAnswer("hyper_c_pro", 0.95, { hyper_c_pro: 0.95 }),
  };
}

function getTool() {
  const pi = fakePi();
  registerTools(pi);
  const tool = pi.tools.find((t: any) => t.name === "smart-router-setup-tiers");
  if (!tool) throw new Error("smart-router-setup-tiers not registered");
  return tool;
}

/** Get the mocked TypeSafeClient's systemOne as seen through the tool. */
function primeJev(answers: Record<string, unknown>) {
  systemOneMock.mockResolvedValue({ answers, usage: { input_tokens: 100, output_tokens: 20 } });
}

const NOOP_SIGNAL = new AbortController().signal;

async function run(params: Record<string, unknown>) {
  const tool = getTool();
  return tool.execute("t1", params, NOOP_SIGNAL, vi.fn(), {
    modelRegistry: {
      find: (p: string, m: string): any =>
        ({ "hyper/a-flash": { cost: { input: 0.1, output: 0.4 } } } as Record<string, unknown>)[`${p}/${m}`],
    },
    cwd: "/tmp",
  });
}

beforeEach(() => {
  execFileMock.mockClear();
  systemOneMock.mockReset();
});

describe("smart-router-setup-tiers", () => {
  it("returns assignments, routes, and warnings in one pass", async () => {
    primeJev(defaultAnswers());
    const { details } = await run({ providers: ["hyper"] });

    expect(details.assignments).toHaveLength(4);
    const byTier = Object.fromEntries(details.assignments.map((a: any) => [a.tier, a]));
    expect(byTier.cheap.model).toBe("hyper/a-flash");
    expect(byTier.powerful.model).toBe("hyper/c-pro");
    // cheap and fast collided on a-flash; cheap (0.9) beats fast (0.7) → fast re-picks
    expect(byTier.fast.collisionResolved).toBe(true);
    expect(byTier.fast.model).not.toBe("hyper/a-flash");
    // Routes payload is ready for update-routes
    expect(details.routes["cheap-code"]).toEqual({
      model: "hyper/a-flash",
      reasoning: "preserve",
    });
    expect(details.routes.powerful).toEqual({
      model: "hyper/c-pro",
      reasoning: "high",
    });
    expect(Array.isArray(details.warnings)).toBe(true);
  });

  it("makes exactly one Jev call for all four tiers", async () => {
    primeJev(defaultAnswers());
    await run({ providers: ["hyper"] });
    expect(systemOneMock).toHaveBeenCalledTimes(1);
    const req = systemOneMock.mock.calls[0][0];
    expect(Object.keys(req.questions).sort()).toEqual(["balanced", "cheap", "fast", "powerful"]);
  });

  it("applies per-tier filters: models failing a tier's pool never reach its criteria", async () => {
    primeJev(defaultAnswers());
    await run({ providers: ["hyper"] });
    const req = systemOneMock.mock.calls[0][0];
    // powerful requires thinking + 500k context → only c-pro qualifies
    expect(Object.keys(req.questions.powerful.criteria)).toEqual(["hyper_c_pro"]);
    // cheap (50k floor, no thinking/images) → a-flash and b-plus (c-pro excluded? c-pro has no images but cheap doesn't require them; c-pro qualifies: 1M context)
    expect(Object.keys(req.questions.cheap.criteria).sort()).toEqual(["hyper_a_flash", "hyper_b_plus", "hyper_c_pro"]);
  });

  it("honors tierOverrides", async () => {
    primeJev(defaultAnswers());
    await run({
      providers: ["hyper"],
      tierOverrides: { balanced: { requireImages: false } },
    });
    const req = systemOneMock.mock.calls[0][0];
    const keys = Object.keys(req.questions.balanced.criteria).sort();
    expect(keys).toContain("hyper_c_pro"); // now eligible (images not required)
  });

  it("excludes models before classification", async () => {
    primeJev(defaultAnswers());
    await run({ providers: ["hyper"], excludeModels: ["c-pro"] });
    const req = systemOneMock.mock.calls[0][0];
    // powerful's pool is empty after exclusion → no question sent for it
    // (a Choice question requires at least one criterion).
    expect(req.questions.powerful).toBeUndefined();
    expect(req.questions.cheap).toBeDefined();
  });

  it("warns about empty pools and unfilled tiers", async () => {
    primeJev(defaultAnswers());
    const { details } = await run({ providers: ["hyper"], excludeModels: ["c-pro"] });
    expect(details.warnings.some((w: string) => w.includes("powerful"))).toBe(true);
    expect(details.routes.powerful).toBeUndefined();
  });

  it("warns on low Jev confidence without re-running", async () => {
    const answers = defaultAnswers();
    answers.balanced = tierAnswer("hyper_b_plus", 0.4, { hyper_b_plus: 0.4 });
    primeJev(answers);
    const { details } = await run({ providers: ["hyper"] });
    expect(details.warnings.some((w: string) => w.includes("low Jev confidence"))).toBe(true);
    // Still single pass — no second Jev call.
    expect(systemOneMock).toHaveBeenCalledTimes(1);
    // The low-confidence pick is still proposed as-is.
    expect(details.routes.balanced.model).toBe("hyper/b-plus");
  });

  it("re-homes displaced balanced via AA-backed runner-up pool", async () => {
    // AA reports latency for a-flash and pricing for a-flash only (via the
    // registry). balanced and fast both pick a-flash; cheap (0.9) keeps it, so
    // fast and balanced are both losers. The balanced re-home then selects from
    // the fast/powerful runner-ups that still pass balanced's filters.
    aaBenchmarksMock = {
      timestamp: Date.now(),
      data: [
        { modelId: "aflash", intelligenceIndex: 40, codingIndex: 80, speedTokensPerSec: 300, ttftSeconds: 0.2 },
        { modelId: "bplus", intelligenceIndex: 50, codingIndex: 70, speedTokensPerSec: 200, ttftSeconds: 0.3 },
      ],
    };
    const answers = {
      // fast beats balanced for a-flash (0.8 > 0.7) → balanced is the loser.
      cheap: tierAnswer("hyper_a_flash", 0.95, { hyper_a_flash: 0.95 }),
      fast: tierAnswer("hyper_a_flash", 0.8, { hyper_a_flash: 0.8, hyper_b_plus: 0.12, hyper_d_general: 0.04 }),
      balanced: tierAnswer("hyper_a_flash", 0.7, { hyper_a_flash: 0.7, hyper_b_plus: 0.1, hyper_d_general: 0.08 }),
      powerful: tierAnswer("hyper_c_pro", 0.95, { hyper_c_pro: 0.95 }),
    };
    primeJev(answers);

    // Richer one-off catalog: a-flash (featured), d-general (featured balanced
    // runner-up), plus the standard fixture models.
    execFileMock.mockImplementationOnce((_c, _a, _o, cb) =>
      cb(null, { stdout: [
        "provider  model          context  max-out  thinking  images",
        "hyper     a-flash        1.0M     64K      no        no",
        "hyper     b-plus         256K     64K      no        yes",
        "hyper     c-pro          1.0M     384K     yes       no",
        "hyper     d-general      1.0M     128K     yes       yes",
      ].join("\n") }),
    );
    aaBenchmarksMock = {
      timestamp: Date.now(),
      data: [
        { modelId: "dgeneral", intelligenceIndex: 60, codingIndex: 72, speedTokensPerSec: 150, ttftSeconds: 0.6 },
        { modelId: "bplus", intelligenceIndex: 50, codingIndex: 70, speedTokensPerSec: 200, ttftSeconds: 0.3 },
        { modelId: "aflash", intelligenceIndex: 40, codingIndex: 80, speedTokensPerSec: 300, ttftSeconds: 0.2 },
      ],
    };

    const { details } = await run({ providers: ["hyper"] });
    aaBenchmarksMock = null;
    const byTier = Object.fromEntries(details.assignments.map((a: any) => [a.tier, a]));
    // cheap keeps a-flash; powerful keeps c-pro.
    expect(byTier.cheap.model).toBe("hyper/a-flash");
    expect(byTier.powerful.model).toBe("hyper/c-pro");
    // cheap (0.95) keeps a-flash; fast is the loser and re-picks inside its
    // latency-gated pool → b-plus (scored 0.12).
    expect(byTier.fast.model).toBe("hyper/b-plus");
    // balanced's scored fallback (b-plus) is now claimed by fast, so its raw
    // fallback would be d-general (0.08); the re-home finds the same model as
    // the best unclaimed task-cost runner-up and keeps the scored confidence.
    expect(byTier.balanced.model).toBe("hyper/d-general");
    expect(byTier.balanced.collisionResolved).toBe(true);
    expect(byTier.balanced.confidence).toBeCloseTo(0.08);
  });

  it("throws when no models are found", async () => {
    execFileMock.mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (e: unknown, out: { stdout: string }) => void) =>
      cb(null, { stdout: "provider  model  context  max-out  thinking  images" }),
    );
    await expect(run({ providers: ["empty-provider"] })).rejects.toThrow(/No models found/);
  });
});
