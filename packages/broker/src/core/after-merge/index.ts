// M7 after-merge watcher (TE-H2 core; slice 2 adds the code host deploy source, the real reporter, the setting reader and the service). See watch.ts for what it does, actions.ts for the two presses, ports.ts for the seams a host fills, and settings.ts for the switch (`afterMergeWatch`, off by default).
export * from "./actions.js";
export * from "./deploy-source.js";
export * from "./facts.js";
export * from "./host-seams.js";
export * from "./ports.js";
export * from "./reporter.js";
export * from "./service.js";
export * from "./settings.js";
export { OPEN_WATCHES_MAX, SWEEP_BATCH_MAX, closeDueWatches, deliverPending, observeDeployment, observeSignal, type DeploymentOutcome, type SignalOutcome, type SweepOutcome } from "./watch.js";
