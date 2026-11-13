// The test-services working exec passes a command's own variables to `docker exec --env`. A name whose value is undefined (a variable the model helper round REMOVES) is never passed as the text "undefined".
import { describe, expect, it } from "vitest";
import { execEnvArgs } from "../../packages/worker/src/test-services-run.js";

describe("docker exec --env arguments", () => {
  it("leaves out an undefined value, and a name the run owns", () => {
    const env = { KEEP: "1", EMPTY: "", GEMINI_KEY: undefined, OWNED: "x" } as unknown as Record<string, string>;
    const args = execEnvArgs(env, new Set(["OWNED"]));
    expect(args).toEqual(["--env", "KEEP=1", "--env", "EMPTY="]);
    expect(args.join(" ")).not.toContain("undefined");
    expect(execEnvArgs(undefined, new Set())).toEqual([]);
  });
});
