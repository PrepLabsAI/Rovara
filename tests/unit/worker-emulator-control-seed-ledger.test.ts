// Slice 2, s2-emulator-run: the worker's calls to Rovara local AWS's control API (emulator-control.ts), the TS22 seeding (service-seed-aws.ts) and the request ledger (emulator-ledger.ts). HIGH risk (secrets, control API):
// every test about a call looks at what reaches `docker` (arguments), at the files the seam saw, and at the errors, not at the code that builds them.
import { describe, expect, it } from "vitest";
import { runNetworkAddresses, runNetworkBridge, runNetworkHelperIp, runNetworkLabelArgs, runNetworkName } from "../../packages/worker/src/run-network.js";
import { EmulatorControlError, emulatorControlCall, type EmulatorControlTarget } from "../../packages/worker/src/emulator-control.js";
import { EmulatorLedgerError, LEDGER_LIMITS, emulatorLedgerPort, parseLedgerSummary } from "../../packages/worker/src/emulator-ledger.js";
import { EmulatorSeedError, buildAwsSeedDocument, seedEmulator, seedReportCovers } from "../../packages/worker/src/service-seed-aws.js";
import { newLocalAwsCredentials, type HelperFiles } from "../../packages/worker/src/service-helpers.js";
import type { TaskAwsResource } from "../../packages/contracts/src/test-services-aws-resources.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";

const RUN = "11111111-1111-4111-8111-111111111111";
const NOW = 1_800_000_000_000;
const PROBE_IMAGE = `rovara/worker@sha256:${"b".repeat(64)}`;
const net = { name: runNetworkName(RUN), gateway: runNetworkAddresses(153).gateway, labelArgs: () => runNetworkLabelArgs({ runId: RUN, workspace: "0123456789abcdef", createdAt: NOW, expiresAt: NOW + 1_500_000 }) };
void runNetworkBridge;

interface Seen { name: string; content: string; mode: number; presentDuringCall: boolean }
function harness(answer: (args: string[]) => { exitCode: number | null; stdout?: string; timedOut?: boolean } = () => ({ exitCode: 0, stdout: "" })) {
  const calls: string[][] = [];
  const seen: Seen[] = [];
  const present = new Map<string, string>();
  const removedContainers: string[] = [];
  const docker: DockerCli = {
    run(args) {
      calls.push([...args]);
      if (args[0] === "rm") { removedContainers.push(...args.filter((arg) => !arg.startsWith("-") && arg !== "rm")); return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }); }
      for (const entry of seen) entry.presentDuringCall = present.has(entry.name);
      const result = answer([...args]);
      return Promise.resolve({ exitCode: result.exitCode, stdout: result.stdout ?? "", stderr: "Unable to do the thing", ...(result.timedOut === undefined ? {} : { timedOut: result.timedOut }) });
    },
  };
  const files: HelperFiles = {
    write(name, content, mode) { seen.push({ name, content, mode, presentDuringCall: false }); present.set(name, content); return Promise.resolve(`/run/rovara-test/${name}`); },
    remove(name) { present.delete(name); return Promise.resolve(); },
  };
  const credentials = newLocalAwsCredentials();
  const target = (extra: Partial<EmulatorControlTarget> = {}): EmulatorControlTarget => ({
    docker, network: net, helper: { container: "rvi-h0123456789", address: runNetworkHelperIp(153, 0), ports: [4566] }, probeImage: PROBE_IMAGE, files, controlToken: credentials.controlToken, ...extra,
  });
  return { calls, seen, present, removedContainers, credentials, target };
}
const callOf = (h: ReturnType<typeof harness>): string[] => h.calls.find((call) => call[0] === "run")!;

