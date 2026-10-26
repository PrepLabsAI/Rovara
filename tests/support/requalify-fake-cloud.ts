/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access -- an in-memory test double for AWS clients: command inputs are dynamic by design */
// An in-memory account for the renewal's tests: EC2, SSM, IAM, S3, DynamoDB, SNS, CloudWatch and Step Functions as far as the renewal uses them, plus an
// interpreter for the renewal's state machine definition so the real machine runs against the real step code. No AWS call is ever made.
import { createHash, randomUUID } from "node:crypto";
import { canonicalJson, e2eQualificationPrefix, REQUALIFY_PROFILE_ID, type Ec2RuntimeBinding } from "../../packages/contracts/src/index.js";
import { e2eModelCheckRunnerKey } from "../../packages/broker/src/e2e/model-route-registry.js";
import { e2eRegisteredRuntimeKey } from "../../packages/broker/src/aws/e2e-runtime-readiness.js";
import type { RequalifyStepsDependencies } from "../../packages/broker/src/aws/runtime-requalify-steps.js";

export const ENV = "agentxlivetest123";
export const CATALOG = "feature-catalog-1";
export const ROLE_ID = "AROAABCDEFGHIJKLMNOP";
export const ROLE_ARN = `arn:aws:iam::111122223333:role/agentx/${ENV}/worker`;
export const WORKER_IMAGE = `111122223333.dkr.ecr.us-east-1.amazonaws.com/agentx-test/worker@sha256:${"a".repeat(64)}`;
export const EXECUTOR_IMAGE = `111122223333.dkr.ecr.us-east-1.amazonaws.com/agentx-test/executor@sha256:${"b".repeat(64)}`;
export const SECRET = "challenge-secret-9f2c7a1d44b0";
export const BINDING: Ec2RuntimeBinding = { deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0", subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0aaaaaaaaaaaaaaaa" }], volumeSizeGiB: 20, volumeType: "gp3" };
const HOUR = 3_600_000;

type Item = Record<string, unknown>;
interface FakeInstance { userData?: string; imageId?: string; id: string; state: string; tags: Record<string, string>; ip: string; volumes: string[]; polls: number }
interface FakeVolume { id: string; state: string; tags: Record<string, string>; attachedTo?: string }
const named = (name: string, message = name): Error => Object.assign(new Error(message), { name });
const hex = (n: number) => n.toString(16).padStart(17, "0");

export class FakeCloud {
  clock = Date.parse("2026-10-27T06:00:00.000Z");
  instances = new Map<string, FakeInstance>();
  volumes = new Map<string, FakeVolume>();
  ssm = new Map<string, string>();
  s3 = new Map<string, Buffer>();
  ddb = new Map<string, Item>();
  sns: Array<{ subject: string; message: string }> = [];
  metrics: string[] = [];
  executions: string[] = [];
  terminated: string[] = [];
  deleted: string[] = [];
  launches: string[] = [];
  /** What the runner's boot hook does: becomes ready, then qualifies when a challenge appears. */
  runner: { ready: boolean; qualify: "SUCCEEDED" | "FAILED" | "never"; failure: string[]; proposal?: Buffer } = { ready: true, qualify: "SUCCEEDED", failure: [] };
  /** Work that began before the hold and has not finished. */
  activeWork: number | "unknown" = 0;
  failRegister = false;
  /** Puts whose body held the challenge secret: the positive control for "the secret never reaches state". */
  secretWrites = 0;
  private counter = 1;

  constructor() {
    for (const [name, value] of Object.entries({ "worker-image": WORKER_IMAGE, "worker-executor-image": EXECUTOR_IMAGE, "worker-model-provider": "amazon-bedrock", "worker-model-id": "model-1", "worker-prompt-cache-retention": "short" })) {
      this.ssm.set(`/agentx/${ENV}/${name}`, value);
    }
    this.ssm.set("/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64", "ami-0abcdef1234567890");
  }

  now = (): number => this.clock;
  key = (item: { pk: string; sk: string }): string => `${item.pk}|${item.sk}`;
  tags = (value: Record<string, string>) => Object.entries(value).map(([Key, Value]) => ({ Key, Value }));

