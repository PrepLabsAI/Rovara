import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { DescribeInstancesCommand } from "@aws-sdk/client-ec2";
import { RequalifyRunRecordSchema, REQUALIFY_REFUSAL_PREFIX, REQUALIFY_TAGS, requalifyLockKey, requalifyRunKey, webApiRuntimeInstallProposalSha256, type RuntimeInstallChallenge } from "../../packages/contracts/src/index.js";
import { e2eRegisteredRuntimeKey } from "../../packages/broker/src/aws/e2e-runtime-readiness.js";
import { e2eModelCheckRunnerKey } from "../../packages/broker/src/e2e/model-route-registry.js";
import { issueRuntimeInstallChallenge, registerRuntimeInstallation } from "../../packages/broker/src/aws/runtime-installation.js";
import { ec2RequalifyInstanceReader, issueRequalifyChallenge, registerRequalifiedRuntime, requalifierIdentity, type RequalifyDependencies, type RequalifyInstance } from "../../packages/broker/src/aws/runtime-requalify.js";
import { qualifyInstalledWebApiRuntime } from "../../packages/verifier/src/install-qualification.js";
import { createFakeRuntimeRegistry } from "../support/runtime-registry-fakes.js";
import { fakeLinuxEnvironment, fakeProbeRunner, privateEvidenceRoot, webApiChallenge, WEB_API_FIXTURE_NOW } from "../support/web-api-qualification.js";

// The committed probe evidence is bound to one fixed challenge, so a renewal challenge (random id, issued by the service identity) cannot re-derive it.
// `evidence.bypass` lets the success-path tests stand in for a runner that produced matching evidence; the "evidence is still re-derived" test leaves it off.
const evidence = vi.hoisted(() => ({ bypass: false }));
vi.mock("@agentx/verifier", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown> & { verifyWebApiProbeRecord: (input: unknown) => { ok: boolean } }>();
  return { ...actual, verifyWebApiProbeRecord: (input: unknown) => (evidence.bypass ? { ok: true as const } : actual.verifyWebApiProbeRecord(input)) };
});

const at = WEB_API_FIXTURE_NOW;
const ENV = "test";
const RUN = "0b8a2f64-7c1d-4e0a-9f1b-3d5c6e7f8a90";
const ROLE = "AROAEXAMPLEROLE0123456";
const NEW_ID = "i-0123456789abcdef0";
const OLD_ID = "i-0fedcba9876543210";
const NEW_IP = "10.0.3.7";
const binding = webApiChallenge(at).binding;
const webKey = e2eRegisteredRuntimeKey("configured-feature", "linux-arm64-web-api-v1", "web");
const apiKey = e2eRegisteredRuntimeKey("configured-feature", "linux-arm64-web-api-v1", "api");
const lockKey = requalifyLockKey("linux-arm64-web-api-v1");
const pointerKey = e2eModelCheckRunnerKey("linux-arm64-web-api-v1");
const itemKey = (key: { pk: string; sk: string }) => `${key.pk}|${key.sk}`;
const managedTags = (runId = RUN): Record<string, string> => ({ DeploymentMode: "e2e-qualification", Environment: ENV, "agentx:requalify-managed": "true", "agentx:qualification-run": runId });

