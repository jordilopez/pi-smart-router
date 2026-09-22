/**
 * Tier rubric boundary tests.
 *
 * The actual cheap/fast/balanced/powerful verdict is a semantic judgment made by
 * the classifier (LLM or TypeSafe Jev), which cannot be unit-tested without a
 * live model. What *can* be tested deterministically is the policy these
 * classifiers consume: `TIER_RUBRIC` is the single source of truth for both the
 * Jev Choice criteria (typesafe-client.ts) and the LLM system prompt
 * (classifier-orchestrator.ts). If the rubric text drifts away from the intended
 * boundaries, routing gets more expensive (or under-serves) silently.
 *
 * These tests lock in the cost-aware boundaries established for the routing
 * policy:
 *  - cheap: obvious, low-risk mechanical work only
 *  - fast:  routine coding workhorse (multi-file / tools are fine here)
 *  - balanced: reserved for meaningful judgment / non-obvious reasoning
 *  - powerful: genuinely difficult or high-risk work only
 */

import { describe, expect, it } from "vitest";
import { TIER_RUBRIC } from "../src/types.js";

describe("TIER_RUBRIC cost-aware boundaries", () => {
  it("cheap tier is limited to obvious mechanical work", () => {
    expect(TIER_RUBRIC.cheap).toMatch(/mechanical/);
    expect(TIER_RUBRIC.cheap).toMatch(/rename|formatting/);
    // Mechanical work should be framed as needing no real judgement.
    expect(TIER_RUBRIC.cheap).toMatch(/no meaningful judgement/i);
  });

  it("fast tier is the routine coding workhorse and covers multi-file work", () => {
    // Fast must explicitly include ordinary implementation, not just trivial edits.
    expect(TIER_RUBRIC.fast).toMatch(/routine coding work/i);
    expect(TIER_RUBRIC.fast).toMatch(/straightforward feature or bug fix/i);
    // Multi-file edits and tool usage must stay in fast, not force an upgrade.
    expect(TIER_RUBRIC.fast).toMatch(/multi-file/);
    expect(TIER_RUBRIC.fast).toMatch(/tools or file count alone do not require a higher tier/i);
  });

  it("balanced tier requires meaningful judgement and does not claim routine work", () => {
    expect(TIER_RUBRIC.balanced).toMatch(/meaningful.*judgement|non-obvious reasoning/i);
    // Code review / ambiguous requirements / unclear-debugging stay here.
    expect(TIER_RUBRIC.balanced).toMatch(/code review/);
    expect(TIER_RUBRIC.balanced).toMatch(/ambiguous requirements/i);
    // Balanced must NOT absorb the routine multi-file work that now belongs to fast.
    expect(TIER_RUBRIC.balanced).not.toMatch(/multi-file/);
    expect(TIER_RUBRIC.balanced).not.toMatch(/routine coding work/i);
  });

  it("powerful tier is limited to genuinely difficult or high-risk work", () => {
    expect(TIER_RUBRIC.powerful).toMatch(/difficult or high-risk/i);
    expect(TIER_RUBRIC.powerful).toMatch(/system architecture/);
    expect(TIER_RUBRIC.powerful).toMatch(/security threat modelling/);
    expect(TIER_RUBRIC.powerful).toMatch(/concurrency or root-cause investigation/i);
    expect(TIER_RUBRIC.powerful).toMatch(/cross-cutting refactor/);
  });

  it("keeps the four tiers in ascending capability/cost order with no overlap on routine work", () => {
    // The tiers must remain mutually distinct strings (no accidental copy-paste
    // collision that would make two tiers classify identically).
    const values = Object.values(TIER_RUBRIC);
    expect(new Set(values).size).toBe(values.length);
  });
});
