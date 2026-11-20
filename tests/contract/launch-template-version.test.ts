import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// #1191: every launch and every check of the worker launch template reads $Latest, the version CloudFormation last wrote.
// CloudFormation adds a version on update but never moves $Default, so a $Default launch kept v1 (m6g.medium) and the provisioner's
// instance-type allow-list refused it. A mix would also check one version and launch another.
const SITES = [
  "infra/lib/session-state-machines.ts",
  "infra/lib/swebench-eval-definition.ts",
  "packages/broker/src/aws/runtime-requalify-steps.ts",
  "packages/contracts/src/qualification-launch.ts",
  "scripts/test-qualify-runtime.ts",
  "scripts/ec2-preflight.ts",
];

describe("the worker launch template's version", () => {
  it.each(SITES)("%s reads $Latest, never $Default", (path) => {
    const source = readFileSync(path, "utf8");
    expect(source).not.toContain('"$Default"');
    expect(source).toContain('"$Latest"');
  });
});