function world(options: { instances?: Record<string, RequalifyInstance> } = {}) {
  const registry = createFakeRuntimeRegistry(at);
  const { items, objects, transactions, deps: base } = registry;
  // The fake client applies no conditions; this one applies the three the switch relies on, so a lost race fails the transaction as DynamoDB would.
  const inner = base.documentClient.send.bind(base.documentClient);
  const hooks = { beforeTransaction: undefined as undefined | (() => void) };
  (base.documentClient as { send: unknown }).send = async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    if (command.constructor.name === "TransactWriteCommand") {
      hooks.beforeTransaction?.();
      for (const write of command.input.TransactItems as Array<Record<string, { Key?: { pk: string; sk: string }; Item?: { pk: string; sk: string }; ConditionExpression?: string; ExpressionAttributeValues?: Record<string, string> }>>) {
        const check = write.ConditionCheck;
        if (check?.Key && check.ConditionExpression === "runId = :runId AND expiresAt > :now") {
          const lock = items.get(itemKey(check.Key));
          if (!lock || lock.runId !== check.ExpressionAttributeValues![":runId"] || String(lock.expiresAt) <= check.ExpressionAttributeValues![":now"]!) throw new Error("ConditionalCheckFailed");
        }
        const put = write.Put;
        if (put?.Item && put.ConditionExpression === "attribute_not_exists(pk) AND attribute_not_exists(sk)" && items.has(itemKey(put.Item))) throw new Error("ConditionalCheckFailed");
        if (put?.Item && put.ConditionExpression?.startsWith("instanceId = :previousInstance")) {
          const current = items.get(itemKey(put.Item));
          if (!current || current.instanceId !== put.ExpressionAttributeValues![":previousInstance"] || current.transportCorrelationId !== put.ExpressionAttributeValues![":previousCorrelation"]) throw new Error("ConditionalCheckFailed");
        }
      }
    }
    return inner(command as never);
  };
  const instances: Record<string, RequalifyInstance> = options.instances ?? { [NEW_ID]: { instanceId: NEW_ID, state: "running", privateIp: NEW_IP, tags: managedTags() } };
  const deps: RequalifyDependencies = { ...base, environment: ENV, expectedBinding: binding, describeInstance: async (id) => instances[id] };
  const hold = (runId = RUN, expiresAt = new Date(at + 3 * 3_600_000).toISOString()) => items.set(itemKey(lockKey), { ...lockKey, entityType: "RUNTIME_REQUALIFY_LOCK", runId, acquiredAt: new Date(at).toISOString(), expiresAt });
  const seedRows = (generation: number) => { for (const key of [webKey, apiKey]) items.set(itemKey(key), { ...key, catalogRevision: 2, generation }); };
  const scriptPointer = (instanceId = OLD_ID, transportCorrelationId = randomUUID()) => items.set(itemKey(pointerKey), { ...pointerKey, entityType: "E2E_MODEL_CHECK_RUNNER", roleId: "AROAOLDROLE0123456789", instanceId, transportCorrelationId, recordedAt: "2026-10-19T00:00:00.000Z" });
  const snapshot = () => JSON.stringify({ items: [...items.entries()].sort(), objects: [...objects.keys()].sort(), transactions: transactions.length });
  return { ...registry, items, objects, transactions, deps, instances, hold, seedRows, scriptPointer, snapshot, hooks };
}

type World = ReturnType<typeof world>;
const input = { runId: RUN, instanceId: NEW_ID, roleId: ROLE };

/** Issues the renewal challenge, reads back what the runner would read from the bucket, and builds the proposal the runner would return for it. */
async function issuedProposal(w: World, run: typeof input = input) {
  const issued = await issueRequalifyChallenge(w.deps, run);
  const stored = [...w.objects.entries()].find(([key]) => key.endsWith("/challenge.json"))!;
  const challenge = JSON.parse(stored[1].toString("utf8")) as RuntimeInstallChallenge;
  const fixture = await qualifyInstalledWebApiRuntime({ challenge: webApiChallenge(WEB_API_FIXTURE_NOW), evidenceRoot: await privateEvidenceRoot(), runProbe: fakeProbeRunner().runProbe, environment: fakeLinuxEnvironment(WEB_API_FIXTURE_NOW) });
  const proposal = { ...fixture, challenge };
  return { issued, challenge, stored, proposal, request: { ...run, proposal, proposalSha256: webApiRuntimeInstallProposalSha256(proposal), amiId: "ami-0123456789abcdef0", images: { worker: "worker@sha256:aaa", executor: null } } };
}

