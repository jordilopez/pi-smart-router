import { describe, expect, it } from "vitest";
import {
  modelDescription,
  narrowPool,
  parseModelsTable,
  parseTokenValue,
  positioningClause,
  prepareClassifierRequest,
  slugify,
  validateRouteModels,
  type CatalogModel,
} from "../src/tools.js";

describe("parseTokenValue", () => {
  it("parses K and M suffixes (case-insensitive)", () => {
    expect(parseTokenValue("256K")).toBe(256_000);
    expect(parseTokenValue("131.1K")).toBe(131_100);
    expect(parseTokenValue("1M")).toBe(1_000_000);
    expect(parseTokenValue("1.0M")).toBe(1_000_000);
    expect(parseTokenValue("512k")).toBe(512_000);
    expect(parseTokenValue("2m")).toBe(2_000_000);
  });

  it("parses bare numbers", () => {
    expect(parseTokenValue("4096")).toBe(4096);
  });

  it("returns 0 for malformed or non-finite input", () => {
    expect(parseTokenValue("1.2.3")).toBe(0); // multiple dots rejected
    expect(parseTokenValue("abc")).toBe(0);
    expect(parseTokenValue("")).toBe(0);
    expect(parseTokenValue("NaN")).toBe(0);
    expect(parseTokenValue("Infinity")).toBe(0);
    expect(parseTokenValue("-5K")).toBe(0); // negative rejected
    expect(parseTokenValue("5X")).toBe(0); // unknown suffix
  });
});

describe("slugify", () => {
  it("replaces / . - with underscores and lowercases", () => {
    expect(slugify("hyper/glm-5.3-flash")).toBe("hyper_glm_5_3_flash");
    expect(slugify("opencode-go/GPT-5.6-Luna")).toBe("opencode_go_gpt_5_6_luna");
  });
});

describe("modelDescription", () => {
  it("formats context/maxOut with M/K suffixes and yes/no flags", () => {
    const m: CatalogModel = {
      provider: "hyper",
      model: "glm-5.3-flash",
      context: 1_000_000,
      maxOut: 131_100,
      thinking: true,
      images: false,
    };
    expect(modelDescription(m)).toBe(
      "hyper/glm-5.3-flash | context 1.0M, maxOut 131K, thinking yes, images no",
    );
  });
});

describe("parseModelsTable", () => {
  const sample = [
    "provider  model                   context  max-out  thinking  images",
    "hyper     glm-5.3-flash           1.0M     131.1K   yes       yes",
    "hyper     kimi-k2.7-code          256K     16K      no        yes",
    "",
  ].join("\n");

  it("parses rows into typed models", () => {
    const models = parseModelsTable(sample);
    expect(models).toHaveLength(2);
    expect(models[0]).toEqual({
      provider: "hyper",
      model: "glm-5.3-flash",
      context: 1_000_000,
      maxOut: 131_100,
      thinking: true,
      images: true,
    });
    expect(models[1]).toEqual({
      provider: "hyper",
      model: "kimi-k2.7-code",
      context: 256_000,
      maxOut: 16_000,
      thinking: false,
      images: true,
    });
  });

  it("returns an empty list for header-only or empty input", () => {
    expect(parseModelsTable("provider  model  context  max-out  thinking  images")).toEqual([]);
    expect(parseModelsTable("")).toEqual([]);
  });

  it("skips malformed short rows", () => {
    const rows = ["header line", "only two cols here", "a b c d e f g"].join("\n");
    const models = parseModelsTable(rows);
    expect(models).toHaveLength(1);
    expect(models[0].provider).toBe("a");
  });
});

describe("prepareClassifierRequest", () => {
  const models: CatalogModel[] = [
    { provider: "hyper", model: "glm-5.3-flash", context: 1_000_000, maxOut: 131_100, thinking: true, images: true },
    { provider: "hyper", model: "kimi-k2.7-code", context: 256_000, maxOut: 16_000, thinking: false, images: true },
  ];

  it("builds one named state field per model keyed by slug", () => {
    const { state } = prepareClassifierRequest(models);
    expect(Object.keys(state).sort()).toEqual(["hyper_glm_5_3_flash", "hyper_kimi_k2_7_code"]);
  });

  it("builds exactly one Choice question per tier with shared criteria", () => {
    const { questions } = prepareClassifierRequest(models);
    expect(Object.keys(questions).sort()).toEqual(["balanced", "cheap", "fast", "powerful"]);
    for (const tier of ["cheap", "fast", "balanced", "powerful"]) {
      expect(questions[tier].type).toBe("choice");
      expect(questions[tier].instructions).toContain(tier);
      expect(Object.keys(questions[tier].criteria).sort()).toEqual([
        "hyper_glm_5_3_flash",
        "hyper_kimi_k2_7_code",
      ]);
    }
  });
});

