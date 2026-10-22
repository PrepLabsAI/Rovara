// The browser executor's entry point. It stays off the main `@agentx/verifier` barrel because it loads Playwright and the
// web engine, which broker and worker bundles must never pull in.
export { runE2EExecutor } from "./run.js";
export type { E2EExecutorRunInput, E2EExecutorExitCode } from "./run.js";
export { createWebApplicationCliHost } from "../web-runtime.js";
// The model channel of an agent step (Task 4.3a): the client for the worker's socket, and the guard that keeps the AI SDK off its default gateway. Task 4.3b loads them.
export { createE2EModelChannelClient, E2EModelChannelError } from "./model-channel.js";
export type { E2EModelChannelClientErrorCode, E2EModelChannelClientOptions } from "./model-channel.js";
export { installRefusingE2EDefaultProvider } from "./ai-default-provider.js";
