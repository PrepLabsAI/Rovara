// The browser executor's entry point. It stays off the main `@agentx/verifier` barrel because it loads Playwright and the
// web engine, which broker and worker bundles must never pull in.
export { runE2EExecutor } from "./run.js";
export type { E2EExecutorRunInput, E2EExecutorExitCode } from "./run.js";
export { createWebApplicationCliHost } from "../web-runtime.js";
// The model channel of an agent step (Task 4.3a): the client for the worker's socket, and the guard that keeps the AI SDK off its default gateway. The agent step driver of
// Task 4.3b (executor/host.ts, loaded by the CLI process through the registered host module) builds on them.
export { createE2EModelChannelClient, E2EModelChannelError } from "./model-channel.js";
export type { E2EModelChannelClientErrorCode, E2EModelChannelClientOptions } from "./model-channel.js";
export { installRefusingE2EDefaultProvider } from "./ai-default-provider.js";
// The agent step driver's parts (Task 4.3b): the closed-toolset executor, the model over the channel, the action ledger and the capture-only replay store.
export { createRovaraE2EAgentExecutor } from "./agent-executor.js";
export { createE2EAgentModelAdapter, E2EAgentModelError } from "./agent-model-adapter.js";
export { createE2EAgentLedgerWriter, E2E_AGENT_EVIDENCE_DIR, E2E_AGENT_LEDGER_FILE } from "./agent-ledger.js";
export { createE2EAgentCaptureStore } from "./agent-capture-store.js";