describe("emulatorControlCall", () => {
  it("makes the call from a hardened probe container: the token in a 0600 env file, the answer from standard output, both files gone afterwards", async () => {
    const h = harness(() => ({ exitCode: 0, stdout: '{"ok":true}' }));
    const out = await emulatorControlCall(h.target(), { path: "ledgerSummary", method: "GET", print: true });
    expect(out).toBe('{"ok":true}');
    const env = h.seen.find((entry) => entry.name.endsWith(".env"))!;
    expect(env.content).toBe(`ROVARA_CONTROL_TOKEN=${h.credentials.controlToken}\n`);
    expect(env.mode).toBe(0o600);
    expect(env.presentDuringCall).toBe(true);
    expect(h.present.size).toBe(0);
    const args = callOf(h);
    expect(args[args.indexOf("--env-file") + 1]).toBe(`/run/rovara-test/${env.name}`);
    expect(args).toContain("--read-only");
    expect(args[args.indexOf("--cap-drop") + 1]).toBe("ALL");
  });
  it("without print the answer is not returned", async () => {
    const h = harness(() => ({ exitCode: 0, stdout: "secret-looking answer" }));
    expect(await emulatorControlCall(h.target(), { path: "reset", method: "POST" })).toBe("");
  });
  it("the token is in no argument, and a body is a mounted file, never an argument", async () => {
    const h = harness(() => ({ exitCode: 0, stdout: "{}" }));
    const body = JSON.stringify({ region: "us-east-1", s3: { buckets: [{ name: "orders-bucket" }] } });
    await emulatorControlCall(h.target(), { path: "seed", method: "POST", body, print: true });
    const text = h.calls.flat().join(" ");
    expect(text).not.toContain(h.credentials.controlToken);
    expect(text).not.toContain("orders-bucket");
    const bodyFile = h.seen.find((entry) => entry.name.endsWith(".body"))!;
    expect(bodyFile.content).toBe(body);
    expect(bodyFile.presentDuringCall).toBe(true);
    expect(callOf(h).join(" ")).toContain(`/run/rovara-test/${bodyFile.name}:/rovara/body.json:ro`);
    expect(h.present.size).toBe(0);
  });
  it("fails closed with one fixed sentence on a non-zero exit, a timeout, a thrown docker call: the container is removed by name, the files are gone, and nothing Docker said is repeated", async () => {
    for (const answer of [() => ({ exitCode: 1 }), () => ({ exitCode: null, timedOut: true }), () => ({ exitCode: 125 })]) {
      const h = harness(answer);
      const error = await emulatorControlCall(h.target(), { path: "reset", method: "POST" }).then(() => undefined, (failure: unknown) => failure);
      expect(error).toBeInstanceOf(EmulatorControlError);
      expect((error as EmulatorControlError).reason).toBe("failed");
      expect((error as Error).message).toBe("The test services' AWS control call did not complete");
      expect(JSON.stringify([(error as Error).message, (error as Error).stack])).not.toContain("Unable to do the thing");
      expect(h.removedContainers).toHaveLength(1);
      expect(h.removedContainers[0]).toMatch(/^rvi-h0123456789-c[0-9a-f]{8}$/u);
      expect(h.present.size).toBe(0);
    }
    const throwing: DockerCli = { run: () => Promise.reject(new Error("daemon down: token abc")) };
    const h = harness();
    const error = await emulatorControlCall(h.target({ docker: throwing }), { path: "reset", method: "POST" }).then(() => undefined, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(EmulatorControlError);
    expect((error as Error).message).not.toContain("daemon");
    expect(h.present.size).toBe(0);
  });
  it("refuses, before any file or docker call, a token that is not plain or too short, an unknown path name, a GET with a body, a body that is too big, and a helper with no port", async () => {
    const good = harness();
    const cases: Array<[string, EmulatorControlTarget, Parameters<typeof emulatorControlCall>[1]]> = [
      ["short token", good.target({ controlToken: "short" }), { path: "reset", method: "POST" }],
      ["newline token", good.target({ controlToken: `${good.credentials.controlToken}\nX=1` }), { path: "reset", method: "POST" }],
      ["long token", good.target({ controlToken: "a".repeat(65) }), { path: "reset", method: "POST" }],
      ["unknown path", good.target(), { path: "tick" as "reset", method: "POST" }],
      ["inherited path name", good.target(), { path: "constructor" as "reset", method: "POST" }],
      ["GET body", good.target(), { path: "ledgerSummary", method: "GET", body: "{}" }],
      ["big body", good.target(), { path: "seed", method: "POST", body: "x".repeat(70 * 1024) }],
      ["no port", good.target({ helper: { container: "c", address: runNetworkHelperIp(153, 0), ports: [] } }), { path: "reset", method: "POST" }],
      ["address outside the run", good.target({ helper: { container: "c", address: "10.1.2.3", ports: [4566] } }), { path: "reset", method: "POST" }],
    ];
    for (const [label, target, request] of cases) {
      const error = await emulatorControlCall(target, request).then(() => undefined, (failure: unknown) => failure);
      expect(error, label).toBeInstanceOf(EmulatorControlError);
      expect((error as EmulatorControlError).reason, label).toBe("refused");
    }
    expect(good.calls).toHaveLength(0);
    expect(good.seen).toHaveLength(0);
  });
  it("a call already stopped makes no docker call; one stopped while it runs removes its container and reports stopped", async () => {
    const early = harness();
    const controller = new AbortController();
    controller.abort();
    await expect(emulatorControlCall(early.target({ signal: controller.signal }), { path: "reset", method: "POST" })).rejects.toMatchObject({ reason: "stopped" });
    expect(early.calls).toHaveLength(0);
    const late = harness();
    const live = new AbortController();
    const target = late.target({ signal: live.signal, docker: { run: (args) => { if (args[0] === "run") live.abort(); return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }); } } });
    await expect(emulatorControlCall(target, { path: "reset", method: "POST" })).rejects.toMatchObject({ reason: "stopped" });
    expect(late.present.size).toBe(0);
  });
  it("a file that cannot be written is a refusal, and what was written is removed", async () => {
    const h = harness();
    let writes = 0;
    const files: HelperFiles = { write(name, content, mode) { writes += 1; if (writes === 2) return Promise.reject(new Error("disk full")); return h.target().files.write(name, content, mode); }, remove: (name) => h.target().files.remove(name) };
    await expect(emulatorControlCall(h.target({ files }), { path: "seed", method: "POST", body: "{}" })).rejects.toMatchObject({ reason: "refused" });
    expect(h.calls).toHaveLength(0);
    expect(h.present.size).toBe(0);
  });
});

