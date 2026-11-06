---
name: model-tier-setup
description: Configures the four-tier routing policy of the pi-smart-router extension. Use when setting up or re-targeting smart-router model tiers ("set up model tiers", "configure smart router models").
---

# Model Tier Setup for pi-smart-router

The mechanical work (catalog fetch → per-tier filters → Jev classification → collision resolution) lives in tools. This skill adds exactly one thing the tools do not: **the approval gate** — show the proposed routes and get explicit user confirmation *before* writing the config. Keep that guarantee; do the rest in the tightest way possible.

## Prerequisite

The pi-smart-router extension must be loaded so `smart-router-setup-tiers` and `smart-router-update-routes` are in the tool list. If they are not, say so and either reload/restart Pi or fall back to the manual path — never silently take the slow path.

## Scope

Set up or re-target the four `routes`. Do **not** touch `rules`, `classifier`, `fallbacks`, or `defaultRoute` — those are config edits, not tier classification.

## The Four Tiers

Source of truth is `TIER_RUBRIC` in `src/types.ts`. Capability filters are applied *before* classification, and Jev is instructed to weigh context/image/thinking per tier (see `TIER_INSTRUCTIONS` in `src/tools.ts`).

| Tier | Route | Intent | Default filters |
|---|---|---|---|
| cheap | `cheap-code` | low-risk mechanical work | ≥128k context |
| fast | `fast` | routine coding, clear implementation | ≥100k context, measured AA latency |
| balanced | `balanced` | context-aware judgment, review, tradeoffs | ≥200k context, images |
| powerful | `powerful` | architecture, security, root-cause, cross-cutting | ≥500k context, thinking |

Expected cost ladder (per 1M in / 250k out at 4:1): cheap ≤ fast ≤ balanced ≤ powerful. Tiers that violate it need justification at the approval gate.

`smart-router-setup-tiers` returns no pricing fields — fetch `costIn`/`costOut` via `smart-router-catalog` when the approval gate needs them.

## Workflow

1. **Gather providers.** Ask which provider(s) to configure (e.g. `hyper`, `opencode-go`). Multiple providers pool into one candidate list per tier.
2. **Classify.** Call `smart-router-setup-tiers({ providers, excludeModels?, tierOverrides?, narrow? })`. One Jev pass, answer taken as-is. It returns `assignments`, `routes` (ready-to-write), and `warnings`. The tool also applies the active provider credential's compatibility guard before classification; for OpenAI ChatGPT OAuth it excludes API-only `mini`/`nano` variants such as `gpt-5-mini`. If Jev is unavailable, the tool throws — surface the error and offer the manual fallback.
3. **Show and get approval.** Render `assignments` as a table (Tier | Route | Model | Confidence) and pass `warnings` through verbatim. Then ask the user to approve. This is the gate — never call `update-routes` without a yes.
   - **Check cost ordering.** Cost is a first-class decision input. Jev weighs capability first and cost only as a tie-break (see `costClause` in `src/catalog.ts`), so it can still propose a model that breaks the tier cost ladder. Fetch pricing via `smart-router-catalog`, compute each pick's blended cost (`costIn + costOut / 4`, a 4:1 input:output mix), and include it in the table.
   - **Flag inversions.** Flag any tier more expensive than a higher tier (e.g. `balanced` costing more than `powerful`) or costing ≥3× the blended cost of the cheapest filter-compliant alternative. Treat missing pricing as unknown, not zero: flag it rather than ranking it. Offer the cheaper compliant alternatives, then ask for approval. This cost offer is the one sanctioned proactive proposal — all other model swaps remain user-driven.
   - **Approve** → step 4.
   - **Wants changes** → the user names them (a specific tier/model, or a re-run with different `excludeModels`/`tierOverrides`). Apply/forward it and, if routes changed, re-show before writing. This is user-driven, not a standing refinement loop you propose unprompted.
   - Flag any unfilled tier and which `tierOverrides` knob would open it. Prefer four distinct models when four eligible candidates exist; the collision resolver re-homes duplicate picks rather than silently assigning one model to multiple tiers. If filtering leaves fewer than four eligible models, report the scarcity and leave the affected tier unfilled rather than inventing or silently duplicating a route.
4. **Write.** Call `smart-router-update-routes({ routes })` with the approved routes object. It validates models against the registry, preserves all non-`routes` config, and warns if a project config shadows the global one — surface that warning.
5. **Report.** Summarize which tiers changed and remind the user to restart Pi (or reload the extension) to take effect.

## Hard Rules

- Never write the config without showing the proposal and getting approval first.
- Never invent model IDs — copy exactly (lowercase) from tool output; `update-routes` enforces registry and current-auth compatibility validation.
- Do not manually re-add a model excluded by the current-auth guard. If filtering leaves a tier empty, use a supported provider/model or an API-key login rather than bypassing the guard.
- Never re-run Jev because confidence was low — surface the warning and let the user decide. The only re-run is a fresh classification with changed filters/exclusions the user asked for.
- The tool resolves model collisions deterministically and never displaces `powerful`; keep tier assignments distinct whenever the filtered candidate pool permits it. Do not silently assign one model to multiple tiers or invent a replacement when a tier is unfilled.
