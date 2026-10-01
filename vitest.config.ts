import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// pi-ai is not on npm; it ships as a bundled dependency of the pi coding agent.
// The agent package is installed as a devDependency (CI + local dev); override
// with PI_PACKAGE_DIR to point at a different pi install (e.g. a global CLI).
const thisDir = path.dirname(fileURLToPath(import.meta.url));
const PI_PACKAGE_DIR =
  process.env.PI_PACKAGE_DIR ??
  path.join(thisDir, "node_modules/@earendil-works/pi-coding-agent");
const PIAI_COMPAT = path.join(
  PI_PACKAGE_DIR,
  "node_modules/@earendil-works/pi-ai/dist/compat.js",
);
const PITUI = path.join(
  PI_PACKAGE_DIR,
  "node_modules/@earendil-works/pi-tui/dist/index.js",
);

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
