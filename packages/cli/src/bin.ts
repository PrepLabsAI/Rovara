#!/usr/bin/env node
// The agentx executable (issue #238). It checks the running Node version before it loads the rest
// of the CLI, so an unsupported Node (AWS CloudShell ships Node 20) gets one plain message and a
// non-zero exit before any command does work or any AWS SDK module loads. Keep this file to
// syntax an old Node can parse (ES2020; see node-version.ts): nothing newer may load before the
// check runs. The published package builds this file as bin/agentx.mjs and main.ts as the
// bundle next to it (scripts/release/pack-cli.ts).
import { startCli } from "./node-version.js";

startCli({
  nodeVersion: process.versions.node,
  env: process.env,
  writeError: (text) => {
    process.stderr.write(text);
  },
  loadCli: () => import("./main.js"),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // Rethrown, so Node reports it the way it reports any other uncaught error, and exits 1.
    process.exitCode = 1;
    throw error;
  },
);
