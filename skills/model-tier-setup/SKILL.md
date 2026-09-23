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
| fast | `fast` | routine coding, clear implementation | ≥100k context |
| balanced | `balanced` | context-aware judgment, review, tradeoffs | ≥200k context, images |
| powerful | `powerful` | architecture, security, root-cause, cross-cutting | ≥500k context, thinking |

## Workflow

1. **Gather providers.** Ask which provider(s) to configure (e.g. `hyper`, `opencode-go`). Multiple providers pool into one candidate list per tier.
2. **Classify.** Call `smart-router-setup-tiers({ providers, excludeModels?, tierOverrides?, narrow? })`. One Jev pass, answer taken as-is. It returns `assignments`, `routes` (ready-to-write), and `warnings`. If Jev is unavailable, the tool throws — surface the error and offer the manual fallback.
3. **Show and get approval.** Render `assignments` as a table (Tier | Route | Model | Confidence) and pass `warnings` through verbatim. Then ask the user to approve. This is the gate — never call `update-routes` without a yes.
   - **Approve** → step 4.
   - **Wants changes** → the user names them (a specific tier/model, or a re-run with different `excludeModels`/`tierOverrides`). Apply/forward it and, if routes changed, re-show before writing. This is user-driven, not a standing refinement loop you propose unprompted.
   - Flag any unfilled tier and which `tierOverrides` knob would open it.
4. **Write.** Call `smart-router-update-routes({ routes })` with the approved routes object. It validates models against the registry, preserves all non-`routes` config, and warns if a project config shadows the global one — surface that warning.
5. **Report.** Summarize which tiers changed and remind the user to restart Pi (or reload the extension) to take effect.

## Hard Rules

- Never write the config without showing the proposal and getting approval first.
- Never invent model IDs — copy exactly (lowercase) from tool output; `update-routes` enforces via registry validation.
- Never re-run Jev because confidence was low — surface the warning and let the user decide. The only re-run is a fresh classification with changed filters/exclusions the user asked for.
- The tool resolves model collisions deterministically and never displaces `powerful` — leave two tiers on one model is not an option.
