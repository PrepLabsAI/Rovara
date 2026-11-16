// Device testing slice 2 (DEC 244): the worker's side of the device executor, the container that runs the Android emulator and Maestro (environments/device-executor). Same shape as browser evidence's
// capture container (DEC 241a): the project's app is built and runs in the TASK SANDBOX; this container is started beside it with `--network container:<sandbox>`, so the two share ONE network
// namespace (the app and the fakes on the sandbox's loopback are reachable from the emulator at its host alias, 10.0.2.2) and nothing else. It is never privileged. The one thing the emulator
// needs beyond a browser is `/dev/kvm`, given to this container only, never to the sandbox; the built apps arrive in ONE read-only mount; nothing leaves but a single line on standard output,
// which this file checks again, whole, before anything of it is believed (the emulator's guest runs the project's own code).
//   * `deviceExecutorRunArgs` is the only place the container's arguments are written, and `deviceExecutorArgProblems` is the exact-match check any other source of arguments must pass.
//   * `encodeDeviceExecutorPlan` / `decodeDeviceExecutorPlan`: what the program is asked, one argument, checked at both ends.
//   * `encodeDeviceExecutorOutput` / `parseDeviceExecutorOutput`: what it answers, checked against the plan (the same steps, the same notes, the caps, every picture's digest).
//   * `checkKvm`: whether this machine can give the emulator KVM; a test that needs it skips with the reason, never passes silently.
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  DEVICE_EVIDENCE_APP_ID, DEVICE_EVIDENCE_NOT_SHOWN_MAX, DEVICE_EVIDENCE_NOT_SHOWN_REASONS, DEVICE_EVIDENCE_RUN_MS, DEVICE_EVIDENCE_SCREENSHOT_MAX_BYTES, DEVICE_EVIDENCE_STEPS_MAX, DEVICE_EVIDENCE_STEP_MS,
  DEVICE_EVIDENCE_FLOWS_MAX, DEVICE_EVIDENCE_MASK_IDS_MAX, DEVICE_EVIDENCE_NOT_RUN_REASONS, DeviceEvidenceActionSchema, checkedDeviceEvidenceCaptured, type DeviceEvidenceCaptured, type DeviceEvidenceFlow,
} from "@agentx/contracts";
import type { DeviceCommandPort, DeviceCommandResult } from "../executor/device-process.js";

/** The program in the image, and where the built apps are mounted (read-only) inside it. */
export const DEVICE_EXECUTOR_ENTRY = "/opt/agentx/packages/verifier/dist/executor/device-evidence-entry.js";
export const DEVICE_EXECUTOR_APPS_DIR = "/apps";
/** The container's own user (the image's `android` user): given in the arguments too, so a swapped image cannot start as root. */
export const DEVICE_EXECUTOR_UID = 10_001;
/** A label every device executor carries, so a sweep can find one that outlived its worker. */
export const DEVICE_EXECUTOR_LABEL = "io.rovara.device-executor";
/** The most one run's answer can take: eight MiB of pictures as base64, and the lines around them. */
export const DEVICE_EXECUTOR_OUTPUT_MAX_BYTES = 12 * 1_048_576;
/** The plan as one argument (base64url JSON). */
export const DEVICE_EXECUTOR_PLAN_MAX_CHARS = 120_000;
/** Time the host leaves the program to start, boot twice and stop, beyond the run's own limit. */
export const DEVICE_EXECUTOR_MARGIN_MS = 30_000;

const IMAGE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/u;
const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const APPS_HOST_DIR = /^\/[A-Za-z0-9._/-]{1,300}$/u;

// ---- the plan

