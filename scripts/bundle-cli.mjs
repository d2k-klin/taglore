// Self-contained CLI: one file with every dependency inside, for locked-down environments that
// can't install packages on each run. Attached to each release with SHA256SUMS and a build
// provenance attestation. Usage: node scripts/bundle-cli.mjs [outfile]
import { build } from "esbuild";

const outfile = process.argv[2] ?? "dist-cli/taglore.mjs";
await build({
  entryPoints: ["packages/taglore/src/cli.ts"],
  outfile,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  minify: true,
  legalComments: "external",
  logLevel: "info",
  // The entry's #!/usr/bin/env node stays on line 1; some CommonJS dependencies call require().
  banner: {
    js: "import { createRequire as __tagloreCreateRequire } from 'node:module'; const require = __tagloreCreateRequire(import.meta.url);",
  },
});
