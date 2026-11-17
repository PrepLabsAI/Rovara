// Device testing slice 2: what must stay true of the device executor image, of the CI job that tests it with a real emulator, and of how that test says it was skipped. These are checks on files (the image
// and the workflow are not run here); the emulator itself runs in CI's `device-runtime` job.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { loadManifest } from "../../scripts/ci-images.js";
import { checkKvm } from "../../packages/verifier/src/host/device-executor.js";
import { kvmHere, skipWithReason } from "../support/device-kvm.js";

const read = (path: string) => readFileSync(path, "utf8");
const dockerfile = read("environments/device-executor/Dockerfile");
const e2eDockerfile = read("environments/e2e-executor/Dockerfile");
const instructions = dockerfile.split("\n").filter((row) => !row.startsWith("#") && row.trim() !== "");
interface Step { name?: string; if?: string; run?: string; uses?: string; env?: Record<string, string> }
interface Job { needs?: unknown; if?: string; "runs-on"?: string; "timeout-minutes"?: number; permissions?: Record<string, string>; steps: Step[] }
const ci = YAML.parse(read(".github/workflows/ci.yml")) as { permissions: Record<string, string>; jobs: Record<string, Job> };
const job = ci.jobs["device-runtime"]!;
const runs = job.steps.map((step) => step.run ?? "").join("\n");

