import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

interface Step {
  name?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
}
interface Job {
  if?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  steps: Step[];
}
interface Workflow {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
}

async function workflowText(): Promise<string> {
  return readFile(".github/workflows/release.yml", "utf8");
}

async function workflow(): Promise<Workflow> {
  return YAML.parse(await workflowText()) as Workflow;
}

describe("release workflow", () => {
  it("runs only on version tags or by hand, never on pull requests or branch pushes", async () => {
    const wf = await workflow();
    expect(Object.keys(wf.on).sort()).toEqual(["push", "workflow_dispatch"]);
    expect(wf.on.push).toEqual({ tags: ["v[0-9]+.[0-9]+.[0-9]+"] });
    expect(wf.permissions).toEqual({ contents: "read" });
  });

  it("guards every publishing job and runs the tests first", async () => {
    const wf = await workflow();
    for (const name of ["images", "release", "npm"]) {
      expect(wf.jobs[name]?.if, name).toBe("vars.AGENTX_PUBLISH_ENABLED == 'true'");
    }
    expect(wf.jobs.images?.needs).toBe("test");
    expect(wf.jobs.test?.if).toBeUndefined();
  });

  it("grants OIDC and write access only where they are needed", async () => {
    const wf = await workflow();
    expect(wf.jobs.test?.permissions).toBeUndefined();
    expect(wf.jobs.images?.permissions).toEqual({ contents: "read", "id-token": "write" });
    expect(wf.jobs.release?.permissions).toEqual({ contents: "write" });
    expect(wf.jobs.npm?.permissions).toEqual({ contents: "read", "id-token": "write" });
  });

  it("builds arm64 images, passes digests (not tags) to the release, and verifies before publishing", async () => {
    const wf = await workflow();
    const push = wf.jobs.images!.steps.map((s) => s.run ?? "").join("\n");
    expect(push).toContain("--platform linux/arm64");
    expect(push).toContain("containerimage.digest");
    expect(push).toContain("@$digest");
    const release = wf.jobs.release!.steps.map((s) => s.run ?? "").join("\n");
    expect(release.indexOf("release:verify")).toBeGreaterThan(release.indexOf("release:build"));
    expect(release.indexOf("gh release create")).toBeGreaterThan(release.indexOf("release:verify"));
    expect(release).toContain('--worker-image "$WORKER"');
    expect(wf.jobs.release!.steps.some((s) => s.env?.GH_TOKEN === "${{ github.token }}")).toBe(true);
  });

  it("never prints secrets", async () => {
    const text = await workflowText();
    expect(text).not.toMatch(/echo[^\n]*secrets\./);
    expect(text).not.toMatch(/set -x/);
  });

  it("refuses to run the images job's publishing steps unless the ref is a version tag", async () => {
    const wf = await workflow();
    const steps = wf.jobs.images!.steps;
    // The publish role's trust policy only allows repo:PrepLabsAI/AgentX:ref:refs/tags/v*, so a
    // workflow_dispatch run started from a branch would otherwise fail deep inside
    // configure-aws-credentials with an opaque AssumeRoleWithWebIdentity error. Guard first, and
    // fail clearly, before checkout or any AWS action runs.
    const guardIndex = steps.findIndex((s) => (s.run ?? "").includes("github.ref"));
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    const guard = steps[guardIndex]!;
    expect(guard.run).toMatch(/refs\/tags\/v\*/);
    expect(guard.run).toMatch(/exit 1/);
    const checkoutIndex = steps.findIndex((s) => s.uses?.startsWith("actions/checkout"));
    expect(checkoutIndex).toBeGreaterThan(guardIndex);
    const credentialsIndex = steps.findIndex((s) => s.uses?.startsWith("aws-actions/configure-aws-credentials"));
    expect(credentialsIndex).toBeGreaterThan(guardIndex);
  });

  it("publishes npm with trusted publishing (OIDC): no stored token, npm upgraded to 11 first", async () => {
    const text = await workflowText();
    expect(text).not.toMatch(/NPM_TOKEN/);
    expect(text).not.toMatch(/NODE_AUTH_TOKEN/);

    const wf = await workflow();
    const npmSteps = wf.jobs.npm!.steps;
    const upgradeIndex = npmSteps.findIndex((s) => (s.run ?? "").includes("npm install -g npm@11"));
    const publishIndex = npmSteps.findIndex((s) => (s.run ?? "").includes("npm publish"));
    expect(upgradeIndex).toBeGreaterThanOrEqual(0);
    expect(publishIndex).toBeGreaterThan(upgradeIndex);
    expect(npmSteps[publishIndex]!.run).toContain("--access public");
    expect(npmSteps[publishIndex]!.run).toContain("--provenance");
  });
});
