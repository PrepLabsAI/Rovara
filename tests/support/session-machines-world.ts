// Engine host (lane E2, step 4): a world for Code's EC2 machines adapter with no AWS. Ported from the monolith's world. The real SessionManager over the fake table; the provisioner and deleter
// state machines played by timers (each runs the same session steps the real machines call: recordVolume, recordInstance, markReady, markDeleted);
// fake EC2 instances; and a worker per instance that checks each invoke token with the worker's own verifier, against a P-256 key standing in for KMS.
import { generateKeyPairSync, randomUUID, sign as signBytes } from "node:crypto";
import { AGENTX_PROTOCOL_VERSION, WorkerInvocationSchema, type Ec2RuntimeBinding, type OrgId, type WorkerInvocation } from "@agentx/contracts";
import { SessionManager, type ProvisioningInput, type DeletionInput } from "../../packages/broker/src/aws/sessions.js";
import { createSessionStepsHandler } from "../../packages/broker/src/aws/session-steps.js";
import { SessionWorkerFleet, type SessionWorkerMachines, type SessionWorkerMachinesDependencies, type SessionWorkerPing } from "../../packages/broker/src/aws/worker-machines/session-worker-machines.js";
import { workspaceCompanyReader } from "../../packages/broker/src/aws/worker-machines/workspace-company.js";
import { WORKER_IMPLEMENTED_FEATURES } from "../../packages/worker/src/implemented-features.js";
import { invocationMatchesClaims, verifyInvokeAuthorization } from "../../packages/worker/src/invoke-auth.js";
import { FakeDynamoDb } from "./fake-dynamodb.js";
import { provisionerRecordInstancePayload, type RunInstancesResult } from "./session-provisioner-payload.js";

export const COMPANY_A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
export const COMPANY_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
export const TABLE = "state";
export const PROVISIONER_ARN = "arn:aws:states:us-west-2:111122223333:stateMachine:provisioner";
export const DELETER_ARN = "arn:aws:states:us-west-2:111122223333:stateMachine:deleter";
/** What the worker on this branch lists on /ping (packages/worker/src/implemented-features.ts): the core is dispatched against the real worker's list, not a made-up one. */
export const WORKER_FEATURES: readonly string[] = [...WORKER_IMPLEMENTED_FEATURES];

export const BINDING: Ec2RuntimeBinding = {
  deploymentMode: "ec2-ebs",
  launchTemplateId: "lt-0123456789abcdef0",
  subnets: [{ availabilityZone: "us-west-2a", subnetId: "subnet-0aaaaaaaaaaaaaaaa" }],
  volumeSizeGiB: 20,
  volumeType: "gp3",
};

interface Instance {
  instanceId: string;
  privateIp: string;
  workspaceId: string;
  generation: number;
  running: boolean;
  accepted: Set<string>;
  active: Set<string>;
}

export interface Execution {
  stateMachineArn: string;
  name: string;
  input: ProvisioningInput | DeletionInput;
}

export interface SessionMachinesWorld {
  db: FakeDynamoDb;
  sessions: SessionManager;
  executions: Execution[];
  instances: Map<string, Instance>;
  /** Every request a worker answered, with its HTTP status. */
  posts: Array<{ url: string; status: number; workspaceId?: string; operationId?: string }>;
  publicKey: string;
  /** A workspace record as the core writes it (`companyId` and the same `orgId`); `fields` replaces or adds fields (a malformed record). */
  workspace(company: OrgId | undefined, fields?: Record<string, unknown>): string;
  machinesFor(company: OrgId, overrides?: Partial<SessionWorkerMachinesDependencies>): SessionWorkerMachines;
  /** The registry's fleet over the same world (bound per company with `forCompany`). */
  fleet(overrides?: Partial<Omit<SessionWorkerMachinesDependencies, "companyId">>): SessionWorkerFleet;
  /** Waits for the state machines started so far to finish. */
  settle(): Promise<void>;
  /** The machine-side signer, as the dispatcher's KMS Sign would answer. */
  sign(message: Uint8Array): Promise<Uint8Array>;
  /** What the worker does when it ends a job (its terminal callback). */
  finish(instanceId: string, operationId: string): void;
  provisionerHolds: boolean;
}

