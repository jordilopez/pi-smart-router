import path from "node:path";
import { defineConfig } from "vitest/config";

// pi-ai is not on npm; resolve to the copy bundled with the installed pi CLI.
const PI_PACKAGE_DIR =
  process.env.PI_PACKAGE_DIR ??
  "/Users/jordi/.nvm/versions/node/v24.15.0/lib/node_modules/@earendil-works/pi-coding-agent";
const PIAI_COMPAT = path.join(
  PI_PACKAGE_DIR,
  "node_modules/@earendil-works/pi-ai/dist/compat.js",
);

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@earendil-works\/pi-ai$/, replacement: PIAI_COMPAT },
      { find: /^@earendil-works\/pi-ai\/compat$/, replacement: PIAI_COMPAT },
    ],
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
});
