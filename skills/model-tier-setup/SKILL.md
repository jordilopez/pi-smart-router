---
name: model-tier-setup
description: Configures the four-tier routing policy of the pi-smart-router extension. Uses the `smart-router-catalog` tool to retrieve models from the Pi registry and prepare classifier input, and `smart-router-update-routes` to update the config. For each tier, asks TypeSafe Jev (via typesafe_evaluate) to pick the best-fitting model from the candidate list (preferred), then updates the routes section of the global ~/.pi/agent/pi-smart-router.json while preserving rules, classifier, fallbacks, and defaultRoute. Use when setting up or re-targeting smart-router model tiers.
---

# Model Tier Setup for pi-smart-router

## Overview

Configures the four-tier routing policy of the [pi-smart-router](https://github.com/jordilopez/pi-smart-router) extension. The skill uses two registered tools to automate the manual work:

- **`smart-router-catalog`** — retrieves models from the Pi registry for given provider(s), applies filters (min context, excluded models), and optionally prepares the classifier input (state + questions) for `typesafe_evaluate`.
- **`smart-router-update-routes`** — updates the `routes` section of the global config at `~/.pi/agent/pi-smart-router.json`, preserving everything else (`version`, `defaultRoute`, `classifier`, `rules`, `fallbacks`, `observability`), and validates the result before writing.

The skill asks the user which providers to use, calls `smart-router-catalog` to get the model list, and — preferably with TypeSafe Jev via the `typesafe_evaluate` tool — asks, for each of the four tiers (cheap, fast, balanced, powerful), which candidate model best fits that tier's rubric. It then calls `smart-router-update-routes` to write the config.

## Prerequisite: the tools must be loaded

The fast path (one catalog call, one config write) requires the pi-smart-router extension to be loaded, so `smart-router-catalog` and `smart-router-update-routes` are in the tool list. If they are not available, **say so explicitly** and either reload/restart Pi or fall back to the manual path (`pi --list-models <provider>`, a hand-built `typesafe_evaluate` request, a hand-edited config validated with `validateConfig`). Never silently take the slow manual path — the user should know why the run is slower.

## When to Use

- The user wants to set up or re-target pi-smart-router model tiers for one or more providers
- The user switched providers or got access to new models and wants the tiers re-assigned
- The user explicitly invokes this skill ("set up model tiers", "configure smart router models")

**When NOT to use:** for tuning thresholds, rules, or the classifier — those are config edits, not tier classification. Touch only `routes` here.

## The Four Tiers (rubric)

Classify each model against this rubric, which mirrors the README's tier policy:

| Tier | Route name | Intent (from `TIER_RUBRIC` in `src/types.ts`) | Typical model profile |
|---|---|---|---|
| cheap | `cheap-code` | Trivial mechanical work: rename, formatting, boilerplate, typo, simple scaffold; no judgement needed. | Smallest/cheapest capable model; low latency matters more than depth. |
| fast | `fast` | Simple work: factual question, small lookup, or a trivial one-line edit. | Small, quick, cheap; slightly more capable than cheap. |
| balanced | `balanced` | Context-aware judgement or multi-step work: code review, analysis, debugging, design discussion. | Solid mid-to-large general-purpose model; the everyday workhorse. |
| powerful | `powerful` | Genuinely hard work: system architecture, security threat modelling, complex debugging, formal reasoning, cross-cutting refactor. | The strongest reasoning model available (thinking/reasoning support strongly preferred); expensive is acceptable here. |

> The Intent column mirrors the canonical `TIER_RUBRIC` constant in `src/types.ts` (the source of truth for the Jev classifier). If that constant changes, update this table to match.

Constraints when assigning:
- A tier must be filled by a model that actually exists in the provider's catalog (exact, lowercase model ID).
- Each of the four tiers gets **exactly one** model; the same model must **not** serve two tiers.
- `powerful` must be the most capable model; if a provider has fewer than four distinct models, leave the weakest tiers to another provider or ask the user how to proceed — never downgrade `powerful` to fill `cheap`.
- Image support (`images: yes`) is a plus for `balanced` but never the deciding factor.
- The user may set hard filters before classification (e.g. "only consider models with ≥1M context", exclude a provider, exclude specific model IDs). Apply these as an exclusion pass on the candidate table in Step 2 — drop non-matching rows entirely before Step 3 runs, rather than letting Jev pick a candidate that gets rejected afterward. If applying a new filter invalidates an existing route (e.g. a previously-chosen model now falls under the context floor), re-run Step 3 for just that tier with the filtered candidate list; the other tiers don't need to be re-classified unless the filter affects them too.

## Workflow

### Step 1: Gather providers

Ask the user which provider(s) to configure (e.g. `hyper`, `deepseek`, `opencode-go`). If the user is unsure, show the providers available from `pi --list-models` (first column). If multiple providers are given, each tier still gets exactly one model overall — ask whether to mix providers per tier or pick a single winning provider.

### Step 2: List models and build the classifier request (one call)

Always pass `prepareClassifier: true` so this single call returns **both** the model list and the Jev classifier input:

```typescript
smart-router-catalog({
  providers: ["hyper", "opencode-go"],  // provider name(s)
  minContext: 1000000,                   // optional: minimum context in tokens
  excludeModels: ["experimental-model"], // optional: model IDs to exclude
  narrow: true,                          // always — cuts each tier's pool to ≤8 fits and adds positioning clauses; makes the first Jev pass sharp
  prepareClassifier: true                // always — builds the Jev request in the same call
})
```

The result contains everything the rest of the flow needs:

```json
{
  "models": [
    {
      "provider": "hyper",
      "model": "glm-5.3-flash",
      "context": 1000000,
      "maxOut": 131072,
      "thinking": true,
      "images": true
    }
  ],
  "count": 23,
  "classifierRequest": { "state": { "...": "..." }, "questions": { "...": "..." } }
}
```

Why `narrow: true` by default: the tool cuts each tier's candidate pool to the ~8 most plausible fits and adds a short positioning clause to each description — pre-applying what used to be the sharpening re-run. The first Jev call is therefore already sharp, and the Step 3 sharpening rule rarely triggers, which saves a second Jev call and a second presentation turn on a normal run.

Present the model list and ask — in this same turn — whether any hard filters apply (a minimum context window, excluded model IDs) or specific models should be deselected. Keep the table data — context window, max output, thinking, images — as classification evidence.

- **No changes → do not call `catalog` again.** Go straight to Step 3 with the `classifierRequest` you already hold.
- **Filters or deselection → re-run `catalog` exactly once**, with the new filters and `prepareClassifier: true`. Use that result for the rest of the flow.

### Step 3: Classify with Jev and present for approval (one turn)

Use the `state` and `questions` from the `classifierRequest` you already hold — do **not** call `catalog` again unless Step 2 changed the pool. Pass them directly to `typesafe_evaluate`.

**Important:** `typesafe_evaluate`'s `questions` parameter must be a **JSON object keyed by question name** (e.g. `{ "cheap": { ... }, "fast": { ... }, "balanced": { ... }, "powerful": { ... } }`), **never an array**. The `smart-router-catalog` tool already returns `questions` in the correct object shape — pass it verbatim. When rebuilding `questions` manually (e.g. during the sharpening re-run), build it as an object with one key per tier, each containing a `{ type: "choice", criteria: { ... } }` entry — do not emit `[ ... ]`.

Key points about the classification:
- **One Choice question per tier** — four questions total (`cheap`, `fast`, `balanced`, `powerful`), never one question per model. The tool already builds this structure.
- Respect tool limits: a `choice` question's `criteria` holds at most 64 entries, so up to 64 candidates can be judged per tier in one question; the whole call stays at exactly 4 questions regardless of candidate count. If a provider (or combined shortlist) has more than 64 candidates, ask the user to shortlist first.
- **Resolve duplicate picks:** because the four tier questions are judged independently, Jev may pick the same model for more than one tier. After getting all four answers, compare `confidence` (or the winning `probabilities` value) across the tiers that collided:
  - **Auto-resolve when the contest is lopsided.** If the colliding tiers' confidences differ by ≥ 0.15, keep the model in the higher-confidence tier; for each losing tier, take the highest-`probabilities` remaining candidate from that tier's own answer that is not already assigned elsewhere. Repeat until every tier has a distinct model. Do **not** spend a user turn on a collision that is already lopsided — resolve it and note it in one line of the Step 4 table.
  - **Escalate only when genuinely close.** If the colliding tiers are within 0.15 of each other, that's a real judgment call between comparable models — present the top two candidates with their probabilities and let the user pick (mark that tier "user-picked" in the Step 4 table).
  - Never break the `powerful` tier's assignment to resolve a collision elsewhere — resolve the *other* tier instead, per the rubric constraint that `powerful` must stay the most capable choice.

If `typesafe_evaluate` is unavailable or fails (no operator opt-in, no `TYPESAFE_API_KEY`), fall back to classifying the models yourself from the rubric and catalog metadata — and **say explicitly** that Jev was not used and the assignment is your own judgment.

**Sharpening rule (conditional and bounded).** After the Jev pass, **accept the assignment iff every tier's confidence is ≥ 0.6 and no two tiers picked the same model.** Because Step 2 already passes `narrow: true`, the first pass is usually sharp and this rule should rarely trigger. If it does, do **exactly one** *further* narrowed+enriched re-run. When rebuilding the call yourself, keep `questions` as an object keyed by tier name (`{ "cheap": {...}, "fast": {...}, "balanced": {...}, "powerful": {...} }`) — one `choice` question per tier, never an array:
- **Narrow the pool further.** Cut each tier's candidate list to the top ~3–5 models plausibly suited to it (family/positioning naming: "flash"/"mini"/"haiku" cluster toward `cheap`/`fast`, "sonnet"/"plus"/mid-size toward `balanced`, "opus"/"pro"/"max" toward `powerful`) — tighter than the first pass's ≤8.
- **Enrich the descriptions.** Add a short, factual positioning clause to each candidate beyond the raw spec columns — e.g. "Anthropic's smallest, fastest, cheapest Claude tier" or "DeepSeek's flagship 'Pro' tier of v4, above the Flash variant". Raw `context/maxOut/thinking/images` numbers alone don't separate reasoning capability.
- Resolve any collisions by confidence (see above), then re-check the accept condition.

If a tier is still below 0.6 after that single re-run, treat it as a **genuine close contest** between comparably-positioned models, not a signal-quality problem: report the top two candidates with their probabilities and let the user pick. Do not loop with further Jev calls.

Then present the proposed assignment (Step 4) and ask for approval **in this same turn** — the Jev call, the assignment table, and the approval prompt are one turn, not three. If the user requests exclusions at approval time, treat that as the pool changing: narrow the pool, re-run Jev once on it, and present again.

### Step 4: Confirm with the user (same turn as Step 3)

Present the proposed assignment as a table before writing anything — in the same turn as the Jev call, not a separate turn:

```
| Tier      | Route       | Model                     | Rationale                       |
|-----------|-------------|---------------------------|---------------------------------|
| cheap     | cheap-code  | hyper/deepseek-v4-flash   | smallest fast variant           |
| fast      | fast        | hyper/deepseek-v4.1-flash | quick, image-capable            |
| balanced  | balanced    | hyper/glm-5.3-flash       | strong general workhorse        |
| powerful  | powerful    | hyper/glm-5.3             | strongest reasoning model       |
```

(Here "Rationale" is the justification for the tier choice — not the route's `reasoning` config level.)

Get explicit user approval (use `ask_user` if interactive) with quick-pick options so the happy path is a single click:
- **"Apply as-is"** (default) → Step 5 next turn.
- **"Tweak one tier"** → user names the tier and the replacement; swap it in and re-present (one turn).
- **"Re-run with different filters/exclusions"** → treat as the pool changing: narrow the pool, re-run Jev once, present again.
Flag any tier left unfilled.

### Step 5: Update the global config

Use the `smart-router-update-routes` tool to update the config:

```typescript
smart-router-update-routes({
  routes: {
    "cheap-code": { "model": "hyper/glm-5.3-flash", "reasoning": "low", "emoji": "🪙" },
    "fast": { "model": "hyper/deepseek-v4.1-flash", "reasoning": "low", "emoji": "⚡" },
    "balanced": { "model": "hyper/qwen3.7-plus", "reasoning": "low", "emoji": "🎯" },
    "powerful": { "model": "hyper/deepseek-v4-pro", "reasoning": "high", "emoji": "💎" }
  }
})
```

The tool:
1. **Validates the models first.** It resolves each route's `provider/modelId` against the model registry and **refuses to write** if any model is unknown or malformed (`provider/modelId` format required). A typo or hallucinated model ID is rejected with an error naming the offending route.
2. Reads `~/.pi/agent/pi-smart-router.json` (or starts from the bundled example if it doesn't exist, stripping `$comment` keys and placeholder routes)
3. Replaces **only** the `routes` section with the provided routes
4. Validates the result (version is 1, defaultRoute exists in routes, every rule's route still exists)
5. Writes the file with valid JSON (2-space indent, trailing newline)
6. **Warns about project config shadowing.** If `<cwd>/.pi/pi-smart-router.json` exists, the result carries a `warning` in its details — that project config shadows the global one in trusted projects, so the update won't apply there until it is updated too. Surface this warning to the user.

Suggested per-tier settings:

```jsonc
{
  "cheap-code": { "model": "<provider>/<cheap-model>", "reasoning": "low", "emoji": "🪙" }, // no-thinking model → use "preserve" or omit
  "fast":       { "model": "<provider>/<fast-model>", "reasoning": "low", "emoji": "⚡" },
  "balanced":   { "model": "<provider>/<balanced-model>", "reasoning": "low", "emoji": "🎯" },
  "powerful":   { "model": "<provider>/<powerful-model>", "reasoning": "high", "emoji": "💎" }
}
```

   - `reasoning`: set it from the model's `thinking` column. If `thinking=no`, use `"preserve"` (or omit the field). If `thinking=yes`, use `"high"` for `powerful` and `"low"` for cheap/fast/balanced. If a provider rejects `low`/`high` at request time, fall back to `"preserve"`. `"off"` cannot force-disable thinking on providers that always think, so prefer `"preserve"` over `"off"`.
   - If the model reports no image support and the user works with images, warn them (the router enforces image compatibility per route).
3. The tool preserves `defaultRoute: "balanced"`, `fallbacks` (never add `powerful` to fallbacks), `classifier`, `rules`, and `version: 1` exactly as they were.
4. **Confirm the router is selectable.** If `~/.pi/agent/settings.json` has an `enabledModels` allowlist, it gates the `/model` selector (which models show up when you cycle), *not* the router's backend resolution — backends resolve via `registry.find()` on the full registry regardless of `enabledModels`. Only `pi-smart-router/auto` *must* be listed for you to select the router as your session model. Listing the four backend models is optional; it only lets you `/model` directly to a backend for manual testing. Do not claim routing breaks without them.

### Step 6: Report (same turn as Step 5)

Summarize — in the same turn as the `smart-router-update-routes` call, not a separate turn — which tiers changed, which kept their model, any tier left unfilled, whether the router is selectable (`pi-smart-router/auto` already present / added to the allowlist / no allowlist present), and remind the user to restart Pi (or reload the extension) for the change to take effect.

## Failure Modes to Avoid

- **Do not touch** `rules`, `classifier`, `fallbacks`, or `defaultRoute` — routes only.
- Never put `powerful` in `fallbacks`.
- Never assign the same model to two tiers.
- Never invent model IDs — copy them exactly (lowercase) from `pi --list-models` / `smart-router-catalog` output. `smart-router-update-routes` now enforces this by validating each model against the registry and refusing to write unknown IDs.
- Never ask Jev one question per model with tiers as the criteria — that judges each model in isolation and can't compare candidates against each other. Always ask one question per tier with the candidate models as criteria.
- If two tiers' Jev picks collide on the same model, resolve by confidence as described in Step 3 — never leave two tiers pointing at the same model.
- Never overwrite the config without showing the user the proposed assignment first.
- Never let a candidate that fails a user-specified hard filter (e.g. below a minimum context window) reach a Jev question or the final config — filter the candidate list first, in Step 2.
- Project config (`<project>/.pi/pi-smart-router.json`) replaces the global one entirely — if one exists for the current project, warn the user that it will shadow the global config.
