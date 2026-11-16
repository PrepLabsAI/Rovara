// Device testing slice 2 (DEC 244) on real Docker, the real device executor image, KVM and a real Android emulator with Maestro: the CI `device-runtime` job (ROVARA_DOCKER=1, ROVARA_DEVICE_IMAGE).
// A tiny fixture app (tests/fixtures/device-evidence-app: a headline, a line with an email address, a password field and a button) is built twice, with two different headlines. The project's app
// would be built and run in the task sandbox; here a container with NO network stands in for the sandbox, and the device executor joins ITS network namespace (`--network container:<it>`), the
// only thing they share. The worker's own code writes the container's arguments, starts it, reads its one line of output and checks it against the plan (verifier/host/device-executor.ts).
//   * it needs KVM: no /dev/kvm (or a machine that is not x86-64) SKIPS the test with the reason, on the log and as a warning annotation; it never passes without having run;
//   * the arguments are checked on the real daemon: what Docker made of them (never privileged, no capability, one device, one read-only mount, the sandbox's network namespace and nothing else);
//   * the run is checked end to end: a masked before and after picture of each step, the email and the password painted black, the button's tap taking effect (so Maestro ran), kind visual;
//   * while it runs, the listeners the emulator and its tools open in the SHARED loopback are looked for from the sandbox's side, and only the known ones may be there.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEVICE_EVIDENCE_RUN_MS, DEVICE_EVIDENCE_STEP_MS, deviceEvidenceCheck, type DeviceEvidenceOutcome } from "../../packages/contracts/src/device-evidence.js";
import {
  DEVICE_EXECUTOR_MARGIN_MS, DEVICE_EXECUTOR_OUTPUT_MAX_BYTES, decodeDeviceExecutorPlan, deviceExecutorArgProblems, deviceExecutorRunArgs, encodeDeviceExecutorPlan, parseDeviceExecutorOutput,
} from "../../packages/verifier/src/host/device-executor.js";
import { decodeJpeg } from "../support/device-jpeg-decode.js";
import { kvmHere, skipWithReason } from "../support/device-kvm.js";

const IMAGE = process.env.ROVARA_DEVICE_IMAGE;
const wanted = process.platform === "linux" && process.env.ROVARA_DOCKER === "1" && IMAGE !== undefined && IMAGE !== "";
const docker = (args: string[], timeout = 120_000) => spawnSync("docker", args, { encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 });

const FIXTURE = join(process.cwd(), "tests/fixtures/device-evidence-app");
const SCAN = "const n=require('net');const open=[];let left=0;for(let p=1024;p<=65535;p++){left++;const s=n.connect({host:'127.0.0.1',port:p});s.once('connect',()=>{open.push(p);s.destroy();if(--left===0)done()});s.once('error',()=>{if(--left===0)done()});}function done(){console.log(JSON.stringify(open));process.exit(0)}setTimeout(()=>{console.log(JSON.stringify(open));process.exit(0)},20000)";
/**
 * The loopback listeners the emulator and its tools may open in the namespace they share with the sandbox, each one a way for the sandbox's own code to reach the emulator's guest (which runs that same code
 * anyway): adb's server, the emulator's console and its adb port, and Maestro's driver port. Anything else is a new door and fails the test.
 */
const KNOWN_PORTS = new Map<number, string>([[5037, "adb server"], [5554, "emulator console"], [5555, "emulator adb"], [7001, "Maestro driver"]]);