  /** A runner the renewal manages (or, with `managed: false`, one it does not), plus its workspace volume. */
  addRunner(options: { managed?: boolean; environment?: string; state?: string; runId?: string } = {}): FakeInstance {
    const id = `i-${hex(this.counter++)}`;
    const rootId = `vol-${hex(this.counter++)}`;
    const volumeId = `vol-${hex(this.counter++)}`;
    const tags: Record<string, string> = { DeploymentMode: "e2e-qualification", Environment: options.environment ?? ENV, ...(options.managed === false ? {} : { "agentx:requalify-managed": "true" }), ...(options.runId ? { "agentx:qualification-run": options.runId } : {}) };
    const instance: FakeInstance = { id, state: options.state ?? "running", tags, ip: `10.0.0.${this.counter}`, volumes: [rootId, volumeId], polls: 0 };
    this.instances.set(id, instance);
    this.volumes.set(rootId, { id: rootId, state: "in-use", tags: {}, attachedTo: id });
    this.volumes.set(volumeId, { id: volumeId, state: "in-use", tags: { ...tags }, attachedTo: id });
    return instance;
  }

  /** Registered rows and the runner pointer, as an earlier renewal (or the script) left them. */
  seedRegistered(options: { generation?: number; expiresInMs?: number; pointerInstance?: string; runId?: string } = {}): void {
    const generation = options.generation ?? 1;
    for (const kind of ["web", "api"] as const) {
      this.ddb.set(this.key(e2eRegisteredRuntimeKey(CATALOG, REQUALIFY_PROFILE_ID, kind)), {
        generation, catalogRevision: generation, expiresAt: new Date(this.clock + (options.expiresInMs ?? 5 * 24 * HOUR)).toISOString(), bindingDigest: createHash("sha256").update(canonicalJson(BINDING)).digest("hex"),
      });
    }
    if (options.pointerInstance !== undefined) {
      this.ddb.set(this.key(e2eModelCheckRunnerKey(REQUALIFY_PROFILE_ID)), { instanceId: options.pointerInstance, roleId: ROLE_ID, transportCorrelationId: randomUUID(), ...(options.runId ? { requalifyRunId: options.runId } : {}) });
    }
  }

  row = (kind: "web" | "api"): Item | undefined => this.ddb.get(this.key(e2eRegisteredRuntimeKey(CATALOG, REQUALIFY_PROFILE_ID, kind)));
  pointerKey = () => e2eModelCheckRunnerKey(REQUALIFY_PROFILE_ID);
  pointer = (): Item | undefined => this.ddb.get(this.key(e2eModelCheckRunnerKey(REQUALIFY_PROFILE_ID)));
  lock = (): Item | undefined => this.ddb.get("RUNTIME_REQUALIFY#linux-arm64-web-api-v1|LOCK");
  hold = (): Item | undefined => this.ddb.get("RUNTIME_REQUALIFY#linux-arm64-web-api-v1|HOLD");

  private runnerObject(key: string): Buffer | undefined {
    const match = /^e2e-runtime\/([A-Z0-9]+):(i-[0-9a-f]+)\/(ready|status|proposal)\.json$/.exec(key);
    if (match === null) return undefined;
    const instance = this.instances.get(match[2]!);
    if (instance === undefined || instance.state !== "running") return undefined;
    const challenge = this.s3.has(`${e2eQualificationPrefix(match[1]!, instance.id)}challenge.json`);
    if (match[3] === "ready") return this.runner.ready && instance.volumes.length > 1 ? Buffer.from("{}") : undefined;
    if (!challenge || this.runner.qualify === "never") return undefined;
    if (match[3] === "status") return Buffer.from(JSON.stringify({ state: this.runner.qualify, reason: "x", finishedAt: "2026-10-27T06:30:00Z", failure: { codes: this.runner.failure } }));
    return this.runner.qualify === "SUCCEEDED" ? (this.runner.proposal ?? Buffer.from(JSON.stringify({ proposal: true, instance: instance.id }))) : undefined;
  }

