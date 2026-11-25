import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertTagIsNew, buildAndPushImage, type ReleaseOptions, type Runner } from "../../scripts/release-common.js";

// ECR image tags are never overwritten by a push path: every repository a push goes to has IMMUTABLE tags, and a push whose tag is already there stops
// before anything is sent. (Installs pin image DIGESTS, so immutability does not touch an install.)
const options: ReleaseOptions = { region: "us-west-2", repository: "agentx-staging/worker", allowDirty: false, skipChecks: true, dryRun: false };
const uri = "111122223333.dkr.ecr.us-west-2.amazonaws.com/agentx-staging/worker";

type Answer = { status: number; stderr: string; stdout: string };
function harness(answers: { mutability?: Answer; tag?: Answer }) {
  const calls: string[][] = [];
  const runner = {
    run: (command: string, args: readonly string[]) => { calls.push([command, ...args]); return ""; },
    aws: (args: readonly string[]) => {
      calls.push(["aws", ...args]);
      if (args.includes("describe-repositories")) return answers.mutability ?? { status: 0, stderr: "", stdout: "IMMUTABLE\n" };
      if (args.includes("describe-images") && !calls.some((call) => call[1] === "push")) return answers.tag ?? { status: 254, stderr: "An error occurred (ImageNotFoundException)", stdout: "" };
      return { status: 0, stderr: "", stdout: args.includes("get-login-password") ? "password" : `sha256:${"c".repeat(64)}\n` };
    },
  } as unknown as Runner;
  return { calls, runner };
}
const build = (runner: Runner) => buildAndPushImage(runner, options, { repository: options.repository, repositoryUri: uri, dockerfile: "environments/base/Dockerfile", localName: "agentx-worker", smokeTest: async () => undefined, tagPrefix: "test-" }, "0123456789abcdef");
const pushed = (calls: string[][]) => calls.some((call) => call[0] === "docker" && call[1] === "push");

describe("an image push never overwrites a tag", () => {
  it("pushes to an immutable repository when the tag is new, after both checks", async () => {
    const { calls, runner } = harness({});
    await build(runner);
    expect(pushed(calls)).toBe(true);
    const index = (match: (call: string[]) => boolean) => calls.findIndex(match);
    expect(index((call) => call.includes("describe-repositories"))).toBeLessThan(index((call) => call[1] === "push"));
    expect(index((call) => call.includes("describe-images"))).toBeLessThan(index((call) => call[1] === "push"));
  });

  it("stops, pushing nothing and logging in nowhere, when the repository has mutable tags, and names the one fix", async () => {
    for (const stdout of ["MUTABLE\n", "MUTABLE_WITH_EXCLUSION\n", "IMMUTABLE_WITH_EXCLUSION\n"]) {
      const { calls, runner } = harness({ mutability: { status: 0, stderr: "", stdout } });
      await expect(build(runner)).rejects.toThrow(/does not have immutable tags[\s\S]*put-image-tag-mutability --region us-west-2 --repository-name agentx-staging\/worker --image-tag-mutability IMMUTABLE/u);
      expect(pushed(calls)).toBe(false);
      expect(calls.some((call) => call.includes("get-login-password"))).toBe(false);
    }
  });

  it("stops when the repository's setting cannot be read (never assumes immutable)", async () => {
    const { calls, runner } = harness({ mutability: { status: 255, stderr: "AccessDenied", stdout: "" } });
    await expect(build(runner)).rejects.toThrow(/could not be read/u);
    expect(pushed(calls)).toBe(false);
  });

  it("stops, pushing nothing, when the tag is already in the repository", async () => {
    const { calls, runner } = harness({ tag: { status: 0, stderr: "", stdout: `sha256:${"d".repeat(64)}\n` } });
    await expect(build(runner)).rejects.toThrow(/already in agentx-staging\/worker: a pushed tag is never overwritten/u);
    expect(pushed(calls)).toBe(false);
  });

  it("stops when it cannot tell whether the tag exists (an error other than 'not found' is not 'new')", () => {
    const { runner } = harness({ tag: { status: 255, stderr: "ThrottlingException", stdout: "" } });
    expect(() => assertTagIsNew(runner, options, { repository: options.repository }, "test-x")).toThrow(/could not tell/u);
  });
});

describe("no infra file declares an ECR repository with mutable tags", () => {
  it("every ImageTagMutability in infra/ is IMMUTABLE", () => {
    const found = execFileSync("git", ["grep", "-n", "-E", "imageTagMutability:", "--", "infra"], { encoding: "utf8" }).trim().split("\n");
    expect(found.length).toBeGreaterThan(0);
    // The L1 form ("IMMUTABLE") or the L2 enum (ecr.TagMutability.IMMUTABLE, the model gateway's images repository, #1478): the same template value.
    for (const line of found) expect(line, line).toMatch(/imageTagMutability: (?:"IMMUTABLE"|ecr\.TagMutability\.IMMUTABLE)/u);
    expect(readFileSync("infra/lib/test-service-mirror.ts", "utf8")).toContain('imageTagMutability: "IMMUTABLE"');
  });
});