const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/u;
const NameSchema = z.string().regex(NAME);
const NO_HIDDEN = /^[^\p{Cc}\p{Cf}]*$/u;
const PlanSchema = z.object({
  v: z.literal(1),
  appId: z.string().max(200).regex(DEVICE_EVIDENCE_APP_ID),
  flows: z.array(z.object({
    id: NameSchema,
    steps: z.array(z.object({ id: NameSchema, label: z.string().min(1).max(80).regex(NO_HIDDEN), actions: z.array(DeviceEvidenceActionSchema).max(10).optional() }).strict()).min(1).max(DEVICE_EVIDENCE_STEPS_MAX),
  }).strict()).min(1).max(DEVICE_EVIDENCE_FLOWS_MAX),
  notShown: z.array(z.object({ flow: NameSchema, reason: z.enum(DEVICE_EVIDENCE_NOT_SHOWN_REASONS) }).strict()).max(DEVICE_EVIDENCE_NOT_SHOWN_MAX),
  moreNotShown: z.number().int().min(0).max(1_000_000),
  maskIds: z.array(z.string().min(1).max(200).regex(NO_HIDDEN)).max(DEVICE_EVIDENCE_MASK_IDS_MAX),
  fixtureDataOnly: z.boolean().optional(),
  runMs: z.number().int().min(1_000).max(DEVICE_EVIDENCE_RUN_MS),
  stepMs: z.number().int().min(1_000).max(DEVICE_EVIDENCE_STEP_MS),
}).strict().superRefine((plan, context) => {
  if (new Set(plan.flows.map((flow) => flow.id)).size !== plan.flows.length) context.addIssue({ code: "custom", message: "flow ids are unique" });
  for (const flow of plan.flows) if (new Set(flow.steps.map((step) => step.id)).size !== flow.steps.length) context.addIssue({ code: "custom", message: "step ids are unique" });
});
export type DeviceExecutorPlan = z.infer<typeof PlanSchema>;
export type DeviceExecutorPlanInput = {
  appId: string; flows: readonly DeviceEvidenceFlow[]; notShown: ReadonlyArray<{ flow: string; reason: "over_flow_cap" }>; moreNotShown: number; maskIds: readonly string[]; fixtureDataOnly?: boolean | undefined; runMs: number; stepMs: number;
};

