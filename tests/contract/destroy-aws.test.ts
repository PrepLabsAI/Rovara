import { describe, expect, it } from "vitest";
import { awsDestroyApi, type DestroyApi, type DestroyStack } from "../../packages/cli/src/destroy/aws.js";
import { deleteVolumesWhenFree, STACK_DELETE_TIMEOUT_MS, waitForInstancesGone, waitForStackDelete } from "../../packages/cli/src/destroy/wait.js";

type Handler = (input: Record<string, unknown>) => unknown;
/** One fake client per service, answering by command name; every call is recorded in order. */
function fakeClients(handlers: Record<string, Handler>) {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const client = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      const name = command.constructor.name.replace(/Command$/, "");
      calls.push({ name, input: command.input });
      const handler = handlers[name];
      if (handler === undefined) throw new Error(`test setup: no handler for ${name}`);
      return handler(command.input);
    },
  };
  return { calls, clients: { cloudFormation: client, ec2: client, s3: client, dynamodb: client, logs: client, cognito: client, kms: client, secrets: client } };
}
const notFound = (name: string) => () => { throw Object.assign(new Error(`${name}`), { name }); };

describe("the destroy adapter", () => {
  it("empties a versioned bucket in batches of at most 1,000, every version and delete marker, then deletes it", async () => {
    const versions = Array.from({ length: 1100 }, (_, index) => ({ Key: `k${index}`, VersionId: `v${index}` }));
    let listed = 0;
    const fake = fakeClients({
      ListObjectVersions: () => (listed++ === 0 ? { Versions: versions, DeleteMarkers: [{ Key: "gone", VersionId: "m1" }], IsTruncated: true, NextKeyMarker: "k1099", NextVersionIdMarker: "v1099" } : { Versions: [{ Key: "last", VersionId: "v" }], IsTruncated: false }),
      DeleteObjects: () => ({ Errors: [] }),
      DeleteBucket: () => ({}),
    });
    const progress: number[] = [];
    await awsDestroyApi(fake.clients).deleteBucket("agentx-staging-control-plane-artifacts-1", (count) => progress.push(count));
    const batches = fake.calls.filter((call) => call.name === "DeleteObjects").map((call) => ((call.input.Delete as { Objects: unknown[] }).Objects).length);
    expect(batches.every((size) => size <= 1000)).toBe(true);
    expect(batches.reduce((sum, size) => sum + size, 0)).toBe(1102);
    expect(fake.calls.at(-1)?.name).toBe("DeleteBucket");
    expect(progress.at(-1)).toBe(1102);
  });

  it("treats a bucket that is already gone as deleted", async () => {
    const fake = fakeClients({ ListObjectVersions: notFound("NoSuchBucket") });
    await expect(awsDestroyApi(fake.clients).deleteBucket("b", () => undefined)).resolves.toBeUndefined();
  });

  it("turns a user pool's deletion protection off and deletes its own domain before the pool, refusing a domain that is not its own", async () => {
    const fake = fakeClients({
      DescribeUserPool: () => ({ UserPool: { Id: "us-east-1_AbC", DeletionProtection: "ACTIVE", Domain: "agentx-staging-123456789012" } }),
      UpdateUserPool: () => ({}), DeleteUserPoolDomain: () => ({}), DeleteUserPool: () => ({}),
    });
    await awsDestroyApi(fake.clients).deleteUserPool("us-east-1_AbC", "agentx-staging-123456789012");
    expect(fake.calls.map((call) => call.name)).toEqual(["DescribeUserPool", "UpdateUserPool", "DeleteUserPoolDomain", "DeleteUserPool"]);
    expect(fake.calls[1]!.input).toMatchObject({ UserPoolId: "us-east-1_AbC", DeletionProtection: "INACTIVE" });
    const foreign = fakeClients({ DescribeUserPool: () => ({ UserPool: { Id: "us-east-1_AbC", DeletionProtection: "INACTIVE", Domain: "someone-else" } }) });
    await expect(awsDestroyApi(foreign.clients).deleteUserPool("us-east-1_AbC", "agentx-staging-123456789012")).rejects.toThrow("user pool us-east-1_AbC has the domain someone-else, which is not agentx-staging-123456789012; delete that domain yourself, then run agentx destroy again");
  });

  it("finds workers by all three tags, and drops any answer that does not carry them", async () => {
    const fake = fakeClients({
      DescribeInstances: () => ({ Reservations: [{ Instances: [
        { InstanceId: "i-1", State: { Name: "running" }, Tags: [{ Key: "DeploymentMode", Value: "ec2-ebs" }, { Key: "Environment", Value: "staging" }, { Key: "agentx:env", Value: "staging" }] },
        { InstanceId: "i-2", State: { Name: "running" }, Tags: [{ Key: "DeploymentMode", Value: "ec2-ebs" }, { Key: "Environment", Value: "staging" }] },
      ] }] }),
    });
    const found = await awsDestroyApi(fake.clients).workerInstances("staging");
    expect(found.map((instance) => instance.id)).toEqual(["i-1"]);
    expect(fake.calls[0]!.input.Filters).toEqual(expect.arrayContaining([
      { Name: "tag:DeploymentMode", Values: ["ec2-ebs"] }, { Name: "tag:Environment", Values: ["staging"] }, { Name: "tag:agentx:env", Values: ["staging"] },
    ]));
  });

  it("lists only this environment's secrets, and force-deletes one already scheduled for deletion by restoring it first", async () => {
    const fake = fakeClients({
      ListSecrets: () => ({ SecretList: [{ Name: "agentx/staging/slack" }, { Name: "agentx/staging-eu/slack" }, { Name: "agentx/staging/github-app", DeletedDate: new Date() }] }),
      RestoreSecret: () => ({}), DeleteSecret: () => ({}),
    });
    const api = awsDestroyApi(fake.clients);
    expect(await api.secrets("staging")).toEqual([{ name: "agentx/staging/slack", scheduled: false }, { name: "agentx/staging/github-app", scheduled: true }]);
    expect(fake.calls[0]!.input).toMatchObject({ Filters: [{ Key: "name", Values: ["agentx/staging/"] }], IncludePlannedDeletion: true });
    await api.deleteSecret("agentx/staging/github-app", true);
    expect(fake.calls.slice(-2).map((call) => call.name)).toEqual(["RestoreSecret", "DeleteSecret"]);
    expect(fake.calls.at(-1)!.input).toEqual({ SecretId: "agentx/staging/github-app", ForceDeleteWithoutRecovery: true });
  });

  it("schedules a KMS key's deletion in 7 days, once", async () => {
    let state = "Enabled";
    const fake = fakeClients({ DescribeKey: () => ({ KeyMetadata: { KeyState: state } }), ScheduleKeyDeletion: () => { state = "PendingDeletion"; return {}; } });
    const api = awsDestroyApi(fake.clients);
    expect(await api.scheduleKeyDeletion("k-1")).toBe("scheduled");
    expect(fake.calls.find((call) => call.name === "ScheduleKeyDeletion")!.input).toEqual({ KeyId: "k-1", PendingWindowInDays: 7 });
    expect(await api.scheduleKeyDeletion("k-1")).toBe("already");
  });

  it("treats a KMS key that is already deleted as already scheduled, so a re-run continues", async () => {
    const fake = fakeClients({ DescribeKey: notFound("NotFoundException") });
    expect(await awsDestroyApi(fake.clients).scheduleKeyDeletion("k-1")).toBe("already");
  });

  it("reads a table's tags through its ARN, and answers undefined for one already gone", async () => {
    const fake = fakeClients({ DescribeTable: () => ({ Table: { TableArn: "arn:aws:dynamodb:us-east-1:1:table/t" } }), ListTagsOfResource: () => ({ Tags: [{ Key: "agentx:env", Value: "staging" }] }) });
    expect(await awsDestroyApi(fake.clients).resourceTags({ part: "control-plane", logicalId: "State", type: "AWS::DynamoDB::Table", physicalId: "t" })).toEqual({ "agentx:env": "staging" });
    const gone = fakeClients({ DescribeTable: notFound("ResourceNotFoundException") });
    expect(await awsDestroyApi(gone.clients).resourceTags({ part: "control-plane", logicalId: "State", type: "AWS::DynamoDB::Table", physicalId: "t" })).toBeUndefined();
  });
});

