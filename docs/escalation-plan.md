# Plan: Borderline-Band LLM Escalation for the Smart Router

> **Status: implemented** (see "Revisions from review" at the bottom for
> deltas from the original plan below).

## Problem

The heuristic classifier is fast and free but blind to meaning. Prompts near a
tier boundary get misrouted: e.g. "Could you review my changes?" scores 0.19–0.28
(just under `simpleMax: 0.3`) and lands in the **fast** tier even in realistic
sessions, while semantically similar prompts ("analyze this diff") land in
**balanced**.

## Approach

Hybrid escalation: keep the heuristic as the always-on pre-filter, and when the
score falls inside a configurable **borderline band**, ask a cheap LLM (the
existing `fast` route) to classify the prompt with a single-token answer. The
LLM's verdict overrides the heuristic's tier; everything outside the band stays
purely heuristic (free, instant).

- Classifier calls happen for an estimated minority of turns (only borderline
  prompts, only once per turn — the per-turn route cache already exists).
- Cost: ~100–500 prompt tokens + 1 output token through the fast model per
  escalated turn.
- Failure mode: timeout, unavailable model, or unparseable answer → silently
  keep the heuristic tier. Escalation can never make routing worse than today.

## Non-goals

- No training data, no local ML runtime, no new npm dependencies.
- Escalation never runs when an explicit rule matched (rules stay absolute).
- Escalation is **opt-in** (disabled by default) so existing configs keep
  deterministic behavior until users enable it.

---

## Phase 1 — Config schema (`src/types.ts`, `src/config.ts`)

New optional `escalation` block on `SmartRouterConfig`:

```jsonc
{
  "escalation": {
    "enabled": true,
    // Borderline band on the heuristic complexity score.
    "minScore": 0.2,
    "maxScore": 0.45,
    // "provider/modelId" of the classifier backend. Optional: defaults to
    // the route that the "fast" tier resolves to (never `powerful`).
    "model": "opencode-go/glm-5.3-flash",
    // Abort the classification call after this many ms; heuristic tier wins.
    "timeoutMs": 1500
  }
}
```

Work items:
1. `types.ts`: add `EscalationConfig` interface + include on `SmartRouterConfig`.
2. `config.ts`: zod schema (`enabled: boolean`, `minScore/maxScore: 0..1`,
   `model: modelRefSchema` optional, `timeoutMs: positive int` optional) and
   semantic validation:
   - `minScore <= maxScore`
   - if `model` is set it must be a well-formed ref (existence in the registry
     is checked at runtime, not config-load time — the registry isn't available
     during validation).
3. Defaults constant (`DEFAULT_ESCALATION_CONFIG`): `enabled: false`,
   `minScore: 0.2`, `maxScore: 0.45`, `timeoutMs: 1500`, `model: undefined`
   (= fast tier).

Tests (`test/config.test.ts`): valid block parses; `minScore > maxScore`
rejected; malformed model ref rejected; absent block → defaults.

## Phase 2 — LLM classification (`src/escalation.ts`, new file)

Pure-ish module with two exports:

1. **`shouldEscalate(features, config)`** — returns true when escalation is
   enabled, no images (`hasImages === false` — keeps the classifier call cheap
   and avoids image-capability requirements), and
   `minScore <= complexityScore <= maxScore`.
2. **`classifyWithLlm(backend, context, features, opts)`** — async, returns
   `"fast" | "balanced" | "powerful"` or `null` (unparseable/error/timeout):
   - Builds a minimal context:
     - system prompt: instructions + the heuristic's own signals as hints
       (`codeLikelihood`, `reasoningLikelihood`, `hasTools`, `contextTokens`) +
       the fixed tier rubric;
     - single user message: the truncated latest user prompt (reuse
       `maxPromptTokens` truncation from the classifier).
   - Calls `provider.streamSimple` via the existing `resolveBackend` /
     `buildStreamOptions` / session-header machinery (classifier calls reuse
     the stable Pi session id).
   - Collects only text deltas; `maxTokens: 4`, `temperature: 0`.
   - Parses the answer: accepts tier names, and integers 1–3 or 1–10 mapped
     onto `fast/balanced/powerful` (defense against verbose models).
   - Enforces `timeoutMs` via `AbortSignal` on the stream options.
   - Never throws — catches everything and returns `null`.

Tests (`test/escalation.test.ts`): band logic; tier parsing (names, "2", "7/10",
junk); timeout → `null`; model error → `null`; prompt truncation applied.

## Phase 3 — Resolution integration (`src/route-resolver.ts`)

`resolveRoute` gains an optional `tierOverride` parameter
(`"fast" | "balanced" | "powerful" | null`):

- Step 1 (rules) is untouched — a matched rule still wins before thresholds.
- Step 2 uses `tierOverride ?? computedTier` for the threshold lookup. The
  logged explanation states the original score, the override, and its source
  (`llm-escalation`).

Why a tier override and not an adjusted score: the band may sit across the
fast/balanced boundary, so nudging the score is fragile; overriding the tier
directly keeps thresholds as the single source of truth and makes the decision
log unambiguous.

Tests (`test/route-resolver.test.ts`): override applied at step 2; rules still
beat an override; override with unavailable target route falls through to
default/fallbacks exactly like a threshold result would.

## Phase 4 — Provider wiring (`src/provider.ts`)

Inside `streamSmartRouter`, in the first-request branch (per-turn cache makes
this once per turn — tool continuations are unaffected):

1. After `classifyPrompt` and **before** `resolveRoute`:
   - Determine whether any rule matches (cheap `matchRule` loop). If yes → skip
     escalation entirely.
   - Else if `shouldEscalate(...)`:
     - Set footer status `router: escalating…` (reuses `setStatus`).
     - Resolve the classifier backend (config `model` or the route the `fast`
       tier resolves to; skip silently if unavailable via `isRouteAvailable`).
     - `const verdict = await classifyWithLlm(...)` (bounded by `timeoutMs`).
     - Map verdict → `tierOverride`; `null` → no override.
