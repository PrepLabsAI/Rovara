// A deferred tool is allowlisted by a `name*` pattern, so Rovara keeps its own list of Pi's host tools (PI_BUILT_IN_TOOL_NAMES) to keep any tool whose name
// starts one of them directly declared and to exclude the ones a stage did not choose. A host tool Pi adds in a new version must fail here, not slip past that list.
import { describe, expect, it } from "vitest";
import { allToolNames } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/index.js";
import { PI_BUILT_IN_TOOL_NAMES } from "../../packages/model-runtime/src/deferred-tools.js";

describe("PI_BUILT_IN_TOOL_NAMES", () => {
  it("is exactly the host tools Pi builds in every session", () => {
    expect([...PI_BUILT_IN_TOOL_NAMES].sort()).toEqual([...allToolNames].sort());
  });
});
