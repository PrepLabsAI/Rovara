// AUTOREQUALIFY (AR-2): the renewal's step machine run end to end against an in-memory account. The authority module (AR-1) is replaced by a small fake that keeps
// its contract (lock held, rows +1, pointer moved, previous runner returned); everything else, including the machine definition, is the real code.
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { REQUALIFY_REASON_CODES, REQUALIFY_STEP_REASON_CODES, e2eQualificationPrefix, requalifyRunKey } from "../../packages/contracts/src/index.js";
import { requalifyDefinition } from "../../infra/lib/runtime-requalify.js";
import { runRequalifyAction, type RequalifyStepsDependencies } from "../../packages/broker/src/aws/runtime-requalify-steps.js";
import { ENV, EXECUTOR_IMAGE, FakeCloud, ROLE_ID, SECRET, WORKER_IMAGE, runMachine, type MachineRun } from "../support/requalify-fake-cloud.js";

const holder = vi.hoisted(() => ({ cloud: undefined as unknown as FakeCloud }));
vi.mock("../../packages/broker/src/aws/runtime-requalify.js", async () => {
  const { randomUUID: uuid } = await import("node:crypto");
  const contracts = await import("../../packages/contracts/src/index.js");
  const readiness = await import("../../packages/broker/src/aws/e2e-runtime-readiness.js");
  const generationOf = (cloud: FakeCloud) => Math.max(0, ...(["web", "api"] as const).map((kind) => Number(cloud.row(kind)?.["generation"] ?? 0)));
  const heldBy = (cloud: FakeCloud, runId: string) => { if (cloud.lock()?.["runId"] !== runId) throw new Error("requalify-refused:lock-not-held"); };
  return {
    async issueRequalifyChallenge(_deps: unknown, input: { runId: string; instanceId: string; roleId: string }) {
      const cloud = holder.cloud;
      heldBy(cloud, input.runId);
      if (cloud.instances.get(input.instanceId)?.tags["agentx:qualification-run"] !== input.runId) throw new Error("requalify-refused:endpoint-not-managed-instance");
      // The secret reaches the runner's prefix and nothing else.
      await cloud.s3Client.send(new PutObjectCommand({ Bucket: "artifacts", Key: `${contracts.e2eQualificationPrefix(input.roleId, input.instanceId)}challenge.json`, Body: Buffer.from(JSON.stringify({ secret: SECRET })) }));
      return { challengeId: uuid(), expiresAt: new Date(cloud.clock + 60 * 60_000).toISOString(), generation: generationOf(cloud) + 1, transportCorrelationId: uuid() };
    },
    async registerRequalifiedRuntime(_deps: unknown, input: { runId: string; instanceId: string; roleId: string; amiId: string | null; images: unknown }) {
      const cloud = holder.cloud;
      heldBy(cloud, input.runId);
      if (cloud.failRegister) throw new Error("requalify-refused:runner-changed");
      const before = cloud.pointer();
      const previousRunner = before === undefined ? null : { instanceId: before["instanceId"] as string, roleId: before["roleId"] as string, transportCorrelationId: before["transportCorrelationId"] as string };
      const generation = generationOf(cloud) + 1;
      for (const kind of ["web", "api"] as const) {
        cloud.ddb.set(cloud.key(readiness.e2eRegisteredRuntimeKey("feature-catalog-1", contracts.REQUALIFY_PROFILE_ID, kind)), { generation, catalogRevision: generation, expiresAt: new Date(cloud.clock + 7 * 24 * 3_600_000).toISOString() });
      }
      cloud.ddb.set(cloud.key(contracts.requalifyRunKey(input.runId)), { runId: input.runId, generation, previousRunner, images: input.images, amiId: input.amiId });
      cloud.ddb.set(cloud.key(cloud.pointerKey()), { instanceId: input.instanceId, roleId: input.roleId, transportCorrelationId: uuid(), requalifyRunId: input.runId });
      return { registration: {}, generation, previousRunner, record: {} };
    },
  };
});

const definition = requalifyDefinition("arn:aws:lambda:us-east-1:111122223333:function:steps");
const FIXED_REASONS = new Set<string>([...REQUALIFY_REASON_CODES, ...REQUALIFY_STEP_REASON_CODES]);
const HOUR = 3_600_000;

let cloud: FakeCloud;
let deps: RequalifyStepsDependencies;
beforeEach(() => {
  cloud = new FakeCloud();
  holder.cloud = cloud;
  deps = cloud.deps();
});

