---
name: model-tier-setup
description: Configures the four-tier routing policy of the pi-smart-router extension. Asks which providers to use, lists their models from the Pi registry, and for each tier asks TypeSafe Jev (via typesafe_evaluate) to pick the best-fitting model from the full candidate list (preferred), then updates the routes section of the global ~/.pi/agent/pi-smart-router.json while preserving rules, classifier, fallbacks, and defaultRoute. Use when setting up or re-targeting smart-router model tiers.
---

# Model Tier Setup for pi-smart-router

## Overview

Configures the four-tier routing policy of the [pi-smart-router](https://github.com/jordilopez/pi-smart-router) extension. The skill asks the user which providers to use, lists each provider's models from the Pi registry, and — preferably with TypeSafe Jev via the `typesafe_evaluate` tool — asks, for each of the four tiers (cheap, fast, balanced, powerful), which candidate model best fits that tier's rubric. It then updates the `routes` section of the **global** config at `~/.pi/agent/pi-smart-router.json`. Everything else in the config (`version`, `defaultRoute`, `classifier`, `rules`, `fallbacks`, `observability`) is preserved untouched.

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

### Step 2: List models

Run:

```sh
pi --list-models <provider>
```

Columns: `provider  model  context  max-out  thinking  images`. Present the model list to the user and let them deselect any models they don't want considered (e.g. experimental snapshots). Ask if any hard filters apply (e.g. a minimum context window, an excluded provider, specific model IDs to skip) and drop non-matching rows from the table immediately — the candidate list handed to Step 3 should already satisfy every hard filter. Keep the table data — context window, max output, thinking, images — as classification evidence.

### Step 3: Classify with Jev (preferred)

Ask Jev to pick the best-fitting model **per tier** from the full candidate list, using the `typesafe_evaluate` tool:

- State: one named field per candidate model, keyed by a slug of the model ID (e.g. `{ "glm_53_flash": "hyper/glm-5.3-flash | context 1M, maxOut 131K, thinking yes, images yes", ... }`). Include every shortlisted candidate from every provider being considered.
- Questions: **one Choice question per tier** — four questions total (`cheap`, `fast`, `balanced`, `powerful`), never one question per model. Each question's `criteria` is the full candidate list (one entry per model, keyed the same as the state field, with a short description as the value); the `instructions` embed that tier's rubric row and ask Jev to pick the single best-fitting model for that tier from the candidates. This lets Jev compare models directly against each other instead of judging each one in isolation.
- Respect tool limits: a `choice` question's `criteria` holds at most 64 entries, so up to 64 candidates can be judged per tier in one question; the whole call stays at exactly 4 questions regardless of candidate count. If a provider (or combined shortlist) has more than 64 candidates, ask the user to shortlist first.
- **Resolve duplicate picks:** because the four tier questions are judged independently, Jev may pick the same model for more than one tier. After getting all four answers, compare `confidence` (or the winning `probabilities` value) across the tiers that collided. Keep the model in the tier where it scored the highest confidence; for each losing tier, take the highest-`probabilities` remaining candidate from that tier's own answer that is not already assigned elsewhere. Repeat until every tier has a distinct model. Never break the `powerful` tier's assignment to resolve a collision elsewhere — resolve the *other* tier instead, per the rubric constraint that `powerful` must stay the most capable choice.

If `typesafe_evaluate` is unavailable or fails (no operator opt-in, no `TYPESAFE_API_KEY`), fall back to classifying the models yourself from the rubric and catalog metadata — and **say explicitly** that Jev was not used and the assignment is your own judgment.

**Tip: sharpening low confidence.** A `choice` question's probability mass spreads across every candidate in its `criteria`, so a large or loosely-related candidate pool naturally dilutes the top score even when there's a real preference. If a tier comes back diffuse (e.g. top pick under ~0.6 confidence with several close competitors), two things reliably sharpen it before you conclude the result is genuinely ambiguous:
- **Narrow the pool.** Cut each tier's candidate list to the ~5–8 models plausibly suited to it (e.g. use known family/positioning naming — "flash"/"mini"/"haiku" cluster toward `cheap`/`fast`, "sonnet"/"plus"/mid-size params toward `balanced`, "opus"/"pro"/"max" toward `powerful`) instead of feeding the same full list to every tier's question.
- **Enrich the state.** Add a short, factual positioning clause to each candidate's description beyond the raw spec columns — e.g. "Anthropic's smallest, fastest, cheapest Claude tier" or "DeepSeek's flagship 'Pro' tier of v4, above the Flash variant". This gives Jev real distinguishing signal instead of only `context/maxOut/thinking/images` numbers, which by themselves don't strongly separate reasoning capability.

In practice this has taken a 15-candidate run with 0.53–0.67 confidence across all four tiers down to 4–5-candidate runs scoring 0.70–0.97 on three of four tiers, and even flipped a tier's winner to one that better matched general expectations about frontier reasoning models. If a tier still comes back low after narrowing and enriching, treat that as a genuine close contest between comparably-positioned models rather than a signal-quality problem, and report it to the user as such rather than picking arbitrarily.

### Step 4: Confirm with the user

Present the proposed assignment as a table before writing anything:

```
| Tier      | Route       | Model                     | Rationale                       |
|-----------|-------------|---------------------------|---------------------------------|
| cheap     | cheap-code  | hyper/deepseek-v4-flash   | smallest fast variant           |
| fast      | fast        | hyper/deepseek-v4.1-flash | quick, image-capable            |
| balanced  | balanced    | hyper/glm-5.3-flash       | strong general workhorse        |
| powerful  | powerful    | hyper/glm-5.3             | strongest reasoning model       |
```

(Here "Rationale" is the justification for the tier choice — not the route's `reasoning` config level.)

Get explicit user approval (use `ask_user` if interactive). Flag any tier left unfilled.

### Step 5: Update the global config

1. Read `~/.pi/agent/pi-smart-router.json`. If it doesn't exist, start from the repo example (`examples/pi-smart-router.json`) — but strip every `$comment`, `$comment-model`, and `$comment-fallbacks` key and remove the placeholder routes before writing. Those keys are silently dropped by the validator (the schema is non-strict), but the live config must be plain JSON with no comments (see step 4).
2. Replace **only** the `routes` section with the four tier routes. Suggested per-tier settings:

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
3. Keep `defaultRoute: "balanced"`, `fallbacks` (never add `powerful` to fallbacks), `classifier`, `rules`, and `version: 1` exactly as they were.
4. Write the file with valid JSON (2-space indent, trailing newline). Do not add comments — the file is plain JSON.
5. Validate: re-read the file, confirm it parses (`node -e "JSON.parse(require('fs').readFileSync(process.env.HOME + '/.pi/agent/pi-smart-router.json'))"`), `version` is `1`, `defaultRoute` exists in `routes`, and every rule's `route` still exists.
6. **Confirm the router is selectable.** If `~/.pi/agent/settings.json` has an `enabledModels` allowlist, it gates the `/model` selector (which models show up when you cycle), *not* the router's backend resolution — backends resolve via `registry.find()` on the full registry regardless of `enabledModels`. Only `pi-smart-router/auto` *must* be listed for you to select the router as your session model. Listing the four backend models is optional; it only lets you `/model` directly to a backend for manual testing. Do not claim routing breaks without them.

### Step 6: Report

Summarize: which tiers changed, which kept their model, any tier left unfilled, whether the router is selectable (`pi-smart-router/auto` already present / added to the allowlist / no allowlist present), and remind the user to restart Pi (or reload the extension) for the change to take effect.

## Failure Modes to Avoid

- **Do not touch** `rules`, `classifier`, `fallbacks`, or `defaultRoute` — routes only.
- Never put `powerful` in `fallbacks`.
- Never assign the same model to two tiers.
- Never invent model IDs — copy them exactly (lowercase) from `pi --list-models`.
- Never ask Jev one question per model with tiers as the criteria — that judges each model in isolation and can't compare candidates against each other. Always ask one question per tier with the candidate models as criteria.
- If two tiers' Jev picks collide on the same model, resolve by confidence as described in Step 3 — never leave two tiers pointing at the same model.
- Never overwrite the config without showing the user the proposed assignment first.
- Never let a candidate that fails a user-specified hard filter (e.g. below a minimum context window) reach a Jev question or the final config — filter the candidate list first, in Step 2.
- Project config (`<project>/.pi/pi-smart-router.json`) replaces the global one entirely — if one exists for the current project, warn the user that it will shadow the global config.
