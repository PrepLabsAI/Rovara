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
      RestoreSecret: () => ({}), DeleteSecret: () => ({}), DescribeSecret: () => ({ Name: "agentx/staging/github-app", DeletedDate: new Date() }),
    });
    const api = awsDestroyApi(fake.clients);
    expect(await api.secrets("staging")).toEqual([{ name: "agentx/staging/slack", scheduled: false }, { name: "agentx/staging/github-app", scheduled: true }]);
    expect(fake.calls[0]!.input).toMatchObject({ Filters: [{ Key: "name", Values: ["agentx/staging/"] }], IncludePlannedDeletion: true });
    await api.deleteSecret("agentx/staging/github-app");
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

describe("the destroy adapter, fix round 1", () => {
  const tags = (env: string) => [{ Key: "DeploymentMode", Value: "ec2-ebs" }, { Key: "Environment", Value: env }, { Key: "agentx:env", Value: env }];

  it("never returns a volume EC2 is already deleting after termination", async () => {
    const fake = fakeClients({ DescribeVolumes: () => ({ Volumes: [
      { VolumeId: "vol-root", State: "deleting", Tags: tags("staging") },
      { VolumeId: "vol-gone", State: "deleted", Tags: tags("staging") },
      { VolumeId: "vol-ws", State: "available", Tags: tags("staging") },
    ] }) });
    expect((await awsDestroyApi(fake.clients).workerVolumes("staging")).map((volume) => volume.id)).toEqual(["vol-ws"]);
    expect(fake.calls[0]!.input.Filters).toEqual(expect.arrayContaining([{ Name: "status", Values: ["creating", "available", "in-use", "error"] }]));
  });

  it("finds a secret scheduled for deletion by itself, restores it, then force-deletes it", async () => {
    const scheduled = fakeClients({ DescribeSecret: () => ({ Name: "agentx/staging/slack", DeletedDate: new Date() }), RestoreSecret: () => ({}), DeleteSecret: () => ({}) });
    await awsDestroyApi(scheduled.clients).deleteSecret("agentx/staging/slack");
    expect(scheduled.calls.map((call) => call.name)).toEqual(["DescribeSecret", "RestoreSecret", "DeleteSecret"]);
    const live = fakeClients({ DescribeSecret: () => ({ Name: "agentx/staging/slack" }), DeleteSecret: () => ({}) });
    await awsDestroyApi(live.clients).deleteSecret("agentx/staging/slack");
    expect(live.calls.map((call) => call.name)).toEqual(["DescribeSecret", "DeleteSecret"]);
    const gone = fakeClients({ DescribeSecret: notFound("ResourceNotFoundException") });
    await expect(awsDestroyApi(gone.clients).deleteSecret("agentx/staging/slack")).resolves.toBeUndefined();
  });

  it("leaves a table that is already deleting, and retries the delete while the protection change settles", async () => {
    const deleting = fakeClients({ DescribeTable: () => ({ Table: { TableStatus: "DELETING", DeletionProtectionEnabled: true } }) });
    await awsDestroyApi(deleting.clients).deleteTable("t");
    expect(deleting.calls.map((call) => call.name)).toEqual(["DescribeTable"]);
    let attempts = 0;
    const slept: number[] = [];
    const busy = fakeClients({
      DescribeTable: () => ({ Table: { TableStatus: "ACTIVE", DeletionProtectionEnabled: true } }), UpdateTable: () => ({}),
      DeleteTable: () => { attempts += 1; if (attempts < 3) throw Object.assign(new Error("updating"), { name: "ResourceInUseException" }); return {}; },
    });
    await awsDestroyApi(busy.clients, { sleep: async (ms) => { slept.push(ms); } }).deleteTable("t");
    expect(busy.calls.map((call) => call.name)).toEqual(["DescribeTable", "UpdateTable", "DeleteTable", "DeleteTable", "DeleteTable"]);
    expect(busy.calls[1]!.input).toEqual({ TableName: "t", DeletionProtectionEnabled: false });
    expect(slept).toHaveLength(2);
    const unprotected = fakeClients({ DescribeTable: () => ({ Table: { TableStatus: "ACTIVE" } }), DeleteTable: () => ({}) });
    await awsDestroyApi(unprotected.clients).deleteTable("t");
    expect(unprotected.calls.map((call) => call.name)).toEqual(["DescribeTable", "DeleteTable"]);
    const gone = fakeClients({ DescribeTable: notFound("ResourceNotFoundException") });
    await expect(awsDestroyApi(gone.clients).deleteTable("t")).resolves.toBeUndefined();
  });

  it("deletes a log group and an alias, treating one already gone as deleted", async () => {
    const fake = fakeClients({ DeleteLogGroup: () => ({}), DeleteAlias: () => ({}) });
    const api = awsDestroyApi(fake.clients);
    await api.deleteLogGroup("g");
    await api.deleteAlias("alias/agentx/staging/workspaces");
    expect(fake.calls).toEqual([{ name: "DeleteLogGroup", input: { logGroupName: "g" } }, { name: "DeleteAlias", input: { AliasName: "alias/agentx/staging/workspaces" } }]);
    const gone = fakeClients({ DeleteLogGroup: notFound("ResourceNotFoundException"), DeleteAlias: notFound("NotFoundException") });
    await expect(awsDestroyApi(gone.clients).deleteLogGroup("g")).resolves.toBeUndefined();
    await expect(awsDestroyApi(gone.clients).deleteAlias("alias/agentx/staging/workspaces")).resolves.toBeUndefined();
  });

  it("throws when S3 cannot delete some objects", async () => {
    const fake = fakeClients({ ListObjectVersions: () => ({ Versions: [{ Key: "k", VersionId: "v" }], IsTruncated: false }), DeleteObjects: () => ({ Errors: [{ Key: "k", Code: "AccessDenied" }] }) });
    await expect(awsDestroyApi(fake.clients).deleteBucket("b", () => undefined)).rejects.toThrow("bucket b: 1 objects could not be deleted (AccessDenied); run agentx destroy again");
    expect(fake.calls.map((call) => call.name)).not.toContain("DeleteBucket");
  });

  it("answers no tags, not gone, for a bucket without a tag set", async () => {
    const fake = fakeClients({ GetBucketTagging: notFound("NoSuchTagSet") });
    expect(await awsDestroyApi(fake.clients).resourceTags({ part: "access", logicalId: "B", type: "AWS::S3::Bucket", physicalId: "b" })).toEqual({});
  });

  it("finds a log group's tags by its exact name across pages", async () => {
    const fake = fakeClients({
      DescribeLogGroups: (input) => (input.nextToken === undefined
        ? { logGroups: [{ logGroupName: "g-longer", logGroupArn: "arn:other" }], nextToken: "p2" }
        : { logGroups: [{ logGroupName: "g", logGroupArn: "arn:g" }] }),
      ListTagsForResource: (input) => ({ tags: input.resourceArn === "arn:g" ? { "agentx:env": "staging" } : { "agentx:env": "other" } }),
    });
    expect(await awsDestroyApi(fake.clients).resourceTags({ part: "foundation", logicalId: "L", type: "AWS::Logs::LogGroup", physicalId: "g" })).toEqual({ "agentx:env": "staging" });
  });

  it("deletes a user pool without protection or a domain, and one already gone", async () => {
    const plain = fakeClients({ DescribeUserPool: () => ({ UserPool: { Id: "p", DeletionProtection: "INACTIVE" } }), DeleteUserPool: () => ({}) });
    await awsDestroyApi(plain.clients).deleteUserPool("p", "agentx-staging-123456789012");
    expect(plain.calls.map((call) => call.name)).toEqual(["DescribeUserPool", "DeleteUserPool"]);
    const gone = fakeClients({ DescribeUserPool: notFound("ResourceNotFoundException") });
    await expect(awsDestroyApi(gone.clients).deleteUserPool("p", "agentx-staging-123456789012")).resolves.toBeUndefined();
  });

  it("reads every page of secrets, instances, volumes, aliases and stack resources", async () => {
    const paged = <T>(first: T, second: T, token: string) => (input: Record<string, unknown>) => (input[token] === undefined ? first : second);
    const fake = fakeClients({
      ListSecrets: paged({ SecretList: [{ Name: "agentx/staging/a" }], NextToken: "t" }, { SecretList: [{ Name: "agentx/staging/b" }] }, "NextToken"),
      DescribeInstances: paged({ Reservations: [{ Instances: [{ InstanceId: "i-1", State: { Name: "running" }, Tags: tags("staging") }] }], NextToken: "t" }, { Reservations: [{ Instances: [{ InstanceId: "i-2", State: { Name: "running" }, Tags: tags("staging") }] }] }, "NextToken"),
      DescribeVolumes: paged({ Volumes: [{ VolumeId: "vol-1", State: "available", Tags: tags("staging") }], NextToken: "t" }, { Volumes: [{ VolumeId: "vol-2", State: "in-use", Tags: tags("staging") }] }, "NextToken"),
      ListAliases: paged({ Aliases: [{ AliasName: "alias/agentx/staging/a" }], Truncated: true, NextMarker: "m" }, { Aliases: [{ AliasName: "alias/agentx/staging/b" }], Truncated: false }, "Marker"),
      ListStackResources: paged({ StackResourceSummaries: [{ LogicalResourceId: "A", ResourceType: "AWS::S3::Bucket", PhysicalResourceId: "a" }], NextToken: "t" }, { StackResourceSummaries: [{ LogicalResourceId: "B", ResourceType: "AWS::KMS::Key", PhysicalResourceId: "b" }] }, "NextToken"),
    });
    const api = awsDestroyApi(fake.clients);
    expect((await api.secrets("staging")).map((entry) => entry.name)).toEqual(["agentx/staging/a", "agentx/staging/b"]);
    expect((await api.workerInstances("staging")).map((entry) => entry.id)).toEqual(["i-1", "i-2"]);
    expect((await api.workerVolumes("staging")).map((entry) => entry.id)).toEqual(["vol-1", "vol-2"]);
    expect((await api.aliases("staging")).map((entry) => entry.name)).toEqual(["alias/agentx/staging/a", "alias/agentx/staging/b"]);
    expect((await api.stackResources("s")).map((entry) => entry.logicalId)).toEqual(["A", "B"]);
  });

  it("reports only the failures since the latest delete began, not a failure from an earlier run", async () => {
    const fake = fakeClients({ DescribeStackEvents: () => ({ StackEvents: [
      { LogicalResourceId: "s", ResourceStatus: "DELETE_FAILED" },
      { LogicalResourceId: "NewSg", ResourceStatus: "DELETE_FAILED", ResourceStatusReason: "has a dependent object" },
      { LogicalResourceId: "s", ResourceStatus: "DELETE_IN_PROGRESS" },
      { LogicalResourceId: "s", ResourceStatus: "DELETE_FAILED" },
      { LogicalResourceId: "OldSg", ResourceStatus: "DELETE_FAILED", ResourceStatusReason: "old" },
      { LogicalResourceId: "s", ResourceStatus: "DELETE_IN_PROGRESS" },
    ] }) });
    expect(await awsDestroyApi(fake.clients).failedResources("s")).toEqual(["NewSg: has a dependent object"]);
  });
});