type Hooks = { failAction?: string; after?: (action: string) => void };
async function renew(runId = randomUUID(), hooks: Hooks = {}): Promise<{ run: MachineRun; runId: string }> {
  const run = await runMachine(definition, { runId }, cloud, async (payload) => {
    if (payload.action === hooks.failAction) throw new Error("injected fault");
    const result = await runRequalifyAction(deps, payload);
    hooks.after?.(payload.action);
    return result;
  });
  return { run, runId };
}

/** An installation as the owner left it: an old runner (tagged once by hand) that rows and the pointer name. */
function oldInstallation(options: { managed?: boolean; environment?: string; expiresInMs?: number } = {}) {
  const old = cloud.addRunner({ ...(options.managed === undefined ? {} : { managed: options.managed }), ...(options.environment === undefined ? {} : { environment: options.environment }) });
  // Rows 30 hours from expiry by default: close enough that a drain timeout is worth an alert.
  cloud.seedRegistered({ generation: 1, pointerInstance: old.id, expiresInMs: options.expiresInMs ?? 30 * HOUR });
  return old;
}

const alert = () => cloud.sns.map((message) => ({ subject: message.subject, reason: /^reason: ([a-z-]+)/m.exec(message.message)?.[1], text: message.message }));
const survivingRunnerVolumes = (runId: string) => [...cloud.volumes.values()].filter((volume) => volume.tags["agentx:qualification-run"] === runId);

describe("a successful renewal", () => {
  it("launches a pinned, tagged runner, switches the rows and the pointer to it, and retires only the old runner and its volume", async () => {
    const old = oldInstallation();
    const oldVolume = old.volumes[1]!;
    const { run, runId } = await renew();
    expect(run.status).toBe("Succeeded");
    expect(run.trace.at(-1)).toBe("Done");
    const [fresh, ...extra] = cloud.launches;
    expect(extra).toEqual([]);
    expect(cloud.row("web")?.["generation"]).toBe(2);
    expect(cloud.row("api")?.["generation"]).toBe(2);
    expect(cloud.pointer()?.["instanceId"]).toBe(fresh);
    expect(cloud.instances.get(fresh!)?.state).toBe("running");
    expect(cloud.instances.get(fresh!)?.tags).toMatchObject({ DeploymentMode: "e2e-qualification", Environment: ENV, "agentx:requalify-managed": "true", "agentx:qualification-run": runId });
    // Only the old runner was ended, and its workspace volume deleted; the new volume (tagged for this run) is attached and still there.
    expect(cloud.terminated).toEqual([old.id]);
    expect(cloud.instances.get(old.id)?.state).toBe("terminated");
    expect(cloud.deleted).toEqual([oldVolume]);
    expect(survivingRunnerVolumes(runId)).toHaveLength(1);
    // The pin task workers boot from (AR-4 reads exactly this name): the AMI the new runner was launched with, in the shape AR-4 accepts.
    const pin = cloud.ssm.get(`/agentx/${ENV}/worker-qualified-ami`);
    expect(pin).toBe(cloud.instances.get(fresh!)?.imageId);
    expect(pin).toMatch(/^ami-[0-9a-f]{8,17}$/);
    expect(cloud.metrics).toEqual(["RequalifySucceeded"]);
    expect(cloud.sns).toEqual([]);
    expect(cloud.lock()).toBeUndefined();
    expect(cloud.hold()).toBeUndefined();
    // The hold covered the switch only: it was put before and gone after.
    expect(run.trace.indexOf("PutHold")).toBeLessThan(run.trace.indexOf("Switch"));
    expect(cloud.ddb.get(cloud.key(requalifyRunKey(runId)))).toMatchObject({ amiId: "ami-0abcdef1234567890" });
  });

  it("keeps the challenge secret out of every step input, output and alert, and out of the bucket once the switch is done (positive control: the secret was written)", async () => {
    oldInstallation();
    const { run } = await renew();
    expect(cloud.secretWrites).toBe(1);
    expect(JSON.stringify([run.payloads, run.results, run.state, run.trace, cloud.sns])).not.toContain(SECRET);
    expect([...cloud.s3.values()].some((bytes) => bytes.includes(SECRET))).toBe(false);
  });

  it("does not write the pin when the renewal fails before the switch, so task workers keep the AMI they have", async () => {
    oldInstallation();
    cloud.ssm.set(`/agentx/${ENV}/worker-qualified-ami`, "ami-0123456789abcdef0");
    await renew(randomUUID(), { failAction: "awaitQualification" });
    expect(cloud.ssm.get(`/agentx/${ENV}/worker-qualified-ami`)).toBe("ami-0123456789abcdef0");
  });

  it("launches the first runner when nothing is registered yet (no old runner to retire)", async () => {
    const { run } = await renew();
    expect(run.status).toBe("Succeeded");
    expect(cloud.row("web")?.["generation"]).toBe(1);
    expect(cloud.terminated).toEqual([]);
  });
});