  // ---- clients: each `send` dispatches on the command's class name -----------------------------------------------------------------------------
  ec2 = { send: async (command: { constructor: { name: string }; input: Record<string, any> }): Promise<any> => {
    const input = command.input;
    switch (command.constructor.name) {
      case "DescribeInstancesCommand": {
        let list = [...this.instances.values()];
        if (input["InstanceIds"] !== undefined) {
          list = (input["InstanceIds"] as string[]).map((id) => this.instances.get(id) ?? (() => { throw named("InvalidInstanceID.NotFound"); })());
        }
        for (const filter of (input["Filters"] ?? []) as Array<{ Name: string; Values: string[] }>) {
          list = list.filter((instance) => filter.Name === "instance-state-name" ? filter.Values.includes(instance.state) : filter.Values.includes(instance.tags[filter.Name.replace(/^tag:/, "")] ?? "\0"));
        }
        for (const instance of list) {
          // Lifecycle moves one step per look: pending -> running, shutting-down -> terminated (its attached volumes detach).
          if (instance.state === "pending" && instance.polls++ >= 1) instance.state = "running";
          else if (instance.state === "shutting-down") { instance.state = "terminated"; for (const id of instance.volumes) { const volume = this.volumes.get(id); if (volume) { volume.state = "available"; delete volume.attachedTo; } } }
        }
        return { Reservations: [{ Instances: list.map((instance) => ({ InstanceId: instance.id, State: { Name: instance.state }, Tags: this.tags(instance.tags), PrivateIpAddress: instance.ip, RootDeviceName: "/dev/xvda",
          BlockDeviceMappings: instance.volumes.map((id, index) => ({ DeviceName: index === 0 ? "/dev/xvda" : "/dev/sdf", Ebs: { VolumeId: id } })) })) }] };
      }
      case "DescribeVolumesCommand": {
        const volume = this.volumes.get((input["VolumeIds"] as string[])[0]!);
        if (volume === undefined) throw named("InvalidVolume.NotFound");
        if (volume.state === "creating") { volume.state = "available"; return { Volumes: [{ VolumeId: volume.id, State: "creating", Tags: this.tags(volume.tags) }] }; }
        return { Volumes: [{ VolumeId: volume.id, State: volume.state, Tags: this.tags(volume.tags) }] };
      }
      case "DescribeLaunchTemplateVersionsCommand":
        return { LaunchTemplateVersions: [{ LaunchTemplateData: { InstanceType: "m6g.large", MetadataOptions: { HttpTokens: "required", HttpPutResponseHopLimit: 1 }, IamInstanceProfile: { Arn: "x" } } }] };
      case "CreateVolumeCommand": {
        const id = `vol-${hex(this.counter++)}`;
        this.volumes.set(id, { id, state: "creating", tags: Object.fromEntries((input["TagSpecifications"][0].Tags as Array<{ Key: string; Value: string }>).map((tag) => [tag.Key, tag.Value])) });
        return { VolumeId: id };
      }
      case "RunInstancesCommand": {
        if (input["ImageId"] === undefined || input["MinCount"] !== 1 || input["MaxCount"] !== 1) throw new Error("bad launch");
        const id = `i-${hex(this.counter++)}`;
        const rootId = `vol-${hex(this.counter++)}`;
        this.launches.push(id);
        const tags = Object.fromEntries((input["TagSpecifications"][0].Tags as Array<{ Key: string; Value: string }>).map((tag) => [tag.Key, tag.Value]));
        this.instances.set(id, { userData: input["UserData"], imageId: input["ImageId"], id, state: "pending", tags, ip: `10.0.1.${this.counter}`, volumes: [rootId], polls: 0 });
        this.volumes.set(rootId, { id: rootId, state: "in-use", tags: {}, attachedTo: id });
        return { Instances: [{ InstanceId: id }] };
      }
      case "AttachVolumeCommand": {
        const instance = this.instances.get(input["InstanceId"]);
        const volume = this.volumes.get(input["VolumeId"]);
        if (instance?.state !== "running" || volume === undefined) throw new Error("cannot attach");
        instance.volumes.push(volume.id);
        volume.state = "in-use";
        volume.attachedTo = instance.id;
        return {};
      }
      case "TerminateInstancesCommand":
        for (const id of input["InstanceIds"] as string[]) { this.terminated.push(id); const instance = this.instances.get(id)!; if (instance.state !== "terminated") instance.state = "shutting-down"; }
        return {};
      case "DeleteVolumeCommand": {
        const volume = this.volumes.get(input["VolumeId"]);
        if (volume === undefined) throw named("InvalidVolume.NotFound");
        if (volume.state === "in-use") throw named("VolumeInUse");
        this.deleted.push(volume.id);
        this.volumes.delete(volume.id);
        return {};
      }
      default: throw new Error(`unexpected EC2 command ${command.constructor.name}`);
    }
  } };