describe("narrowPool", () => {
  const pool: CatalogModel[] = [
    { provider: "hyper", model: "glm-5.3-flash", context: 1_000_000, maxOut: 131_100, thinking: true, images: true },
    { provider: "hyper", model: "qwen3.8-flash", context: 1_000_000, maxOut: 128_000, thinking: true, images: true },
    { provider: "hyper", model: "glm-5.3", context: 1_000_000, maxOut: 128_000, thinking: true, images: false },
    { provider: "hyper", model: "deepseek-v4-pro", context: 1_000_000, maxOut: 384_000, thinking: true, images: false },
    { provider: "hyper", model: "qwen3.8-max", context: 1_000_000, maxOut: 65_500, thinking: true, images: true },
    { provider: "hyper", model: "gemma-4-26b", context: 256_000, maxOut: 25_600, thinking: true, images: false },
    { provider: "hyper", model: "gpt-oss-120b", context: 131_100, maxOut: 13_100, thinking: true, images: false },
    { provider: "hyper", model: "minimax-m2.7", context: 262_100, maxOut: 6_600, thinking: false, images: false },
    { provider: "hyper", model: "kimi-k2.7-code", context: 256_000, maxOut: 16_000, thinking: false, images: true },
  ];

  it("caps every tier's pool at 8 entries", () => {
    for (const tier of ["cheap", "fast", "balanced", "powerful"] as const) {
      expect(narrowPool(tier, pool).length).toBeLessThanOrEqual(8);
    }
  });

  it("keeps the most capable candidates in the powerful pool", () => {
    const powerful = narrowPool("powerful", pool);
    const ids = powerful.map((m) => m.model);
    expect(ids).toContain("deepseek-v4-pro"); // name match (pro)
    expect(ids).toContain("glm-5.3");         // capability fill: thinking + 1M context
  });

  it("prefers weakest-capability fills for the cheap tier", () => {
    const cheap = narrowPool("cheap", pool);
    const fills = cheap.filter((m) => !/flash|mini/i.test(m.model));
    const maxOuts = fills.map((m) => m.maxOut);
    expect([...maxOuts].sort((a, b) => a - b)).toEqual(maxOuts); // non-decreasing
  });

  it("falls back to capability fill when no names match the hints", () => {
    const noHints: CatalogModel[] = [
      { provider: "p", model: "alpha", context: 100_000, maxOut: 8_000, thinking: false, images: false },
      { provider: "p", model: "beta", context: 1_000_000, maxOut: 64_000, thinking: true, images: true },
    ];
    const powerful = narrowPool("powerful", noHints);
    expect(powerful[0].model).toBe("beta"); // strongest first
  });
});