describe("single flight and the cost guard", () => {
  it("does nothing when another run holds the lock, and does not take or release its lock", async () => {
    oldInstallation();
    cloud.ddb.set("RUNTIME_REQUALIFY#linux-arm64-web-api-v1|LOCK", { entityType: "RUNTIME_REQUALIFY_LOCK", runId: randomUUID(), acquiredAt: new Date(cloud.clock).toISOString(), expiresAt: new Date(cloud.clock + HOUR).toISOString() });
    const other = cloud.lock()?.["runId"];
    const { run } = await renew();
    expect(run.trace).toEqual(["Lock", "LockChoice", "NotAcquired"]);
    expect(cloud.launches).toEqual([]);
    expect(cloud.lock()?.["runId"]).toBe(other);
  });

  it("takes over a lock whose time is up", async () => {
    oldInstallation();
    cloud.ddb.set("RUNTIME_REQUALIFY#linux-arm64-web-api-v1|LOCK", { entityType: "RUNTIME_REQUALIFY_LOCK", runId: randomUUID(), acquiredAt: new Date(cloud.clock - 5 * HOUR).toISOString(), expiresAt: new Date(cloud.clock - HOUR).toISOString() });
    const { run } = await renew();
    expect(run.trace.at(-1)).toBe("Done");
  });

  it("refuses to launch a third runner: two live runners of this environment alarm and nothing is created or ended", async () => {
    const old = oldInstallation();
    const stray = cloud.addRunner();
    const { run, runId } = await renew();
    expect(run.trace).toContain("ReasonCostGuard");
    expect(cloud.launches).toEqual([]);
    expect(cloud.volumes.size).toBe(4);
    expect(cloud.terminated).toEqual([]);
    expect([old.id, stray.id].map((id) => cloud.instances.get(id)?.state)).toEqual(["running", "running"]);
    expect(alert().map((entry) => entry.reason)).toEqual(["cost-guard"]);
    expect(cloud.lock()).toBeUndefined();
    expect(runId).toBeDefined();
  });

  it("counts only this environment's live qualification runners: another environment's runner and a terminated one do not trip the guard", async () => {
    oldInstallation();
    cloud.addRunner({ environment: "someotherenv" });
    cloud.addRunner({ state: "terminated" });
    const { run } = await renew();
    expect(run.trace.at(-1)).toBe("Done");
    expect(cloud.sns).toEqual([]);
  });
});

