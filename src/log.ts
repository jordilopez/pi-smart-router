/**
 * File-based debug logging for the smart-router extension.
 *
 * The extension runs inside the pi TUI process, where anything written to
 * stdout/stderr (console.log / console.error) is painted as raw output over
 * the TUI, corrupting the input line. All diagnostics therefore go to a log
 * file instead - never to the process streams.
 *
 * Log file resolution (first match wins):
 * 1. `SMART_ROUTER_LOG` environment variable (supports a leading `~`)
 * 2. `<os tmpdir>/smart-router.log`
 */

import { appendFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

/** Resolved once at module load; null disables file logging. */
const logPath: string | null = (() => {
  const configured = process.env.SMART_ROUTER_LOG?.trim();
  if (configured) {
    // Expand only a home-directory tilde ("~" or "~/..."); "~user" forms are
    // left untouched (they refer to another user's home).
    return /^~(\/|$)/.test(configured) ? path.join(homedir(), configured.slice(1)) : configured;
  }
  return path.join(tmpdir(), "smart-router.log");
})();

/** The active log file path (exported for tests and diagnostics). */
export function getLogPath(): string | null {
  return logPath;
}

/**
 * Append one diagnostic line to the log file. Best-effort: any write error
 * (unwritable path, disk full, ...) is swallowed so logging can never break
 * routing or the TUI.
 */
export function debugLog(message: string): void {
  if (!logPath) return;
  try {
    appendFileSync(logPath, `[${new Date().toISOString()}] [smart-router] ${message}\n`);
  } catch {
    // Ignore - diagnostics must never interfere with routing.
  }
}