2. The route log line gains `esc=<orig-tier>-><verdict|->` (and the detailed
   `logDecisions` line includes the classifier model). The footer status shows
   the final route as today — no extra UI surface.
3. `RouteDecision` gains an optional `escalatedFromTier?: string` field for the
   detailed log only (no behavior attached).

Ordering note: the escalation happens before `resolveBackend` for the *chosen*
route; the classifier call reuses the same registry helpers, so no new plumbing
is needed beyond passing the classifier's own backend through.

Tests (`test/provider-stream.test.ts`): mock provider (helpers already build
models/contexts — add a stub provider whose `streamSimple` yields a fixed text
delta): in-band + verdict "balanced" → routed balanced; classifier hangs →
timeout → heuristic tier; out-of-band → classifier provider never called;
rule-matched turn → never called.

## Phase 5 — Docs + configs

1. `README.md`: new "Escalation" section (what it does, when it fires, cost
   model, how to disable).
2. `examples/smart-router.json`: add the `escalation` block (enabled) with a
   `$comment` explaining the band and that the classifier model defaults to the
   fast tier.
3. Live config `~/.pi/agent/smart-router.json`: add the same block.
4. `examples.test.ts` already validates the example config — extend if it
   asserts an exact rules/config shape.

---

## Sequencing & validation

| Order | Phase | Validates via |
|---|---|---|
| 1 | Config schema + tests | `npm test` |
| 2 | Escalation module + tests | `npm test` |
| 3 | Resolver override + tests | `npm test` |
| 4 | Provider wiring + tests | `npm test` + manual session |
| 5 | Docs + configs | `npm test` + `npm run typecheck` |

Manual acceptance (after `npm run typecheck && npm test`):
1. Restart a pi session in this repo with the live config enabled.
2. "could you review my changes?" (score ~0.2, in band) → footer/log shows the
   escalation and routes **balanced**.
3. "hi" (score ~0.1, below band) → no classifier call, routes fast/cheap as
   today; log shows `esc=-`.
4. "architecture review" (rule match) → still **powerful**, no classifier call.
5. Kill network/auth for the classifier model → routing degrades to today's
   heuristic behavior with no user-facing error.

## Risks / mitigations

- **Added latency on borderline turns** (~0.3–1.5s): bounded by `timeoutMs`;
  footer shows "escalating…" so the wait is visible.
- **Classifier answers inconsistently**: strict parser with tier names + numeric
  mappings, `temperature: 0`, `maxTokens: 4`; anything unexpected → `null`.
- **Privacy**: escalated turns send the (truncated) prompt text to the
  classifier model — the same provider family the prompt would go to anyway,
  but worth a `$comment` in the example config.
- **Cost drift**: the band bounds how often escalation fires; `logDecisions`
  lines make the frequency visible. No retry on classifier failure (single
  attempt) to keep worst-case cost at one call per turn.

---

## Revisions from review (implemented)

The review of this plan changed the design in five ways:

1. **Escalation runs only for `reason: "threshold"` decisions** (not "no rule
   matched"). A rule whose keywords match but whose route is unavailable must
   not suppress escalation - `provider.ts` checks the resolved decision's
   reason instead of duplicating rule-matching logic, then re-resolves with
   the verdict as a `tierOverride`.
2. **The classifier can never select `powerful`** (or `cheap`).
   `EscalationVerdict` is `"fast" | "balanced"` only, enforced by the parser
   (strict word-boundary match, ambiguous answers → null) and by the
   `resolveRoute` override parameter type. An explicit `allowPowerful` opt-in
   is left for the future; the default is no.
3. **The classifier sees bounded conversation context**, not just the latest
   prompt: ≤ 6 recent messages (thinking stripped, images replaced with a
   placeholder, per-message truncation) inside a ~2000-token budget, wrapped
   in delimiters and labeled as untrusted, plus the heuristic's signals as
   advisory hints in the rubric.
4. **Timeout aborts and winds down the stream**: the options `signal` aborts
   the request, the consumption loop is catch-guarded so it can never produce
   an unhandled rejection after losing the race, and a 250 ms grace period
   lets the aborted stream drain before routing proceeds.
5. **Recursive routing is blocked twice**: `escalation.model` referencing
   `smart-router/*` is rejected at config validation (`CONFIG_INVALID`) and
   guarded again at runtime in `resolveClassifierModelRef` /
   `isClassifierBackendAvailable`.

Additional deltas: partial `escalation` config blocks are merged field-by-field
over `DEFAULT_ESCALATION_CONFIG` (`resolveEscalationConfig`); the route log
gained `esc=<heuristic-tier>-><verdict>` (or `esc=-` for non-escalated turns);
`RouteDecision.escalatedFromTier`
carries the heuristic tier for detailed logging; escalation is **opt-in**
(`enabled: false` by default, enabled in the example and live configs).
Note the existing `review-tasks` keyword rule still routes review prompts to
balanced deterministically - the rule wins before escalation, which now covers
*other* borderline prompts instead.

Final-review fixes: (a) the escalation band is validated **after** defaults are
merged, so a partial config like `{"minScore": 0.8}` is rejected instead of
silently forming an impossible `[0.8, 0.45]` band; (b) the classifier context
uses `getLatestUserPrompt()` (the same source of truth as the rest of the
router) instead of the raw last message, which can be an assistant/tool result;
(c) the classifier request sets `reasoning: "minimal"` (lowest portable
thinking level) so reasoning tokens cannot eat the 4-token output budget on
models that think by default.