  ssmClient = { send: async (command: { constructor: { name: string }; input: Record<string, any> }): Promise<any> => {
    const input = command.input;
    switch (command.constructor.name) {
      case "GetParametersCommand": return { Parameters: (input["Names"] as string[]).flatMap((Name) => this.ssm.has(Name) ? [{ Name, Value: this.ssm.get(Name) }] : []) };
      case "GetParameterCommand": return { Parameter: { Value: this.ssm.get(input["Name"]) } };
      case "PutParameterCommand": this.ssm.set(input["Name"], input["Value"]); return {};
      default: throw new Error(`unexpected SSM command ${command.constructor.name}`);
    }
  } };

  iam = { send: async (): Promise<any> => ({ Role: { Arn: ROLE_ARN, RoleId: ROLE_ID } }) };
  sns_ = { send: async (command: { input: { Subject: string; Message: string } }): Promise<any> => { this.sns.push({ subject: command.input.Subject, message: command.input.Message }); return {}; } };
  cloudwatch = { send: async (command: { input: { MetricData: Array<{ MetricName: string }> } }): Promise<any> => { this.metrics.push(command.input.MetricData[0]!.MetricName); return {}; } };
  sfn = { send: async (command: { input: { name: string } }): Promise<any> => {
    if (this.executions.includes(command.input.name)) throw named("ExecutionAlreadyExists");
    this.executions.push(command.input.name);
    return {};
  } };

  s3Client = { send: async (command: { constructor: { name: string }; input: Record<string, any> }): Promise<any> => {
    const key = command.input["Key"] as string;
    switch (command.constructor.name) {
      case "GetObjectCommand": {
        const bytes = this.s3.get(key) ?? this.runnerObject(key);
        if (bytes === undefined) throw named("NoSuchKey");
        return { Body: { transformToByteArray: async () => new Uint8Array(bytes) } };
      }
      case "PutObjectCommand": { const body = Buffer.from(command.input["Body"]); if (body.includes(SECRET)) this.secretWrites += 1; this.s3.set(key, body); return {}; }
      case "DeleteObjectCommand": this.s3.delete(key); return {};
      default: throw new Error(`unexpected S3 command ${command.constructor.name}`);
    }
  } };

