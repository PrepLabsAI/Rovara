// TE-R2 part A (M4): the subpath entry `@agentx/contracts/independent-channel`. The mint for `independent` decisions is NOT in the public `@agentx/contracts` index: this is the only entry that carries it, and only the broker's
// independent reply agent step (and the reply store's own test kit) may import it (`tests/unit/model-independent-mint-guard.test.ts` fails on any other importer or mention). The worker never imports it: it only receives resolved sets.
export * from "./model-independent-channel.js";
export { createRovaraIndependentDecision } from "./model-reply-set.js";
