// The browser executor's entry point. It stays off the main `@agentx/verifier` barrel because it loads Playwright and the
// web engine, which broker and worker bundles must never pull in.
export { runE2EExecutor } from "./run.js";
export type { E2EExecutorRunInput, E2EExecutorExitCode } from "./run.js";
export { createWebApplicationCliHost } from "../web-runtime.js";