describe("pricing (cost-aware cheap/fast)", () => {
  it("modelDescription includes $/M pricing when present", () => {
    const m: CatalogModel = {
      provider: "hyper", model: "qwen3.8-flash", context: 1_000_000, maxOut: 128_000,
      thinking: true, images: true, costIn: 0.15, costOut: 0.47,
    };
    expect(modelDescription(m)).toContain("$0.15/$0.47 per M tokens");
  });

  it("modelDescription omits pricing when absent", () => {
    const m: CatalogModel = {
      provider: "hyper", model: "qwen3.8-flash", context: 1_000_000, maxOut: 128_000,
      thinking: true, images: true,
    };
    expect(modelDescription(m)).not.toContain("per M tokens");
  });

  it("narrowPool cheap orders the non-matched fill by blended cost, not maxOut", () => {
    // Regression for the real bug: a frontier model (kimi-k3) with the smallest
    // output cap sorted FIRST into the cheap pool under the old maxOut proxy.
    // With pricing it must sort after a cheaper mid model.
    const models: CatalogModel[] = [
      { provider: "hyper", model: "glm-5.3-flash", context: 1_000_000, maxOut: 131_000, thinking: true, images: true, costIn: 0.16, costOut: 0.54 },
      { provider: "hyper", model: "deepseek-v4-flash", context: 1_000_000, maxOut: 384_000, thinking: true, images: false, costIn: 0.2, costOut: 0.4 },
      { provider: "hyper", model: "qwen3.8-27b", context: 1_000_000, maxOut: 128_000, thinking: true, images: true, costIn: 0.5, costOut: 3 },
      { provider: "hyper", model: "kimi-k3", context: 1_000_000, maxOut: 16_000, thinking: true, images: true, costIn: 3.27, costOut: 16.33 },
    ];
    const ids = narrowPool("cheap", models).map((m) => m.model);
    expect(ids.indexOf("qwen3.8-27b")).toBeLessThan(ids.indexOf("kimi-k3"));
  });

  it("prepareClassifierRequest adds a cost clause to cheap/fast only when pricing is present", () => {
    const withPricing: CatalogModel[] = [
      { provider: "hyper", model: "a-flash", context: 1_000_000, maxOut: 64_000, thinking: true, images: true, costIn: 0.1, costOut: 0.4 },
      { provider: "hyper", model: "b-pro", context: 1_000_000, maxOut: 64_000, thinking: true, images: false, costIn: 2, costOut: 6 },
    ];
    const { questions } = prepareClassifierRequest(withPricing);
    expect(questions.cheap.instructions).toContain("cost-sensitive");
    // Fast is latency-driven; the per-token price clause is still added when pricing exists.
    expect(questions.fast.instructions).toContain("per-token price");
    expect(questions.balanced.instructions).not.toContain("per-token price");
    expect(questions.powerful.instructions).not.toContain("per-token price");
    // state carries the price
    expect(questions.cheap.criteria["hyper_a_flash"]).toContain("$0.1");
  });

  it("prepareClassifierRequest omits the cost clause when no model has pricing", () => {
    const noPricing: CatalogModel[] = [
      { provider: "hyper", model: "a-flash", context: 1_000_000, maxOut: 64_000, thinking: true, images: true },
    ];
    const { questions } = prepareClassifierRequest(noPricing);
    // The per-token price comparison is only added when pricing data exists.
    expect(questions.cheap.instructions).not.toContain("per-token price");
    expect(questions.fast.instructions).not.toContain("per-token price");
  });
});

describe("positioningClause (family coverage)", () => {
  // Task 6: previously-uncovered families now get factual positioning.
  const families: Array<[string, string]> = [
    ["deepseek-v4", "DeepSeek"],
    ["glm-5.3", "Zhipu GLM"],
    ["gemma-4-26b", "Gemma"],
    ["qwen3.8", "Qwen"],
    ["kimi-k2", "Kimi"],
    ["minimax-m2.7", "MiniMax"],
    ["gpt-oss-120b", "GPT-OSS"],
    ["gpt-5", "GPT"],
  ];

  for (const [modelName, family] of families) {
    it(`gives ${family} a positioning clause`, () => {
      const m: CatalogModel = {
        provider: "hyper", model: modelName, context: 1_000_000, maxOut: 128_000,
        thinking: true, images: true,
      };
      const desc = modelDescription(m, positioningClause(m));
      // The description includes the family name via the positioning clause.
      expect(desc).toContain(family);
    });
  }
});

describe("tier-specific instructions (Task 7)", () => {
  const models: CatalogModel[] = [
    { provider: "hyper", model: "a-flash", context: 1_000_000, maxOut: 64_000, thinking: true, images: true },
    { provider: "hyper", model: "b-pro", context: 1_000_000, maxOut: 64_000, thinking: true, images: false },
  ];

  it("cheap instruction warns against flagship/over-powered models", () => {
    const { questions } = prepareClassifierRequest(models);
    expect(questions.cheap.instructions).toContain("Do not pick a flagship");
    expect(questions.cheap.instructions).toContain("over-powered");
  });

  it("fast instruction warns against heavy reasoning models", () => {
    const { questions } = prepareClassifierRequest(models);
    expect(questions.fast.instructions).toContain("low latency");
    expect(questions.fast.instructions).toContain("Do not pick a heavy reasoning");
  });

  it("balanced instruction mentions general-purpose capability", () => {
    const { questions } = prepareClassifierRequest(models);
    expect(questions.balanced.instructions).toContain("everyday workhorse");
    expect(questions.balanced.instructions).toContain("general-purpose");
  });

  it("powerful instruction prioritises reasoning over cost", () => {
    const { questions } = prepareClassifierRequest(models);
    expect(questions.powerful.instructions).toContain("strongest");
    expect(questions.powerful.instructions).toContain("reasoning capability");
    expect(questions.powerful.instructions).toContain("cost is secondary");
  });

  it("all four tiers have distinct instructions", () => {
    const { questions } = prepareClassifierRequest(models);
    const instrs = ["cheap", "fast", "balanced", "powerful"].map(
      (t) => questions[t].instructions,
    );
    // No two tiers should have identical instructions.
    const unique = new Set(instrs);
    expect(unique.size).toBe(4);
  });
});

