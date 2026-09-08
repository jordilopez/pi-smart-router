# pi Smart Router

A [Pi coding-agent](https://github.com/earendil-works/pi-coding-agent) extension that registers a custom provider, `smart-router`, with a single model `smart-router/auto`. Each prompt is classified locally (no extra LLM calls) and routed through a **four-tier** resolver to the best configured **backend model** through Pi's model registry.

```
pi -e ./src/index.ts
# then: /model smart-router/auto
```

## The four tiers (recommended policy)

All routes use pi's built-in `opencode-go` provider (auth: `OPENCODE_API_KEY`, `pi auth opencode-go`, or `/login opencode-go`). Pi's footer keeps showing `smart-router/auto`; the `[smart-router]` route log line identifies the actual backend used for each turn.

| Tier | Route | Backend | Cost per 1M (in/out) | Intent |
|---|---|---|---|---|
| cheap | `cheap-code` | `opencode-go/mimo-v2.5` | $0.14 / $0.28 | Mechanical, low-risk tasks (renames, formatting, imports, boilerplate, simple CRUD, test scaffolds). **Not local** - mimo-v2.5 is a cheap hosted code model. |
| fast | `fast` | `opencode-go/glm-5.3-flash` | $0.075 / $0.25 | Greetings, quick questions, trivial lookups. |
| balanced | `balanced` | `opencode-go/gpt-5.6-luna` (exact lowercase ID) | $0.20 / $1.20 | The everyday default: normal coding, reviews, multi-file edits. |
| powerful | `powerful` | `opencode-go/kimi-k3` | $3 / $15 | Genuinely difficult work only: architecture/system design, root-cause debugging, race conditions/concurrency, security vulnerabilities, hard performance bottlenecks, formal proofs/algorithmic reasoning, cross-cutting refactors. |

**Kimi is dramatically more expensive** (an order of magnitude above the other tiers) and is deliberately hard to reach:

- The default `mediumMax` threshold is **0.80**, so only the highest complexity scores reach the powerful tier without explicit rules.
- Explicit powerful rules use **high-confidence phrases only** (e.g. "root cause", "race condition", "system design", "security vulnerability", "performance bottleneck", "formal proof") - never generic words like `analyze`, `debug`, `design`, or `implement`.
- `powerful` is **never** in `fallbacks`; the default fallback chain is `fast` → `cheap-code`.
- Ordinary code-looking prompts are **not** dumped onto cheap-code; they flow through the score tiers to balanced. The only cheap-code rule is scoped to explicit mechanical-task phrases.

## How it works

1. `streamSimple` is called by Pi for `smart-router/auto`.
2. Once per **turn**, the prompt/context is classified into features (token estimates, code likelihood, reasoning likelihood, keyword groups, tools) and a weighted **complexity score** (0-1) is computed.
3. A deterministic resolver picks a **route** (see [Routing decision order](#routing-decision-order)). Each route maps to a backend `provider/modelId`.
4. The request is delegated to the backend provider via `modelRegistry.getProvider(...).streamSimple(...)`, with auth (`apiKey`/`headers`/`baseUrl`) resolved through `modelRegistry.getApiKeyAndHeaders(...)`. All stream events are forwarded unchanged.
5. Tool-call continuations **reuse the turn's route decision** - the backend never changes mid-turn.

## Install

### Try it for one session

Run the extension directly without installing it:

```sh
pi -e /path/to/smart-router/src/index.ts
```

### Install globally for your user

Install the package into Pi's global settings (the default; do not use `-l`):

```sh
pi install /path/to/smart-router
```

For this repository:

```sh
pi install /Users/jordi/development/routerrific/smart-router
```

Verify the installation:

```sh
pi list
pi --list-models | grep smart-router
```

After installation, start Pi normally. You no longer need `-e`:

```sh
pi
```

If your `~/.pi/agent/settings.json` contains an `enabledModels` allowlist, add the router explicitly or it will be hidden from the model selector:

```json
{
  "enabledModels": [
    "smart-router/auto",
    "opencode-go/glm-5.3-flash",
    "opencode-go/mimo-v2.5",
    "opencode-go/gpt-5.6-luna",
    "opencode-go/kimi-k3"
  ]
}
```

Use `pi install -l /path/to/smart-router` only for a project-local installation. Global installs are recorded in `~/.pi/agent/settings.json`; project-local installs are recorded in `.pi/settings.json`.

The extension loads as plain TypeScript (Pi loads extensions via jiti) - no build step. `zod` is a runtime dependency; TypeScript and Vitest are only needed for development.

## Configuration files

Two-file layout:

| File | Purpose |
|---|---|
| `~/.pi/agent/models.json` or `<project>/.pi/models.json` | Standard Pi backend providers/models (untouched; the `opencode-go` catalog is built into pi) |
| `~/.pi/agent/smart-router.json` | Global routing config |
| `<project>/.pi/smart-router.json` | Project routing config (**only loaded when the project is trusted**) |

**Precedence:** project config (if trusted and present) > global config > built-in defaults. A config file that exists replaces the lower-priority one entirely (no deep merge).

Built-in defaults (used when no config file exists) mirror the recommended policy: `fast` → `opencode-go/glm-5.3-flash`, `cheap-code` → `opencode-go/mimo-v2.5`, `balanced` → `opencode-go/gpt-5.6-luna`, `powerful` → `opencode-go/kimi-k3`; defaultRoute `balanced`; fallbacks `["fast", "cheap-code"]`.

Routes are only resolved when actually selected - backends that don't exist or aren't configured do **not** break the extension; they're skipped and the fallback chain takes over. But **invalid config files fail loudly on load** (see [Troubleshooting](#troubleshooting)).

## Config schema (smart-router.json)

```jsonc
{
  "version": 1,                       // required, must be 1
  "defaultRoute": "balanced",         // required; must exist in routes
  "routes": {
    "<name>": {
      "model": "provider/modelId",    // required, must contain "/"
      "reasoning": "preserve",        // optional: preserve|off|low|medium|high
      "maxTokens": 32000              // optional output cap (must fit the model)
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
    "thresholds": {
      "cheapMax": 0.15,               // score <= cheapMax  -> cheap tier (cheap/cheap-code/low-cost/economy)
      "simpleMax": 0.3,               // <= simpleMax       -> fast tier (fast/simple/...)
      "mediumMax": 0.8                // <= mediumMax       -> balanced tier; above -> powerful tier
    },
    "maxPromptTokens": 4000,          // prompt analysis truncation limit
    "maxContextTokens": 100000        // context analysis limit
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
  "observability": {
    "showRouteStatus": true,          // emit the concise decision log line (route/backend/score/turn)
    "logDecisions": false             // emit the detailed decision log (adds rule, reason, explanation)
  }
}
```

User keywords in rules are matched as **escaped literal phrases** (case-insensitive, whitespace-flexible); no arbitrary regex from config is evaluated.

## Routing decision order

For each new turn (re-classified only on `turn_start`):

1. **Explicit rules**, highest `priority` first. A matching rule is used only if its route resolves to an available + compatible backend; otherwise evaluation continues.
2. **Complexity thresholds** (cheap → fast → balanced → powerful): score ≤ `cheapMax` → route named `cheap`/`cheap-code`/`low-cost`/`economy`; ≤ `simpleMax` → `fast`/`simple`/...; ≤ `mediumMax` → `balanced`/...; above `mediumMax` → `powerful`/.... Alias matching is exact-name first, then name-segment match (e.g. `my-cheap-code-route` matches the cheap tier, but `fastest` does not match `fast`). If the tier route doesn't exist or is unavailable, fall through to `defaultRoute`.
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

## Turn stability

- The route decision is cached per turn. Within a turn (e.g. tool-call continuations) the **same backend is reused**; only classification/route resolution is skipped - every stream request still delegates to the backend.
- `turn_start` resets the cache. A message-based heuristic (new user prompt after tool results) is kept as fallback safety.
- The backend is never switched after the first stream event; failures after content has been emitted surface as stream errors, not fallbacks.

## Route visibility in Pi's UI

- **Footer status** - after each route decision the footer shows the active backend, e.g. `↳ balanced · opencode-go/gpt-5.6-luna (0.42)`. On a new turn it briefly shows `router: classifying…` until the decision replaces it, and it is cleared when the session shuts down. This is enabled by default and does not depend on `logDecisions`.
- **No transcript noise** - route decisions are intentionally *not* appended to the transcript; the footer status is the single source of that information. For the full detail (reason, explanation, matched rule), check the log file below.
- **Footer model unchanged** - Pi's normal footer model remains `smart-router/auto`; the footer status line above is where you see which backend actually served the turn.

## Observability (log file)

Diagnostics are written to a **log file, never to stdout/stderr** - raw console output from an in-process extension is painted directly over the pi TUI and corrupts the input line. One log line is emitted per route decision (never includes prompt text) and names the **actual backend**. With the default `showRouteStatus: true` the concise line is logged:

```
[2026-02-14T10:12:33.001Z] [smart-router] route=balanced backend=opencode-go/gpt-5.6-luna score=0.42 turn=3 session=a1b2c3d4
```

Setting `logDecisions: true` switches to the detailed line, which adds the matched rule, decision reason, and explanation:

```
[2026-02-14T10:12:33.001Z] [smart-router] route=balanced backend=opencode-go/gpt-5.6-luna score=0.42 turn=3 session=a1b2c3d4 rule=- reason=threshold detail="Complexity 0.42 (balanced tier) -> route 'balanced'"
```

The log file defaults to `<tmpdir>/smart-router.log` (e.g. `/tmp/smart-router.log` on macOS/Linux) and can be redirected with the `SMART_ROUTER_LOG` environment variable (a leading `~` is expanded; `~user` forms are not):

```sh
SMART_ROUTER_LOG=~/.pi/agent/logs/smart-router.log pi
```

The `session=` prefix (first 8 characters of the Pi session id) disambiguates parallel pi sessions appending to a shared log file. Config-load diagnostics on `session_start` and config errors are also logged to the file; config errors additionally surface as a `ctx.ui.notify` toast in the TUI, and router-originated stream failures are prefixed with their error code (e.g. `BACKEND_AUTH_MISSING: ...`) in the stream error message. No raw prompt data is ever logged or stored in entries.

## Selecting the router

After a global installation:

```sh
pi
# in the TUI: /model smart-router/auto
# or from the shell:
pi --model smart-router/auto
```

When running directly from the repository, include the extension path:

```sh
pi -e ./src/index.ts --model smart-router/auto
```

## Troubleshooting

- **`400 MissingSessionID: Request is missing x-opencode-session`** - Console Go (opencode-go) requires a session header to route requests efficiently. The router forwards Pi's **stable session id** (captured on `session_start` from `ctx.sessionManager.getSessionId()`) as the `x-opencode-session` header on every opencode-go request, so the value stays constant across prompts and tool continuations. If the caller already supplies its own `x-opencode-session` header or `options.sessionId`, that explicit value wins and is forwarded as-is. The header is only injected for `opencode-go` - other providers are untouched.
- **`No credentials configured for provider 'opencode-go'`** - auth missing. Run `pi auth opencode-go`, set `OPENCODE_API_KEY`, or use `/login opencode-go`.
- **`Model not found in registry: provider/modelId`** - the route references a model Pi doesn't know. Check spelling (model IDs are exact and lowercase, e.g. `gpt-5.6-luna`) and run `pi --list-models opencode-go` to see the catalog.
- **`No compatible backend model available for any configured route`** - every route failed the availability/compatibility checks (missing auth, model missing, context window too small for the current conversation, etc.).
- **Config error at startup** - smart-router.json is invalid (bad JSON, unknown route reference, duplicate rule id, malformed `provider/modelId`, wrong `version`). Fix the file; the message names the offending path.
- **Kimi (powerful) shows up more than expected** - check your `mediumMax` (default 0.80) and your rules; the policy deliberately keeps kimi-k3 rare and out of the fallback chain.

## Limitations

- Routing is **per turn, not per tool call**: tool-call continuations keep the turn's route even if the intermediate prompt looks different.
- Token counts are **heuristics** (`chars/4`, images ≈ 512 tokens); treat thresholds as approximate.
- Classification is local heuristics (keywords/patterns) - no extra LLM call, and no semantic understanding.
- `reasoning: "off"` cannot force-disable thinking on providers that always think; it only avoids requesting reasoning. `preserve` keeps the session's thinking level.
- Backend availability is evaluated when the decision is made; a backend that dies mid-turn surfaces as a stream error (no mid-turn failover).

## Development

```sh
npm install
npx tsc --noEmit   # typecheck (resolves pi packages via tsconfig paths)
npx vitest run     # unit tests (classifier, route resolver, config, stream contract)
```

The typecheck/tests resolve `@earendil-works/pi-ai` / `@earendil-works/pi-coding-agent` from the installed Pi CLI (see `tsconfig.json` paths and `vitest.config.ts`); override with `PI_PACKAGE_DIR` if your Pi install lives elsewhere.
