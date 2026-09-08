# ADR: Borderline-Band LLM Escalation

> **Status:** implemented | **Date:** 2025-09-08

## Context

The heuristic complexity classifier is fast and free but blind to meaning.
Prompts near a tier boundary (e.g. "Could you review my changes?" scoring
0.19–0.28 against `simpleMax: 0.3`) get misrouted to **fast** while
semantically equivalent prompts ("analyze this diff") land in **balanced**.

## Decision

Hybrid escalation: the heuristic stays as the always-on pre-filter. When the
score falls inside a configurable **borderline band** (default 0.2–0.45) and
no explicit rule matched, a cheap LLM (the existing `fast` tier) classifies
the prompt with a single-token answer (`fast` or `balanced`). The LLM verdict
overrides the heuristic tier; everything outside the band stays purely
heuristic.

Escalation is **opt-in** (`enabled: false` by default) and fails silently —
timeout, unavailable model, or unparseable answer always degrades to the
original heuristic tier.

## Key design choices

| Choice | Rationale |
|---|---|
| **Tier override, not score adjustment** | The band may span the fast/balanced boundary; overriding the tier keeps thresholds as the single source of truth and makes the route log unambiguous. |
| **Classifier can never select `powerful`** | A cheap classifier should not promote to the expensive tier. `EscalationVerdict` is `"fast" \| "balanced"` only; an `allowPowerful` opt-in is left for the future. |
| **Bounded conversation context** | The classifier sees ≤ 6 recent messages (~2000 token budget, thinking stripped, images replaced, labeled untrusted) plus the heuristic's own signals as advisory hints. |
| **Rules still win** | Escalation only fires when `resolveRoute` returns `reason: "threshold"` (no rule matched). A keyword rule whose route is unavailable does not suppress escalation. |
| **Recursive routing blocked twice** | `escalation.model` referencing `smart-router/*` is rejected at config validation and guarded again at runtime. |
| **Timeout aborts cleanly** | The stream `signal` aborts the request; the consumption loop is catch-guarded; a 250 ms grace period lets the aborted stream drain before routing proceeds. |

## Deviations from the original plan

1. Escalation checks the resolved decision's `reason` instead of duplicating
   rule-matching logic — a rule whose keywords match but whose route is
   unavailable no longer suppresses escalation.
2. Partial config blocks are merged field-by-field over
   `DEFAULT_ESCALATION_CONFIG`; the band is validated **after** merging so a
   partial config like `{"minScore": 0.8}` is rejected.
3. The classifier context uses `getLatestUserPrompt()` (the same source of
   truth as the rest of the router) instead of the raw last message.
4. The classifier request sets `reasoning: "minimal"` so reasoning tokens
   cannot eat the 4-token output budget on models that think by default.
5. Route log gained `esc=<heuristic-tier>-><verdict>` (or `esc=-`);
   `RouteDecision.escalatedFromTier` carries the heuristic tier for detailed
   logging.

## Cost & failure mode

- ~100–500 prompt tokens + 1 output token through the fast model per
  escalated turn (minority of turns).
- `timeoutMs` (default 1500) bounds worst-case added latency.
- No retry on classifier failure — single attempt, `null` → heuristic tier.