describe("AUTOREQUALIFY issue: the product opens its own challenge", () => {
  it("derives profile, binding, generation and endpoint itself, and writes the secret to the runner prefix without returning it", async () => {
    const w = world(); w.hold(); w.seedRows(4);
    const { issued, challenge, stored } = await issuedProposal(w);
    expect(issued).toEqual({ challengeId: challenge.challengeId, expiresAt: challenge.expiresAt, generation: 5, transportCorrelationId: challenge.transportCorrelationId });
    // The secret reached the object store (positive control) and nowhere in what the step returns.
    expect(stored[0]).toBe(`e2e-runtime/${ROLE}:${NEW_ID}/challenge.json`);
    expect(challenge.challengeSecret.length).toBeGreaterThan(20);
    expect(JSON.stringify(issued)).not.toContain(challenge.challengeSecret);
    expect(challenge).toMatchObject({ profileId: "linux-arm64-web-api-v1", endpoint: `http://${NEW_IP}:8080`, generation: 5, issuedBySubject: "runtime-requalifier/test", binding });
    const row = w.items.get(`RUNTIME_INSTALL_CHALLENGE#${challenge.challengeId}|CHALLENGE`)!;
    expect(row).toMatchObject({ state: "ISSUED", issuedBySubject: "runtime-requalifier/test", requalifyRunId: RUN, requalifyInstanceId: NEW_ID });
  });

  it("starts at generation 1 when nothing is registered", async () => {
    const w = world(); w.hold();
    expect((await issueRequalifyChallenge(w.deps, input)).generation).toBe(1);
  });

  it("takes no profile, binding, generation or endpoint from its input", async () => {
    const w = world(); w.hold();
    for (const extra of [{ profileId: "default-sandbox" }, { binding }, { generation: 1 }, { endpoint: "http://10.9.9.9:8080" }]) {
      await expect(issueRequalifyChallenge(w.deps, { ...input, ...extra })).rejects.toThrow(`${REQUALIFY_REFUSAL_PREFIX}invalid-input`);
    }
    expect(w.objects.size).toBe(0);
  });

  it.each([
    ["no lock", (w: World) => w.items.delete(itemKey(lockKey)), "lock-not-held"],
    ["another run's lock", (w: World) => w.hold(randomUUID()), "lock-not-held"],
    ["an expired lock", (w: World) => w.hold(RUN, new Date(at - 1000).toISOString()), "lock-not-held"],
    ["an instance that does not exist", (w: World) => { delete w.instances[NEW_ID]; }, "endpoint-not-managed-instance"],
    ["an instance that is not running", (w: World) => { w.instances[NEW_ID] = { ...w.instances[NEW_ID]!, state: "pending" }; }, "endpoint-not-managed-instance"],
    ["an instance without the managed tag", (w: World) => { const { "agentx:requalify-managed": _m, ...rest } = managedTags(); void _m; w.instances[NEW_ID] = { ...w.instances[NEW_ID]!, tags: rest }; }, "endpoint-not-managed-instance"],
    ["an instance of another environment", (w: World) => { w.instances[NEW_ID] = { ...w.instances[NEW_ID]!, tags: { ...managedTags(), Environment: "prod" } }; }, "endpoint-not-managed-instance"],
    ["an instance launched by another run", (w: World) => { w.instances[NEW_ID] = { ...w.instances[NEW_ID]!, tags: managedTags(randomUUID()) }; }, "endpoint-not-managed-instance"],
    ["an instance with no private address", (w: World) => { w.instances[NEW_ID] = { ...w.instances[NEW_ID]!, privateIp: undefined }; }, "endpoint-not-managed-instance"],
  ])("refuses %s and writes nothing", async (_name, arrange, code) => {
    const w = world(); w.hold(); arrange(w);
    const before = w.snapshot();
    await expect(issueRequalifyChallenge(w.deps, input)).rejects.toThrow(`${REQUALIFY_REFUSAL_PREFIX}${code}`);
    expect(w.snapshot()).toBe(before);
  });
});

