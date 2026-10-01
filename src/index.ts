/**
 * Smart Router extension entry point.
 *
 * Registers the "pi-smart-router/auto" virtual model (selectable via /model)
 * and wires lifecycle events:
 * - session_start: load routing config and capture the footer status callback
 * - session_shutdown: clear all router state
 *
 * Dispatch is native: the virtual model's route() picks a physical backend
 * model and pi streams from it directly.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadSmartRouterConfig } from "./config.js";
import { initializeRouterState, routeRequest, shutdownRouterState } from "./virtual-router.js";
import { registerTools } from "./tools.js";

export default function (pi: ExtensionAPI): void {
  pi.registerVirtualModel({
    provider: "pi-smart-router",
    id: "auto",
    name: "Smart Router (Auto)",
    thinkingLevels: ["off", "low", "medium", "high"],
    input: ["text", "image"],
    async route(request, ctx) {
      return routeRequest(request, { modelRegistry: ctx.modelRegistry as never });
    },
  });

  // Register tools for the model-tier-setup skill
  registerTools(pi);

  pi.on("session_start", async (_event, ctx) => {
    const trusted = ctx.isProjectTrusted();
    try {
      const result = await loadSmartRouterConfig({ projectTrusted: trusted, cwd: ctx.cwd });
      initializeRouterState({
        config: result.config,
        // Tier visibility in the footer. Bound closures only — no whole
        // ExtensionContext is retained.
        setStatus: (key, text) => ctx.ui.setStatus(key, text),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // stderr is only safe outside the TUI (print/JSON mode); in the TUI the
      // user is notified through ctx.ui instead.
      if (!ctx.hasUI) console.error(`[pi-smart-router] ${message}`);
      if (ctx.hasUI) ctx.ui.notify(`pi-smart-router: ${message}`, "error");
    }
  });

  pi.on("session_shutdown", () => {
    shutdownRouterState();
  });

  // Config reload: session_start fires again with reason "reload" and re-runs
  // loadSmartRouterConfig, so no dedicated handler is needed.
}