describe("the device executor image", () => {
  it("starts from the same digest-pinned base as every other CI image, and only from it", () => {
    const base = loadManifest().find((image) => image.name === "node-build")!;
    const froms = instructions.filter((row) => row.startsWith("FROM "));
    expect(froms).toHaveLength(3);
    for (const row of froms) expect(row.split(/\s+/u)[1]).toBe(`${base.upstream}@${base.digest}`);
    expect(e2eDockerfile).toContain(`${base.upstream}@${base.digest}`);
  });

  it("downloads the Android command-line tools and Maestro only with their SHA-256 checked, from the vendors' own hosts, and installs nothing else from the network at run time", () => {
    expect(dockerfile).toMatch(/commandlinetools-linux-\d+_latest\.zip[\s\S]*?echo "[0-9a-f]{64} {2}\/tmp\/cmdline-tools\.zip" \| sha256sum --check -/u);
    expect(dockerfile).toMatch(/maestro\/releases\/download\/cli-[\d.]+\/maestro\.zip[\s\S]*?echo "[0-9a-f]{64} {2}\/tmp\/maestro\.zip" \| sha256sum --check -/u);
    const urls = [...dockerfile.matchAll(/https?:\/\/[^\s"']+/gu)].map((match) => new URL(match[0]).host);
    expect(new Set(urls)).toEqual(new Set(["dl.google.com", "github.com"]));
    expect(dockerfile).not.toMatch(/^ADD\s+https?:/mu);
    expect(dockerfile).not.toMatch(/curl[^\n]*\|\s*(ba)?sh/u);
    // The command-line tools (sdkmanager) are removed before the final image: nothing in it can install anything.
    expect(dockerfile).toContain("rm -rf /opt/android-sdk/cmdline-tools");
    expect(instructions.filter((row) => row.startsWith("COPY --from=android"))).toEqual(["COPY --from=android /opt/android-sdk /opt/android-sdk", "COPY --from=android /opt/android-avd /opt/android-avd", "COPY --from=android /opt/maestro /opt/maestro"]);
  });

  it("runs as an ordinary user whose number is the one the arguments name, with Maestro's analytics and update check off, and fails its own build when the emulator cannot load", () => {
    const useradd = instructions.join("\n").match(/useradd --uid (\d+)/u);
    expect(useradd?.[1]).toBe("10001");
    expect(instructions.filter((row) => row.startsWith("USER "))).toEqual(["USER android"]);
    expect(instructions.at(-2)).toBe("USER android");
    expect(dockerfile).toContain("MAESTRO_CLI_NO_ANALYTICS=true MAESTRO_DISABLE_UPDATE_CHECK=true");
    expect(dockerfile).toMatch(/test -x \/opt\/android-sdk\/emulator\/qemu\/linux-x86_64\/qemu-system-x86_64-headless[\s\S]*! ldd \/opt\/android-sdk\/emulator\/qemu\/linux-x86_64\/qemu-system-x86_64-headless \| grep "not found"/u);
    expect(dockerfile).toMatch(/emulator -version/u);
    expect(dockerfile).toMatch(/--list_installed/u);
    // never a loosened sandbox in the image's own instructions
    expect(dockerfile).not.toMatch(/privileged|--no-sandbox|seccomp=unconfined|chmod\s+[0-7]*[2367][0-7]{0,2}\s+\/(dev|etc)|sudo/u);
    expect(dockerfile).not.toMatch(/^(ENV|ARG)\s+\w*(TOKEN|SECRET|PASSWORD|KEY)\w*=/mu);
    expect(instructions.filter((row) => row.startsWith("EXPOSE"))).toEqual([]);
  });

  it("builds the one program the worker starts, and nothing else of the repository", () => {
    expect(dockerfile).toContain('CMD ["node", "/opt/agentx/packages/verifier/dist/executor/device-evidence-entry.js"]');
    const copies = instructions.filter((row) => /^COPY (?!--from)/u.test(row)).map((row) => row.split(/\s+/u)[1]);
    expect(copies.filter((path) => path?.startsWith("packages/") && !path.endsWith("package.json"))).toEqual(["packages/contracts", "packages/verifier"]);
    expect(copies).not.toContain(".");
  });
});

describe("the CI job that runs the emulator", () => {
  it("runs on x86-64 Linux (the emulator image is x86-64 only) planned like linux-runtime (only when the device area changes, always in a FULL run), with its own time limit, read-only permissions, and the one gate does NOT wait for it yet (informational until its first real run has been read)", () => {
    expect(job["runs-on"]).toBe("ubuntu-latest");
    expect(job.needs).toBe("plan");
    expect(job.if).toBe("needs.plan.outputs.device == 'true'");
    expect(job["timeout-minutes"]).toBeGreaterThan(0);
    expect(job["timeout-minutes"]).toBeLessThanOrEqual(90);
    expect(ci.jobs["local"]!.needs).not.toContain("device-runtime");
    expect(job.permissions).toBeUndefined();
    expect(ci.permissions).toEqual({ contents: "read" });
  });

  it("opens /dev/kvm on the runner, says plainly when it is missing, builds the image from the pinned base's local copy and runs the one test with Docker and the image named", () => {
    expect(runs).toContain("/etc/udev/rules.d/99-kvm4all.rules");
    expect(runs).toContain('ls -l /dev/kvm || echo "::warning');
    expect(runs).toContain('node scripts/ci-images.ts dockerfile environments/device-executor/Dockerfile "$RUNNER_TEMP/device-executor.Dockerfile"');
    expect(runs).toContain('docker build -f "$RUNNER_TEMP/device-executor.Dockerfile" -t rovara-device-executor:ci .');
    expect(runs).not.toContain("-f environments/");
    expect(runs).toContain("node scripts/ci-images.ts pull --github-env node-build");
    expect(runs.indexOf("ci-images.ts pull")).toBeLessThan(runs.indexOf("docker build"));
    expect(runs.indexOf("npm run build")).toBeLessThan(runs.indexOf("vitest run tests/linux/device-evidence-emulator.test.ts"));
    const test = job.steps.find((step) => (step.run ?? "").includes("tests/linux/device-evidence-emulator.test.ts"))!;
    expect(test.env).toEqual({ ROVARA_DOCKER: "1", ROVARA_DEVICE_IMAGE: "rovara-device-executor:ci" });
    expect(runs).not.toMatch(/--privileged|--cap-add|seccomp=unconfined|continue-on-error|\|\| true/u);
  });

  it("is quarantined (DEC 254zn): non-blocking unless the plan says the change touches device files, with a plain warning when it fails and the image build and the test both retried", () => {
    const quarantined = job as Job & { "continue-on-error"?: string };
    expect(quarantined["continue-on-error"]).toBe("${{ needs.plan.outputs.device_required != 'true' }}");
    const warn = job.steps.find((step) => step.name === "Say that a failure here is non-blocking")!;
    expect(warn.if).toBe("failure() && needs.plan.outputs.device_required != 'true'");
    expect(warn.run).toContain("::warning title=device-runtime is quarantined (non-blocking)::");
    // the SDK download happens in the image build: up to 3 attempts, ending in an error annotation and a failed step, never a silent pass
    const build = job.steps.find((step) => step.name === "Build the device executor image")!.run!;
    expect(build).toMatch(/until docker build -f "\$RUNNER_TEMP\/device-executor\.Dockerfile" -t rovara-device-executor:ci \.; do/u);
    expect(build).toContain('if [ "$attempt" -ge 3 ]; then');
    expect(build).toMatch(/::error title=Device executor image build failed::[^\n]*\n\s+exit 1/u);
    // the test file retries a failed test twice itself (vitest retry), so the job step needs no loop of its own
    expect(read("tests/linux/device-evidence-emulator.test.ts")).toMatch(/describe\.runIf\(wanted\)\("device evidence: the Android emulator in the device executor", \{ retry: 2 \}, \(\) => \{/u);
  });

  it("leaves the emulator test to this job: the ARM Linux job does not run it", () => {
    const generic = ci.jobs["linux-runtime"]!.steps.find((step) => (step.run ?? "").startsWith("npx vitest run tests/linux"))!;
    expect(generic.run).toContain("--exclude tests/linux/device-evidence-emulator.test.ts");
  });
});

describe("how the emulator test says it was skipped", () => {
  it("skips with the reason on the log and as a warning annotation, and never returns (so the test shows as skipped, not passed)", () => {
    const written: string[] = [];
    const skipped: Array<string | undefined> = [];
    const sentinel = new Error("skipped");
    const skip = (note?: string): never => { skipped.push(note); throw sentinel; };
    expect(() => skipWithReason(skip, "this runner has no KVM", (text) => written.push(text))).toThrow(sentinel);
    expect(skipped).toEqual(["this runner has no KVM"]);
    expect(written.join("")).toContain("::warning title=Device emulator test SKIPPED::this runner has no KVM\n");
    expect(written.join("")).toContain("SKIPPED (no emulator was run): this runner has no KVM\n");
  });

  it("fails instead of skipping where a job says KVM is required (ROVARA_DEVICE_REQUIRE_KVM), without skipping or writing a skipped line", () => {
    const written: string[] = [];
    const skipped: Array<string | undefined> = [];
    const skip = (note?: string): never => { skipped.push(note); throw new Error("skipped"); };
    expect(() => skipWithReason(skip, "no kvm", (text) => written.push(text), true)).toThrow("needs KVM and ROVARA_DEVICE_REQUIRE_KVM is set: no kvm");
    expect(skipped).toEqual([]);
    expect(written).toEqual([]);
  });

  it("the Linux test reads the KVM probe before it builds, starts or runs anything, in each test, and has no way out that passes without a result", () => {
    const text = read("tests/linux/device-evidence-emulator.test.ts");
    for (const title of ["starts the container with arguments the daemon understands", "takes masked before and after pictures"]) {
      const body = text.slice(text.indexOf(title));
      const probe = body.indexOf("kvmHere()");
      const skip = body.indexOf("skipWithReason(");
      const first = Math.min(...["prepare()", "docker(", "spawn("].map((word) => { const at = body.indexOf(word); return at < 0 ? Number.MAX_SAFE_INTEGER : at; }));
      expect(probe, title).toBeGreaterThan(0);
      expect(skip, title).toBeGreaterThan(probe);
      expect(skip, title).toBeLessThan(first);
    }
    expect(text).not.toMatch(/\.skip\(\)|\bit\.skip|\bdescribe\.skip|\btest\.skip|if \(!kvm\.ok\) return/u);
    expect(text).toMatch(/expect\(code,/u);
    expect(text).toContain("the sandbox's scan saw none of the emulator's own listeners, so the scan proves nothing");
  });

  it("the probe says no on a machine that cannot give the emulator KVM (this one included, when it has none)", () => {
    expect(kvmHere({ platform: "darwin" })).toEqual({ ok: false, reason: "this machine is not Linux, so there is no KVM" });
    expect(kvmHere({ arch: "arm64" }).ok).toBe(false);
    expect(checkKvm({ platform: "linux", arch: "x64", stat: () => undefined, canReadWrite: () => false }).ok).toBe(false);
  });
});
