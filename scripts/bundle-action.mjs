// Bundles the GitHub Action into a single committed file: dist/index.js
import { build } from "esbuild";

await build({
  entryPoints: ["packages/taglore/src/action.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  minify: true,
  legalComments: "external",
  logLevel: "info",
  // Some CommonJS dependencies call require(); give the ESM bundle one.
  banner: {
    js: "import { createRequire as __tagloreCreateRequire } from 'node:module'; const require = __tagloreCreateRequire(import.meta.url);",
  },
});

// Browser bundle of both web components (<taglore-whats-new>, <taglore-changelog>): one file, no dependencies.
// Served from GitHub via jsDelivr, or copied into output-dir by the action (web-components: true).
await build({
  entryPoints: ["packages/whats-new/src/element.ts"],
  outfile: "dist/whats-new.js",
  bundle: true,
  platform: "browser",
  target: "es2020",
  format: "esm",
  minify: true,
  logLevel: "info",
});