describe("buildAwsSeedDocument (TS22)", () => {
  const resources: TaskAwsResource[] = [
    { kind: "table", name: "orders", keySchema: { partitionKey: { name: "orderId", type: "S" }, sortKey: { name: "createdAt", type: "N" } } },
    { kind: "table", name: "sessions", keySchema: { partitionKey: { name: "id", type: "B" } } },
    { kind: "bucket", name: "orders-archive" },
    { kind: "queue", name: "order-events" },
    { kind: "queue", name: "order-events.fifo" },
  ];
  it("makes the fork's seed document: buckets, on-demand tables with exactly their key attributes, queues (a .fifo name is a FIFO queue)", () => {
    expect(buildAwsSeedDocument("us-west-2", resources)).toEqual({
      region: "us-west-2",
      s3: { buckets: [{ name: "orders-archive" }] },
      dynamodb: { tables: [
        { request: { TableName: "orders", KeySchema: [{ AttributeName: "orderId", KeyType: "HASH" }, { AttributeName: "createdAt", KeyType: "RANGE" }], AttributeDefinitions: [{ AttributeName: "orderId", AttributeType: "S" }, { AttributeName: "createdAt", AttributeType: "N" }], BillingMode: "PAY_PER_REQUEST" } },
        { request: { TableName: "sessions", KeySchema: [{ AttributeName: "id", KeyType: "HASH" }], AttributeDefinitions: [{ AttributeName: "id", AttributeType: "B" }], BillingMode: "PAY_PER_REQUEST" } },
      ] },
      sqs: { queues: [{ name: "order-events" }, { name: "order-events.fifo", attributes: { FifoQueue: "true" } }] },
    });
  });
  it("leaves out a service with no resources", () => {
    expect(buildAwsSeedDocument("us-east-1", [{ kind: "bucket", name: "only-bucket" }])).toEqual({ region: "us-east-1", s3: { buckets: [{ name: "only-bucket" }] } });
  });
  it("refuses, with one fixed sentence that names nothing, a resource list or a region that does not pass the strict forms", () => {
    const secretLike = ["AK", "IA", "ABCDEFGHIJKLMNOP"].join("");
    const bad: Array<[string, unknown, string]> = [
      ["upper-case bucket", [{ kind: "bucket", name: "Orders" }], "us-east-1"],
      ["bucket with ..", [{ kind: "bucket", name: "a..b" }], "us-east-1"],
      ["address-shaped bucket", [{ kind: "bucket", name: "192.168.1.1" }], "us-east-1"],
      ["short table", [{ kind: "table", name: "ab", keySchema: { partitionKey: { name: "id", type: "S" } } }], "us-east-1"],
      ["table without keys", [{ kind: "table", name: "orders" }], "us-east-1"],
      ["sort key = partition key", [{ kind: "table", name: "orders", keySchema: { partitionKey: { name: "id", type: "S" }, sortKey: { name: "id", type: "S" } } }], "us-east-1"],
      ["key type", [{ kind: "table", name: "orders", keySchema: { partitionKey: { name: "id", type: "X" } } }], "us-east-1"],
      ["queue with a space", [{ kind: "queue", name: "a b" }], "us-east-1"],
      ["queue with a dot", [{ kind: "queue", name: "a.b" }], "us-east-1"],
      ["topic", [{ kind: "topic", name: "events" }], "us-east-1"],
      ["extra field", [{ kind: "bucket", name: "bucket-one", acl: "public" }], "us-east-1"],
      ["duplicate", [{ kind: "queue", name: "dup" }, { kind: "queue", name: "dup" }], "us-east-1"],
      ["secret-shaped name", [{ kind: "queue", name: secretLike }], "us-east-1"],
      ["25 resources", Array.from({ length: 25 }, (_value, index) => ({ kind: "bucket", name: `bucket-${String(index).padStart(2, "0")}` })), "us-east-1"],
      ["bad region", [{ kind: "bucket", name: "bucket-one" }], "us-east-1;rm"],
      ["empty region", [{ kind: "bucket", name: "bucket-one" }], ""],
    ];
    for (const [label, list, region] of bad) {
      let error: unknown;
      try { buildAwsSeedDocument(region, list as TaskAwsResource[]); } catch (failure) { error = failure; }
      expect(error, label).toBeInstanceOf(EmulatorSeedError);
      expect((error as Error).message, label).toBe("The project's AWS resources cannot be created in the test services");
    }
  });
});

