import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// pi-ai and pi-tui are host-provided packages: the pi coding agent supplies
// them at runtime. Locally they may be installed either top-level (hoisted) or
// nested under the agent package, so resolve whichever layout is present — the
// same fallback order as tsconfig.json's `paths`. PI_PACKAGE_DIR points at a
// different pi install (e.g. a global CLI) and is searched first when set.
const thisDir = path.dirname(fileURLToPath(import.meta.url));
const AGENT_DIR =
  process.env.PI_PACKAGE_DIR ??
  path.join(thisDir, "node_modules/@earendil-works/pi-coding-agent");

/** Directories that may contain @earendil-works/<pkg>, in resolution order. */
const hostPackageRoots = [
  ...(process.env.PI_PACKAGE_DIR
    ? [path.join(process.env.PI_PACKAGE_DIR, "node_modules")]
    : []),
  path.join(thisDir, "node_modules"),
  path.join(AGENT_DIR, "node_modules"),
];

/** Absolute path to a file inside a host-provided package, in any layout. */
function hostPackageFile(pkg: string, file: string): string {
  const relative = [...pkg.split("/"), file].join("/");
  for (const root of hostPackageRoots) {
    const candidate = path.join(root, relative);
    if (existsSync(candidate)) return candidate;
  }
  // Nothing resolved — return the top-level candidate so the failure message
  // points at the expected location.
  return path.join(hostPackageRoots[0], relative);
}

const PIAI_COMPAT = hostPackageFile("@earendil-works/pi-ai", "dist/compat.js");
const PITUI = hostPackageFile("@earendil-works/pi-tui", "dist/index.js");

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@earendil-works\/pi-ai$/, replacement: PIAI_COMPAT },
      { find: /^@earendil-works\/pi-ai\/compat$/, replacement: PIAI_COMPAT },
      { find: /^@earendil-works\/pi-tui$/, replacement: PITUI },
    ],
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
});