describe("a failure before the switch", () => {
  const cases: Array<[string, string]> = [
    ["pinAmi", "launch-failed"], ["createVolume", "launch-failed"], ["awaitVolume", "launch-failed"], ["runInstance", "launch-failed"], ["attachVolume", "launch-failed"],
    ["awaitReady", "not-ready"], ["issueChallenge", "qualification-failed"], ["awaitQualification", "qualification-failed"], ["putHold", "drain-timeout"],
    ["awaitDrain", "drain-timeout"], ["switch", "unexpected-error"],
  ];
  it.each(cases)("at %s leaves the rows, the pointer and the old runner alone, ends only what this run launched, alerts once with a fixed code (%s) and frees the lock", async (action, reason) => {
    const old = oldInstallation();
    const oldVolume = old.volumes[1]!;
    const before = JSON.stringify([cloud.row("web"), cloud.row("api"), cloud.pointer()]);
    const { run, runId } = await renew(randomUUID(), { failAction: action });
    expect(run.status).toBe("Succeeded");
    expect(JSON.stringify([cloud.row("web"), cloud.row("api"), cloud.pointer()])).toBe(before);
    expect(cloud.instances.get(old.id)?.state).toBe("running");
    expect(cloud.volumes.get(oldVolume)?.state).toBe("in-use");
    // Whatever was ended carries this run's tag; and nothing of this run is left billing.
    expect(cloud.terminated.every((id) => cloud.launches.includes(id))).toBe(true);
    expect([...cloud.instances.values()].filter((instance) => instance.tags["agentx:qualification-run"] === runId && instance.state !== "terminated")).toEqual([]);
    expect(survivingRunnerVolumes(runId)).toEqual([]);
    const sent = alert();
    expect(sent.map((entry) => entry.reason)).toEqual([reason]);
    expect(FIXED_REASONS.has(sent[0]!.reason!)).toBe(true);
    expect(sent[0]!.text).toContain("The old runner and the registered rows were left as they were.");
    expect(cloud.metrics).toEqual(["RequalifyFailed"]);
    expect(cloud.lock()).toBeUndefined();
    expect(cloud.hold()).toBeUndefined();
    expect(cloud.s3.has(`${e2eQualificationPrefix(ROLE_ID, cloud.launches[0] ?? "i-00000000000000000")}challenge.json`)).toBe(false);
  });

  it("ends the new runner even when the alert itself cannot be sent", async () => {
    oldInstallation();
    const { run, runId } = await renew(randomUUID(), { failAction: "awaitReady" });
    expect(run.status).toBe("Succeeded");
    const again = new FakeCloud();
    holder.cloud = again;
    deps = again.deps();
    const old = again.addRunner();
    again.seedRegistered({ pointerInstance: old.id });
    again.sns_.send = async () => { throw new Error("sns down"); };
    const second = await runMachine(definition, { runId: randomUUID() }, again, async (payload) => {
      if (payload.action === "awaitReady") throw new Error("injected fault");
      return runRequalifyAction(deps, payload);
    });
    expect(second.status).toBe("Succeeded");
    expect(again.launches.every((id) => again.instances.get(id)?.state === "terminated")).toBe(true);
    expect(again.lock()).toBeUndefined();
    expect(runId).toBeDefined();
  });

  it("when the runner never becomes ready, ends it and says not-ready", async () => {
    oldInstallation();
    cloud.runner.ready = false;
    const { run } = await renew();
    expect(run.trace).toContain("ReasonNotReady");
    expect(alert().map((entry) => entry.reason)).toEqual(["not-ready"]);
    expect(cloud.launches.map((id) => cloud.instances.get(id)?.state)).toEqual(["terminated"]);
  });

  it("when qualification fails, reports the runner's failure codes (filtered to the hook's grammar) and registers nothing", async () => {
    oldInstallation();
    cloud.runner.qualify = "FAILED";
    cloud.runner.failure = ["qualification-rejected", "probe-wrong-cause:api-egress-denial-v1", "Free text from the runner!", `${"x".repeat(120)}`];
    const { run } = await renew();
    expect(run.trace).toContain("ReasonQualificationFailed");
    const [sent] = alert();
    expect(sent?.reason).toBe("qualification-failed");
    expect(sent?.text).toContain("(qualification-rejected,probe-wrong-cause:api-egress-denial-v1)");
    expect(sent?.text).not.toContain("Free text");
    expect(cloud.row("web")?.["generation"]).toBe(1);
  });

  it("gives up on a drain that never finishes: no switch, the old runner serves, and the alert waits for the rows to be under 48 hours from expiry", async () => {
    const old = oldInstallation({ expiresInMs: 5 * 24 * HOUR });
    cloud.activeWork = 2;
    const { run } = await renew();
    expect(run.trace).toContain("ReasonDrainTimeout");
    expect(cloud.row("web")?.["generation"]).toBe(1);
    expect(cloud.instances.get(old.id)?.state).toBe("running");
    expect(cloud.sns).toEqual([]);
    expect(cloud.hold()).toBeUndefined();
    expect(cloud.launches.map((id) => cloud.instances.get(id)?.state)).toEqual(["terminated"]);

    const close = new FakeCloud();
    holder.cloud = close;
    deps = close.deps();
    const oldClose = close.addRunner();
    close.seedRegistered({ pointerInstance: oldClose.id, expiresInMs: 30 * HOUR });
    close.activeWork = "unknown";
    await runMachine(definition, { runId: randomUUID() }, close, (payload) => runRequalifyAction(deps, payload));
    expect(close.sns.map((message) => /^reason: ([a-z-]+)/m.exec(message.message)?.[1])).toEqual(["drain-timeout"]);
  });

  it("abandons without a switch when the worker settings changed during the run", async () => {
    const old = oldInstallation();
    const { run } = await renew(randomUUID(), { after: (action) => { if (action === "putHold") cloud.ssm.set(`/agentx/${ENV}/worker-image`, `111122223333.dkr.ecr.us-east-1.amazonaws.com/agentx-test/worker@sha256:${"c".repeat(64)}`); } });
    expect(run.trace).toContain("ReasonSettingsChanged");
    expect(alert().map((entry) => entry.reason)).toEqual(["settings-changed"]);
    expect(cloud.row("web")?.["generation"]).toBe(1);
    expect(cloud.pointer()?.["instanceId"]).toBe(old.id);
    expect(cloud.hold()).toBeUndefined();
    expect(cloud.launches.map((id) => cloud.instances.get(id)?.state)).toEqual(["terminated"]);
  });

  it("abandons when settings change between preflight and launch, before anything is launched", async () => {
    oldInstallation();
    const { run } = await renew(randomUUID(), { after: (action) => { if (action === "preflight") cloud.ssm.set(`/agentx/${ENV}/worker-model-id`, "model-2"); } });
    expect(run.trace).toContain("ReasonLaunchFailed");
    expect(cloud.launches).toEqual([]);
  });

  it("when RunInstances fails after creating an instance, finds it by the run's tag and ends it with its volume", async () => {
    oldInstallation();
    const original = cloud.ec2.send;
    cloud.ec2.send = async (command) => {
      const result: unknown = await original(command);
      if (command.constructor.name === "RunInstancesCommand") throw new Error("connection reset after create");
      return result;
    };
    const { run, runId } = await renew();
    expect(run.status).toBe("Succeeded");
    expect(cloud.launches).toHaveLength(1);
    expect(cloud.instances.get(cloud.launches[0]!)?.state).toBe("terminated");
    expect(survivingRunnerVolumes(runId)).toEqual([]);
  });
});