describe("AUTOREQUALIFY switch: one transaction", () => {
  it("moves both rows, the evidence pointer, the challenge, the model-check runner and the audit record together, attributed to the service identity", async () => {
    const w = world(); w.hold(); w.seedRows(4); w.scriptPointer(OLD_ID, "11111111-1111-4111-8111-111111111111"); evidence.bypass = true;
    const t = await issuedProposal(w);
    const result = await registerRequalifiedRuntime(w.deps, t.request);
    evidence.bypass = false;
    expect(w.transactions).toHaveLength(1);
    expect(w.transactions[0]!.map((write) => Object.keys(write)[0])).toEqual(["Put", "Put", "Put", "Update", "ConditionCheck", "Put", "Put"]);
    for (const key of [webKey, apiKey]) expect(w.items.get(itemKey(key))).toMatchObject({ generation: 5, catalogRevision: 3, state: "READY", endpoint: `http://${NEW_IP}:8080` });
    expect(w.items.get(`RUNTIME_INSTALL_CHALLENGE#${t.challenge.challengeId}|CHALLENGE`)!.state).toBe("CONSUMED");
    expect(w.items.get(`RUNTIME_INSTALLATION_EVIDENCE#${result.registration.proposalSha256}|EVIDENCE`)).toMatchObject({ approvedBySubject: "runtime-requalifier/test", issuedBySubject: "runtime-requalifier/test" });
    expect(w.items.get(itemKey(pointerKey))).toMatchObject({ roleId: ROLE, instanceId: NEW_ID, transportCorrelationId: t.challenge.transportCorrelationId, requalifyRunId: RUN });
    const record = RequalifyRunRecordSchema.parse(Object.fromEntries(Object.entries(w.items.get(itemKey(requalifyRunKey(RUN)))!).filter(([name]) => name !== "pk" && name !== "sk")));
    expect(record).toMatchObject({ runId: RUN, environment: "test", generation: 5, featureRevisions: { web: 3, api: 3 }, challengeId: t.challenge.challengeId, amiId: "ami-0123456789abcdef0",
      previousRunner: { instanceId: OLD_ID, transportCorrelationId: "11111111-1111-4111-8111-111111111111" }, newRunner: { instanceId: NEW_ID, roleId: ROLE }, requestedBySubject: "runtime-requalifier/test" });
    expect(result).toMatchObject({ generation: 5, previousRunner: { instanceId: OLD_ID } });
  });

  it("switches from nothing: no earlier pointer, no earlier rows", async () => {
    const w = world(); w.hold(); evidence.bypass = true;
    const t = await issuedProposal(w);
    const result = await registerRequalifiedRuntime(w.deps, t.request);
    evidence.bypass = false;
    expect(result.previousRunner).toBeNull();
    expect(w.items.get(itemKey(webKey))).toMatchObject({ generation: 1, catalogRevision: 1 });
    expect(w.items.get(itemKey(pointerKey))).toMatchObject({ instanceId: NEW_ID });
  });

  it("still re-derives every probe from its retained bytes for the service identity", async () => {
    const w = world(); w.hold();
    const t = await issuedProposal(w);
    const before = w.snapshot();
    await expect(registerRequalifiedRuntime(w.deps, t.request)).rejects.toThrow(/probe-evidence-unbound/);
    expect(w.snapshot()).toBe(before);
    // Positive control: the same request registers once the evidence binds.
    evidence.bypass = true;
    await expect(registerRequalifiedRuntime(w.deps, t.request)).resolves.toMatchObject({ generation: 1 });
    evidence.bypass = false;
  });

  it.each([
    ["the lock is gone", (w: World) => w.items.delete(itemKey(lockKey)), "lock-not-held"],
    ["the lock belongs to another run", (w: World) => w.hold(randomUUID()), "lock-not-held"],
    ["another registration already took the generation the challenge was issued for", (w: World) => w.seedRows(5), "generation-not-next"],
    ["the instance lost its managed tag", (w: World) => { w.instances[NEW_ID] = { ...w.instances[NEW_ID]!, tags: { ...managedTags(), "agentx:requalify-managed": "false" } }; }, "endpoint-not-managed-instance"],
    ["the instance now has another address", (w: World) => { w.instances[NEW_ID] = { ...w.instances[NEW_ID]!, privateIp: "10.0.3.99" }; }, "endpoint-not-managed-instance"],
    ["the pointer names something that is not a runner", (w: World) => w.items.set(itemKey(pointerKey), { ...pointerKey, entityType: "E2E_MODEL_CHECK_RUNNER", instanceId: "not-an-instance" }), "runner-pointer-invalid"],
  ])("refuses when %s, with nothing written", async (_name, arrange, code) => {
    const w = world(); w.hold(); w.seedRows(4); evidence.bypass = true;
    const t = await issuedProposal(w);
    arrange(w);
    const before = w.snapshot();
    await expect(registerRequalifiedRuntime(w.deps, t.request)).rejects.toThrow(`${REQUALIFY_REFUSAL_PREFIX}${code}`);
    evidence.bypass = false;
    expect(w.snapshot()).toBe(before);
  });

  it("refuses a proposal older than the registered generation through the registrar's own rule", async () => {
    const w = world(); w.hold(); w.seedRows(4); evidence.bypass = true;
    const t = await issuedProposal(w);
    w.seedRows(9);
    const before = w.snapshot();
    await expect(registerRequalifiedRuntime(w.deps, t.request)).rejects.toThrow(/older worker generation/);
    evidence.bypass = false;
    expect(w.snapshot()).toBe(before);
  });

  it("refuses a binding that is not this environment's, even for a challenge it issued", async () => {
    const w = world(); w.hold(); evidence.bypass = true;
    const t = await issuedProposal(w);
    const drifted = { ...w.deps, expectedBinding: { ...binding, volumeSizeGiB: 64 } };
    const before = w.snapshot();
    await expect(registerRequalifiedRuntime(drifted, t.request)).rejects.toThrow(`${REQUALIFY_REFUSAL_PREFIX}binding-mismatch`);
    evidence.bypass = false;
    expect(w.snapshot()).toBe(before);
  });

  it("refuses a challenge an administrator issued, and one the service issued for another run or runner", async () => {
    const w = world(); w.hold(); evidence.bypass = true;
    const t = await issuedProposal(w);
    const before = w.snapshot();
    // Another run's lock holder cannot redeem this run's challenge: the row names the run and runner it was issued for.
    const row = w.items.get(`RUNTIME_INSTALL_CHALLENGE#${t.challenge.challengeId}|CHALLENGE`)!;
    w.items.set(`RUNTIME_INSTALL_CHALLENGE#${t.challenge.challengeId}|CHALLENGE`, { ...row, requalifyRunId: randomUUID() });
    await expect(registerRequalifiedRuntime(w.deps, t.request)).rejects.toThrow(`${REQUALIFY_REFUSAL_PREFIX}challenge-not-requalifier`);
    w.items.set(`RUNTIME_INSTALL_CHALLENGE#${t.challenge.challengeId}|CHALLENGE`, { ...row, requalifyInstanceId: OLD_ID });
    await expect(registerRequalifiedRuntime(w.deps, t.request)).rejects.toThrow(`${REQUALIFY_REFUSAL_PREFIX}challenge-not-requalifier`);
    // A challenge a human administrator issued is refused by the issuer rule: the service is not that administrator.
    const humanRow = { ...row, issuedByOwnerKey: "admin", issuedBySubject: "admin" };
    w.items.set(`RUNTIME_INSTALL_CHALLENGE#${t.challenge.challengeId}|CHALLENGE`, humanRow);
    await expect(registerRequalifiedRuntime(w.deps, t.request)).rejects.toThrow();
    evidence.bypass = false;
    w.items.set(`RUNTIME_INSTALL_CHALLENGE#${t.challenge.challengeId}|CHALLENGE`, row);
    expect(w.snapshot()).toBe(before);
  });

  it("refuses a proposal for any other profile", async () => {
    const w = world(); w.hold(); evidence.bypass = true;
    const t = await issuedProposal(w);
    const other = { ...t.proposal, challenge: { ...t.challenge, profileId: "linux-arm64-docker-v1" } };
    const before = w.snapshot();
    await expect(registerRequalifiedRuntime(w.deps, { ...t.request, proposal: other, proposalSha256: "a".repeat(64) })).rejects.toThrow();
    evidence.bypass = false;
    expect(w.snapshot()).toBe(before);
  });

  it("fails the whole switch when the model-check pointer moved after it was read (a script run raced the renewal)", async () => {
    const w = world(); w.hold(); w.scriptPointer(OLD_ID, "11111111-1111-4111-8111-111111111111"); evidence.bypass = true;
    const t = await issuedProposal(w);
    w.hooks.beforeTransaction = () => w.scriptPointer("i-0aaaaaaaaaaaaaaaa", randomUUID());
    await expect(registerRequalifiedRuntime(w.deps, t.request)).rejects.toThrow(/changed before registration/);
    evidence.bypass = false;
    expect(w.items.get(itemKey(webKey))).toBeUndefined();
    expect(w.items.get(itemKey(requalifyRunKey(RUN)))).toBeUndefined();
    expect(w.items.get(itemKey(pointerKey))).toMatchObject({ instanceId: "i-0aaaaaaaaaaaaaaaa" });
    expect(w.items.get(`RUNTIME_INSTALL_CHALLENGE#${t.challenge.challengeId}|CHALLENGE`)!.state).toBe("ISSUED");
  });

  it("fails the whole switch when the lock expired between the checks and the transaction", async () => {
    const w = world(); w.hold(); evidence.bypass = true;
    const t = await issuedProposal(w);
    w.hooks.beforeTransaction = () => w.hold(RUN, new Date(at - 1).toISOString());
    await expect(registerRequalifiedRuntime(w.deps, t.request)).rejects.toThrow(/changed before registration/);
    evidence.bypass = false;
    expect(w.items.get(itemKey(webKey))).toBeUndefined();
    expect(w.items.get(itemKey(pointerKey))).toBeUndefined();
  });

  it("records a run once: a second switch for the same run id fails whole and leaves the first record", async () => {
    const w = world(); w.hold(); evidence.bypass = true;
    const first = await issuedProposal(w);
    await registerRequalifiedRuntime(w.deps, first.request);
    const second = await issuedProposal(w);
    const before = JSON.stringify([...w.items.entries()].sort());
    await expect(registerRequalifiedRuntime(w.deps, second.request)).rejects.toThrow(/changed before registration/);
    evidence.bypass = false;
    // The retained evidence object is content addressed and written before the transaction; no row moved.
    expect(JSON.stringify([...w.items.entries()].sort())).toBe(before);
    expect(w.items.get(itemKey(requalifyRunKey(RUN)))).toMatchObject({ generation: 1, challengeId: first.challenge.challengeId });
  });
});

