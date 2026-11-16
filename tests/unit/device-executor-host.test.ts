// Device testing slice 2: the worker's side of the device executor. The container's arguments (never privileged; the sandbox's network namespace, /dev/kvm and one read-only mount are all it shares),
// the exact-match check on them, the plan it is asked, the answer it gives (checked whole against the plan before anything is believed), the KVM probe and the run.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DEVICE_EVIDENCE_RUN_MS, DEVICE_EVIDENCE_SCREENSHOT_MAX_BYTES, DEVICE_EVIDENCE_STEP_MS, type DeviceEvidenceCaptured } from "../../packages/contracts/src/device-evidence.js";
import {
  DEVICE_EXECUTOR_ENTRY, DEVICE_EXECUTOR_LABEL, DEVICE_EXECUTOR_MARGIN_MS, DEVICE_EXECUTOR_OUTPUT_MAX_BYTES, DEVICE_EXECUTOR_PLAN_MAX_CHARS, checkKvm, decodeDeviceExecutorPlan, deviceExecutorArgProblems,
  deviceExecutorRunArgs, encodeDeviceExecutorOutput, encodeDeviceExecutorPlan, parseDeviceExecutorOutput, runDeviceExecutor, type DeviceExecutorPlan, type DeviceExecutorRunInput, type KvmProbe,
} from "../../packages/verifier/src/host/device-executor.js";
import { answer, scriptedPort } from "../support/device-command-fake.js";

