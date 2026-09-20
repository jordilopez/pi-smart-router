---
name: model-tier-setup
description: Configures the four-tier routing policy of the pi-smart-router extension. Asks which providers to use, lists their models from the Pi registry, classifies each candidate model into cheap, fast, balanced, or powerful (preferably with TypeSafe Jev via typesafe_evaluate), and updates the routes section of the global ~/.pi/agent/pi-smart-router.json while preserving rules, classifier, fallbacks, and defaultRoute. Use when setting up or re-targeting smart-router model tiers.
---

# Model Tier Setup for pi-smart-router

## Overview

Configures the four-tier routing policy of the [pi-smart-router](https://github.com/jordilopez/pi-smart-router) extension. The skill asks the user which providers to use, lists each provider's models from the Pi registry, classifies every candidate model into one of the four tiers (cheap, fast, balanced, powerful) — preferably with TypeSafe Jev via the `typesafe_evaluate` tool — and updates the `routes` section of the **global** config at `~/.pi/agent/pi-smart-router.json`. Everything else in the config (`version`, `defaultRoute`, `classifier`, `rules`, `fallbacks`, `observability`) is preserved untouched.

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

## Workflow

### Step 1: Gather providers

Ask the user which provider(s) to configure (e.g. `hyper`, `deepseek`, `opencode-go`). If the user is unsure, show the providers available from `pi --list-models` (first column). If multiple providers are given, each tier still gets exactly one model overall — ask whether to mix providers per tier or pick a single winning provider.

### Step 2: List models

Run:

```sh
pi --list-models <provider>
```

Columns: `provider  model  context  max-out  thinking  images`. Present the model list to the user and let them deselect any models they don't want considered (e.g. experimental snapshots). Keep the table data — context window, max output, thinking, images — as classification evidence.

### Step 3: Classify with Jev (preferred)

Classify **each model** into a tier using the `typesafe_evaluate` tool:

- State: one named field per model, keyed by a slug of the model ID (e.g. `{ "glm_53_flash": "hyper/glm-5.3-flash | context 1M, maxOut 131K, thinking yes, images yes", ... }`).
- Questions: **one Choice question per model** (never aggregate several models into one question). The criteria are the four tiers `cheap`, `fast`, `balanced`, `powerful`; the instructions embed the tier rubric above and name the state field being judged.
- Respect tool limits: max 32 questions per call — batch in groups of ≤32; if a provider has more than 32 candidate models, ask the user to shortlist first.

If `typesafe_evaluate` is unavailable or fails (no operator opt-in, no `TYPESAFE_API_KEY`), fall back to classifying the models yourself from the rubric and catalog metadata — and **say explicitly** that Jev was not used and the assignment is your own judgment.

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
- Never overwrite the config without showing the user the proposed assignment first.
- Project config (`<project>/.pi/pi-smart-router.json`) replaces the global one entirely — if one exists for the current project, warn the user that it will shadow the global config.
