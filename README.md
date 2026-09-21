# pi Smart Router

A [Pi coding-agent](https://github.com/earendil-works/pi-coding-agent) extension that registers a custom provider, `pi-smart-router`, with a single model `pi-smart-router/auto`. Each prompt is classified once per turn and routed through a **four-tier** resolver to the best configured **backend model** through Pi's model registry.

Classification and execution are separate concerns: the selected backend LLM performs the actual work, while the tier is chosen by a **classifier** — the recommended setup uses [TypeSafe Jev](#typesafe-jev-setup) (or any one-shot LLM); without it, a built-in keyword heuristic (English-oriented, no semantic understanding) picks the tier. The `fast` backend is **not** used as a judge unless you explicitly configure it as the classifier.

```
pi -e ./src/index.ts
# then: /model pi-smart-router/auto
```

> **Note:** The default configuration, examples, and testing have only used the `opencode-go` provider. Other providers *may* work but are untested; the session header injection (`x-opencode-session`) is currently `opencode-go`-specific.

## The four tiers (recommended policy)

All routes use pi's built-in `opencode-go` provider (auth: `OPENCODE_API_KEY`, `pi auth opencode-go`, or `/login opencode-go`). Pi's footer keeps showing `pi-smart-router/auto`; the footer status line names the backend that actually served each turn.

| Tier | Route | Backend | Intent |
|---|---|---|---|
| cheap | `cheap-code` | `<provider>/<cheap-model>` | Trivial work: greetings and small talk, quick questions, mechanical low-risk tasks (renames, formatting, imports, boilerplate, simple CRUD, test scaffolds). Score-driven via `cheapMax` (0.18) plus explicit mechanical-task rules, in heuristic mode. **Not local** — models listed in the example config are hosted. |
| fast | `fast` | `<provider>/<fast-model>` | Factual questions, trivial lookups, one-line edits. |
| balanced | `balanced` | `<provider>/<balanced-model>` | The everyday default: normal coding, reviews, multi-file edits. |
| powerful | `powerful` | `<provider>/<powerful-model>` | Genuinely difficult work only: architecture/system design, root-cause debugging, race conditions/concurrency, security vulnerabilities, hard performance bottlenecks, formal proofs/algorithmic reasoning, cross-cutting refactors. |

## Install

### Try it for one session

Run the extension directly without installing it:

```sh
pi -e /path/to/pi-smart-router/src/index.ts
```

### Install globally for your user

Install the package into Pi's global settings (the default; do not use `-l`):

```sh
pi install /path/to/pi-smart-router
```

For this repository, from its parent directory:

```sh
pi install ./pi-smart-router
```

Verify the installation:

```sh
pi list
pi --list-models | grep pi-smart-router
```

After installation, start Pi normally. You no longer need `-e`:

```sh
pi
```

If your `~/.pi/agent/settings.json` contains an `enabledModels` allowlist, add the router explicitly or it will be hidden from the model selector:

```json
{
  "enabledModels": [
    "pi-smart-router/auto",
    "<provider>/<fast-model>",
    "<provider>/<cheap-model>",
    "<provider>/<balanced-model>",
    "<provider>/<powerful-model>"
  ]
}
```

Use `pi install -l /path/to/pi-smart-router` only for a project-local installation. Global installs are recorded in `~/.pi/agent/settings.json`; project-local installs are recorded in `.pi/settings.json`.

The extension loads as plain TypeScript (Pi loads extensions via jiti) - no build step. `zod` is a runtime dependency; TypeScript and Vitest are only needed for development.

> **Note:** `pi-smart-router/auto` is a virtual model (never contacted). Its declared 1M context window is only for Pi's UI and compaction — the resolver checks each backend's own window (×0.8) when routing.

### Selecting the router model

```sh
pi                                    # then in the TUI: /model pi-smart-router/auto
pi --model pi-smart-router/auto       # or straight from the shell
pi -e ./src/index.ts --model pi-smart-router/auto   # when running from the repository
```

## Configuration files

Two-file layout:

| File | Purpose |
|---|---|
| `~/.pi/agent/models.json` or `<project>/.pi/models.json` | Standard Pi backend providers/models (untouched; the `opencode-go` catalog is built into pi) |
| `~/.pi/agent/pi-smart-router.json` | Global routing config |
| `<project>/.pi/pi-smart-router.json` | Project routing config (**only loaded when the project is trusted**) |

**Precedence:** project config (if trusted and present) > global config > built-in defaults. A config file that exists replaces the lower-priority one entirely (no deep merge).

Built-in defaults (used when no config file exists) mirror the recommended policy: `fast` → `<provider>/<fast-model>`, `cheap-code` → `<provider>/<cheap-model>`, `balanced` → `<provider>/<balanced-model>`, `powerful` → `<provider>/<powerful-model>`; defaultRoute `balanced`; fallbacks `["fast", "cheap-code"]`.

Routes are only resolved when actually selected - backends that don't exist or aren't configured do **not** break the extension; they're skipped and the fallback chain takes over. But **invalid config files fail loudly on load** (see [Troubleshooting](#troubleshooting)).

## Config schema (pi-smart-router.json)

```jsonc
{
  "version": 1,                       // required, must be 1
  "defaultRoute": "balanced",         // required; must exist in routes
  "routes": {
    "<name>": {
      "model": "provider/modelId",    // required, must contain "/"
      "reasoning": "preserve",        // optional: preserve|off|low|medium|high
      "maxTokens": 32000,             // optional output cap (must fit the model)
      "emoji": "🎯"                   // optional footer glyph (max 8 code points)
    }
  },
  "classifier": {
    "weights": {                      // complexity score weights (0-1)
      "promptTokens": 0.1,
      "contextTokens": 0.05,          // deliberately low: long sessions must not
                                      // inflate later prompts into the powerful tier
      "codeLikelihood": 0.25,
      "reasoningLikelihood": 0.35,
      "keywordSignal": 0.15,
      "toolSignal": 0.1,
      "imageSignal": 0                // kept at 0; image support is enforced by
                                      // capability checks, not the complexity score
    },
    "thresholds": {                   // used in heuristic mode (no classifier model)
      "cheapMax": 0.18,                // score <= cheapMax  -> cheap tier (cheap/cheap-code/low-cost/economy)
      "simpleMax": 0.35,               // <= simpleMax       -> fast tier (fast/simple/...)
      "mediumMax": 0.8                // <= mediumMax       -> balanced tier; above -> powerful tier
    },
    "maxPromptTokens": 4000,          // prompt analysis truncation limit
    "maxContextTokens": 100000,       // context analysis limit
    "model": "typesafe-ai/jev",      // recommended: per-turn classifier; omit to fall back to the keyword heuristic
    "timeoutMs": 1500                 // aborts the classifier call; see "Classifier" below
  },
  "rules": [                          // optional, evaluated by priority (desc)
    {
      "id": "hard-debugging",         // required, unique
      "priority": 100,
      "match": {                      // all specified conditions must hold
        "anyKeywords": ["root cause", "race condition"],  // any of these (escaped literal phrases)
        "allKeywords": ["memory", "leak"],                // all of these
        "minPromptTokens": 10,
        "minComplexity": 0.5,
        "code": true,               // prompt looks code-related
        "reasoningRequired": true,  // prompt looks reasoning-heavy
        "hasTools": true,           // tools attached to the context
        "hasImages": true           // images in the context
      },
      "route": "powerful"           // must exist in routes
    }
  ],
  "fallbacks": ["fast", "cheap-code"],  // tried in order after defaultRoute; NEVER include "powerful"
}
```

User keywords in rules are matched as **escaped literal phrases** (case-insensitive, whitespace-flexible); no arbitrary regex from config is evaluated.

## Routing decision order

For each new turn (re-classified only on `turn_start`):

1. **Explicit rules**, highest `priority` first. A matching rule is used only if its route resolves to an available + compatible backend; otherwise evaluation continues.
2. **Complexity thresholds — heuristic mode only** (cheap → fast → balanced → powerful): score ≤ `cheapMax` (default `0.18`) → route named `cheap`/`cheap-code`/`low-cost`/`economy`; ≤ `simpleMax` (default `0.35`) → `fast`/`simple`/...; ≤ `mediumMax` → `balanced`/...; above `mediumMax` → `powerful`/.... Alias matching is exact-name first, then name-segment match (e.g. `my-cheap-code-route` matches the cheap tier, but `fastest` does not match `fast`). If the tier route doesn't exist or is unavailable, fall through to `defaultRoute`. With a classifier configured this step is skipped entirely: the classifier's verdict replaces the tier (and a transient classifier failure goes to `defaultRoute`, never a heuristic tier) — see below.
3. **`defaultRoute`**.
4. **`fallbacks`**, in order.
5. **Any available route** (declaration order).
6. If nothing is available: stream error `NO_FALLBACK_AVAILABLE`.

**Compatibility checks** before a route is accepted:

- images in context require the backend model to list `"image"` in `input` (all four opencode-go models support images)
- estimated context tokens must fit `contextWindow * 0.8` (opencode-go models offer ~1M context, so this rarely binds)
- explicit `reasoning` (`low|medium|high`) requires `model.reasoning`
- route `maxTokens` must not exceed `model.maxTokens`
- the model/provider must exist and have configured auth

## Classifier (recommended: LLM / TypeSafe Jev)

Keyword thresholds are fast and free but blind to meaning — and English-only —
so semantically equal prompts can land on opposite sides of a tier boundary.
**Configure a classifier** (`classifier.model`) and it classifies **every** new
turn; its verdict is final (any tier, including `powerful`). Without it the
router falls back to the heuristic score: deterministic, no API key needed,
but keyword-based and English-oriented. Either way, explicit rules always win
first.

Two backends:

- `typesafe-ai/...` ref (e.g. `typesafe-ai/jev`) — served by the
  `@typesafe-ai/sdk` directly, one System One **Choice** call per new turn.
  Requires `TYPESAFE_API_KEY` in the environment (see
  [setup](#typesafe-jev-setup)); without it the classifier is unavailable and
  the heuristic thresholds apply instead.
- any other `provider/modelId` — a one-shot LLM call
  (`maxTokens: 4`, `temperature: 0`).

The classifier sees the four-tier rubric, a bounded recent transcript
(~2000 tokens, untrusted input), and the heuristic's own signals. Transient
failures (timeout, stream error, unparseable answer) route through
`defaultRoute`/fallbacks — never a heuristic tier. `pi-smart-router/*` refs
are rejected at config load so the router can never classify into itself.

The heuristic fallback is computed from the prompt and context: estimated
tokens, code/reasoning keyword likelihoods (English keyword lists), tool and
image presence, combined with configurable weights. Harness-injected skill
bodies are stripped before scoring — and in the classifier transcript replaced
by a `[skill invoked: <name>]` marker — so a SKILL.md cannot inflate the score
or saturate the classifier's bounded budget.

```jsonc
{
  "classifier": {
    "model": "typesafe-ai/jev",   // omit to use heuristic thresholds only
    "timeoutMs": 1500
  }
}
```

### Why route with Jev

The score thresholds are fast, free, and blind to meaning — semantically equal
prompts land on opposite sides of a boundary ("could you review my changes?"
vs. "analyze this diff"). Jev is a judgment model, not a chat model:

- **Semantic tier choice.** It reads a bounded transcript plus the user request
  and returns one of `cheap`/`fast`/`balanced`/`powerful` with a probability —
  fixing boundary misrouting that keywords cannot.
- **Sub-second and cheap.** No multi-step reasoning; tool-call continuations
  reuse the cached decision.
- **Verdict is final, any tier.** It may promote *or* demote, including to
  `powerful` — which is otherwise hard to reach.
- **Data note.** Each classified turn sends the bounded transcript (not the
  full conversation, not files) to TypeSafe, and usage is billed to your
  TypeSafe account. Omit `classifier.model` to stay fully local.

### TypeSafe Jev setup

1. Create a key at [console.typesafe.ai](https://console.typesafe.ai) and export
   it **in the environment that runs Pi** (do not paste it into config files):

   ```sh
   export TYPESAFE_API_KEY="..."   # ~/.zshrc / ~/.bashrc, or a launcher
   ```

2. Configure the router to use it (global `~/.pi/agent/pi-smart-router.json` or a
   trusted project `.pi/pi-smart-router.json`):

   ```jsonc
   { "classifier": { "model": "typesafe-ai/jev", "timeoutMs": 1500 } }
   ```

3. Start Pi and confirm the classifier ran: the footer shows
   `… · classifier` (plus `· <ms>/<in>i/<out>o` once the backend reports
   stats). If you instead see `threshold` in the footer, the router did not
   find a usable key and fell back to heuristics.

> **`/typesafe login` is not enough for the router.** The
> [`pi-typesafe`](https://github.com/DevMortimer/pi-typesafe) extension (`pi
> install npm:pi-typesafe`) stores its key in `~/.pi/agent/pi-typesafe/auth.json`
> and is only needed for its own `typesafe_evaluate` tool. The router always
> reads `TYPESAFE_API_KEY` from the environment. Set both if you want the tool
> *and* Jev routing. To enable the `typesafe_evaluate` tool by default in every
> new session (no `/typesafe enable` prompt), export `PI_TYPESAFE_ENABLED=1` in
> your shell.

## Route visibility in Pi's UI

- **Footer status** - after each route decision the footer shows the active backend and how the tier was chosen, e.g. `🎯 balanced · <provider>/<balanced-model> · threshold`, `⚡ fast · <provider>/<fast-model> · classifier`, or `💎 powerful · <provider>/<powerful-model> · classifier`. When the classifier reports usage, its cost is appended: `· 742ms/350i/47o`. The heuristic complexity score is intentionally omitted (it does not select the tier when a classifier is configured). The leading glyph is the route's configured `emoji`, or the built-in glyph for the standard route names (⚡ fast, 🪙 cheap-code, 🎯 balanced, 💎 powerful). Custom routes without an `emoji` fall back to `↳`. On a new turn it briefly shows `router: classifying…` until the decision replaces it, and it is cleared when the session shuts down. This is enabled by default.
- **No transcript noise** - route decisions are intentionally *not* appended to the transcript; the footer status is the single source of that information.
- **Footer model unchanged** - Pi's normal footer model remains `pi-smart-router/auto`; the footer status line above is where you see which backend actually served the turn.

## Troubleshooting

- **`400 MissingSessionID: Request is missing x-opencode-session`** - Console Go (opencode-go) requires a session header to route requests efficiently. The router forwards Pi's **stable session id** (captured on `session_start` from `ctx.sessionManager.getSessionId()`) as the `x-opencode-session` header on every opencode-go request, so the value stays constant across prompts and tool continuations. If the caller already supplies its own `x-opencode-session` header or `options.sessionId`, that explicit value wins and is forwarded as-is. The header is only injected for `opencode-go` - other providers are untouched.
- **`No credentials configured for provider 'opencode-go'`** - auth missing. Run `pi auth opencode-go`, set `OPENCODE_API_KEY`, or use `/login opencode-go`.
- **`Model not found in registry: provider/modelId`** — the route references a model Pi doesn't know. Check spelling (model IDs are exact and lowercase) and run `pi --list-models <provider>` to see the catalog.
- **`No compatible backend model available for any configured route`** - every route failed the availability/compatibility checks (missing auth, model missing, context window too small for the current conversation, etc.).
- **Config error at startup** - pi-smart-router.json is invalid (bad JSON, unknown route reference, duplicate rule id, malformed `provider/modelId`, wrong `version`). Fix the file; the message names the offending path.
- **The powerful model shows up more than expected** — check your `mediumMax` (default 0.80) and your rules; the policy deliberately keeps the powerful model rare and out of the fallback chain.

## Limitations

- Token counts are **heuristics** (`chars/4`, images ≈ 512 tokens); treat thresholds as approximate.
- `reasoning: "off"` cannot force-disable thinking on providers that always think; it only avoids requesting reasoning. `preserve` keeps the session's thinking level.
- Backend availability is evaluated when the decision is made; a backend that dies mid-turn surfaces as a stream error (no mid-turn failover).
- The router does not evaluate answer quality or test outcomes after a turn starts.

## Development

```sh
npm install
npx tsc --noEmit   # typecheck (resolves pi packages via tsconfig paths)
npx vitest run     # unit tests (classifier, route resolver, config, stream contract)
```

The typecheck/tests resolve `@earendil-works/pi-ai` / `@earendil-works/pi-coding-agent` from the installed Pi CLI (see `tsconfig.json` paths and `vitest.config.ts`); override with `PI_PACKAGE_DIR` if your Pi install lives elsewhere.
