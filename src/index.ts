/**
 * Smart Router extension entry point.
 *
 * Registers the "pi-smart-router" custom provider (selectable via
 * /model pi-smart-router/auto) and wires lifecycle events:
 * - session_start: capture the model registry/cwd/trust/session id, load
 *   routing config, and bind the footer status callback
 * - turn_start: reset the per-turn cached route decision (footer shows
 *   "classifying…" until the decision replaces it)
 * - session_shutdown: clear all router state and the footer status
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadSmartRouterConfig } from "./config.js";
import { debugLog } from "./log.js";
import {
  getRouterState,
  initializeRouter,
  onTurnStart,
  shutdownRouter,
  streamSmartRouter,
} from "./provider.js";

/**
 * The single registered router model.
 *
 * "auto" is a virtual model: routing decisions use each backend model's own
 * contextWindow (see route-resolver.ts), so this value only affects pi core's
 * view of the router (UI display and compaction triggering). It is declared as
 * 1M to mirror the configured 1M-context backends; a smaller value would make
 * pi compact conversations long before the backends were actually full.
 */
const ROUTER_MODELS = [
  {
    id: "auto",
    name: "Smart Router (Auto)",
    reasoning: true,
    input: ["text", "image"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 64000,
  },
];

export default function (pi: ExtensionAPI): void {
  // Legacy config-form registration (same shape as the gitlab-duo example).
  // The baseUrl is a placeholder - the router never contacts it; it delegates
  // to backend providers via the model registry. The apiKey is a sentinel so
  // the model is selectable; it is never forwarded to backends.
  pi.registerProvider("pi-smart-router", {
    name: "Smart Router",
    baseUrl: "http://localhost",
    apiKey: "pi-smart-router",
    api: "pi-smart-router-api",
    models: ROUTER_MODELS,
    streamSimple: streamSmartRouter,
  });

  pi.on("session_start", async (_event, ctx) => {
    const trusted = ctx.isProjectTrusted();
    try {
      const result = await loadSmartRouterConfig({ projectTrusted: trusted, cwd: ctx.cwd });
      const sessionId = ctx.sessionManager.getSessionId();
      initializeRouter({
        registry: ctx.modelRegistry,
        config: result.config,
        // Stable session id forwarded to backends that require it (Console Go
        // requires x-opencode-session). Cleared again on session_shutdown.
        sessionId,
        // Turn numbering continues across config reloads (session_start fires
        // again with reason "reload" and re-runs this handler). A fresh
        // session starts at 0 because session_shutdown cleared the state.
        turnNumber: getRouterState()?.turnNumber ?? 0,
        // Route visibility: footer status only.
        // Bound closures only - no whole ExtensionContext is retained.
        setStatus: (key, text) => ctx.ui.setStatus(key, text),
      });
      // Never console.log here: stdout is owned by the TUI and raw writes
      // paint over the input line. Diagnostics go to the log file instead
      // (see log.ts; default <tmpdir>/pi-smart-router.log).
      debugLog(
        `config from ${result.sourcePath} (project: ${result.isProjectConfig}); ` +
          `default route '${result.config.defaultRoute}', routes: ${Object.keys(result.config.routes).join(", ")} ` +
          `session=${sessionId ? sessionId.slice(0, 8) : "-"}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debugLog(`config load failed: ${message}`);
      // stderr is only safe outside the TUI (print/JSON mode); in the TUI the
      // user is notified through ctx.ui instead.
      if (!ctx.hasUI) console.error(`[pi-smart-router] ${message}`);
      if (ctx.hasUI) ctx.ui.notify(`pi-smart-router: ${message}`, "error");
    }
  });

  pi.on("turn_start", () => {
    onTurnStart();
  });

  pi.on("session_shutdown", () => {
    shutdownRouter();
  });

  // Config reload: session_start fires again with reason "reload" and re-runs
  // loadSmartRouterConfig, so no dedicated handler is needed.
}