describe("waiting for a stack delete", () => {
  function stackApi(statuses: Array<string | undefined>): DestroyApi {
    let index = 0;
    return {
      stack: async (): Promise<DestroyStack | undefined> => { const status = statuses[Math.min(index++, statuses.length - 1)]; return status === undefined ? undefined : { status, terminationProtection: false, outputs: {} }; },
      latestEvent: async () => "SlackIngressFunction DELETE_IN_PROGRESS",
      failedResources: async () => ["WorkerSecurityGroup: resource sg-1 has a dependent object"],
    } as unknown as DestroyApi;
  }
  const clock = () => { let time = 0; return { now: () => time, sleep: async (ms: number) => { time += ms; } }; };

  it("waits through a 40-minute control-plane delete, with a progress line each minute, and never gives up early", async () => {
    const statuses = [...Array.from({ length: 160 }, () => "DELETE_IN_PROGRESS"), undefined];
    const lines: string[] = [];
    await waitForStackDelete({ api: stackApi(statuses), name: "agentx-staging-control-plane", write: (line) => lines.push(line), ...clock() });
    expect(lines.filter((line) => line.startsWith("still deleting agentx-staging-control-plane")).length).toBeGreaterThanOrEqual(39);
    expect(lines).toContain("still deleting agentx-staging-control-plane: 1 minute so far; last event: SlackIngressFunction DELETE_IN_PROGRESS");
    expect(lines.at(-1)).toBe("deleted agentx-staging-control-plane (40 minutes)");
  });

  it("gives up only after 3 hours, saying a re-run keeps waiting", async () => {
    const time = clock();
    await expect(waitForStackDelete({ api: stackApi(["DELETE_IN_PROGRESS"]), name: "s", write: () => undefined, ...time })).rejects.toThrow("stack s is still DELETE_IN_PROGRESS after 3 hours; it may still finish. Run agentx destroy again to keep waiting and continue");
    expect(time.now()).toBeGreaterThanOrEqual(STACK_DELETE_TIMEOUT_MS);
  });

  it("stops on DELETE_FAILED with the failing resources", async () => {
    await expect(waitForStackDelete({ api: stackApi(["DELETE_FAILED"]), name: "agentx-staging-foundation", write: () => undefined, ...clock() }))
      .rejects.toThrow("stack agentx-staging-foundation could not be deleted: WorkerSecurityGroup: resource sg-1 has a dependent object. Fix that, then run agentx destroy again to continue");
  });

  it("retries a volume that is still attached until it is free", async () => {
    let attempts = 0;
    const api = { deleteVolume: async () => { attempts += 1; if (attempts < 3) throw Object.assign(new Error("in use"), { name: "VolumeInUse" }); } } as unknown as DestroyApi;
    await deleteVolumesWhenFree({ api, ids: ["vol-1"], ...clock() });
    expect(attempts).toBe(3);
  });

  it("ruling F27: gives up on an instance still shutting-down after 30 minutes, pointing at the EC2 console", async () => {
    const time = clock();
    const api = { workerInstances: async () => [{ id: "i-1", state: "shutting-down", tags: {} }] } as unknown as DestroyApi;
    await expect(waitForInstancesGone({ api, env: "staging", ids: ["i-1"], ...time }))
      .rejects.toThrow("worker instances i-1 are still shutting-down after 30 minutes; check them in the EC2 console, then run agentx destroy again");
    expect(time.now()).toBeGreaterThanOrEqual(30 * 60_000);
  });

  it("counts a terminated instance, or one not asked about, as gone", async () => {
    const api = { workerInstances: async () => [{ id: "i-1", state: "terminated", tags: {} }, { id: "i-9", state: "running", tags: {} }] } as unknown as DestroyApi;
    await expect(waitForInstancesGone({ api, env: "staging", ids: ["i-1"], ...clock() })).resolves.toBeUndefined();
  });
});