describe("capability/cost ranking in narrowed descriptions (Task 8)", () => {
  const pool: CatalogModel[] = [
    { provider: "hyper", model: "a-flash", context: 1_000_000, maxOut: 131_100, thinking: true, images: true, costIn: 0.15, costOut: 0.47 },
    { provider: "hyper", model: "b-pro", context: 1_000_000, maxOut: 384_000, thinking: true, images: false, costIn: 2.0, costOut: 6.0 },
    { provider: "hyper", model: "c-mini", context: 512_000, maxOut: 64_000, thinking: false, images: true, costIn: 0.30, costOut: 0.80 },
  ];

  it("adds rank labels to narrowed criteria", () => {
    const { state } = prepareClassifierRequest(pool, true);
    // At least one entry should contain a rank label.
    const hasRank = Object.values(state).some(
      (d) => d.includes("cheapest in pool") || d.includes("most capable in pool"),
    );
    expect(hasRank).toBe(true);
  });

  it("cheap tier ranks cheapest model first", () => {
    const { questions } = prepareClassifierRequest(pool, true);
    const cheapCriteria = questions.cheap.criteria;
    // The cheapest model (a-flash, cost 0.15+0.47=0.62) should be rank 0.
    const aFlashDesc = cheapCriteria["hyper_a_flash"];
    expect(aFlashDesc).toMatch(/\(cheapest in pool\)$/);
    // The expensive model (b-pro, cost 2.0+6.0=8.0) should be ranked last.
    const bProDesc = cheapCriteria["hyper_b_pro"];
    expect(bProDesc).toMatch(/\(3rd cheapest in pool\)$/);
  });

  it("powerful tier ranks most capable model first", () => {
    const { questions } = prepareClassifierRequest(pool, true);
    const powerfulCriteria = questions.powerful.criteria;
    // b-pro has the largest context and maxOut, should be rank 0.
    const bProDesc = powerfulCriteria["hyper_b_pro"];
    expect(bProDesc).toMatch(/\(most capable in pool\)$/);
  });

  it("narrow: false descriptions have no rank labels", () => {
    const { state } = prepareClassifierRequest(pool, false);
    const hasRank = Object.values(state).some(
      (d) => d.includes("cheapest in pool") || d.includes("most capable in pool") || /\d+(st|nd|rd|th)/.test(d),
    );
    expect(hasRank).toBe(false);
  });
});

describe("positioningClause composition (family + tier)", () => {
  it("composes family and tier when both match", () => {
    const m: CatalogModel = {
      provider: "hyper", model: "deepseek-v4-pro", context: 1_000_000, maxOut: 384_000,
      thinking: true, images: false,
    };
    expect(positioningClause(m)).toContain("DeepSeek model");
    expect(positioningClause(m)).toContain("flagship/reasoning tier");
  });

  it("composes family and lightweight tier for flash variants", () => {
    const m: CatalogModel = {
      provider: "hyper", model: "glm-5.3-flash", context: 1_000_000, maxOut: 131_100,
      thinking: true, images: true,
    };
    expect(positioningClause(m)).toContain("Zhipu GLM model");
    expect(positioningClause(m)).toContain("lightweight, fast tier");
  });

  it("returns family-only when no tier pattern matches", () => {
    const m: CatalogModel = {
      provider: "hyper", model: "minimax-m2.7", context: 262_100, maxOut: 6_600,
      thinking: false, images: false,
    };
    expect(positioningClause(m)).toBe("MiniMax model");
  });

  it("returns tier-only for unknown families", () => {
    const m: CatalogModel = {
      provider: "p", model: "random-pro", context: 1_000_000, maxOut: 64_000,
      thinking: true, images: true,
    };
    expect(positioningClause(m)).toBe("flagship/reasoning tier");
  });

  it("returns empty string when neither matches", () => {
    const m: CatalogModel = {
      provider: "p", model: "model-x", context: 1_000_000, maxOut: 64_000,
      thinking: false, images: false,
    };
    expect(positioningClause(m)).toBe("");
  });
});

