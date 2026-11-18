// L4-VX: the model-host block facts the stand-in test reads (the by-name block list of the built-in catalog and what the redirect check says about a list of called hosts). Kept here, in the model-* test
// helpers, because tests/unit/model-egress-block.test.ts keeps every caller of these contracts names out of other test files.
import { builtinModelCatalog, findRedirectEscapes, modelHostBlockList } from "@agentx/contracts";

export const blockedModelHosts = (): string[] => modelHostBlockList(builtinModelCatalog().rows, []);
export const redirectEscapesFor = (called: readonly string[]) => findRedirectEscapes(blockedModelHosts(), called);
