/**
 * Tests for the file-based debug log sink (src/log.ts).
 *
 * The log path is resolved once at module load, so each case re-imports the
 * module with vi.resetModules() after setting the environment. Writes go to
 * real files under os.tmpdir() and are cleaned up afterwards.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const LOG_SRC = new URL("../src/log.js", import.meta.url).pathname;

/** (Re)import the log module with the current environment. */
async function importLogModule() {
  vi.resetModules();
  return import(LOG_SRC);
}

/** Unique scratch path under the OS temp dir. */
function scratchPath(name: string): string {
  return path.join(os.tmpdir(), `smart-router-log-test-${process.pid}-${name}`);
}

describe("debugLog sink", () => {
  const scratch: string[] = [];

  beforeEach(() => {
    delete process.env.SMART_ROUTER_LOG;
  });

  afterEach(() => {
    for (const p of scratch.splice(0)) {
      try {
        rmSync(p, { force: true, recursive: true });
      } catch {
        // best-effort cleanup
      }
    }
    vi.resetModules();
  });

  it("defaults to <tmpdir>/smart-router.log when SMART_ROUTER_LOG is unset", async () => {
    const { getLogPath } = await importLogModule();
    expect(getLogPath()).toBe(path.join(os.tmpdir(), "smart-router.log"));
  });

  it("uses SMART_ROUTER_LOG verbatim for plain absolute paths", async () => {
    const target = scratchPath("plain.log");
    scratch.push(target);
    process.env.SMART_ROUTER_LOG = target;
    const { getLogPath } = await importLogModule();
    expect(getLogPath()).toBe(target);
  });

  it("expands a leading ~ to the home directory", async () => {
    const relative = path.join(".pi", "agent", "logs", "smart-router-test.log");
    process.env.SMART_ROUTER_LOG = `~/${relative}`;
    const { getLogPath } = await importLogModule();
    expect(getLogPath()).toBe(path.join(os.homedir(), relative));
  });

  it("expands a bare ~ to the home directory itself", async () => {
    process.env.SMART_ROUTER_LOG = "~";
    const { getLogPath } = await importLogModule();
    expect(getLogPath()).toBe(os.homedir());
  });

  it("does not expand ~user forms", async () => {
    process.env.SMART_ROUTER_LOG = "~someuser/logs/smart-router.log";
    const { getLogPath } = await importLogModule();
    expect(getLogPath()).toBe("~someuser/logs/smart-router.log");
  });

  it("appends timestamped [smart-router] lines", async () => {
    const target = scratchPath("append.log");
    scratch.push(target);
    process.env.SMART_ROUTER_LOG = target;
    const { debugLog } = await importLogModule();

    debugLog("first message");
    debugLog("second message");

    const lines = readFileSync(target, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z\] \[smart-router\] first message$/);
    expect(lines[1]).toContain("[smart-router] second message");
  });

  it("swallows write errors instead of throwing", async () => {
    // A directory is not writable as a log file (EISDIR); debugLog must
    // never propagate the failure to routing.
    const dir = scratchPath("dir");
    scratch.push(dir);
    mkdirSync(dir, { recursive: true });
    process.env.SMART_ROUTER_LOG = dir;
    const { debugLog } = await importLogModule();

    expect(() => debugLog("goes nowhere")).not.toThrow();
  });
});
