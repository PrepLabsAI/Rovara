// M7 after-merge watcher, first slice (TE-H2 core). See watch.ts for what it does, actions.ts for the two presses, ports.ts for the seams a host fills, and settings.ts for the switch (`afterMergeWatch`, off by default).
export * from "./actions.js";
export * from "./facts.js";
export * from "./ports.js";
export * from "./settings.js";
export { OPEN_WATCHES_MAX, SWEEP_BATCH_MAX, closeDueWatches, deliverPending, observeDeployment, observeSignal, type DeploymentOutcome, type SignalOutcome, type SweepOutcome } from "./watch.js";