describe("seedEmulator (TS22): POST /_rovara/seed with the control token, fail closed", () => {
  const resources: TaskAwsResource[] = [
    { kind: "bucket", name: "orders-archive" },
    { kind: "table", name: "orders", keySchema: { partitionKey: { name: "orderId", type: "S" } } },
    { kind: "queue", name: "order-events" },
  ];
  const goodReport = { ok: true, failed: 0, steps: [
    { service: "s3", action: "CreateBucket", name: "orders-archive", ok: true },
    { service: "dynamodb", action: "CreateTable", name: "orders", ok: true },
    { service: "sqs", action: "CreateQueue", name: "order-events", ok: true },
  ] };
  it("sends the document as a mounted file with the token in the env file, and succeeds on a complete report", async () => {
    const h = harness(() => ({ exitCode: 0, stdout: JSON.stringify(goodReport) }));
    await seedEmulator({ target: h.target(), region: "us-east-1", resources });
    const bodyFile = h.seen.find((entry) => entry.name.endsWith(".body"))!;
    expect(JSON.parse(bodyFile.content)).toEqual(buildAwsSeedDocument("us-east-1", resources));
    expect(h.seen.find((entry) => entry.name.endsWith(".env"))!.content).toBe(`ROVARA_CONTROL_TOKEN=${h.credentials.controlToken}\n`);
    const args = callOf(h).slice(callOf(h).indexOf(PROBE_IMAGE) + 1);
    expect(args).toContain("/_rovara/seed");
    expect(args[args.indexOf("--control") + 1]).toBe("POST");
    const text = h.calls.flat().join(" ");
    for (const secretish of [h.credentials.controlToken, "orders-archive", "orderId", "order-events"]) expect(text).not.toContain(secretish);
    expect(h.present.size).toBe(0);
  });
  it("makes no call at all when there is nothing to create", async () => {
    const h = harness();
    await seedEmulator({ target: h.target(), region: "us-east-1", resources: [] });
    expect(h.calls).toHaveLength(0);
    expect(h.seen).toHaveLength(0);
  });
  it("fails when the emulator answers anything but a complete success: a failed exit (a 403 or 422 is a non-zero exit of the probe), not JSON, a missing, extra, failed or renamed step, ok false", async () => {
    const withStep = (index: number, change: Record<string, unknown>) => ({ ...goodReport, steps: goodReport.steps.map((step, at) => (at === index ? { ...step, ...change } : step)) });
    const answers: Array<[string, { exitCode: number; stdout: string }]> = [
      ["403/422 (probe exits 1)", { exitCode: 1, stdout: "" }],
      ["not json", { exitCode: 0, stdout: "<html>" }],
      ["empty", { exitCode: 0, stdout: "" }],
      ["array", { exitCode: 0, stdout: "[]" }],
      ["ok false", { exitCode: 0, stdout: JSON.stringify({ ...goodReport, ok: false }) }],
      ["failed 1", { exitCode: 0, stdout: JSON.stringify({ ...goodReport, failed: 1 }) }],
      ["a step not ok", { exitCode: 0, stdout: JSON.stringify(withStep(1, { ok: false, error: "ResourceInUseException: orders" })) }],
      ["a missing step", { exitCode: 0, stdout: JSON.stringify({ ...goodReport, steps: goodReport.steps.slice(0, 2) }) }],
      ["an extra step", { exitCode: 0, stdout: JSON.stringify({ ...goodReport, steps: [...goodReport.steps, { service: "sns", action: "CreateTopic", name: "t", ok: true }] }) }],
      ["a renamed step", { exitCode: 0, stdout: JSON.stringify(withStep(0, { name: "another-bucket" })) }],
      ["a wrong action", { exitCode: 0, stdout: JSON.stringify(withStep(2, { action: "PurgeQueue" })) }],
      ["a duplicated step that hides a missing one", { exitCode: 0, stdout: JSON.stringify({ ...goodReport, steps: [goodReport.steps[0], goodReport.steps[0], goodReport.steps[2]] }) }],
      ["ok as a string", { exitCode: 0, stdout: JSON.stringify({ ...goodReport, ok: "true" }) }],
    ];
    for (const [label, answer] of answers) {
      const h = harness(() => answer);
      const error = await seedEmulator({ target: h.target(), region: "us-east-1", resources }).then(() => undefined, (failure: unknown) => failure);
      expect(error, label).toBeInstanceOf(EmulatorSeedError);
      expect((error as EmulatorSeedError).reason, label).toBe("failed");
      expect((error as Error).message, label).toBe("The test services' AWS resources were not created");
      expect(JSON.stringify([(error as Error).message, (error as Error).stack]), label).not.toMatch(/orders|ResourceInUse|order-events/u);
      expect(h.present.size, label).toBe(0);
    }
  });
  it("a refused resource list is refused before any file is written or docker is called", async () => {
    const h = harness();
    await expect(seedEmulator({ target: h.target(), region: "us-east-1", resources: [{ kind: "bucket", name: "BAD_NAME" }] })).rejects.toMatchObject({ reason: "refused" });
    expect(h.calls).toHaveLength(0);
    expect(h.seen).toHaveLength(0);
  });
  it("a control call that is stopped is a stopped seed; a bad token is a refused one", async () => {
    const controller = new AbortController();
    controller.abort();
    const stopped = harness();
    await expect(seedEmulator({ target: stopped.target({ signal: controller.signal }), region: "us-east-1", resources })).rejects.toMatchObject({ reason: "stopped" });
    const badToken = harness();
    await expect(seedEmulator({ target: badToken.target({ controlToken: "nope" }), region: "us-east-1", resources })).rejects.toMatchObject({ reason: "refused" });
    expect(badToken.calls).toHaveLength(0);
  });
  it("seedReportCovers needs exactly one step per resource", () => {
    expect(seedReportCovers(goodReport, resources)).toBe(true);
    expect(seedReportCovers({ ...goodReport, steps: [] }, [])).toBe(true);
    expect(seedReportCovers(null, resources)).toBe(false);
    expect(seedReportCovers({ ok: true, failed: 0, steps: [null, null, null] }, resources)).toBe(false);
  });
});