/** The plan as the one argument the program takes. Throws a fixed sentence on a plan that is not valid (the limits are the built-in ones at most). */
export function encodeDeviceExecutorPlan(input: DeviceExecutorPlanInput): string {
  const plan = PlanSchema.safeParse({
    v: 1, appId: input.appId, flows: input.flows.map((flow) => ({ id: flow.id, steps: flow.steps.map((step) => ({ id: step.id, label: step.label, ...(step.actions === undefined ? {} : { actions: step.actions }) })) })),
    notShown: input.notShown, moreNotShown: input.moreNotShown, maskIds: input.maskIds, ...(input.fixtureDataOnly === true ? { fixtureDataOnly: true } : {}), runMs: input.runMs, stepMs: input.stepMs,
  });
  if (!plan.success) throw new Error("the device plan is not valid");
  const text = Buffer.from(JSON.stringify(plan.data), "utf8").toString("base64url");
  if (text.length > DEVICE_EXECUTOR_PLAN_MAX_CHARS) throw new Error("the device plan is not valid");
  return text;
}
/** The plan from its argument, or undefined when it is not exactly what `encodeDeviceExecutorPlan` writes. */
export function decodeDeviceExecutorPlan(argument: unknown): DeviceExecutorPlan | undefined {
  if (typeof argument !== "string" || argument.length === 0 || argument.length > DEVICE_EXECUTOR_PLAN_MAX_CHARS || !/^[A-Za-z0-9_-]+$/u.test(argument)) return undefined;
  try {
    const parsed = PlanSchema.safeParse(JSON.parse(Buffer.from(argument, "base64url").toString("utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch { return undefined; }
}

// ---- the container's arguments

/** The container's own sandbox and limits: every capability dropped, no new privileges, a read-only root, Docker's default seccomp and AppArmor profiles (never loosened), one device (`/dev/kvm`) and nothing else. */
function sandboxArgs(kvmGid: number | undefined): string[] {
  return ["--cap-drop=ALL", "--security-opt", "no-new-privileges", "--init", "--read-only", "--user", `${String(DEVICE_EXECUTOR_UID)}:${String(DEVICE_EXECUTOR_UID)}`,
    ...(kvmGid === undefined ? [] : ["--group-add", String(kvmGid)]), "--device", "/dev/kvm:/dev/kvm:rw",
    // /tmp holds the emulator's copy-on-write disk and the JVM's unpacked libraries (so it may run code); the home directory holds only keys and logs.
    "--tmpfs", "/tmp:rw,exec,nosuid,nodev,size=4g", "--tmpfs", `/home/android:rw,noexec,nosuid,nodev,size=256m,uid=${String(DEVICE_EXECUTOR_UID)},gid=${String(DEVICE_EXECUTOR_UID)},mode=0700`,
    "--shm-size", "1g", "--memory", "6g", "--memory-swap", "6g", "--pids-limit", "4096", "--cpus", "4"];
}

export type DeviceExecutorRunInput = Readonly<{
  image: string;
  /** The task sandbox's container name: the one thing this container shares. */
  sandbox: string;
  name: string;
  /** A directory on the Docker host with `before.apk` and `after.apk`, mounted read-only at `/apps`. */
  appsDir: string;
  /** The group of `/dev/kvm` when it is not world-readable (from `checkKvm`); never 0. */
  kvmGid?: number | undefined;
  /** The plan argument (`encodeDeviceExecutorPlan`). */
  plan: string;
}>;

function buildArgs(input: DeviceExecutorRunInput): string[] {
  return ["run", "--rm", "--pull=never", "--name", input.name, "--label", `${DEVICE_EXECUTOR_LABEL}=1`, "--network", `container:${input.sandbox}`, ...sandboxArgs(input.kvmGid),
    "-v", `${input.appsDir}:${DEVICE_EXECUTOR_APPS_DIR}:ro`, input.image, "node", DEVICE_EXECUTOR_ENTRY, input.plan];
}
function inputProblems(input: DeviceExecutorRunInput): string[] {
  const problems: string[] = [];
  if (typeof input.image !== "string" || !IMAGE_REFERENCE.test(input.image)) problems.push("image");
  if (typeof input.sandbox !== "string" || !CONTAINER_NAME.test(input.sandbox)) problems.push("sandbox");
  if (typeof input.name !== "string" || !CONTAINER_NAME.test(input.name) || input.name === input.sandbox) problems.push("name");
  if (typeof input.appsDir !== "string" || !APPS_HOST_DIR.test(input.appsDir) || input.appsDir.slice(1).split("/").some((part) => part === "" || part === "." || part === "..")) problems.push("apps directory");
  if (input.kvmGid !== undefined && (!Number.isInteger(input.kvmGid) || input.kvmGid < 1 || input.kvmGid > 65_535)) problems.push("kvm group");
  if (typeof input.plan !== "string" || input.plan.length === 0 || input.plan.length > DEVICE_EXECUTOR_PLAN_MAX_CHARS || !/^[A-Za-z0-9_-]+$/u.test(input.plan)) problems.push("plan");
  return problems;
}

/** The `docker run` arguments of the device executor. Pure, so a test reads every flag. The one thing shared with the sandbox is its network namespace. Throws on input it was not built for. */
export function deviceExecutorRunArgs(input: DeviceExecutorRunInput): string[] {
  if (inputProblems(input).length > 0) throw new Error("the device executor's arguments are not valid");
  return buildArgs(input);
}

/**
 * What is wrong with `args` as the device executor's arguments: empty when they are exactly what `deviceExecutorRunArgs` writes for some valid input. An exact match, not a deny list: another network, a
 * second device, a mount, an environment variable, a capability, `--privileged`, a loosened profile or a different command is a problem whatever it is.
 */
export function deviceExecutorArgProblems(args: readonly unknown[], expected: Partial<Pick<DeviceExecutorRunInput, "image" | "sandbox" | "name" | "appsDir" | "plan">> = {}): string[] {
  if (!Array.isArray(args) || !args.every((value) => typeof value === "string")) return ["not a list of words"];
  const list: string[] = args;
  const at = (flag: string) => list.indexOf(flag);
  const sandbox = /^container:(.+)$/u.exec(list[at("--network") + 1] ?? "")?.[1];
  const mount = /^(.+):\/apps:ro$/u.exec(list[at("-v") + 1] ?? "")?.[1];
  const groupAt = at("--group-add");
  const candidate: DeviceExecutorRunInput = {
    image: list.at(-4) ?? "", sandbox: sandbox ?? "", name: list[at("--name") + 1] ?? "", appsDir: mount ?? "", plan: list.at(-1) ?? "",
    ...(groupAt >= 0 ? { kvmGid: Number(list[groupAt + 1]) } : {}),
  };
  if (inputProblems(candidate).length > 0) return ["the parts are not valid"];
  // The parts the caller knows (the image it started, the sandbox it shares, its own container, its mount, its plan) must be those exactly.
  for (const key of ["image", "sandbox", "name", "appsDir", "plan"] as const) if (expected[key] !== undefined && expected[key] !== candidate[key]) return [`not the expected ${key}`];
  const rebuilt = buildArgs(candidate);
  return rebuilt.length === list.length && rebuilt.every((word, index) => word === list[index]) ? [] : ["not the device executor's arguments"];
}

// ---- the answer

const Base64Schema = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/u);
const WireShotSchema = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/u), jpegBase64: Base64Schema }).strict();
const WireSchema = z.object({
  v: z.literal(1),
  device: z.literal("android_emulator"),
  isolation: z.literal("sandbox"),
  durationMs: z.number().int().min(0).max(86_400_000),
  notShown: z.array(z.object({ flow: NameSchema, reason: z.enum(DEVICE_EVIDENCE_NOT_SHOWN_REASONS) }).strict()).max(DEVICE_EVIDENCE_NOT_SHOWN_MAX),
  moreNotShown: z.number().int().min(0).max(1_000_000),
  unmasked: z.number().int().min(0).max(1_000_000),
  notRun: z.enum(DEVICE_EVIDENCE_NOT_RUN_REASONS).optional(),
  steps: z.array(z.discriminatedUnion("status", [
    z.object({ flow: NameSchema, step: NameSchema, status: z.literal("shown"), before: WireShotSchema, after: WireShotSchema }).strict(),
    z.object({ flow: NameSchema, step: NameSchema, status: z.literal("not_run"), reason: z.enum(DEVICE_EVIDENCE_NOT_RUN_REASONS) }).strict(),
  ])).max(DEVICE_EVIDENCE_FLOWS_MAX * DEVICE_EVIDENCE_STEPS_MAX),
}).strict();