describe.runIf(wanted)("device evidence: the Android emulator in the device executor", () => {
  const suffix = randomBytes(4).toString("hex");
  const sandbox = `rovara-dev-sbx-${suffix}`;
  const created = `rovara-dev-chk-${suffix}`;
  const run = `rovara-dev-run-${suffix}`;
  let appsDir = "";
  let sandboxStarted = false;
  const planInput = {
    appId: "io.rovara.fixture", flows: [{ id: "main", steps: [{ id: "open", label: "Open" }, { id: "next", label: "Next", actions: [{ do: "tap_text" as const, text: "Continue" }] }] }],
    notShown: [], moreNotShown: 0, maskIds: [], runMs: DEVICE_EVIDENCE_RUN_MS, stepMs: DEVICE_EVIDENCE_STEP_MS,
  };

  /** The fixture apps built on this machine (the runner's JDK and Android SDK), the sandbox stand-in started, once. */
  function prepare(): { kvmGid: number | undefined } {
    const kvm = kvmHere();
    if (!kvm.ok) throw new Error(`no KVM: ${kvm.reason}`);
    if (appsDir === "") {
      appsDir = mkdtempSync(join("/var/tmp", "rovara-device-apps-"));
      const built = spawnSync("bash", [join(FIXTURE, "build.sh"), appsDir], { encoding: "utf8", timeout: 300_000 });
      if (built.status !== 0) throw new Error(`the fixture apps did not build:\n${built.stdout}\n${built.stderr}`);
      // The container's own user reads them: the directory and each file are open to read.
      chmodSync(appsDir, 0o755);
      for (const name of readdirSync(appsDir)) chmodSync(join(appsDir, name), 0o644);
    }
    if (!sandboxStarted) {
      // The task sandbox's stand-in: no network at all (its only address is its own loopback), nothing mounted, nothing added.
      const started = docker(["run", "--detach", "--rm", "--pull=never", "--name", sandbox, "--network", "none", "--cap-drop=ALL", "--security-opt", "no-new-privileges", IMAGE!, "sleep", "3600"]);
      if (started.status !== 0) throw new Error(`the sandbox stand-in did not start: ${started.stderr}`);
      sandboxStarted = true;
    }
    return { kvmGid: kvm.gid };
  }

  afterAll(() => {
    for (const name of [run, created, sandbox]) docker(["rm", "--force", name]);
    if (appsDir !== "") rmSync(appsDir, { recursive: true, force: true });
  });

  it("starts the container with arguments the daemon understands as exactly what was asked: never privileged, one device, one read-only mount, the sandbox's network namespace and nothing else", (context) => {
    const kvm = kvmHere();
    if (!kvm.ok) skipWithReason((note) => context.skip(note), kvm.reason);
    const { kvmGid } = prepare();
    const plan = encodeDeviceExecutorPlan(planInput);
    const args = deviceExecutorRunArgs({ image: IMAGE!, sandbox, name: created, appsDir, kvmGid, plan });
    expect(deviceExecutorArgProblems(args, { image: IMAGE!, sandbox, name: created, appsDir, plan })).toEqual([]);
    // `docker create` takes the same flags as `docker run` but not --rm, and does not start anything.
    const made = docker(["create", ...args.slice(1).filter((word) => word !== "--rm")]);
    expect(made.status, made.stderr).toBe(0);
    const inspected = docker(["inspect", created, sandbox]);
    expect(inspected.status, inspected.stderr).toBe(0);
    const [executor, standIn] = JSON.parse(inspected.stdout) as Array<{ Id: string; HostConfig: Record<string, unknown>; Config: { User: string; Env: string[] } }>;
    const host = executor!.HostConfig as {
      Privileged: boolean; CapAdd: string[] | null; CapDrop: string[]; SecurityOpt: string[] | null; NetworkMode: string; Devices: Array<{ PathOnHost: string; PathInContainer: string; CgroupPermissions: string }> | null;
      Binds: string[] | null; Mounts?: unknown[] | null; ReadonlyRootfs: boolean; PidMode: string; IpcMode: string; UsernsMode: string; UTSMode: string; PortBindings: Record<string, unknown> | null; PublishAllPorts: boolean;
      Dns: string[] | null; ExtraHosts: string[] | null; Links: string[] | null; VolumesFrom: string[] | null; Tmpfs: Record<string, string> | null; Memory: number; MemorySwap: number; PidsLimit: number | null; NanoCpus: number;
      DeviceCgroupRules: string[] | null; Sysctls: Record<string, string> | null; Runtime: string; Init: boolean | null;
    };
    expect(host.Privileged).toBe(false);
    expect(host.CapAdd ?? []).toEqual([]);
    expect(host.CapDrop).toEqual(["ALL"]);
    expect((host.SecurityOpt ?? []).filter((option) => !option.startsWith("no-new-privileges"))).toEqual([]);
    expect((host.SecurityOpt ?? []).some((option) => option.startsWith("no-new-privileges"))).toBe(true);
    expect(host.NetworkMode).toBe(`container:${standIn!.Id}`);
    expect(host.Devices).toEqual([{ PathOnHost: "/dev/kvm", PathInContainer: "/dev/kvm", CgroupPermissions: "rw" }]);
    expect(host.DeviceCgroupRules ?? []).toEqual([]);
    expect(host.Binds).toEqual([`${appsDir}:/apps:ro`]);
    expect(host.Mounts ?? []).toEqual([]);
    expect(host.VolumesFrom ?? []).toEqual([]);
    expect(host.ReadonlyRootfs).toBe(true);
    expect(["", "private"]).toContain(host.PidMode);
    expect(host.IpcMode).not.toBe("host");
    expect(host.IpcMode).not.toMatch(/^container:/u);
    expect([host.UsernsMode, host.UTSMode]).toEqual(["", ""]);
    expect(Object.keys(host.PortBindings ?? {})).toEqual([]);
    expect(host.PublishAllPorts).toBe(false);
    expect([host.Dns ?? [], host.ExtraHosts ?? [], host.Links ?? []]).toEqual([[], [], []]);
    expect(Object.keys(host.Tmpfs ?? {}).sort()).toEqual(["/home/android", "/tmp"]);
    expect(Object.keys(host.Sysctls ?? {})).toEqual([]);
    expect([host.Memory, host.MemorySwap, host.PidsLimit, host.NanoCpus]).toEqual([8 * 1024 ** 3, 8 * 1024 ** 3, 4096, 4_000_000_000]);
    expect(host.Init).toBe(true);
    expect(executor!.Config.User).toBe("10001:10001");
    // nothing of the host's, the worker's or anyone's credentials is in the container's environment: only what the image itself sets
    expect(executor!.Config.Env.filter((row) => /^(AWS_|AGENTX_|PI_|GIT_|GITHUB_|NPM_|DOCKER_|.*(TOKEN|SECRET|PASSWORD|KEY)=)/iu.test(row))).toEqual([]);
    docker(["rm", "--force", created]);
  }, 180_000);

  it("takes masked before and after pictures of a real app on a real emulator in the shared network namespace, and only the known listeners are open there", async (context) => {
    const kvm = kvmHere();
    if (!kvm.ok) skipWithReason((note) => context.skip(note), kvm.reason);
    const { kvmGid } = prepare();
    const plan = encodeDeviceExecutorPlan(planInput);
    const decoded = decodeDeviceExecutorPlan(plan)!;
    const baseArgs = deviceExecutorRunArgs({ image: IMAGE!, sandbox, name: run, appsDir, kvmGid, plan });
    // The one addition to the worker's own arguments, for this test only: the program's stage log on standard error (never the evidence).
    const args = [baseArgs[0]!, "--env", "ROVARA_DEVICE_DIAG=1", ...baseArgs.slice(1)];
    const started = Date.now();
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let outSize = 0;
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => { outSize += chunk.byteLength; if (outSize <= DEVICE_EXECUTOR_OUTPUT_MAX_BYTES) out.push(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { err.push(chunk); });
    const exited = new Promise<number | null>((resolve) => { child.once("close", resolve); child.once("error", () => { resolve(null); }); });
    // Look from the sandbox's side, every few seconds, for as long as the executor runs, and keep every port ever seen.
    const seen = new Set<number>();
    let running = true;
    void exited.then(() => { running = false; });
    const watcher = (async () => {
      while (running) {
        const scanned = docker(["exec", sandbox, "node", "-e", SCAN], 60_000);
        if (scanned.status === 0) for (const port of JSON.parse(scanned.stdout.trim().split("\n").at(-1) ?? "[]") as number[]) seen.add(port);
        await new Promise((resolve) => { setTimeout(resolve, 5_000); });
      }
    })();
    const timer = setTimeout(() => { docker(["rm", "--force", run]); }, DEVICE_EVIDENCE_RUN_MS + DEVICE_EXECUTOR_MARGIN_MS);
    const code = await exited;
    clearTimeout(timer);
    await watcher;
    const stderr = Buffer.concat(err).toString("utf8");
    const elapsed = Math.round((Date.now() - started) / 1000);
    process.stdout.write(`device executor finished in ${String(elapsed)} s with exit code ${String(code)}\n${stderr.slice(-6_000)}\n`);
    expect(code, `the container exited with ${String(code)}:\n${stderr.slice(-4_000)}`).toBe(0);

    const captured = parseDeviceExecutorOutput(new Uint8Array(Buffer.concat(out)), decoded);
    if (captured === undefined) { const all = Buffer.concat(out); throw new Error(`the program's output was not an honest answer to the plan (${String(all.byteLength)} bytes, ends with a newline: ${String(all.at(-1) === 10)}, lines: ${String(all.toString("utf8").split("\n").length)}):\n${all.toString("utf8").slice(0, 300)} ... ${all.toString("utf8").slice(-200)}\n${stderr.slice(-3_000)}`); }
    process.stdout.write(`result: ${JSON.stringify({ ...captured, steps: captured.steps.map((row) => (row.status === "shown" ? { flow: row.flow, step: row.step, status: row.status } : row)) })}\n`);
    if (captured.notRun !== undefined || captured.steps.some((row) => row.status !== "shown")) throw new Error(`the run did not show every step: ${JSON.stringify({ notRun: captured.notRun, steps: captured.steps.map((row) => (row.status === "shown" ? "shown" : row.reason)) })}\n${stderr.slice(-4_000)}`);
    expect(captured.device).toBe("android_emulator");
    expect(captured.isolation).toBe("sandbox");
    expect(captured.durationMs).toBeLessThanOrEqual(DEVICE_EVIDENCE_RUN_MS);

    // Every step has a before and an after JPEG within the cap; the emulator's real screen, with the email line and the password field painted black and the rest of the page left alone.
    for (const row of captured.steps) {
      if (row.status !== "shown") throw new Error("shown expected");
      for (const side of [row.before, row.after]) {
        const picture = decodeJpeg(side.bytes);
        expect(picture.width).toBeGreaterThan(300);
        expect(picture.height).toBeGreaterThan(picture.width);
        const darkRows = Array.from({ length: picture.height }, (_row, y) => {
          let dark = 0;
          for (let x = 0; x < picture.width; x += 1) if (picture.rgba[(y * picture.width + x) * 4]! < 40) dark += 1;
          return dark / picture.width;
        }).filter((share) => share > 0.95).length;
        // two painted bands of about 200 rows each (the email line and the password field); the headline and the button are not black rows
        expect(darkRows, `${row.flow}/${row.step}: rows painted black`).toBeGreaterThanOrEqual(300);
        expect(darkRows, `${row.flow}/${row.step}: rows painted black`).toBeLessThanOrEqual(Math.round(picture.height * 0.6));
        // the right-hand end of the headline row is the page's own light colour, not painted
        expect(picture.rgba[(Math.round(picture.height * 0.14) * picture.width + picture.width - 10) * 4]!).toBeGreaterThan(150);
      }
    }
    // The two builds differ on the first step (their headlines), and on each side the second step differs from the first (the tap on "Continue" changed the headline: Maestro really ran).
    const [open, next] = captured.steps;
    if (open?.status !== "shown" || next?.status !== "shown") throw new Error("two shown steps expected");
    expect(open.before.sha256).not.toBe(open.after.sha256);
    expect(next.before.sha256).not.toBe(open.before.sha256);
    expect(next.after.sha256).not.toBe(open.after.sha256);

    // The pictures are visual evidence only.
    const ref = (bytes: Uint8Array) => ({ kind: "jpeg" as const, sha256: "a".repeat(64), bytes: bytes.byteLength, retentionClass: "evidence-std" as const });
    const outcome: DeviceEvidenceOutcome = { ...captured, steps: captured.steps.map((row) => (row.status === "shown" ? { ...row, before: ref(row.before.bytes), after: ref(row.after.bytes) } : row)) };
    expect(deviceEvidenceCheck(outcome).check).toMatchObject({ kind: "visual", runBy: "rovara", label: "Device evidence: Android emulator" });

    // The listeners in the shared loopback, seen from the sandbox. The emulator's guest, adb and Maestro are reachable by what runs in the sandbox (which is the code the emulator runs anyway); nothing else is.
    process.stdout.write(`listeners seen in the shared loopback: ${JSON.stringify([...seen].sort((a, b) => a - b))}\n`);
    const unknown = [...seen].filter((port) => !KNOWN_PORTS.has(port));
    expect(unknown, `ports in the shared network namespace that nobody expected: ${unknown.join(", ")}`).toEqual([]);
    expect(seen.size, "the sandbox's scan saw none of the emulator's own listeners, so the scan proves nothing").toBeGreaterThan(0);
  }, DEVICE_EVIDENCE_RUN_MS + 2 * DEVICE_EXECUTOR_MARGIN_MS + 120_000);
});
