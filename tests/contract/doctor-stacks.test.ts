import { describe, expect, it } from "vitest";
import { doctorReport, guarded, reportText } from "../../packages/cli/src/doctor/checks.js";
import { releaseMismatch, stackChecks } from "../../packages/cli/src/doctor/stacks.js";
import { doctorContext, doctorServices, healthyStacks, MANIFEST, SETTINGS } from "../support/doctor-fakes.js";

const withStack = (name: string, change: Partial<ReturnType<typeof healthyStacks>[string]> | undefined) => {
  const stacks = healthyStacks();
  if (change === undefined) delete stacks[name];
  else stacks[name] = { ...stacks[name]!, ...change };
  return doctorContext({ services: doctorServices({ stackMap: stacks }) });
};

describe("doctor: stacks (FR-050)", () => {
  it("passes a healthy environment deployed from the release in its settings", async () => {
    const checks = await stackChecks(doctorContext());
    expect(checks.filter((entry) => entry.status !== "ok")).toEqual([]);
    expect(checks.map((entry) => entry.name)).toEqual([
      "agentx-staging-access", "agentx-staging-foundation", "agentx-staging-identity", "agentx-staging-control-plane", "agentx-staging-runtime", "agentx-staging-slack",
      "engine", "drift", "release 1.2.3",
    ]);
  });

  it("fails a missing stack and says upgrade deploys it again", async () => {
    const found = (await stackChecks(withStack("agentx-staging-slack", undefined))).find((entry) => entry.name === "agentx-staging-slack")!;
    expect(found).toMatchObject({ status: "fail", detail: "does not exist", fix: "agentx --env staging upgrade deploys it again" });
  });

  it("fails a stack whose first create failed, offering the delete command and agentx destroy", async () => {
    const found = (await stackChecks(withStack("agentx-staging-identity", { status: "ROLLBACK_COMPLETE" }))).find((entry) => entry.name === "agentx-staging-identity")!;
    expect(found.status).toBe("fail");
    expect(found.fix).toContain("aws cloudformation delete-stack --stack-name agentx-staging-identity --region us-east-1");
    expect(found.fix).toContain("agentx --env staging destroy --region us-east-1");
  });

  it("warns about a rolled-back update and a stack that is still busy", async () => {
    expect((await stackChecks(withStack("agentx-staging-runtime", { status: "UPDATE_ROLLBACK_COMPLETE" }))).find((entry) => entry.name === "agentx-staging-runtime")?.status).toBe("warn");
    expect((await stackChecks(withStack("agentx-staging-runtime", { status: "UPDATE_IN_PROGRESS" }))).find((entry) => entry.name === "agentx-staging-runtime")?.status).toBe("warn");
  });

  it("fails an engine mismatch: a cdk-deployed stack (BootstrapVersion) in a templates environment", async () => {
    const stacks = healthyStacks();
    stacks["agentx-staging-slack"] = { ...stacks["agentx-staging-slack"]!, parameters: { ...stacks["agentx-staging-slack"]!.parameters, BootstrapVersion: "/cdk-bootstrap/hnb659fds/version" } };
    const engine = (await stackChecks(doctorContext({ services: doctorServices({ stackMap: stacks }) }))).find((entry) => entry.name === "engine")!;
    expect(engine.status).toBe("fail");
    expect(engine.detail).toContain("agentx-staging-slack (cdk)");
  });

  it("warns about drift found by the last drift check, with the admin command to see it", async () => {
    const drift = (await stackChecks(withStack("agentx-staging-control-plane", { drift: "DRIFTED" }))).find((entry) => entry.name === "drift")!;
    expect(drift.status).toBe("warn");
    expect(drift.fix).toContain("aws cloudformation describe-stack-resource-drifts --stack-name agentx-staging-control-plane --region us-east-1");
  });

  it("fails a stack running another release's code, and warns about a testing image", async () => {
    const stacks = healthyStacks();
    stacks["agentx-staging-control-plane"] = { ...stacks["agentx-staging-control-plane"]!, parameters: { ...stacks["agentx-staging-control-plane"]!.parameters, AssetHash: "f".repeat(64) } };
    const release = (await stackChecks(doctorContext({ services: doctorServices({ stackMap: stacks }) }))).find((entry) => entry.name === "release 1.2.3")!;
    expect(release).toMatchObject({ status: "fail", fix: "agentx --env staging upgrade --to 1.2.3" });
    expect(releaseMismatch("runtime", { WorkerImageUri: `x@sha256:${"9".repeat(64)}` }, MANIFEST)).toEqual({ code: [], images: ["WorkerImageUri"] });
  });

  // Ruling F4: a cdk-deployed stack (DefaultStackSynthesizer) keeps its code in the bootstrap bucket
  // and declares no asset parameters, so only its image digests are compared.
  const cdkEnvironment = (change: (stacks: ReturnType<typeof healthyStacks>) => void = () => undefined) => {
    const stacks = healthyStacks();
    for (const stack of Object.values(stacks)) {
      const parameters = { ...stack.parameters, BootstrapVersion: "/cdk-bootstrap/hnb659fds/version" };
      delete parameters.AssetHash;
      stack.parameters = parameters;
    }
    change(stacks);
    return doctorContext({ settings: { ...SETTINGS, engine: "cdk" }, services: doctorServices({ stackMap: stacks }) });
  };

  it("passes a cdk environment whose stacks carry BootstrapVersion and no asset parameters (F4)", async () => {
    const checks = await stackChecks(cdkEnvironment());
    expect(checks.filter((entry) => entry.status !== "ok")).toEqual([]);
    const release = checks.find((entry) => entry.name === "release 1.2.3")!;
    expect(release.detail).toContain("cdk: code packages are not compared (they live in the bootstrap bucket)");
  });

  it("still compares a cdk stack's image digest, and never its code packages (F4)", async () => {
    const context = cdkEnvironment((stacks) => {
      stacks["agentx-staging-runtime"]!.parameters.WorkerImageUri = `x@sha256:${"9".repeat(64)}`;
      stacks["agentx-staging-control-plane"]!.parameters.AssetHash = "f".repeat(64);
    });
    const release = (await stackChecks(context)).find((entry) => entry.name === "release 1.2.3")!;
    expect(release.status).toBe("warn");
    expect(release.detail).toContain("agentx-staging-runtime WorkerImageUri");
    expect(release.detail).not.toContain("AssetHash");
  });

  it("warns, and does not fail, when the release manifest cannot be read", async () => {
    const release = (await stackChecks(doctorContext({ services: doctorServices({ releaseManifest: async () => undefined }) }))).find((entry) => entry.name === "release 1.2.3")!;
    expect(release.status).toBe("warn");
  });
});