/** The runner's result as the one line the program prints. */
export function encodeDeviceExecutorOutput(captured: DeviceEvidenceCaptured): string {
  const shot = (value: { sha256: string; bytes: Uint8Array }) => ({ sha256: value.sha256, jpegBase64: Buffer.from(value.bytes).toString("base64") });
  return JSON.stringify({
    v: 1, device: captured.device, isolation: captured.isolation, durationMs: captured.durationMs, notShown: captured.notShown, moreNotShown: captured.moreNotShown, unmasked: captured.unmasked,
    ...(captured.notRun === undefined ? {} : { notRun: captured.notRun }),
    steps: captured.steps.map((row) => (row.status === "shown" ? { flow: row.flow, step: row.step, status: "shown", before: shot(row.before), after: shot(row.after) } : row)),
  });
}

const isJpeg = (bytes: Uint8Array) => bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
/**
 * The program's output as the runner's result, or undefined when it is not exactly an honest answer to `plan`: one line within the byte bound, in the schema, from an Android emulator in the sandbox,
 * with exactly the plan's steps in the plan's order (a run that did not happen has none), the plan's own notes, no unmasked screen unless the plan allows it, every picture a JPEG within the cap
 * whose digest is the one it names, and the run's own caps (`checkedDeviceEvidenceCaptured`). Never throws, never keeps any of the program's own words.
 */
export function parseDeviceExecutorOutput(stdout: Uint8Array, plan: DeviceExecutorPlan): DeviceEvidenceCaptured | undefined {
  if (!(stdout instanceof Uint8Array) || stdout.byteLength === 0 || stdout.byteLength > DEVICE_EXECUTOR_OUTPUT_MAX_BYTES) return undefined;
  try {
    const text = Buffer.from(stdout).toString("utf8").replace(/\n$/u, "");
    if (text.includes("\n")) return undefined;
    const wire = WireSchema.safeParse(JSON.parse(text));
    if (!wire.success) return undefined;
    const row = wire.data;
    if (row.durationMs > plan.runMs + DEVICE_EXECUTOR_MARGIN_MS) return undefined;
    if (JSON.stringify(row.notShown) !== JSON.stringify(plan.notShown) || row.moreNotShown !== plan.moreNotShown) return undefined;
    const wanted = plan.flows.flatMap((flow) => flow.steps.map((step) => `${flow.id}/${step.id}`));
    const got = row.steps.map((step) => `${step.flow}/${step.step}`);
    if (row.notRun !== undefined ? got.length !== 0 : JSON.stringify(got) !== JSON.stringify(wanted)) return undefined;
    const shown = row.steps.filter((step) => step.status === "shown").length;
    // Only the admin's own choice shows a screen unmasked; a program that says otherwise is not believed.
    if (row.unmasked > shown || (plan.fixtureDataOnly !== true && row.unmasked > 0)) return undefined;
    const keep = (value: { sha256: string; jpegBase64: string }) => {
      const bytes = new Uint8Array(Buffer.from(value.jpegBase64, "base64"));
      if (Buffer.from(bytes).toString("base64") !== value.jpegBase64 || !isJpeg(bytes) || bytes.byteLength > DEVICE_EVIDENCE_SCREENSHOT_MAX_BYTES || createHash("sha256").update(bytes).digest("hex") !== value.sha256) throw new Error("picture");
      return { sha256: value.sha256, bytes };
    };
    return checkedDeviceEvidenceCaptured({
      device: row.device, isolation: row.isolation, durationMs: row.durationMs, notShown: row.notShown, moreNotShown: row.moreNotShown, unmasked: row.unmasked, ...(row.notRun === undefined ? {} : { notRun: row.notRun }),
      steps: row.steps.map((step) => (step.status === "shown" ? { flow: step.flow, step: step.step, status: "shown" as const, before: keep(step.before), after: keep(step.after) } : step)),
    });
  } catch { return undefined; }
}