describe("the service identity has no human or HTTP authority", () => {
  it("carries no administrator claim, so the admin functions and routes refuse it", async () => {
    const identity = requalifierIdentity(ENV);
    expect(identity).toMatchObject({ issuer: "rovara:internal", subject: "runtime-requalifier/test", isAdministrator: false });
    const w = world();
    await expect(issueRuntimeInstallChallenge(w.deps, identity, { binding, endpoint: "http://10.0.3.7:8080", generation: 1, transportCorrelationId: randomUUID(), profileId: "linux-arm64-web-api-v1" })).rejects.toThrow(/administrator/);
    await expect(registerRuntimeInstallation(w.deps, identity, { proposal: {}, proposalSha256: "a".repeat(64) })).rejects.toThrow(/administrator/);
    expect(w.items.size).toBe(0);
  });

  it("cannot be built for a malformed environment", () => {
    expect(() => requalifierIdentity("Test Env")).toThrow(`${REQUALIFY_REFUSAL_PREFIX}invalid-input`);
    expect(() => requalifierIdentity("")).toThrow();
  });

  it("leaves the human path as it was: an administrator's challenge still registers its own proposal in the original four writes", async () => {
    const w = world();
    const admin = { issuer: "test", subject: "admin", ownerKey: "admin", isAdministrator: true, claims: {} };
    w.seedChallenge(webApiChallenge(at));
    evidence.bypass = false;
    const proposal = await qualifyInstalledWebApiRuntime({ challenge: webApiChallenge(at), evidenceRoot: await privateEvidenceRoot(), runProbe: fakeProbeRunner().runProbe, environment: fakeLinuxEnvironment(at) });
    await registerRuntimeInstallation(w.deps, admin, { proposal, proposalSha256: webApiRuntimeInstallProposalSha256(proposal) });
    expect(w.transactions[0]!.map((write) => Object.keys(write)[0])).toEqual(["Put", "Put", "Put", "Update"]);
    expect(w.items.has(itemKey(pointerKey))).toBe(false);
  });
});

