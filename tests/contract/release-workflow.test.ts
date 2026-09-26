import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

interface Step {
  id?: string;
  name?: string;
  run?: string;
  uses?: string;
  shell?: string;
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

  it("takes the version only from the tag: workflow_dispatch has no inputs, nothing reads inputs.*", async () => {
    const wf = await workflow();
    // "by hand" still means re-running from the tag ref itself (the guard test below enforces
    // that); it must not accept an operator-typed version that could disagree with the tag.
    expect((wf.on.workflow_dispatch as Record<string, unknown> | null | undefined)?.inputs).toBeUndefined();
    const text = await workflowText();
    expect(text).not.toMatch(/inputs\.version/);
    expect(text).not.toMatch(/inputs\./);
  });

  it("guards every publishing job and runs the tests first", async () => {
    const wf = await workflow();
    for (const name of ["images", "release", "npm"]) {
      expect(wf.jobs[name]?.if, name).toBe("vars.AGENTX_PUBLISH_ENABLED == 'true'");
    }
    expect(wf.jobs.images?.needs).toBe("test");
    expect(wf.jobs.test?.if).toBeUndefined();
  });

  it("the test job runs typecheck, lint, build, test and infra:synth", async () => {
    const wf = await workflow();
    const testRun = wf.jobs.test!.steps.map((s) => s.run ?? "").join("\n");
    expect(testRun).toContain("npm run typecheck");
    expect(testRun).toContain("npm run lint");
    expect(testRun).toContain("npm run build");
    expect(testRun).toContain("npm test");
    expect(testRun).toContain("npm run infra:synth");
    // In the declared order, so a later step can't silently run against a stale build.
    expect(testRun.indexOf("npm run lint")).toBeLessThan(testRun.indexOf("npm run build"));
    expect(testRun.indexOf("npm run build")).toBeLessThan(testRun.indexOf("npm test"));
    expect(testRun.indexOf("npm test")).toBeLessThan(testRun.indexOf("npm run infra:synth"));
  });

  it("grants OIDC and write access only where they are needed", async () => {
    const wf = await workflow();
    expect(wf.jobs.test?.permissions).toBeUndefined();
    expect(wf.jobs.images?.permissions).toEqual({ contents: "read", "id-token": "write" });
    expect(wf.jobs.release?.permissions).toEqual({ contents: "write" });
    expect(wf.jobs.npm?.permissions).toEqual({ contents: "read", "id-token": "write" });
  });