  private condition(command: { input: Record<string, any> }, existing: Item | undefined): boolean {
    const expression = command.input["ConditionExpression"] as string | undefined;
    if (expression === undefined) return true;
    const names = (command.input["ExpressionAttributeNames"] ?? {}) as Record<string, string>;
    const values = (command.input["ExpressionAttributeValues"] ?? {}) as Record<string, unknown>;
    return expression.split(" OR ").some((clause) => {
      const trimmed = clause.trim();
      if (trimmed === "attribute_not_exists(pk)") return existing === undefined;
      const match = /^(#?\w+) (=|<=) (:\w+)$/.exec(trimmed);
      if (match === null) throw new Error(`fake DynamoDB cannot evaluate ${trimmed}`);
      const actual = existing?.[names[match[1]!] ?? match[1]!] as string | undefined;
      const wanted = values[match[3]!] as string;
      return actual !== undefined && (match[2] === "=" ? actual === wanted : actual <= wanted);
    });
  }

  documentClient = { send: async (command: { constructor: { name: string }; input: Record<string, any> }): Promise<any> => {
    const input = command.input;
    switch (command.constructor.name) {
      case "GetCommand": { const item = this.ddb.get(this.key(input["Key"])); return item === undefined ? {} : { Item: { ...item, ...input["Key"] } }; }
      case "PutCommand": {
        const key = this.key(input["Item"]);
        if (!this.condition(command, this.ddb.get(key))) throw named("ConditionalCheckFailedException");
        this.ddb.set(key, { ...input["Item"] });
        return {};
      }
      case "DeleteCommand": {
        const key = this.key(input["Key"]);
        if (!this.condition(command, this.ddb.get(key))) throw named("ConditionalCheckFailedException");
        this.ddb.delete(key);
        return {};
      }
      default: throw new Error(`unexpected DynamoDB command ${command.constructor.name}`);
    }
  } };

  deps(): RequalifyStepsDependencies {
    return {
      documentClient: this.documentClient as never, s3: this.s3Client as never, tableName: "state", artifactBucketName: "artifacts", setupCatalogId: "setup-catalog-1", featureCatalogId: CATALOG,
      now: this.now, environment: ENV, expectedBinding: BINDING,
      describeInstance: async (instanceId) => {
        const instance = this.instances.get(instanceId);
        return instance === undefined ? undefined : { instanceId, state: instance.state, privateIp: instance.ip, tags: instance.tags };
      },
      config: { workerRoleArn: ROLE_ARN, workerSettingsPrefix: `/agentx/${ENV}/`, amiParameterName: "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64", controlPlaneUrl: "https://cp.example", logGroupName: "/agentx/worker",
        operatorTopicArn: "arn:aws:sns:us-east-1:111122223333:alerts", metricsNamespace: "AgentX", stateMachineArn: "arn:aws:states:us-east-1:111122223333:stateMachine:renew" },
      ec2: this.ec2 as never, ssm: this.ssmClient as never, iam: this.iam as never, sns: this.sns_ as never, cloudwatch: this.cloudwatch as never, sfn: this.sfn as never,
      drain: { activeWork: async () => this.activeWork },
      bootScript: () => "#!/bin/bash\n# boot\n",
      invokePublicKey: async () => `MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE${"A".repeat(88)}`,
      parseProposal: (bytes) => ({ proposal: JSON.parse(bytes.toString("utf8")), sha256: createHash("sha256").update(bytes).digest("hex") }),
    };
  }
}

// ---- the state machine interpreter ---------------------------------------------------------------------------------------------------------------
type Asl = { StartAt: string; States: Record<string, Record<string, any>> };
const at = (value: unknown, path: string): unknown => path.replace(/^\$\.?/, "").split(".").filter((part) => part !== "").reduce<unknown>((current, part) => (current as Record<string, unknown> | undefined)?.[part], value);

export interface MachineRun { status: "Succeeded" | "Failed"; state: Record<string, any>; trace: string[]; payloads: unknown[]; results: unknown[] }

/** Runs the definition: Tasks call `invoke`, Waits advance the cloud's clock, Catch routes a thrown error to its Next. Bounded so a loop in the definition fails the test, not the machine. */
export async function runMachine(definition: object, input: Record<string, unknown>, cloud: FakeCloud, invoke: (payload: { action: string; state: Record<string, any> }) => Promise<unknown>): Promise<MachineRun> {
  const machine = definition as Asl;
  let state: Record<string, any> = input;
  let name = machine.StartAt;
  const run: MachineRun = { status: "Succeeded", state, trace: [], payloads: [], results: [] };
  for (let step = 0; step < 2_000; step += 1) {
    const node = machine.States[name]!;
    run.trace.push(name);
    switch (node["Type"]) {
      case "Task": {
        const payload = { action: node["Parameters"].Payload.action as string, state };
        run.payloads.push(JSON.parse(JSON.stringify(payload)));
        try {
          const result = await invoke(payload);
          run.results.push(JSON.parse(JSON.stringify(result)));
          state = result as Record<string, any>;
          name = node["Next"];
        } catch (error) {
          state = { ...state, error: { Error: (error as Error).name, Cause: (error as Error).message } };
          name = node["Catch"][0].Next;
        }
        break;
      }
      case "Choice": {
        const rule = (node["Choices"] as Array<Record<string, any>>).find((choice) => {
          const value = at(state, choice["Variable"]);
          if ("IsPresent" in choice) return (value !== undefined) === choice["IsPresent"];
          // As in Step Functions: a comparison against a path that is not there is a runtime error, not "no match".
          if (value === undefined) throw new Error(`choice variable ${choice["Variable"]} is not in the state`);
          if ("StringEquals" in choice) return value === choice["StringEquals"];
          if ("BooleanEquals" in choice) return value === choice["BooleanEquals"];
          throw new Error("unsupported choice");
        });
        name = rule?.["Next"] ?? node["Default"];
        break;
      }
      case "Wait": cloud.clock += node["Seconds"] * 1000; name = node["Next"]; break;
      case "Pass": state = { ...state, [(node["ResultPath"] as string).replace("$.", "")]: node["Result"] }; name = node["Next"]; break;
      case "Succeed": run.state = state; return run;
      case "Fail": run.status = "Failed"; run.state = state; return run;
      default: throw new Error(`unsupported state type ${node["Type"]}`);
    }
  }
  throw new Error("the machine did not finish in 2000 transitions");
}