describe("ec2RequalifyInstanceReader and the run record", () => {
  it("reads state, address and tags, and treats a missing instance as absent", async () => {
    const sent: unknown[] = [];
    const reader = ec2RequalifyInstanceReader({ send: async (command: unknown) => { sent.push(command); return { Reservations: [{ Instances: [{ InstanceId: NEW_ID, State: { Name: "running" }, PrivateIpAddress: NEW_IP, Tags: [{ Key: "Environment", Value: "test" }] }] }] }; } } as never);
    expect(await reader(NEW_ID)).toEqual({ instanceId: NEW_ID, state: "running", privateIp: NEW_IP, tags: { Environment: "test" } });
    expect(sent[0]).toBeInstanceOf(DescribeInstancesCommand);
    expect(await reader("i-0aaaaaaaaaaaaaaaa")).toBeUndefined();
    const missing = ec2RequalifyInstanceReader({ send: async () => { throw Object.assign(new Error("x"), { name: "InvalidInstanceID.NotFound" }); } } as never);
    expect(await missing(NEW_ID)).toBeUndefined();
    const denied = ec2RequalifyInstanceReader({ send: async () => { throw Object.assign(new Error("x"), { name: "UnauthorizedOperation" }); } } as never);
    await expect(denied(NEW_ID)).rejects.toThrow();
  });

  it("keeps the run record and the tag names fixed", () => {
    expect(REQUALIFY_TAGS).toMatchObject({ managedKey: "agentx:requalify-managed", runKey: "agentx:qualification-run", deploymentModeValue: "e2e-qualification" });
    expect(RequalifyRunRecordSchema.safeParse({ unknown: true }).success).toBe(false);
  });
});