  it("builds arm64 images with buildx, pushes a single-manifest image, and cross-checks the registry digest before publishing", async () => {
    const wf = await workflow();
    const steps = wf.jobs.images!.steps;
    const buildxIndex = steps.findIndex((s) => s.uses?.startsWith("docker/setup-buildx-action"));
    expect(buildxIndex).toBeGreaterThanOrEqual(0);
    const push = steps.map((s) => s.run ?? "").join("\n");
    const buildIndex = push.indexOf("docker buildx build");
    expect(buildIndex).toBeGreaterThanOrEqual(0);
    // setup-buildx-action must run as an earlier *step* than the one containing the build.
    const pushStepIndex = steps.findIndex((s) => (s.run ?? "").includes("docker buildx build"));
    expect(buildxIndex).toBeLessThan(pushStepIndex);

    expect(push).toContain("--platform linux/arm64");
    // Without these, buildx pushes an OCI index (image + attestations), not a single arm64
    // manifest, and the digest read back would be the index's, not the image's.
    expect(push).toContain("--provenance=false");
    expect(push).toContain("--sbom=false");
    expect(push).toContain("containerimage.digest");

    // The registry, not just the local build metadata, must confirm what got pushed.
    expect(push).toContain("docker buildx imagetools inspect");
    expect(push).toMatch(/imagetools inspect "\$repo:\$VERSION" --format '\{\{json \.Manifest\.Digest\}\}'/);
    expect(push).toMatch(/registry_digest/);
    // Fails on an empty/null registry digest, and on a mismatch against the pushed digest.
    expect(push).toMatch(/registry_digest"\s*\]\s*\|\|\s*\[\s*"\$registry_digest"\s*=\s*"null"/);
    expect(push).toMatch(/"\$registry_digest"\s*!=\s*"\$digest"/);
    expect(push).toContain("exit 1");
    expect(push).toContain("@$registry_digest");

    const release = wf.jobs.release!.steps.map((s) => s.run ?? "").join("\n");
    expect(release.indexOf("release:verify")).toBeGreaterThan(release.indexOf("release:build"));
    expect(release.indexOf("gh release create")).toBeGreaterThan(release.indexOf("release:verify"));
    expect(release).toContain('--worker-image "$WORKER"');
    expect(wf.jobs.release!.steps.some((s) => s.env?.GH_TOKEN === "${{ github.token }}")).toBe(true);
  });

  it("runs the images push step with shell: bash, so a failing `imagetools inspect | tr` fails the step instead of being swallowed by the pipe", async () => {
    const wf = await workflow();
    const push = wf.jobs.images!.steps.find((s) => s.id === "push");
    expect(push).toBeDefined();
    // Without an explicit shell, GitHub Actions runs a Linux run: step as plain `bash -e {0}`, not
    // `bash --noprofile --norc -eo pipefail {0}`; only shell: bash turns pipefail on.
    expect(push?.shell).toBe("bash");
  });

  it("never prints secrets", async () => {
    const text = await workflowText();
    expect(text).not.toMatch(/echo[^\n]*secrets\./);
    expect(text).not.toMatch(/set -x/);
  });

  it("no run: script interpolates a GitHub Actions expression; everything flows through env", async () => {
    const wf = await workflow();
    for (const [jobName, job] of Object.entries(wf.jobs)) {
      for (const step of job.steps) {
        if (step.run) expect(step.run, `${jobName}: ${step.run}`).not.toContain("${{");
      }
    }
  });

  it("refuses to run the images job's publishing steps unless the ref is a version tag matching vX.Y.Z", async () => {
    const wf = await workflow();
    const steps = wf.jobs.images!.steps;
    // The publish role's trust policy only allows repo:PrepLabsAI/AgentX:ref:refs/tags/v*, so a
    // workflow_dispatch run started from a branch would otherwise fail deep inside
    // configure-aws-credentials with an opaque AssumeRoleWithWebIdentity error. Guard first, and
    // fail clearly, before checkout or any AWS action runs. GITHUB_REF/GITHUB_REF_NAME are the
    // runner's own default env vars, read directly rather than interpolated in as `${{ github.ref
    // }}` (see the "no run: script interpolates" test above).
    const guardIndex = steps.findIndex((s) => (s.run ?? "").includes("GITHUB_REF"));
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    const guard = steps[guardIndex]!;
    expect(guard.run).toContain("$GITHUB_REF");
    expect(guard.run).toMatch(/refs\/tags\/v\*/);
    expect(guard.run).toContain("$GITHUB_REF_NAME");
    expect(guard.run).toMatch(/\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/);
    expect(guard.run).toMatch(/exit 1/);
    const checkoutIndex = steps.findIndex((s) => s.uses?.startsWith("actions/checkout"));
    expect(checkoutIndex).toBeGreaterThan(guardIndex);
    const credentialsIndex = steps.findIndex((s) => s.uses?.startsWith("aws-actions/configure-aws-credentials"));
    expect(credentialsIndex).toBeGreaterThan(guardIndex);
  });

  it("publishes npm with trusted publishing (OIDC): no stored token, npm upgraded to 11 first, no --provenance (private repo)", async () => {
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
    // PrepLabsAI/AgentX is private today, and npm provenance attestation fails for private repos;
    // trusted publishing adds provenance automatically once the repo goes public.
    expect(npmSteps[publishIndex]!.run).not.toContain("--provenance");
  });
});