describe("a switch that committed but whose step then failed (review M-2)", () => {
  /** Runs the real action, then loses the answer: the transaction committed and the machine saw an error. */
  async function renewLosingTheSwitchAnswer(extra: (action: string) => void = () => undefined) {
    const runId = randomUUID();
    const run = await runMachine(definition, { runId }, cloud, async (payload) => {
      extra(payload.action);
      const result = await runRequalifyAction(deps, payload);
      if (payload.action === "switch") throw new Error("Task timed out after 300.00 seconds");
      return result;
    });
    return { run, runId };
  }

  it("finishes the retirement from the run record instead of stranding the old runner, and sends no alert", async () => {
    const old = oldInstallation();
    const { run } = await renewLosingTheSwitchAnswer();
    expect(run.trace).toContain("RecoverSwitch");
    expect(run.trace.at(-1)).toBe("Done");
    expect(cloud.terminated).toEqual([old.id]);
    expect(cloud.instances.get(old.id)?.state).toBe("terminated");
    expect(cloud.pointer()?.["instanceId"]).toBe(cloud.launches[0]);
    expect(cloud.ssm.get(`/agentx/${ENV}/worker-qualified-ami`)).toBe("ami-0abcdef1234567890");
    expect(cloud.sns).toEqual([]);
    expect(cloud.hold()).toBeUndefined();
    expect(cloud.lock()).toBeUndefined();
  });

  it("when the recovery fails too, says the switch happened and names the old runner to retire, and keeps the new runner", async () => {
    const old = oldInstallation();
    const { run } = await renewLosingTheSwitchAnswer();
    expect(run.status).toBe("Succeeded");
    // Second run: lose the answer and the recovery.
    const again = new FakeCloud();
    holder.cloud = again;
    deps = again.deps();
    cloud = again;
    const oldAgain = oldInstallation();
    const second = await runMachine(definition, { runId: randomUUID() }, again, async (payload) => {
      if (payload.action === "recoverSwitch") throw new Error("down");
      const result = await runRequalifyAction(deps, payload);
      if (payload.action === "switch") throw new Error("Task timed out after 300.00 seconds");
      return result;
    });
    expect(second.status).toBe("Succeeded");
    expect(again.terminated).toEqual([]);
    expect(again.instances.get(again.launches[0]!)?.state).toBe("running");
    const [sent] = alert();
    expect(sent?.text).toContain("The new runner is serving");
    expect(sent?.text).toContain(`previous runner: ${oldAgain.id}`);
    expect(sent?.text).not.toContain("left as they were");
    expect(old.id).toBeDefined();
  });

  it("recovers nothing when the switch did not commit: the failure path runs as before", async () => {
    const old = oldInstallation();
    cloud.failRegister = true;
    const { run } = await renew();
    expect(run.trace).toContain("RecoverSwitch");
    expect(run.trace).toContain("ReasonUnexpected");
    expect(cloud.instances.get(old.id)?.state).toBe("running");
    expect(alert()[0]?.text).toContain("left as they were");
  });
});