describe("the ledger (GET /_rovara/ledger/summary)", () => {
  const summary = {
    s3: { calls: 41, unsupported: 1, errors: 2, operations: { PutObject: { calls: 12, unsupported: 0, errors: 0 }, GetObject: { calls: 28, unsupported: 0, errors: 2 }, PutBucketReplication: { calls: 1, unsupported: 1, errors: 1 } } },
    sqs: { calls: 3, unsupported: 0, errors: 0, operations: { SendMessage: { calls: 3, unsupported: 0, errors: 0 } } },
  };
  it("reads the fork's summary shape", () => {
    const ledger = parseLedgerSummary(JSON.stringify(summary));
    expect(ledger.services.map((service) => service.service)).toEqual(["s3", "sqs"]);
    expect(ledger.services[0]).toMatchObject({ calls: 41, unsupported: 1, errors: 2 });
    expect(ledger.services[0]!.operations.map((row) => row.operation).sort()).toEqual(["GetObject", "PutBucketReplication", "PutObject"]);
    expect(parseLedgerSummary("{}")).toEqual({ services: [] });
  });
  it("refuses anything that is not exactly that shape within the limits", () => {
    const op = { calls: 1, unsupported: 0, errors: 0 };
    const bad: Array<[string, string]> = [
      ["not json", "<html>"], ["array", "[]"], ["null", "null"], ["a number", "5"],
      ["service value a number", JSON.stringify({ s3: 5 })],
      ["bad service key", JSON.stringify({ "S3 ": { ...op, operations: {} } })],
      ["upper-case key", JSON.stringify({ S3: { ...op, operations: {} } })],
      ["missing operations", JSON.stringify({ s3: op })],
      ["operations an array", JSON.stringify({ s3: { ...op, operations: [] } })],
      ["negative", JSON.stringify({ s3: { ...op, calls: -1, operations: {} } })],
      ["float", JSON.stringify({ s3: { ...op, calls: 1.5, operations: {} } })],
      ["string count", JSON.stringify({ s3: { ...op, calls: "1", operations: {} } })],
      ["huge", JSON.stringify({ s3: { ...op, calls: LEDGER_LIMITS.count + 1, operations: {} } })],
      ["missing count", JSON.stringify({ s3: { calls: 1, unsupported: 0, operations: {} } })],
      ["operation row a string", JSON.stringify({ s3: { ...op, operations: { Put: "x" } } })],
      ["empty operation name", JSON.stringify({ s3: { ...op, operations: { "": op } } })],
      ["long operation name", JSON.stringify({ s3: { ...op, operations: { ["x".repeat(LEDGER_LIMITS.operationChars + 1)]: op } } })],
      ["too many operations", JSON.stringify({ s3: { ...op, operations: Object.fromEntries(Array.from({ length: LEDGER_LIMITS.operationsPerService + 1 }, (_v, index) => [`Op${String(index)}`, op])) } })],
      ["too many services", JSON.stringify(Object.fromEntries(Array.from({ length: LEDGER_LIMITS.services + 1 }, (_v, index) => [`svc${String(index)}`, { ...op, operations: {} }])))],
    ];
    for (const [label, text] of bad) expect(() => parseLedgerSummary(text), label).toThrow(EmulatorLedgerError);
  });
  it("the port reads it through the control call, with the token and no body, and fails closed (it throws, it never answers 'no calls') when the call or the answer is bad", async () => {
    const ok = harness(() => ({ exitCode: 0, stdout: JSON.stringify(summary) }));
    const ledger = await emulatorLedgerPort(ok.target())();
    expect(ledger.services).toHaveLength(2);
    const args = callOf(ok).slice(callOf(ok).indexOf(PROBE_IMAGE) + 1);
    expect(args).toContain("/_rovara/ledger/summary");
    expect(args[args.indexOf("--control") + 1]).toBe("GET");
    expect(args).not.toContain("--body-file");
    expect(ok.seen.find((entry) => entry.name.endsWith(".env"))!.content).toBe(`ROVARA_CONTROL_TOKEN=${ok.credentials.controlToken}\n`);
    expect(ok.calls.flat().join(" ")).not.toContain(ok.credentials.controlToken);
    expect(ok.present.size).toBe(0);
    const forbidden = harness(() => ({ exitCode: 1, stdout: "" }));
    await expect(emulatorLedgerPort(forbidden.target())()).rejects.toBeInstanceOf(EmulatorControlError);
    const garbage = harness(() => ({ exitCode: 0, stdout: "not json" }));
    await expect(emulatorLedgerPort(garbage.target())()).rejects.toBeInstanceOf(EmulatorLedgerError);
    const refused = harness();
    await expect(emulatorLedgerPort(refused.target({ controlToken: "x" }))()).rejects.toBeInstanceOf(EmulatorControlError);
    expect(refused.calls).toHaveLength(0);
  });
});
