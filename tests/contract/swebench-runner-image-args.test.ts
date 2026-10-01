import { describe, expect, it } from "vitest";
import { parseReleaseArgs, splitEnvFlag } from "../../scripts/release-common.js";

describe("the runner-image script's --env flag", () => {
  it("keeps every other argument when --env is absent", () => {
    // Was dropping argv[0]: `npm run swebench:runner-image -- --dry-run` built and pushed (2026-10-01).
    expect(splitEnvFlag(["--dry-run"])).toEqual({ rest: ["--dry-run"] });
    expect(parseReleaseArgs(splitEnvFlag(["--dry-run", "--allow-dirty"]).rest, {})).toMatchObject({ dryRun: true, allowDirty: true });
  });

  it("removes --env and its value wherever they appear", () => {
    expect(splitEnvFlag(["--env", "staging", "--dry-run"])).toEqual({ env: "staging", rest: ["--dry-run"] });
    expect(splitEnvFlag(["--dry-run", "--env", "staging"])).toEqual({ env: "staging", rest: ["--dry-run"] });
  });

  it("refuses --env without a value", () => {
    expect(() => splitEnvFlag(["--env"])).toThrow(/--env requires a value/);
    expect(() => splitEnvFlag(["--env", "--dry-run"])).toThrow(/--env requires a value/);
  });
});
