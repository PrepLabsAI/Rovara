// DEC 254zm (Q2): the release builds the worker image for linux/arm64 AND linux/amd64 as one multi-architecture image (one index digest), so the x86
// machine sizes can run; every other image, and the private release path, stays arm64 exactly as before.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAndPushImage, type ReleaseOptions, type Runner } from "../../scripts/release-common.js";

const workflow = readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
const bootScript = readFileSync(new URL("../../packages/worker/ec2/boot.sh", import.meta.url), "utf8");

const scratch: string[] = [];
afterEach(() => { for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function temporary(): string { const directory = mkdtempSync(join(tmpdir(), "worker-image-platforms-")); scratch.push(directory); return directory; }
function fake(bin: string, name: string, body: string): void { writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`); chmodSync(join(bin, name), 0o755); }

/** The text of the workflow's `case "$image" in ... esac` that names each image's platforms. */
function platformPlan(): string {
  const start = workflow.indexOf('case "$image" in');
  const end = workflow.indexOf("esac", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return workflow.slice(start, end + "esac".length);
}

function platformsOf(image: string): string {
  const ran = spawnSync("bash", ["-c", `image=${image}\n${platformPlan()}\nprintf '%s' "$platforms"`], { encoding: "utf8" });
  expect(ran.status, ran.stderr).toBe(0);
  return ran.stdout;
}

describe("the release build plan", () => {
  it("builds the worker for both architectures and every other image for arm64 only", () => {
    expect(platformsOf("worker")).toBe("linux/arm64,linux/amd64");
    expect(platformsOf("slack")).toBe("linux/arm64");
    expect(platformsOf("executor")).toBe("linux/arm64");
  });

  it("pushes the worker and slack builds with the plan's platforms and keeps the executor's smoke-tested build arm64 (golden)", () => {
    expect(workflow).toContain('docker buildx build --platform "$platforms" --provenance=false --sbom=false --file "$dockerfile" --tag "$repo:$VERSION" --push --metadata-file "$RUNNER_TEMP/$image.json" .');
    expect(workflow).toContain('docker buildx build --platform linux/arm64 --provenance=false --sbom=false --file "$dockerfile" --tag "$repo:$VERSION" --load .');
    // One build, one digest: no second build or tag per architecture, so the manifest's single worker digest is the index's.
    expect(workflow.match(/docker buildx build/g)).toHaveLength(2);
  });

  /** The workflow's own check that the registry serves both platforms, run against a registry that answers with `manifest`. */
  function servedCheck(manifest: unknown): { status: number | null; stdout: string; stderr: string } {
    const line = /^\s*(served=\$\(docker buildx imagetools inspect --raw .*\))$/m.exec(workflow)?.[1];
    expect(line, "the workflow reads the platforms the registry serves").toBeDefined();
    const directory = temporary();
    const bin = join(directory, "bin");
    mkdirSync(bin);
    writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest));
    fake(bin, "docker", `[ "$1 $2 $3" = "buildx imagetools inspect" ] && [ "$4" = "--raw" ] && cat "${join(directory, "manifest.json")}"`);
    const check = /if \[ "\$served" != "linux\/amd64,linux\/arm64" \]; then\n[\s\S]*?\n\s*fi/.exec(workflow)?.[0];
    expect(check, "the workflow compares the served platforms").toBeDefined();
    return spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", `repo=r VERSION=1\n${line}\n${check}\necho ok:$served`], { encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH ?? ""}` } });
  }
  const platform = (architecture: string) => ({ mediaType: "application/vnd.oci.image.manifest.v1+json", digest: `sha256:${"a".repeat(64)}`, platform: { os: "linux", architecture } });

  it("refuses to ship a worker whose registry index lacks either platform", () => {
    expect(servedCheck({ manifests: [platform("arm64"), platform("amd64")] })).toMatchObject({ status: 0, stdout: "ok:linux/amd64,linux/arm64\n" });
    expect(servedCheck({ manifests: [platform("amd64"), platform("arm64")] }).status).toBe(0);
    // An attestation entry of an index has no platform of its own; it is not a platform the worker serves.
    expect(servedCheck({ manifests: [platform("arm64"), platform("amd64"), { mediaType: "application/vnd.oci.image.manifest.v1+json", digest: `sha256:${"d".repeat(64)}` }] }).status).toBe(0);
    for (const manifest of [
      { manifests: [platform("arm64")] },
      { manifests: [platform("amd64")] },
      { manifests: [] },
      { mediaType: "application/vnd.oci.image.manifest.v1+json", config: {}, layers: [] },
      { manifests: [platform("arm64"), platform("amd64"), platform("riscv64")] },
    ]) {
      const ran = servedCheck(manifest);
      expect(ran.status, JSON.stringify(manifest)).toBe(1);
      expect(ran.stderr).toContain("::error::the worker image");
    }
  });

  it("runs on an arm64 runner and registers amd64 emulation before buildx, so the worker's amd64 half can build", async () => {
    const YAML = (await import("yaml")).default;
    const parsed = YAML.parse(workflow) as { jobs: { images: { "runs-on": string; "timeout-minutes"?: number; steps: Array<{ uses?: string; with?: { platforms?: string } }> } } };
    const images = parsed.jobs.images;
    expect(images["runs-on"]).toBe("blacksmith-4vcpu-ubuntu-2404-arm");
    const qemu = images.steps.findIndex((step) => step.uses?.startsWith("docker/setup-qemu-action@"));
    const buildx = images.steps.findIndex((step) => step.uses?.startsWith("useblacksmith/setup-docker-builder@"));
    expect(qemu).toBeGreaterThanOrEqual(0);
    expect(qemu).toBeLessThan(buildx);
    expect(images.steps[qemu]!.with?.platforms).toBe("amd64");
    expect(images["timeout-minutes"]).toBeGreaterThan(0);
  });

  it("checks the worker only, after the registry digest matches, and before the digest is published", () => {
    expect(workflow).toContain('if [ "$image" = worker ]; then');
    expect(workflow.indexOf('"$registry_digest" != "$digest"')).toBeLessThan(workflow.indexOf("imagetools inspect --raw"));
    expect(workflow.indexOf("imagetools inspect --raw")).toBeLessThan(workflow.indexOf('echo "$image=$repo@$registry_digest"'));
  });
});