describe("waits, fix round 1", () => {
  const clock = () => { let time = 0; return { now: () => time, sleep: async (ms: number) => { time += ms; } }; };

  it("sleeps one poll before the first check, so a stale DELETE_FAILED from an earlier run does not stop a re-run", async () => {
    const time = clock();
    const api = { stack: async () => (time.now() === 0 ? { status: "DELETE_FAILED", terminationProtection: false, outputs: {} } : undefined), failedResources: async () => ["old"] } as unknown as DestroyApi;
    await expect(waitForStackDelete({ api, name: "s", write: () => undefined, ...time })).resolves.toBeUndefined();
  });

  it("prints the actual stack timeout", async () => {
    const api = { stack: async () => ({ status: "DELETE_IN_PROGRESS", terminationProtection: false, outputs: {} }), latestEvent: async () => undefined } as unknown as DestroyApi;
    await expect(waitForStackDelete({ api, name: "s", write: () => undefined, timeoutMs: 90 * 60_000, ...clock() })).rejects.toThrow("stack s is still DELETE_IN_PROGRESS after 90 minutes;");
  });

  it("ends every AWS error that stops a wait with what to do next", async () => {
    const throttled = () => { throw Object.assign(new Error("Rate exceeded"), { name: "Throttling" }); };
    const api = { stack: throttled, workerInstances: throttled, deleteVolume: throttled } as unknown as DestroyApi;
    await expect(waitForStackDelete({ api, name: "s", write: () => undefined, ...clock() })).rejects.toThrow(/Rate exceeded.*run agentx destroy again to continue$/);
    await expect(waitForInstancesGone({ api, env: "staging", ids: ["i-1"], ...clock() })).rejects.toThrow(/Rate exceeded.*run agentx destroy again to continue$/);
    await expect(deleteVolumesWhenFree({ api, ids: ["vol-1"], ...clock() })).rejects.toThrow(/Rate exceeded.*run agentx destroy again to continue$/);
  });

  it("counts a volume that is already gone or being deleted as done", async () => {
    const errors = [Object.assign(new Error("The volume 'vol-1' is 'deleting'"), { name: "IncorrectState" }), Object.assign(new Error("no such volume"), { name: "InvalidVolume.NotFound" })];
    let index = 0;
    const api = { deleteVolume: async () => { const error = errors[index++]; if (error !== undefined) throw error; } } as unknown as DestroyApi;
    await expect(deleteVolumesWhenFree({ api, ids: ["vol-1", "vol-2"], ...clock() })).resolves.toBeUndefined();
    expect(index).toBe(2);
  });
});