describe("a malformed proposal (review M-1)", () => {
  it("never puts any part of the proposal, which holds the challenge secret, into the machine's error or later inputs", async () => {
    oldInstallation();
    delete (deps as { parseProposal?: unknown }).parseProposal;
    cloud.runner.proposal = Buffer.from(`{"challenge":{"challengeSecret":${SECRET.slice(0, 18)}`);
    const { run } = await renew();
    expect(run.trace).toContain("Switch");
    expect(run.trace).toContain("ReasonUnexpected");
    expect(JSON.stringify([run.state, run.payloads, run.results, cloud.sns])).not.toContain(SECRET.slice(0, 12));
    expect(JSON.stringify(run.state["error"])).toContain("the proposal is not valid JSON");
  });

  it("does the same for a proposal that parses but is not a READY qualification", async () => {
    oldInstallation();
    delete (deps as { parseProposal?: unknown }).parseProposal;
    cloud.runner.proposal = Buffer.from(JSON.stringify({ challenge: { challengeSecret: SECRET } }));
    const { run } = await renew();
    expect(JSON.stringify([run.state, run.payloads, run.results, cloud.sns])).not.toContain(SECRET);
    expect(JSON.stringify(run.state["error"])).toContain("the proposal is not a READY web/API qualification");
  });
});

describe("retiring the old runner", () => {
  it.each([
    ["an old runner nobody tagged", { managed: false }],
    ["an old runner of another environment", { environment: "someotherenv" }],
  ])("refuses %s: it keeps running, the new runner keeps serving and is not ended, and the owner is alerted", async (_label, options) => {
    const old = oldInstallation(options);
    const { run } = await renew();
    expect(run.trace).toContain("ReasonRetireFailed");
    expect(cloud.terminated).toEqual([]);
    expect(cloud.instances.get(old.id)?.state).toBe("running");
    expect(cloud.row("web")?.["generation"]).toBe(2);
    expect(cloud.pointer()?.["instanceId"]).toBe(cloud.launches[0]);
    expect(cloud.instances.get(cloud.launches[0]!)?.state).toBe("running");
    const [sent] = alert();
    expect(sent?.reason).toBe("retire-failed");
    expect(sent?.text).toContain("The new runner is serving");
    expect(cloud.lock()).toBeUndefined();
  });

  it("never ends the runner the pointer names, even if a failed run's state does not say the switch committed", async () => {
    const serving = cloud.addRunner({ runId: "00000000-0000-4000-8000-000000000001" });
    cloud.seedRegistered({ pointerInstance: serving.id });
    const state = { runId: "00000000-0000-4000-8000-000000000001", preflight: { settingsDigest: "a".repeat(64), workerRoleId: ROLE_ID }, instance: { instanceId: serving.id, attachDeadlineAt: new Date(cloud.clock).toISOString(), readyDeadlineAt: new Date(cloud.clock).toISOString() } };
    const out = await runRequalifyAction(deps, { action: "terminateNew", state }) as { newTermination?: unknown };
    expect(out.newTermination).toBeUndefined();
    expect(cloud.terminated).toEqual([]);
  });

  it("does not end the new runner after a switch that committed", async () => {
    const fresh = cloud.addRunner({ runId: "00000000-0000-4000-8000-000000000002" });
    const state = { runId: "00000000-0000-4000-8000-000000000002", preflight: { settingsDigest: "a".repeat(64), workerRoleId: ROLE_ID }, switch: { switched: true, generation: 2, previous: null },
      instance: { instanceId: fresh.id, attachDeadlineAt: new Date(cloud.clock).toISOString(), readyDeadlineAt: new Date(cloud.clock).toISOString() } };
    const out = await runRequalifyAction(deps, { action: "terminateNew", state }) as { newTermination?: unknown };
    expect(out.newTermination).toBeUndefined();
    expect(cloud.terminated).toEqual([]);
  });

  it("refuses to end a runner that carries another run's tag when cleaning up a failed run", async () => {
    const foreign = cloud.addRunner({ runId: "00000000-0000-4000-8000-0000000000aa" });
    const state = { runId: "00000000-0000-4000-8000-0000000000bb", preflight: { settingsDigest: "a".repeat(64), workerRoleId: ROLE_ID }, instance: { instanceId: foreign.id, attachDeadlineAt: new Date(cloud.clock).toISOString(), readyDeadlineAt: new Date(cloud.clock).toISOString() } };
    await expect(runRequalifyAction(deps, { action: "terminateNew", state })).rejects.toThrow("not ended automatically");
    expect(cloud.terminated).toEqual([]);
  });

  it("refuses to retire the new runner as the previous one", async () => {
    const fresh = cloud.addRunner();
    const state = { runId: randomUUID(), preflight: { settingsDigest: "a".repeat(64), workerRoleId: ROLE_ID }, instance: { instanceId: fresh.id, attachDeadlineAt: new Date(cloud.clock).toISOString(), readyDeadlineAt: new Date(cloud.clock).toISOString() },
      switch: { switched: true, generation: 2, previous: { instanceId: fresh.id, roleId: ROLE_ID } } };
    await expect(runRequalifyAction(deps, { action: "terminatePrevious", state })).rejects.toThrow("is the new one");
    expect(cloud.terminated).toEqual([]);
  });

  it("deletes a retired runner's volume only if the volume carries the renewal's tags", async () => {
    const old = cloud.addRunner({ state: "terminated" });
    const volume = cloud.volumes.get(old.volumes[1]!)!;
    volume.state = "available";
    volume.tags = { DeploymentMode: "e2e-qualification", Environment: ENV };
    const termination = { instanceId: old.id, roleId: ROLE_ID, volumeIds: [volume.id], deadlineAt: new Date(cloud.clock + HOUR).toISOString() };
    const out = await runRequalifyAction(deps, { action: "awaitTerminatedPrevious", state: { runId: randomUUID(), previousTermination: termination } }) as { previousTermination: { status: string } };
    expect(out.previousTermination.status).toBe("failed");
    expect(cloud.deleted).toEqual([]);
    expect(cloud.volumes.has(volume.id)).toBe(true);
  });
});