describe("the private release path (golden)", () => {
  it("still builds an image for linux/arm64 only when no platform is given (the worker's call), loaded for its smoke test", async () => {
    const calls: string[][] = [];
    const runner = {
      run: (command: string, args: readonly string[]) => { calls.push([command, ...args]); return ""; },
      aws: (args: readonly string[]) => args.includes("describe-repositories")
        ? { status: 0, stderr: "", stdout: "IMMUTABLE\n" }
        // The tag-is-new check (describe-images before the push) finds nothing; the digest read after the push finds it.
        : args.includes("describe-images") && !calls.some((call) => call[1] === "push") ? { status: 254, stderr: "ImageNotFoundException", stdout: "" }
        : { status: 0, stderr: "", stdout: args.includes("get-login-password") ? "password" : `sha256:${"b".repeat(64)}\n` },
    } as unknown as Runner;
    const options: ReleaseOptions = { region: "us-east-1", repository: "agentx-worker-production", allowDirty: false, skipChecks: true, dryRun: false };
    // The smoke test runs the loaded image: stand in for it so no container starts.
    const image = await buildAndPushImage(runner, options, { repository: options.repository, repositoryUri: "111122223333.dkr.ecr.us-east-1.amazonaws.com/agentx-worker-production", dockerfile: "environments/base/Dockerfile", localName: "agentx-worker", smokeTest: async () => undefined }, "0123456789abcdef");
    expect(image).toBe(`111122223333.dkr.ecr.us-east-1.amazonaws.com/agentx-worker-production@sha256:${"b".repeat(64)}`);
    const build = calls.find((call) => call[1] === "buildx")!;
    expect(build.slice(build.indexOf("--platform"), build.indexOf("--platform") + 2)).toEqual(["--platform", "linux/arm64"]);
    expect(build).toContain("--load");
  });
});

describe("a worker boot gets the image for its own chip from the index (golden: boot.sh is unchanged)", () => {
  it("pulls the worker image by its one digest with no platform flag, so Docker resolves the index to the host's chip", () => {
    expect(bootScript).toContain('pull_image_once() { timeout "$(try_seconds 300)" docker pull "$1"; }');
    expect(bootScript).toContain('retry "could not download the worker image" pull_image_once "$AGENTX_WORKER_IMAGE"');
    expect(bootScript).not.toContain("--platform");
  });
});