// ---- running it

export type DeviceExecutorOutcome = Readonly<{ captured: DeviceEvidenceCaptured | undefined; timedOut: boolean }>;
/**
 * Starts the container through `port` (the `docker` program), waits for its line within `plan.runMs` plus the margin, believes it only through `parseDeviceExecutorOutput`, and always removes the
 * container afterwards (the docker client being killed does not stop it). Refuses arguments that are not exactly the device executor's. Never throws on what the container does.
 */
export async function runDeviceExecutor(port: DeviceCommandPort, input: DeviceExecutorRunInput & { plan: string }, env: Readonly<Record<string, string>>): Promise<DeviceExecutorOutcome> {
  const args = deviceExecutorRunArgs(input);
  const plan = decodeDeviceExecutorPlan(input.plan);
  if (plan === undefined || deviceExecutorArgProblems(args, input).length > 0) throw new Error("the device executor's arguments are not valid");
  let result: DeviceCommandResult | undefined;
  try {
    result = await port.run("docker", args, { timeoutMs: plan.runMs + DEVICE_EXECUTOR_MARGIN_MS, maxStdoutBytes: DEVICE_EXECUTOR_OUTPUT_MAX_BYTES, env });
  } catch { result = undefined; }
  await port.run("docker", ["rm", "--force", input.name], { timeoutMs: 20_000, maxStdoutBytes: 4_096, env }).catch(() => undefined);
  if (result === undefined) return { captured: undefined, timedOut: false };
  const ok = result.exitCode === 0 && !result.timedOut && !result.tooLarge;
  return { captured: ok ? parseDeviceExecutorOutput(result.stdout, plan) : undefined, timedOut: result.timedOut };
}

// ---- KVM

export type KvmProbe = Readonly<{
  platform: string;
  arch: string;
  /** The device file's kind, group and permission bits, or undefined when it is not there. */
  stat(path: string): { isCharacterDevice: boolean; gid: number; mode: number } | undefined;
  /** Whether this process may open the path for reading and writing. */
  canReadWrite(path: string): boolean;
}>;
export type KvmStatus = { ok: true; gid: number | undefined } | { ok: false; reason: string };
/**
 * Whether this machine can give the emulator KVM: Linux on x86-64 (the emulator image is x86-64 only), a `/dev/kvm` that is a device this process can open for reading and writing. `gid` is the device's
 * group when it is not open to everyone (the container is given it with `--group-add`). The reasons are fixed words for a test's "skipped" line.
 */
export function checkKvm(probe: KvmProbe): KvmStatus {
  if (probe.platform !== "linux") return { ok: false, reason: "this machine is not Linux, so there is no KVM" };
  if (probe.arch !== "x64") return { ok: false, reason: "this machine is not x86-64, and the Android emulator image is x86-64 only" };
  const device = probe.stat("/dev/kvm");
  if (device === undefined) return { ok: false, reason: "/dev/kvm is not there (this runner has no KVM)" };
  if (!device.isCharacterDevice) return { ok: false, reason: "/dev/kvm is not a device" };
  if (!probe.canReadWrite("/dev/kvm")) return { ok: false, reason: "/dev/kvm cannot be opened for reading and writing by this user" };
  if ((device.mode & 0o006) === 0o006) return { ok: true, gid: undefined };
  if (!Number.isInteger(device.gid) || device.gid < 1) return { ok: false, reason: "/dev/kvm is open to no group the container could join" };
  return { ok: true, gid: device.gid };
}