describe("the daily check", () => {
  const due = (force = false) => runRequalifyAction(deps, { action: "due", ...(force ? { force: true } : {}) }) as Promise<{ started: boolean; reason: string }>;

  it("starts nothing while the rows are more than 72 hours from expiry and the images are the last renewal's", async () => {
    oldInstallation({ expiresInMs: 5 * 24 * HOUR });
    expect(await due()).toEqual({ started: false, reason: "not-due" });
    expect(cloud.executions).toEqual([]);
  });

  it("starts one named execution when a row is within 72 hours, and a second check in the same hour does not start another", async () => {
    oldInstallation({ expiresInMs: 71 * HOUR });
    expect(await due()).toEqual({ started: true, reason: "expiring" });
    expect(cloud.executions).toEqual([`requalify-${ENV}-2026102706`]);
    expect(await due()).toEqual({ started: false, reason: "already-started" });
  });

  it("starts when the deployed images differ from the ones the last renewal qualified", async () => {
    const old = cloud.addRunner();
    const lastRun = randomUUID();
    cloud.seedRegistered({ pointerInstance: old.id, runId: lastRun, expiresInMs: 6 * 24 * HOUR });
    cloud.ddb.set(cloud.key(requalifyRunKey(lastRun)), { images: { worker: WORKER_IMAGE, executor: EXECUTOR_IMAGE } });
    expect(await due()).toEqual({ started: false, reason: "not-due" });
    cloud.ssm.set(`/agentx/${ENV}/worker-executor-image`, `111122223333.dkr.ecr.us-east-1.amazonaws.com/agentx-test/executor@sha256:${"d".repeat(64)}`);
    expect(await due()).toEqual({ started: true, reason: "images-changed" });
  });

  it("starts when the operator forces it, and not for a runner the script recorded (no run record) with fresh rows", async () => {
    oldInstallation({ expiresInMs: 6 * 24 * HOUR });
    expect(await due()).toEqual({ started: false, reason: "not-due" });
    expect(await due(true)).toEqual({ started: true, reason: "requested" });
  });
});