export function invocationFor(workspaceId: string, operationId: string = randomUUID(), kind: "task" | "publish" = "task"): WorkerInvocation {
  return WorkerInvocationSchema.parse({
    protocolVersion: AGENTX_PROTOCOL_VERSION, operationId, workspaceId, fence: 1, projectRevision: 1, callbackCapability: "c".repeat(48),
    kind, payload: kind === "task" ? { conversationId: randomUUID(), prompt: "make the change" } : {},
  });
}

export function createSessionMachinesWorld(options: { startedAt?: number } = {}): SessionMachinesWorld {
  const db = new FakeDynamoDb();
  const executions: Execution[] = [];
  const instances = new Map<string, Instance>();
  const pending: Array<Promise<void>> = [];
  const posts: SessionMachinesWorld["posts"] = [];
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKeyText = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const clock = options.startedAt ?? Date.parse("2026-11-12T10:00:00.000Z");
  let ipCounter = 10;

  const sessions = new SessionManager({
    documentClient: db,
    tableName: TABLE,
    now: () => new Date(clock),
    chooseSubnet: (subnets) => subnets[0]!,
    executions: {
      provisionerArn: PROVISIONER_ARN,
      deleterArn: DELETER_ARN,
      async start(execution) {
        // Step Functions keeps one execution per name: a second start with the name of a running or finished one is refused (the session manager reads that as started).
        if (executions.some((started) => started.stateMachineArn === execution.stateMachineArn && started.name === execution.name)) {
          throw Object.assign(new Error("Execution Already Exists"), { name: "ExecutionAlreadyExists" });
        }
        const input = JSON.parse(execution.input) as ProvisioningInput | DeletionInput;
        executions.push({ stateMachineArn: execution.stateMachineArn, name: execution.name, input });
        const run = execution.stateMachineArn === PROVISIONER_ARN ? () => provision(input as ProvisioningInput) : () => remove(input as DeletionInput);
        pending.push(new Promise<void>((resolve, reject) => setTimeout(() => { run().then(resolve, reject); }, 0)));
        return `${execution.stateMachineArn.replace(":stateMachine:", ":execution:")}:${execution.name}`;
      },
    },
  });

  // One Lambda handler serves every workspace and generation in this world.
  // Fail if recording unexpectedly depends on boot configuration or a health probe.
  const unusedStepDependency = () => { throw new Error("recordInstance must not use launch/probe dependencies"); };
  const sessionSteps = createSessionStepsHandler({
    sessions,
    workerSettings: unusedStepDependency,
    invokePublicKey: unusedStepDependency,
    bootScript: unusedStepDependency,
    controlPlaneUrl: "https://control.example.invalid",
    logGroupName: "/test/worker",
    ping: unusedStepDependency,
  });

  // The provisioner: a volume when there is none, an instance from the launch template, then READY once the worker answers.
  async function provision(input: ProvisioningInput): Promise<void> {
    while (world.provisionerHolds) await new Promise((resolve) => setTimeout(resolve, 1));
    const volumeId = input.volumeId ?? `vol-${randomUUID().replace(/-/g, "").slice(0, 17)}`;
    if (input.volumeId === null) await sessions.markVolume(input.workspaceId, input.generation, volumeId);
    const instanceId = `i-${randomUUID().replace(/-/g, "").slice(0, 17)}`;
    const privateIp = `10.42.0.${ipCounter++}`;
    instances.set(instanceId, { instanceId, privateIp, workspaceId: input.workspaceId, generation: input.generation, running: true, accepted: new Set(), active: new Set() });
    const result: RunInstancesResult = { Instances: [{ InstanceId: instanceId, PrivateIpAddress: privateIp, InstanceType: input.machine?.instanceType ?? "m6g.large" }] };
    const launch = input.machine === undefined ? "RunInstance" : input.machine.chip === "x86_64" ? "RunInstanceX86" : "RunInstanceSized";
    const payload = await provisionerRecordInstancePayload(input, launch, result);
    await sessionSteps(payload);
    await sessions.markReady(input.workspaceId, input.generation);
  }

  // The deleter: the instance, then the volume, then DELETED.
  async function remove(input: DeletionInput): Promise<void> {
    if (input.instanceId !== null) {
      const instance = instances.get(input.instanceId);
      if (instance !== undefined) instance.running = false;
    }
    await sessions.markDeleted(input.workspaceId);
  }

  const instanceAt = (url: string): Instance | undefined => {
    const host = new URL(url).hostname;
    return [...instances.values()].find((instance) => instance.privateIp === host && instance.running);
  };

  const ping = async (url: string): Promise<SessionWorkerPing | undefined> => {
    const instance = instanceAt(url);
    if (instance === undefined) throw new Error("connect ECONNREFUSED");
    return { status: instance.active.size === 0 ? "Healthy" : "HealthyBusy", activeOperations: instance.active.size, features: [...WORKER_FEATURES] };
  };

  const post = async (url: string, init: { authorization: string; body: string }): Promise<{ status: number; body: string }> => {
    const instance = instanceAt(url);
    if (instance === undefined) throw new Error("connect ECONNREFUSED");
    const answer = (status: number, body: Record<string, unknown>, invocation?: WorkerInvocation) => {
      posts.push({ url, status, ...(invocation === undefined ? {} : { workspaceId: invocation.workspaceId, operationId: invocation.operationId }) });
      return { status, body: JSON.stringify(body) };
    };
    // The worker's own checks (packages/worker/src/server.ts): the token first, then the body against the token's claims.
    const verified = verifyInvokeAuthorization(init.authorization, { publicKey, workspaceId: instance.workspaceId, generation: instance.generation, now: () => Math.floor(clock / 1_000) });
    if (!verified.ok) return answer(401, { error: verified.reason });
    const invocation = WorkerInvocationSchema.parse(JSON.parse(init.body));
    if (!invocationMatchesClaims(invocation, verified.claims)) return answer(401, { error: "invocation_mismatch" }, invocation);
    if (invocation.kind === "steer" || invocation.kind === "peek") return answer(200, { accepted: true, outcome: invocation.kind === "steer" ? "steered" : "unavailable" }, invocation);
    const duplicate = instance.accepted.has(invocation.operationId);
    if (!duplicate) {
      instance.accepted.add(invocation.operationId);
      instance.active.add(invocation.operationId);
    }
    return answer(200, { accepted: true, operationId: invocation.operationId, status: "ACCEPTED", duplicate }, invocation);
  };

  const sign = async (message: Uint8Array) => new Uint8Array(signBytes("sha256", message, { key: privateKey, dsaEncoding: "der" }));

  const world: SessionMachinesWorld = {
    db, sessions, executions, instances, posts, publicKey: publicKeyText, provisionerHolds: false, sign,
    workspace(company, fields = {}) {
      const workspaceId = randomUUID();
      db.set({
        pk: `WORKSPACE#${workspaceId}`, sk: "META", entityType: "WORKSPACE", status: "READY", fence: 1, projectName: "payments", projectRevision: 1,
        ...(company === undefined ? {} : { companyId: company, orgId: company }), ...fields,
      });
      return workspaceId;
    },
    machinesFor(company, overrides = {}) {
      return world.fleet(overrides).forCompany(company);
    },
    fleet(overrides = {}) {
      return new SessionWorkerFleet({
        sessions,
        companyOfWorkspace: workspaceCompanyReader(db, TABLE),
        binding: async () => BINDING,
        async stopInstance(instanceId) {
          const instance = instances.get(instanceId);
          if (instance !== undefined) instance.running = false;
          return { gone: true };
        },
        sign,
        post,
        ping,
        now: () => clock,
        ...overrides,
      });
    },
    async settle() {
      while (pending.length > 0) await pending.shift();
    },
    finish(instanceId, operationId) {
      instances.get(instanceId)?.active.delete(operationId);
    },
  };
  return world;
}