describe("the destroy adapter, queued minors", () => {
  it("deletes a stack with its own request token, and reports only that delete's failures", async () => {
    const fake = fakeClients({
      DeleteStack: () => ({}),
      DescribeStackEvents: () => ({ StackEvents: [
        { LogicalResourceId: "s", ResourceStatus: "DELETE_FAILED", ClientRequestToken: "mine" },
        { LogicalResourceId: "Sg", ResourceStatus: "DELETE_FAILED", ResourceStatusReason: "now", ClientRequestToken: "mine" },
        { LogicalResourceId: "s", ResourceStatus: "DELETE_IN_PROGRESS", ClientRequestToken: "mine" },
        { LogicalResourceId: "Old", ResourceStatus: "DELETE_FAILED", ResourceStatusReason: "before", ClientRequestToken: "earlier" },
      ] }),
    });
    const api = awsDestroyApi(fake.clients);
    const token = await api.deleteStack("s");
    expect(fake.calls[0]!.input).toEqual({ StackName: "s", ClientRequestToken: token });
    expect(token).toMatch(/^[a-zA-Z0-9][-a-zA-Z0-9]{0,127}$/);
    expect(await api.failedResources("s", "mine")).toEqual(["Sg: now"]);
  });

  it("passes the delete's token to the failure report", async () => {
    let asked: string | undefined;
    const api = { stack: async () => ({ status: "DELETE_FAILED", terminationProtection: false, outputs: {} }), failedResources: async (_name: string, token?: string) => { asked = token; return ["Sg: now"]; } } as unknown as DestroyApi;
    let time = 0;
    await expect(waitForStackDelete({ api, name: "s", token: "mine", write: () => undefined, now: () => time, sleep: async (ms) => { time += ms; } })).rejects.toThrow("Sg: now");
    expect(asked).toBe("mine");
  });

  it("retries turning a busy table's deletion protection off", async () => {
    let updates = 0;
    const fake = fakeClients({
      DescribeTable: () => ({ Table: { TableStatus: "UPDATING", DeletionProtectionEnabled: true } }),
      UpdateTable: () => { updates += 1; if (updates < 2) throw Object.assign(new Error("busy"), { name: "ResourceInUseException" }); return {}; },
      DeleteTable: () => ({}),
    });
    await awsDestroyApi(fake.clients, { sleep: async () => undefined }).deleteTable("t");
    expect(fake.calls.map((call) => call.name)).toEqual(["DescribeTable", "UpdateTable", "UpdateTable", "DeleteTable"]);
  });
});

