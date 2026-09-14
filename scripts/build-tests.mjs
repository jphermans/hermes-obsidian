/**
 * Bundles the tested plugin modules for node, swapping the `obsidian` import
 * for scripts/obsidian-stub.mjs. Run through `npm test`.
 */

import esbuild from "esbuild";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

await esbuild.build({
  entryPoints: [path.join(here, "test-entry.ts")],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  outfile: path.join(here, ".build", "tests.mjs"),
  alias: {
    obsidian: path.join(here, "obsidian-stub.mjs"),
  },
  logLevel: "warning",
});

console.log("bundled tests → scripts/.build/tests.mjs");
