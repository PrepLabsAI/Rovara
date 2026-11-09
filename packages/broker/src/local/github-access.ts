// Port lane L11 (BOTH-OWNERS-INTERFACE-ITEMS C3): the owner's GitHub sign-in moved into the GitHub adapter (`plugins/code-host/github/token-access.ts`),
// so a second code host brings its own. This file keeps the old import path for `rovara up`.
export * from "../plugins/code-host/github/token-access.js";