describe("prepareClassifierRequest (narrow: true)", () => {
  const pool: CatalogModel[] = [
    { provider: "hyper", model: "glm-5.3-flash", context: 1_000_000, maxOut: 131_100, thinking: true, images: true },
    { provider: "hyper", model: "qwen3.8-flash", context: 1_000_000, maxOut: 128_000, thinking: true, images: true },
    { provider: "hyper", model: "glm-5.3", context: 1_000_000, maxOut: 128_000, thinking: true, images: false },
    { provider: "hyper", model: "deepseek-v4-pro", context: 1_000_000, maxOut: 384_000, thinking: true, images: false },
    { provider: "hyper", model: "gemma-4-26b", context: 256_000, maxOut: 25_600, thinking: true, images: false },
  ];

  it("cuts each tier's criteria to at most 8 entries", () => {
    const { questions } = prepareClassifierRequest(pool, true);
    for (const tier of ["cheap", "fast", "balanced", "powerful"]) {
      expect(Object.keys(questions[tier].criteria).length).toBeLessThanOrEqual(8);
    }
  });

  it("enriches descriptions with a positioning clause", () => {
    const { state } = prepareClassifierRequest(pool, true);
    expect(state["hyper_deepseek_v4_pro"]).toContain("flagship/reasoning tier");
    expect(state["hyper_glm_5_3_flash"]).toContain("lightweight, fast tier");
  });

  it("keeps state as the union of the narrowed pools and includes powerful's strongest", () => {
    const { state, questions } = prepareClassifierRequest(pool, true);
    const stateIds = Object.keys(state).sort();
    const union = new Set<string>();
    for (const tier of ["cheap", "fast", "balanced", "powerful"]) {
      for (const id of Object.keys(questions[tier].criteria)) union.add(id);
    }
    expect(stateIds).toEqual([...union].sort());
    expect(Object.keys(questions.powerful.criteria)).toContain("hyper_deepseek_v4_pro");
  });

  it("leaves the default (narrow: false) output unchanged", () => {
    const baseline = prepareClassifierRequest(pool);
    const explicit = prepareClassifierRequest(pool, false);
    expect(explicit).toEqual(baseline);
    // spec-only descriptions, no positioning clause
    expect(baseline.state["hyper_deepseek_v4_pro"]).not.toContain("flagship");
    // full pool shared by every tier
    for (const tier of ["cheap", "fast", "balanced", "powerful"]) {
      expect(Object.keys(baseline.questions[tier].criteria).sort()).toEqual(Object.keys(baseline.state).sort());
    }
  });
});

describe("validateRouteModels", () => {
  const known = new Set(["hyper/glm-5.3-flash", "hyper/deepseek-v4-pro", "opencode-go/mimo-v2.5"]);
  const find = (provider: string, modelId: string) => (known.has(`${provider}/${modelId}`) ? {} : undefined);

  it("passes for valid routes", () => {
    expect(
      validateRouteModels(
        {
          cheap: { model: "hyper/glm-5.3-flash" },
          powerful: { model: "hyper/deepseek-v4-pro" },
        },
        find,
      ),
    ).toEqual([]);
  });

  it("rejects unknown models", () => {
    const errors = validateRouteModels({ balanced: { model: "hyper/nonexistent" } }, find);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/unknown model 'hyper\/nonexistent'/);
  });

  it("rejects malformed model references (no slash, empty sides)", () => {
    expect(validateRouteModels({ fast: { model: "just-a-model" } }, find)[0]).toMatch(/malformed/);
    expect(validateRouteModels({ fast: { model: "/leading" } }, find)[0]).toMatch(/malformed/);
    expect(validateRouteModels({ fast: { model: "trailing/" } }, find)[0]).toMatch(/malformed/);
  });

  it("reports a missing model field", () => {
    const errors = validateRouteModels({ cheap: {} }, find);
    expect(errors[0]).toMatch(/missing a model/);
  });

  it("accumulates one error per bad route", () => {
    const errors = validateRouteModels(
      { cheap: { model: "bad" }, fast: { model: "hyper/nope" } },
      find,
    );
    expect(errors).toHaveLength(2);
  });
});