describe("doctor: reporting (FR-051)", () => {
  it("counts results and prints each problem with its fix", () => {
    const report = doctorReport(SETTINGS, [
      { group: "stacks", name: "agentx-staging-slack", status: "fail", detail: "does not exist", fix: "agentx --env staging upgrade deploys it again" },
      { group: "alerts", name: "subscription", status: "warn", detail: "not confirmed yet" },
      { group: "models", name: "orchestrator", status: "ok", detail: "answers" },
      { group: "slack", name: "bound channel", status: "skip", detail: "no channel recorded" },
    ]);
    expect(report).toMatchObject({ env: "staging", failed: 1, warned: 1, passed: 1 });
    const text = reportText(report);
    expect(text).toContain("FAIL  stacks      agentx-staging-slack: does not exist\n      fix: agentx --env staging upgrade deploys it again");
    expect(text).toContain("warn  alerts      subscription: not confirmed yet");
    expect(text).toContain("skip  slack       bound channel: no channel recorded");
    expect(text.trimEnd().split("\n").at(-1)).toBe("1 failed, 1 warning, 1 passed, 1 skipped");
  });

  it("turns a check group that throws into one failed check, without the error's code prefix", async () => {
    const checks = await guarded("github", async () => { throw new Error("GitHub app lookup failed with HTTP 502"); });
    expect(checks).toEqual([{ group: "github", name: "github checks", status: "fail", detail: "could not run the github checks: GitHub app lookup failed with HTTP 502" }]);
  });
});