describe("deleting a secret that is being force-deleted", () => {
  const refused = () => { throw Object.assign(new Error("it was deleted"), { name: "InvalidRequestException" }); };

  it("confirms by describing again that a secret refusing RestoreSecret is gone", async () => {
    let described = 0;
    const fake = fakeClients({
      DescribeSecret: () => { described += 1; if (described <= 2) return { Name: "agentx/staging/a", DeletedDate: new Date() }; throw Object.assign(new Error("gone"), { name: "ResourceNotFoundException" }); },
      RestoreSecret: refused,
    });
    const slept: number[] = [];
    await awsDestroyApi(fake.clients, { sleep: async (ms) => { slept.push(ms); } }).deleteSecret("agentx/staging/a");
    expect(fake.calls.map((call) => call.name)).toEqual(["DescribeSecret", "RestoreSecret", "DescribeSecret", "DescribeSecret"]);
    expect(slept).toEqual([5000, 5000]);
  });

  it("gives up after 2 minutes when the secret is still there, saying to run destroy again", async () => {
    const fake = fakeClients({ DescribeSecret: () => ({ Name: "agentx/staging/a", DeletedDate: new Date() }), RestoreSecret: refused });
    let time = 0;
    await expect(awsDestroyApi(fake.clients, { sleep: async (ms) => { time += ms; } }).deleteSecret("agentx/staging/a"))
      .rejects.toThrow("secret agentx/staging/a refused RestoreSecret and is still listed after 2 minutes; run agentx destroy again to continue");
    expect(time).toBe(120_000);
    expect(fake.calls.map((call) => call.name)).not.toContain("DeleteSecret");
  });

  it("does not treat another RestoreSecret error as gone", async () => {
    const fake = fakeClients({ DescribeSecret: () => ({ Name: "agentx/staging/a", DeletedDate: new Date() }), RestoreSecret: () => { throw Object.assign(new Error("denied"), { name: "AccessDeniedException" }); } });
    await expect(awsDestroyApi(fake.clients, { sleep: async () => undefined }).deleteSecret("agentx/staging/a")).rejects.toThrow("denied");
  });
});