const flows = [
  { id: "main", steps: [{ id: "open", label: "Open" }, { id: "next", label: "Next", actions: [{ do: "tap_text" as const, text: "Continue" }] }] },
  { id: "settings", steps: [{ id: "open", label: "Open" }] },
];
const planInput = { appId: "io.rovara.fixture", flows, notShown: [], moreNotShown: 0, maskIds: ["io.rovara.fixture:id/secret"], runMs: DEVICE_EVIDENCE_RUN_MS, stepMs: DEVICE_EVIDENCE_STEP_MS };
const PLAN = encodeDeviceExecutorPlan(planInput);
const input = (over: Partial<DeviceExecutorRunInput> = {}): DeviceExecutorRunInput => ({ image: "rovara-device-executor:ci", sandbox: "rovara-sbx-1a2b", name: "rovara-dev-3c4d", appsDir: "/var/lib/rovara/apps-1", kvmGid: 108, plan: PLAN, ...over });
const jpeg = (seed: number, size = 40) => { const bytes = new Uint8Array(size); bytes.set([0xff, 0xd8, 0xff, 0xe0]); bytes.fill(seed, 4); return bytes; };
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const shot = (seed: number, size?: number) => { const bytes = jpeg(seed, size); return { sha256: sha(bytes), bytes }; };
const captured = (over: Partial<DeviceEvidenceCaptured> = {}): DeviceEvidenceCaptured => ({
  device: "android_emulator", isolation: "sandbox", durationMs: 90_000, notShown: [], moreNotShown: 0, unmasked: 0,
  steps: [
    { flow: "main", step: "open", status: "shown", before: shot(1), after: shot(2) }, { flow: "main", step: "next", status: "not_run", reason: "masked_content" }, { flow: "settings", step: "open", status: "shown", before: shot(3), after: shot(4) },
  ], ...over,
});
const plan = (): DeviceExecutorPlan => decodeDeviceExecutorPlan(PLAN)!;
const line = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value)}\n`);
const wire = (over: Record<string, unknown> = {}) => ({ ...(JSON.parse(encodeDeviceExecutorOutput(captured())) as Record<string, unknown>), ...over });

describe("deviceExecutorRunArgs", () => {
  it("is exactly this, in this order: the sandbox's network namespace, /dev/kvm, one read-only mount, every capability dropped, a read-only root, the default profiles, and limits", () => {
    expect(deviceExecutorRunArgs(input())).toEqual([
      "run", "--rm", "--pull=never", "--name", "rovara-dev-3c4d", "--label", `${DEVICE_EXECUTOR_LABEL}=1`, "--network", "container:rovara-sbx-1a2b",
      "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--init", "--read-only", "--user", "10001:10001", "--group-add", "108", "--device", "/dev/kvm:/dev/kvm:rw",
      "--tmpfs", "/tmp:rw,exec,nosuid,nodev,size=8g", "--tmpfs", "/home/android:rw,noexec,nosuid,nodev,size=256m,uid=10001,gid=10001,mode=0700",
      "--shm-size", "1g", "--memory", "8g", "--memory-swap", "8g", "--pids-limit", "4096", "--cpus", "4",
      "-v", "/var/lib/rovara/apps-1:/apps:ro", "rovara-device-executor:ci", "node", DEVICE_EXECUTOR_ENTRY, PLAN,
    ]);
  });

  it("adds a group only for a device that is not open to everyone, and never the root group", () => {
    expect(deviceExecutorRunArgs(input({ kvmGid: undefined }))).not.toContain("--group-add");
    for (const gid of [0, -1, 1.5, Number.NaN, 65_536, "108" as unknown as number]) expect(() => deviceExecutorRunArgs(input({ kvmGid: gid })), String(gid)).toThrow("the device executor's arguments are not valid");
    expect(() => deviceExecutorRunArgs(input({ kvmGid: 1 }))).not.toThrow();
  });

  it("shares only the sandbox's network namespace, one device, one mount: never privileged, no capability, no loosened profile, no environment, no port, no other namespace", () => {
    const args = deviceExecutorRunArgs(input());
    expect(args.filter((word) => word === "--network")).toHaveLength(1);
    expect(args[args.indexOf("--network") + 1]).toBe("container:rovara-sbx-1a2b");
    expect(args.filter((word) => word === "--device")).toEqual(["--device"]);
    expect(args[args.indexOf("--device") + 1]).toBe("/dev/kvm:/dev/kvm:rw");
    expect(args.filter((word) => word === "-v")).toHaveLength(1);
    expect(args[args.indexOf("-v") + 1]).toMatch(/:\/apps:ro$/u);
    expect(args).toContain("--cap-drop=ALL");
    const securityOptions = args.flatMap((word, at) => (word === "--security-opt" ? [args[at + 1]!] : []));
    expect(securityOptions).toEqual(["no-new-privileges"]);
    for (const forbidden of ["--privileged", "--cap-add", "--pid", "--ipc", "--uts", "--userns", "--cgroupns", "--env", "-e", "--env-file", "--publish", "-p", "--publish-all", "-P", "--dns", "--add-host", "--volumes-from", "--mount",
      "--entrypoint", "--ulimit", "--sysctl", "--runtime", "--gpus", "--device-cgroup-rule", "--security-opt=seccomp=unconfined", "--net", "--link", "--expose", "--tty", "-t", "--interactive", "-i"]) expect(args, forbidden).not.toContain(forbidden);
    expect(args.join(" ")).not.toMatch(/docker\.sock|seccomp|apparmor|unconfined|--network host|\brwm\b/u);
    expect(args.some((word) => word.includes("/dev/") && !word.startsWith("/dev/kvm:/dev/kvm:rw"))).toBe(false);
    expect(args[args.indexOf("--user") + 1]).toBe("10001:10001");
    expect(args).toContain("--read-only");
    expect(args).toContain("--init");
    expect(args).toContain("--rm");
    expect(args).toContain("--pull=never");
  });

  it("limits the container: memory, swap, processes, cpus and shared memory", () => {
    const args = deviceExecutorRunArgs(input());
    const after = (flag: string) => args[args.indexOf(flag) + 1];
    expect([after("--memory"), after("--memory-swap"), after("--pids-limit"), after("--cpus"), after("--shm-size")]).toEqual(["8g", "8g", "4096", "4", "1g"]);
  });

  it("refuses an image, container name, mount directory or plan that could become another argument", () => {
    for (const bad of [{ image: "" }, { image: "a b" }, { image: "x;y" }, { image: "--privileged" }, { image: "x\ny" }, { sandbox: "" }, { sandbox: "a/b" }, { sandbox: "-x" }, { sandbox: "a b" }, { sandbox: "host" + "\n" }, { name: "a:b" }, { name: "-x" },
      { name: "rovara-sbx-1a2b" }, { appsDir: "apps" }, { appsDir: "/a b" }, { appsDir: "/a:rw" }, { appsDir: "/a,b" }, { appsDir: "/a/../b" }, { appsDir: "/a//b" }, { appsDir: "/" }, { appsDir: "/a/." }, { appsDir: "/var/run/docker.sock:/x" }, { plan: "" },
      { plan: "a b" }, { plan: "a/b" }, { plan: "--privileged" + " x" }, { plan: "x".repeat(DEVICE_EXECUTOR_PLAN_MAX_CHARS + 1) }]) {
      expect(() => deviceExecutorRunArgs(input(bad as Partial<DeviceExecutorRunInput>)), JSON.stringify(bad).slice(0, 80)).toThrow("the device executor's arguments are not valid");
    }
  });
});

describe("deviceExecutorArgProblems", () => {
  it("accepts what deviceExecutorRunArgs writes, with or without a group", () => {
    expect(deviceExecutorArgProblems(deviceExecutorRunArgs(input()))).toEqual([]);
    expect(deviceExecutorArgProblems(deviceExecutorRunArgs(input({ kvmGid: undefined })))).toEqual([]);
  });

  it("refuses every way to widen the container, whatever the extra word", () => {
    const good = deviceExecutorRunArgs(input());
    const widened: Array<[string, string[]]> = [
      ["privileged", [...good.slice(0, 1), "--privileged", ...good.slice(1)]],
      ["cap-add", [...good.slice(0, 1), "--cap-add", "SYS_ADMIN", ...good.slice(1)]],
      ["cap-add all", [...good.slice(0, 1), "--cap-add=ALL", ...good.slice(1)]],
      ["host network", good.map((word) => (word.startsWith("container:") ? "host" : word))],
      ["bridge network", good.map((word) => (word.startsWith("container:") ? "bridge" : word))],
      ["no network flag", good.filter((word, at) => word !== "--network" && good[at - 1] !== "--network")],
      ["host pid", [...good.slice(0, 1), "--pid", "host", ...good.slice(1)]],
      ["host ipc", [...good.slice(0, 1), "--ipc=host", ...good.slice(1)]],
      ["docker socket", [...good.slice(0, 1), "-v", "/var/run/docker.sock:/var/run/docker.sock", ...good.slice(1)]],
      ["read-write mount", good.map((word) => (word.endsWith(":/apps:ro") ? word.replace(":ro", ":rw") : word))],
      ["no ro flag", good.map((word) => (word.endsWith(":/apps:ro") ? word.replace(":ro", "") : word))],
      ["second mount", [...good.slice(0, 1), "-v", "/etc:/etc:ro", ...good.slice(1)]],
      ["whole /dev/kvm rwm", good.map((word) => (word === "/dev/kvm:/dev/kvm:rw" ? "/dev/kvm:/dev/kvm:rwm" : word))],
      ["second device", [...good.slice(0, 1), "--device", "/dev/mem", ...good.slice(1)]],
      ["another device", good.map((word) => (word === "/dev/kvm:/dev/kvm:rw" ? "/dev/mem:/dev/mem:rw" : word))],
      ["seccomp off", [...good.slice(0, 1), "--security-opt", "seccomp=unconfined", ...good.slice(1)]],
      ["apparmor off", [...good.slice(0, 1), "--security-opt", "apparmor=unconfined", ...good.slice(1)]],
      ["root user", good.map((word) => (word === "10001:10001" ? "0:0" : word))],
      ["no cap-drop", good.filter((word) => word !== "--cap-drop=ALL")],
      ["writable root", good.filter((word) => word !== "--read-only")],
      ["environment", [...good.slice(0, 1), "--env", "AWS_SECRET_ACCESS_KEY=x", ...good.slice(1)]],
      ["published port", [...good.slice(0, 1), "-p", "5555:5555", ...good.slice(1)]],
      ["more memory", good.map((word) => (word === "8g" ? "64g" : word))],
      ["no pids limit", good.filter((word, at) => word !== "--pids-limit" && good[at - 1] !== "--pids-limit")],
      ["root group", good.map((word, at) => (good[at - 1] === "--group-add" ? "0" : word))],
      ["another image command", [...good.slice(0, -3), "sh", "-c", "id"]],
      ["another entry", good.map((word) => (word === DEVICE_EXECUTOR_ENTRY ? "/bin/sh" : word))],
      ["another image", good.map((word) => (word === "rovara-device-executor:ci" ? "evil:latest" : word))],
      ["extra word at the end", [...good, "x"]],
      ["extra argument before the plan", [...good.slice(0, -1), "extra", good.at(-1)!]],
      ["pull always", good.map((word) => (word === "--pull=never" ? "--pull=always" : word))],
      ["no rm", good.filter((word) => word !== "--rm")],
      ["no label", good.filter((word, at) => word !== "--label" && good[at - 1] !== "--label")],
      ["empty", []],
    ];
    const known = { image: "rovara-device-executor:ci", sandbox: "rovara-sbx-1a2b", name: "rovara-dev-3c4d", appsDir: "/var/lib/rovara/apps-1", plan: PLAN };
    for (const [name, args] of widened) expect(deviceExecutorArgProblems(args, known).length, name).toBeGreaterThan(0);
    // The caller's own image, sandbox, container, mount and plan must be the ones in the arguments: another sandbox's namespace or another mount is refused even though it is well formed.
    const other = (from: string, to: string) => good.map((word) => word.replace(from, to));
    expect(deviceExecutorArgProblems(other("container:rovara-sbx-1a2b", "container:rovara-sbx-9999"), known)).toEqual(["not the expected sandbox"]);
    expect(deviceExecutorArgProblems(other("/var/lib/rovara/apps-1:", "/var/lib/rovara/apps-2:"), known)).toEqual(["not the expected appsDir"]);
    expect(deviceExecutorArgProblems(other("rovara-dev-3c4d", "rovara-dev-0000"), known)).toEqual(["not the expected name"]);
    expect(deviceExecutorArgProblems(good.slice(0, -1).concat("AAAA"), known)).toEqual(["not the expected plan"]);
    expect(deviceExecutorArgProblems(good, known)).toEqual([]);
    for (const bad of [null, undefined, "run", 5, [1, 2], ["run", null], {}]) expect(deviceExecutorArgProblems(bad as never).length).toBeGreaterThan(0);
  });
});

describe("the plan", () => {
  it("goes through one argument and comes back as it was, actions and all", () => {
    expect(plan()).toEqual({
      v: 1, appId: "io.rovara.fixture", flows: [
        { id: "main", steps: [{ id: "open", label: "Open" }, { id: "next", label: "Next", actions: [{ do: "tap_text", text: "Continue" }] }] }, { id: "settings", steps: [{ id: "open", label: "Open" }] },
      ], notShown: [], moreNotShown: 0, maskIds: ["io.rovara.fixture:id/secret"], runMs: DEVICE_EVIDENCE_RUN_MS, stepMs: DEVICE_EVIDENCE_STEP_MS,
    });
    expect(PLAN).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(decodeDeviceExecutorPlan(encodeDeviceExecutorPlan({ ...planInput, fixtureDataOnly: true }))?.fixtureDataOnly).toBe(true);
    expect(decodeDeviceExecutorPlan(encodeDeviceExecutorPlan({ ...planInput, fixtureDataOnly: false }))?.fixtureDataOnly).toBeUndefined();
  });

  it("holds the time limits at the built-in ones and no more", () => {
    expect(() => encodeDeviceExecutorPlan({ ...planInput, runMs: DEVICE_EVIDENCE_RUN_MS + 1 })).toThrow("the device plan is not valid");
    expect(() => encodeDeviceExecutorPlan({ ...planInput, stepMs: DEVICE_EVIDENCE_STEP_MS + 1 })).toThrow("the device plan is not valid");
    expect(() => encodeDeviceExecutorPlan({ ...planInput, runMs: 0 })).toThrow();
    expect(() => encodeDeviceExecutorPlan({ ...planInput, runMs: 60_000, stepMs: 5_000 })).not.toThrow();
  });

  it("refuses a plan that is not valid, at both ends", () => {
    for (const bad of [{ appId: "app" }, { appId: "io.x\n---" }, { flows: [] }, { flows: [flows[0]!, flows[0]!] }, { flows: [{ id: "A", steps: flows[0]!.steps }] }, { flows: [{ id: "x", steps: [] }] },
      { flows: [{ id: "x", steps: [{ id: "a", label: "A" }, { id: "a", label: "B" }] }] }, { flows: Array.from({ length: 6 }, (_v, i) => ({ id: `f${String(i)}`, steps: [{ id: "a", label: "A" }] })) },
      { flows: [{ id: "x", steps: [{ id: "a", label: "A", actions: [{ do: "run_script" }] }] }] }, { notShown: [{ flow: "x", reason: "other" }] }, { moreNotShown: -1 }, { maskIds: Array.from({ length: 21 }, () => "id") }, { maskIds: ["a\nb"] }]) {
      expect(() => encodeDeviceExecutorPlan({ ...planInput, ...bad } as never), JSON.stringify(bad).slice(0, 80)).toThrow("the device plan is not valid");
    }
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    const raw = JSON.parse(Buffer.from(PLAN, "base64url").toString("utf8")) as Record<string, unknown>;
    for (const argument of [undefined, null, 5, "", "!!", "a b", "a/b", "+", `${PLAN}=`, `${PLAN}x`, "x".repeat(DEVICE_EXECUTOR_PLAN_MAX_CHARS + 1), encode({ ...raw, v: 2 }), encode({ ...raw, extra: 1 }), encode({ ...raw, runMs: DEVICE_EVIDENCE_RUN_MS + 1 }), encode([]), encode("x")]) {
      expect(decodeDeviceExecutorPlan(argument), String(argument).slice(0, 40)).toBeUndefined();
    }
  });
});

describe("the answer", () => {
  it("is the runner's result, from one line, with every picture's bytes and digest intact", () => {
    const got = parseDeviceExecutorOutput(new TextEncoder().encode(`${encodeDeviceExecutorOutput(captured())}\n`), plan())!;
    expect(got.device).toBe("android_emulator");
    expect(got.steps.map((row) => [row.flow, row.step, row.status])).toEqual([["main", "open", "shown"], ["main", "next", "not_run"], ["settings", "open", "shown"]]);
    const first = got.steps[0]!;
    if (first.status !== "shown") throw new Error("shown expected");
    expect([...first.before.bytes]).toEqual([...jpeg(1)]);
    expect(first.before.sha256).toBe(sha(jpeg(1)));
  });

  it("is believed only when it is an honest answer to the plan: the device, the place, the steps in order, the notes, the caps", () => {
    const refused: Record<string, Uint8Array> = {
      empty: new Uint8Array(0), notJson: new TextEncoder().encode("hello"), twoLines: new TextEncoder().encode(`${encodeDeviceExecutorOutput(captured())}\n${encodeDeviceExecutorOutput(captured())}\n`),
      tooBig: new Uint8Array(DEVICE_EXECUTOR_OUTPUT_MAX_BYTES + 1), extraKey: line(wire({ extra: 1 })), version: line(wire({ v: 2 })), fake: line(wire({ device: "fake" })), simulator: line(wire({ device: "ios_simulator" })),
      laptop: line(wire({ isolation: "developer_machine" })), missingStep: line(wire({ steps: (wire().steps as unknown[]).slice(0, 2) })), extraStep: line(wire({ steps: [...(wire().steps as unknown[]), { flow: "other", step: "x", status: "not_run", reason: "capture_failed" }] })),
      reordered: line(wire({ steps: [...(wire().steps as unknown[])].reverse() })), noStepsAndNoReason: line(wire({ steps: [] })), notRunWithSteps: line(wire({ notRun: "device_did_not_start" })),
      overBound: new Uint8Array([...new TextEncoder().encode(JSON.stringify(wire())), ...new Uint8Array(DEVICE_EXECUTOR_OUTPUT_MAX_BYTES).fill(0x20)]), prettyPrinted: new TextEncoder().encode(JSON.stringify(wire(), null, 1)),
      notShownDiffers: line(wire({ notShown: [{ flow: "x", reason: "over_flow_cap" }] })), moreDiffers: line(wire({ moreNotShown: 3 })), unmaskedWithoutAdmin: line(wire({ unmasked: 1 })), unmaskedOverShown: line(wire({ unmasked: 9 })),
      slow: line(wire({ durationMs: DEVICE_EVIDENCE_RUN_MS + DEVICE_EXECUTOR_MARGIN_MS + 1 })), badReason: line(wire({ steps: [{ flow: "main", step: "open", status: "not_run", reason: "because" }] })), badStatus: line(wire({ steps: [{ flow: "main", step: "open", status: "ok" }] })),
    };
    for (const [name, bytes] of Object.entries(refused)) expect(parseDeviceExecutorOutput(bytes, plan()), name).toBeUndefined();
    expect(parseDeviceExecutorOutput("text" as unknown as Uint8Array, plan())).toBeUndefined();
  });

  it("takes a run that did not happen only with no steps, and the admin's own fixture-data choice for an unmasked screen", () => {
    const none = line(wire({ steps: [], notRun: "app_did_not_build" }));
    expect(parseDeviceExecutorOutput(none, plan())).toMatchObject({ notRun: "app_did_not_build", steps: [] });
    const withAdmin = decodeDeviceExecutorPlan(encodeDeviceExecutorPlan({ ...planInput, fixtureDataOnly: true }))!;
    expect(parseDeviceExecutorOutput(line(wire({ unmasked: 1 })), withAdmin)?.unmasked).toBe(1);
    expect(parseDeviceExecutorOutput(line(wire({ unmasked: 3 })), withAdmin)).toBeUndefined();
  });

  it("refuses a picture that is not a JPEG, not the bytes its digest names, not canonical base64, or over the cap, and a run over its byte budget", () => {
    const base = wire();
    const steps = base.steps as Array<{ before?: { sha256: string; jpegBase64: string } }>;
    const withBefore = (before: { sha256: string; jpegBase64: string }) => line({ ...base, steps: [{ ...steps[0]!, before }, ...steps.slice(1)] });
    const good = steps[0]!.before!;
    const text = Buffer.from("not a jpeg at all.....").toString("base64");
    for (const [name, before] of Object.entries({
      notJpeg: { sha256: sha(new TextEncoder().encode("not a jpeg at all.....")), jpegBase64: text }, wrongDigest: { ...good, sha256: "0".repeat(64) }, badBase64: { ...good, jpegBase64: `${good.jpegBase64}!` },
      nonCanonical: { ...good, jpegBase64: good.jpegBase64.replace(/=+$/u, "") + (good.jpegBase64.endsWith("=") ? "" : "") + (good.jpegBase64.endsWith("=") ? "" : "A") }, empty: { ...good, jpegBase64: "" },
      overCap: (() => { const big = jpeg(9, DEVICE_EVIDENCE_SCREENSHOT_MAX_BYTES + 1); return { sha256: sha(big), jpegBase64: Buffer.from(big).toString("base64") }; })(),
    })) expect(parseDeviceExecutorOutput(withBefore(before), plan()), name).toBeUndefined();
    const fat = (seed: number) => shot(seed, 500_000);
    const over: DeviceEvidenceCaptured = captured({ steps: flows.flatMap((flow) => flow.steps.map((step, at) => ({ flow: flow.id, step: step.id, status: "shown" as const, before: fat(at + 1), after: fat(at + 5) }))) });
    // 3 steps x 2 x 500,000 = 3 MB: inside the budget. Nine steps of the same are 9 MB, over the run's 8 MiB, and the run's own check says so.
    expect(parseDeviceExecutorOutput(new TextEncoder().encode(`${encodeDeviceExecutorOutput(over)}\n`), plan())).toBeDefined();
    const wide = decodeDeviceExecutorPlan(encodeDeviceExecutorPlan({ ...planInput, flows: Array.from({ length: 3 }, (_v, i) => ({ id: `f${String(i)}`, steps: [1, 2, 3].map((n) => ({ id: `s${String(n)}`, label: "S" })) })) }))!;
    const tooMuch: DeviceEvidenceCaptured = captured({ steps: wide.flows.flatMap((flow) => flow.steps.map((step, at) => ({ flow: flow.id, step: step.id, status: "shown" as const, before: fat(at + 1), after: fat(at + 5) }))) });
    const tooMuchBytes = new TextEncoder().encode(`${encodeDeviceExecutorOutput(tooMuch)}\n`);
    expect(tooMuchBytes.byteLength).toBeLessThanOrEqual(DEVICE_EXECUTOR_OUTPUT_MAX_BYTES);
    expect(parseDeviceExecutorOutput(tooMuchBytes, wide)).toBeUndefined();
  });

  it("never throws and never echoes the program's own words", () => {
    const secret = "tok_PROGRAM_SECRET";
    expect(() => parseDeviceExecutorOutput(new TextEncoder().encode(`{"v":1,"note":"${secret}"`), plan())).not.toThrow();
    expect(JSON.stringify(parseDeviceExecutorOutput(line(wire({ note: secret })), plan()) ?? null)).not.toContain(secret);
  });
});

describe("runDeviceExecutor", () => {
  const env = { DOCKER_HOST: "unix:///var/run/docker.sock" };
  const goodOutput = () => new TextEncoder().encode(`${encodeDeviceExecutorOutput(captured())}\n`);

  it("starts the container with exactly its arguments, within the run's time and the output bound, and removes it afterwards", async () => {
    const { port, runs } = scriptedPort((_file, args) => (args[0] === "run" ? answer(goodOutput()) : answer("")));
    const outcome = await runDeviceExecutor(port, input(), env);
    expect(outcome.captured?.steps).toHaveLength(3);
    expect(runs[0]!.file).toBe("docker");
    expect(runs[0]!.args).toEqual(deviceExecutorRunArgs(input()));
    expect(runs[0]!.options).toMatchObject({ timeoutMs: DEVICE_EVIDENCE_RUN_MS + DEVICE_EXECUTOR_MARGIN_MS, maxStdoutBytes: DEVICE_EXECUTOR_OUTPUT_MAX_BYTES, env });
    expect(runs[1]!.args).toEqual(["rm", "--force", "rovara-dev-3c4d"]);
  });

  it("believes nothing from a container that failed, ran out of time, printed too much or printed a wrong answer, and still removes it", async () => {
    for (const result of [answer(goodOutput(), 1), answer(goodOutput(), null, { timedOut: true }), answer(goodOutput(), 0, { tooLarge: true }), answer("hello"), answer("")]) {
      const { port, runs } = scriptedPort((_file, args) => (args[0] === "run" ? result : answer("")));
      const outcome = await runDeviceExecutor(port, input(), env);
      expect(outcome.captured).toBeUndefined();
      expect(outcome.timedOut).toBe(result.timedOut);
      expect(runs.at(-1)!.args).toEqual(["rm", "--force", "rovara-dev-3c4d"]);
    }
    const throwing = scriptedPort((_file, args) => { if (args[0] === "run") throw new Error("docker failed"); return answer(""); });
    expect((await runDeviceExecutor(throwing.port, input(), env)).captured).toBeUndefined();
    expect(throwing.runs.at(-1)!.args[0]).toBe("rm");
  });

  it("refuses arguments that are not the device executor's before it starts anything", async () => {
    const { port, runs } = scriptedPort(() => answer(""));
    await expect(runDeviceExecutor(port, input({ image: "--privileged" }), env)).rejects.toThrow("the device executor's arguments are not valid");
    await expect(runDeviceExecutor(port, input({ plan: "not-a-plan" }), env)).rejects.toThrow("the device executor's arguments are not valid");
    expect(runs).toHaveLength(0);
  });
});

describe("checkKvm", () => {
  const probe = (over: Partial<KvmProbe> = {}): KvmProbe => ({ platform: "linux", arch: "x64", stat: () => ({ isCharacterDevice: true, gid: 108, mode: 0o660 }), canReadWrite: () => true, ...over });
  it("is ok on x86-64 Linux with a /dev/kvm the user can open, and names the group when the device is not open to everyone", () => {
    expect(checkKvm(probe())).toEqual({ ok: true, gid: 108 });
    expect(checkKvm(probe({ stat: () => ({ isCharacterDevice: true, gid: 108, mode: 0o666 }) }))).toEqual({ ok: true, gid: undefined });
    expect(checkKvm(probe({ stat: () => ({ isCharacterDevice: true, gid: 108, mode: 0o664 }) }))).toEqual({ ok: true, gid: 108 });
  });
  it("says why it is not, in fixed words, for each way it can fail", () => {
    const reasons = [
      checkKvm(probe({ platform: "darwin" })), checkKvm(probe({ arch: "arm64" })), checkKvm(probe({ stat: () => undefined })), checkKvm(probe({ stat: () => ({ isCharacterDevice: false, gid: 108, mode: 0o666 }) })),
      checkKvm(probe({ canReadWrite: () => false })), checkKvm(probe({ stat: () => ({ isCharacterDevice: true, gid: 0, mode: 0o660 }) })),
    ];
    for (const row of reasons) expect(row.ok).toBe(false);
    expect(reasons.map((row) => (row.ok ? "" : row.reason))).toEqual([
      "this machine is not Linux, so there is no KVM", "this machine is not x86-64, and the Android emulator image is x86-64 only", "/dev/kvm is not there (this runner has no KVM)", "/dev/kvm is not a device",
      "/dev/kvm cannot be opened for reading and writing by this user", "/dev/kvm is open to no group the container could join",
    ]);
  });
});
