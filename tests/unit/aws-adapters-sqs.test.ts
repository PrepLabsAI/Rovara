// Convergence lane A2: the SQS queue adapter passes the shared queue and outbox suites (standard and FIFO queues, over the in-memory SQS
// double), and what SQS makes different is pinned here: size limits, ordering, duplicates, poison messages and redrive, and the outbox's two
// AWS triggers (the stream hook and the scheduled backstop).
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GetQueueAttributesCommand, SQSServiceException } from "@aws-sdk/client-sqs";
import { OUTBOX_PENDING_INDEX, QUEUE_LIMITS, change, companyScoped, isAllowedModuleSpecifier, when, type DocumentChange, type OutboxRelayReport } from "@agentx/contracts";
import {
  DEAD_LETTER_ATTRIBUTE,
  DynamoStreamChangeFeed,
  MAX_MESSAGE_ATTRIBUTES,
  SqsQueueError,
  SqsQueueService,
  changeOfRecord,
  createOutboxBackstop,
  createOutboxRelayHook,
  createSqsQueueServiceFromSettings,
  pendingOutboxRow,
  queuesOfSettings,
  type DynamoStreamRecord,
} from "../../packages/aws-adapters/src/index.js";
import * as sqsPluginModule from "../../packages/aws-adapters/src/sqs/plugin.js";
import { createAdapterRegistry, loadAdapters, parsePluginConfig, type ModuleImporter } from "../../packages/broker/src/ports/adapter-registry.js";
import { createTransactionalOutbox } from "../../packages/broker/src/ports/transactional-outbox.js";
import { runOutboxConformance } from "../support/ports/outbox-conformance.js";
import { runQueueConformance } from "../support/ports/queue-conformance.js";
import { dynamoWorld } from "../support/ports/dynamodb-harness.js";
import { FakeSqs, type SqsRequest } from "../support/ports/sqs-fake.js";
import { SQS_BASE_URL, sqsQueueHarness, sqsWorld } from "../support/ports/sqs-harness.js";

const COMPANY = "org_aaaaaaaaaaaaaaaaaaaa";
const OTHER = "org_bbbbbbbbbbbbbbbbbbbb";
const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const urlOf = (name: string, fifo = false): string => `${SQS_BASE_URL}/${name}${fifo ? ".fifo" : ""}`;
const sends = (fake: FakeSqs, url?: string): SqsRequest[] => fake.requests.filter((request) => request.operation === "SendMessage" && (url === undefined || request.input.QueueUrl === url));
const service = (name: string): Error => new SQSServiceException({ name, $fault: "server", $metadata: {}, message: `raw ${name} text with a queue url ${SQS_BASE_URL}/secret-queue` });

// ---- The shared suites ----

runQueueConformance("sqs standard queue (in-memory SQS double)", sqsQueueHarness(false));
runQueueConformance("sqs FIFO queue (in-memory SQS double)", sqsQueueHarness(true));

for (const fifo of [false, true]) {
  // The suite's "oldest first" cases hold for what the double delivers (oldest first here); real SQS gives no such order on a standard
  // queue, which is why the core's consumers must not depend on it (the ordering tests below).
  runOutboxConformance(`generic outbox over the DynamoDB store and the SQS ${fifo ? "FIFO" : "standard"} queue`, {
    async create() {
      const dynamo = dynamoWorld();
      const sqs = sqsWorld({ order: "oldest-first" });
      return { store: dynamo.store, queues: sqs.provisioning(fifo), outbox: createTransactionalOutbox({ store: dynamo.store, queues: sqs.provisioning(fifo) }), settleIndexes: dynamo.settled };
    },
  });
}

// ---- What a queue is: modes, options read back from SQS ----

describe("the SQS adapter reads a queue's policy from SQS and declares what it can do", () => {
  it("says what a standard queue and a FIFO queue guarantee", async () => {
    const world = sqsWorld();
    const standard = await world.provisioning(false).queue("a");
    const fifo = await world.provisioning(true).queue("b");
    expect(standard.capabilities).toEqual({ ordered: false, dedupe: false, maxDelaySeconds: 900, detectsStaleHandle: false, deadLettersById: false });
    expect(fifo.capabilities).toEqual({ ordered: true, dedupe: true, maxDelaySeconds: 0, detectsStaleHandle: false, deadLettersById: false });
  });

  it("refuses options the queue was not declared with, and a name nothing declares", async () => {
    const world = sqsWorld();
    world.provision("jobs", { visibilityTimeoutSeconds: 40, maxReceiveCount: 5 });
    await expect(world.service.queue("jobs", { visibilityTimeoutSeconds: 41 })).rejects.toThrow(/different options/);
    await expect(world.service.queue("jobs", { maxReceiveCount: 4 })).rejects.toThrow(/different options/);
    await expect(world.service.queue("jobs", { ordered: true })).rejects.toThrow(/different options/);
    expect(await world.service.queue("jobs", { visibilityTimeoutSeconds: 40, maxReceiveCount: 5, ordered: false })).toBeDefined();
    world.provision("plain");
    await expect(world.service.queue("plain", { maxReceiveCount: 3 })).rejects.toThrow(/different options/);
    await expect(world.service.queue("nobody")).rejects.toThrow(/no SQS queue is declared/);
    await expect(world.service.queue("bad name")).rejects.toThrow();
    await expect(world.service.queue("jobs", { visibilityTimeoutSeconds: 1.5 })).rejects.toThrow();
  });

  it("reads each queue's attributes once, even when asked for at the same time, and asks again after a failed read", async () => {
    const world = sqsWorld();
    world.provision("once");
    await Promise.all([world.service.queue("once"), world.service.queue("once"), world.service.queue("once")]);
    await world.service.queue("once");
    expect(world.fake.requests.filter((request) => request.operation === "GetQueueAttributes" && request.input.QueueUrl === urlOf("once"))).toHaveLength(1);
    world.provision("flaky");
    world.fake.fail("GetQueueAttributes", service("ServiceUnavailable"));
    await expect(world.service.queue("flaky")).rejects.toBeInstanceOf(SqsQueueError);
    expect(await world.service.queue("flaky")).toBeDefined();
  });

  it("refuses a dead-letter URL that is not the queue its redrive policy names, and a URL that disagrees with the queue's kind", async () => {
    const world = sqsWorld();
    world.fake.createQueue(urlOf("dlq"));
    world.fake.createQueue(urlOf("other-dlq"));
    world.fake.createQueue(urlOf("main"), { maxReceiveCount: 3, deadLetterUrl: urlOf("dlq") });
    const mismatched = new SqsQueueService({
      client: world.fake, queues: { main: { url: urlOf("main"), deadLetterUrl: urlOf("other-dlq") }, kind: { url: urlOf("main"), deadLetterUrl: urlOf("dlq", true) }, ok: { url: urlOf("main"), deadLetterUrl: urlOf("dlq") } },
    });
    await expect(mismatched.queue("main")).rejects.toThrow(/not the queue its redrive policy names/);
    await expect(mismatched.queue("kind")).rejects.toThrow(/same kind/);
    expect(await mismatched.queue("ok", { maxReceiveCount: 3 })).toBeDefined();
  });

  it("refuses a queue URL that is not an SQS queue URL, and one that says FIFO while the queue is not", async () => {
    const fake = new FakeSqs();
    fake.createQueue(urlOf("plain"));
    const make = (queues: Record<string, { url: string }>) => createSqsQueueServiceFromSettings({ queues }, fake);
    await expect(make({ q: { url: "ftp://x/y" } }).queue("q")).rejects.toThrow(/not an SQS queue URL/);
    await expect(make({ q: { url: `${SQS_BASE_URL}/plain.fifo` } }).queue("q")).rejects.toThrow();
    // The double has no such FIFO queue; make one that disagrees with its own name by serving the wrong attribute.
    fake.createQueue(urlOf("liar.fifo"));
    const original = fake.send.bind(fake);
    fake.send = async (command) => {
      const out = (await original(command)) as { Attributes?: Record<string, string> };
      if (command instanceof GetQueueAttributesCommand && out.Attributes !== undefined) delete out.Attributes.FifoQueue;
      return out;
    };
    await expect(make({ q: { url: urlOf("liar.fifo") } }).queue("q")).rejects.toThrow(/disagree/);
  });
});

// ---- Message size and content ----

describe("message size: SQS counts the body and its attributes together", () => {
  it("refuses a body over the port's limit and sends nothing", async () => {
    const world = sqsWorld();
    const queue = await world.provisioning(false).queue("size");
    await expect(queue.enqueue({ body: "x".repeat(QUEUE_LIMITS.maxBodyBytes) })).rejects.toThrow(/at most/);
    expect(sends(world.fake)).toHaveLength(0);
  });

  it("counts attribute names, the type name and values, and refuses a message over SQS's 256 KiB total", async () => {
    const world = sqsWorld();
    const queue = await world.provisioning(false).queue("size");
    // The JSON of a string body is the text plus two quotes.
    const quotesOnly = 2;
    const attributeBytes = "kind".length + "String".length + "dispatch".length;
    const room = 262_144 - quotesOnly - attributeBytes;
    await expect(queue.enqueue({ body: "x".repeat(room + 1), attributes: { kind: "dispatch" } })).rejects.toThrow(/at most 262144 bytes/);
    expect(sends(world.fake)).toHaveLength(0);
    await queue.enqueue({ body: "x".repeat(room), attributes: { kind: "dispatch" } });
    expect(sends(world.fake)).toHaveLength(1);
    // The same body with no attributes has room for them to spare.
    await queue.enqueue({ body: "x".repeat(room + 1) });
    expect(sends(world.fake)).toHaveLength(2);
  });

  it("counts a body by its UTF-8 bytes, not its characters", async () => {
    const world = sqsWorld();
    const queue = await world.provisioning(false).queue("size");
    // 3 bytes each; 87,381 of them plus the quotes is 262,145 bytes.
    await expect(queue.enqueue({ body: "€".repeat(87_381) })).rejects.toThrow();
    await queue.enqueue({ body: "€".repeat(87_380) });
    expect(sends(world.fake)).toHaveLength(1);
  });

  it("honours a queue whose own maximum message size is smaller", async () => {
    const world = sqsWorld();
    world.provision("small", {}, { maximumMessageSize: 1_024 });
    const queue = await world.service.queue("small");
    await expect(queue.enqueue({ body: "x".repeat(1_023) })).rejects.toThrow(/at most 1024 bytes/);
    await queue.enqueue({ body: "x".repeat(1_000) });
  });

  it("carries at most nine attributes of its own (SQS's ten less the dead-letter marker's) and refuses names and values SQS refuses", async () => {
    const world = sqsWorld();
    const queue = await world.provisioning(false).queue("attrs");
    const many = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`a${index}`, "v"]));
    expect(MAX_MESSAGE_ATTRIBUTES).toBe(9);
    await queue.enqueue({ body: 1, attributes: many(9) });
    await expect(queue.enqueue({ body: 1, attributes: many(10) })).rejects.toThrow(/at most 9 attributes/);
    for (const bad of [{ "": "v" }, { "has space": "v" }, { ".lead": "v" }, { "trail.": "v" }, { "a..b": "v" }, { "AWS.thing": "v" }, { "amazon.thing": "v" }, { [DEAD_LETTER_ATTRIBUTE]: "v" }, { ok: "" }, { ok: "bad\u0000value" }, { ok: "lone\ud800" }]) {
      await expect(queue.enqueue({ body: 1, attributes: bad })).rejects.toThrow();
    }
    expect(sends(world.fake)).toHaveLength(1);
  });

  it("writes the two characters SQS refuses as JSON escapes, so the body comes back unchanged", async () => {
    const world = sqsWorld();
    const queue = await world.provisioning(false).queue("chars");
    const body = { text: "a￾b￿c", control: "tab\tnul\u0000bell\u0007", lone: "x\ud800y", emoji: "\u{1F600}" };
    await queue.enqueue({ body });
    const sent = sends(world.fake)[0]!.input.MessageBody as string;
    expect(sent).not.toMatch(/[￾￿]/);
    const [message] = await queue.receive();
    expect(message!.body).toEqual(body);
  });

  it("refuses text SQS cannot hold in a group, dedupe id or reason, and a delay and visibility that are not whole seconds in range", async () => {
    const world = sqsWorld();
    const standard = await world.provisioning(false).queue("a");
    const fifo = await world.provisioning(true).queue("b");
    await expect(standard.enqueue({ body: 1, delaySeconds: 1.5 })).rejects.toThrow(/whole number/);
    await expect(standard.enqueue({ body: 1, delaySeconds: 901 })).rejects.toThrow();
    await standard.enqueue({ body: 1, delaySeconds: 900 });
    await expect(fifo.enqueue({ body: 1, delaySeconds: 1 })).rejects.toThrow(/from 0 to 0/);
    await expect(fifo.enqueue({ body: 1, groupId: "has space" })).rejects.toThrow(/groupId/);
    await expect(fifo.enqueue({ body: 1, groupId: "g".repeat(129) })).rejects.toThrow(/groupId/);
    await expect(standard.enqueue({ body: 1, dedupeId: "bad\u0000" })).rejects.toThrow();
    await expect(standard.receive({ visibilityTimeoutSeconds: 1.5 })).rejects.toThrow();
    await expect(standard.receive({ waitSeconds: -1 })).rejects.toThrow();
    await expect(standard.changeVisibility("handle", QUEUE_LIMITS.maxSeconds + 1)).rejects.toThrow();
  });
});

// ---- Ordering ----

describe("ordering: FIFO keeps a group's order, a standard queue promises none", () => {
  it("is received one message per request on a FIFO queue, because a FIFO request may return several of one group", async () => {
    const world = sqsWorld();
    const queue = await world.provisioning(true).queue("order");
    for (const body of ["a1", "a2", "a3"]) await queue.enqueue({ body, groupId: "a" });
    await queue.enqueue({ body: "b1", groupId: "b" });
    const got = await queue.receive({ maxMessages: 10 });
    expect(got.map((message) => message.body)).toEqual(["a1", "b1"]);
    const asked = world.fake.requests.filter((request) => request.operation === "ReceiveMessage" && request.input.QueueUrl === urlOf("order", true));
    expect(asked.map((request) => request.input.MaxNumberOfMessages)).toEqual([1, 1, 1]);
    // a2 and a3 were never received, so their receive counts are untouched.
    expect(world.fake.stored(urlOf("order", true)).filter((message) => message.groupId === "a").map((message) => message.receiveCount)).toEqual([1, 0, 0]);
  });

  it("delivers a group's messages in the order they were sent, one after the other, across acknowledgements", async () => {
    const world = sqsWorld();
    const queue = await world.provisioning(true).queue("order");
    for (const body of ["a1", "a2", "a3"]) await queue.enqueue({ body, groupId: "a" });
    const seen: unknown[] = [];
    for (let round = 0; round < 3; round += 1) {
      const [message] = await queue.receive({ maxMessages: 10 });
      seen.push(message!.body);
      expect(await queue.receive({ maxMessages: 10 })).toEqual([]);
      await queue.ack(message!.receiptHandle);
    }
    expect(seen).toEqual(["a1", "a2", "a3"]);
  });

  it("gives a message with no group a group of its own, so unrelated messages never wait for each other, and hides that group", async () => {
    const world = sqsWorld();
    const queue = await world.provisioning(true).queue("solo");
    await queue.enqueue({ body: "one" });
    await queue.enqueue({ body: "two" });
    const groups = sends(world.fake).map((request) => request.input.MessageGroupId as string);
    expect(new Set(groups).size).toBe(2);
    expect(groups.every((group) => group.startsWith("rovara-solo-"))).toBe(true);
    const got = await queue.receive({ maxMessages: 2 });
    expect(got.map((message) => message.body)).toEqual(["one", "two"]);
    expect(got.every((message) => message.groupId === undefined)).toBe(true);
  });

  it("makes no order promise on a standard queue: the double shuffles, and every message still comes exactly once", async () => {
    const world = sqsWorld();
    const queue = await world.provisioning(false).queue("loose");
    const bodies = Array.from({ length: 30 }, (_, index) => index);
    for (const body of bodies) await queue.enqueue({ body });
    const received: number[] = [];
    for (;;) {
      const batch = await queue.receive({ maxMessages: 10 });
      if (batch.length === 0) break;
      for (const message of batch) {
        received.push(message.body as number);
        await queue.ack(message.receiptHandle);
      }
    }
    expect([...received].sort((a, b) => a - b)).toEqual(bodies);
    expect(received).not.toEqual(bodies);
    expect(queue.capabilities.ordered).toBe(false);
  });

  it("asks a standard queue for the whole batch in one request, and a long poll waits at most SQS's 20 seconds, on the first request only", async () => {
    const world = sqsWorld();
    const standard = await world.provisioning(false).queue("std");
    await standard.receive({ maxMessages: 7, waitSeconds: 60 });
    const request = world.fake.requests.find((entry) => entry.operation === "ReceiveMessage")!.input;
    expect(request.MaxNumberOfMessages).toBe(7);
    expect(request.WaitTimeSeconds).toBe(20);
    const fifo = await world.provisioning(true).queue("fifo");
    await fifo.enqueue({ body: 1 });
    await fifo.enqueue({ body: 2 });
    await fifo.receive({ maxMessages: 3, waitSeconds: 5 });
    const fifoRequests = world.fake.requests.filter((entry) => entry.operation === "ReceiveMessage" && entry.input.QueueUrl === urlOf("fifo", true));
    expect(fifoRequests.map((entry) => entry.input.WaitTimeSeconds)).toEqual([5, undefined, undefined]);
  });
});

// ---- Duplicates ----

describe("duplicates: suppressed on FIFO by the deduplication id, reported only for what this process sent", () => {
  it("sends the id's hash as the deduplication id, so any text is accepted and nothing leaks", async () => {
    const world = sqsWorld();
    const queue = await world.provisioning(true).queue("dup");
    const id = `${companyScoped(COMPANY, "OUTBOX#op 1 with spaces and é")}#${"long".repeat(60)}`;
    await queue.enqueue({ body: 1, dedupeId: id });
    expect(sends(world.fake)[0]!.input.MessageDeduplicationId).toBe(sha(id));
  });

  it("drops a repeat inside five minutes and says so, then accepts the id again when the window has passed", async () => {
    const world = sqsWorld();
    const queue = await world.provisioning(true).queue("dup");
    const first = await queue.enqueue({ body: "x", dedupeId: "same" });
    expect(await queue.enqueue({ body: "x again", dedupeId: "same" })).toEqual({ messageId: first.messageId, duplicate: true });
    expect(world.fake.stored(urlOf("dup", true))).toHaveLength(1);
    world.fake.advance(QUEUE_LIMITS.dedupeWindowSeconds + 1);
    const later = await queue.enqueue({ body: "x later", dedupeId: "same" });
    expect(later.duplicate).toBe(false);
    expect(world.fake.stored(urlOf("dup", true))).toHaveLength(2);
  });

  it("cannot tell a repeat sent by another process: SQS drops it all the same, and the flag stays false", async () => {
    const world = sqsWorld();
    const mine = await world.provisioning(true).queue("dup");
    const theirs = await new SqsQueueService({ client: world.fake, queues: { dup: world.provision("dup", { ordered: true }) }, now: () => world.fake.now }).queue("dup");
    await mine.enqueue({ body: "x", dedupeId: "shared" });
    const repeat = await theirs.enqueue({ body: "x", dedupeId: "shared" });
    expect(repeat.duplicate).toBe(false);
    expect(world.fake.stored(urlOf("dup", true))).toHaveLength(1);
  });

  it("sends no deduplication id to a standard queue (SQS refuses one) and so stores both copies", async () => {
    const world = sqsWorld();
    const queue = await world.provisioning(false).queue("std");
    expect(queue.capabilities.dedupe).toBe(false);
    expect((await queue.enqueue({ body: "x", dedupeId: "same" })).duplicate).toBe(false);
    expect((await queue.enqueue({ body: "x", dedupeId: "same" })).duplicate).toBe(false);
    expect(sends(world.fake).every((request) => request.input.MessageDeduplicationId === undefined)).toBe(true);
    expect(world.fake.stored(urlOf("std"))).toHaveLength(2);
  });

  it("gives a FIFO message with no dedupe id a fresh one, so nothing is suppressed", async () => {
    const world = sqsWorld();
    const queue = await world.provisioning(true).queue("dup");
    await queue.enqueue({ body: "same body" });
    await queue.enqueue({ body: "same body" });
    expect(world.fake.stored(urlOf("dup", true))).toHaveLength(2);
    expect(new Set(sends(world.fake).map((request) => request.input.MessageDeduplicationId)).size).toBe(2);
  });
});

// ---- Handles ----

describe("receipt handles: SQS cannot always say a handle is stale", () => {
  it("answers false for a handle SQS has never issued or no longer holds, and true for one it cannot judge", async () => {
    const world = sqsWorld();
    const queue = await world.provisioning(false).queue("handles");
    await queue.enqueue({ body: "a" });
    expect(await queue.ack("never-issued")).toBe(false);
    expect(await queue.changeVisibility("never-issued", 5)).toBe(false);
    const [first] = await queue.receive({ visibilityTimeoutSeconds: 5 });
    world.fake.advance(6);
    const [second] = await queue.receive();
    // The earlier handle of a message received again: SQS answers success and removes nothing. The adapter reports what SQS said.
    expect(await queue.ack(first!.receiptHandle)).toBe(true);
    expect(world.fake.stored(urlOf("handles"))).toHaveLength(1);
    expect(await queue.ack(second!.receiptHandle)).toBe(true);
    expect(world.fake.stored(urlOf("handles"))).toHaveLength(0);
    // A message that is not in flight cannot have its visibility changed.
    await queue.enqueue({ body: "b" });
    const [third] = await queue.receive({ visibilityTimeoutSeconds: 5 });
    world.fake.advance(6);
    expect(await queue.changeVisibility(third!.receiptHandle, 30)).toBe(false);
  });

  it("maps SQS failures to a SqsQueueError that names the call and SQS's error and never repeats SQS's text", async () => {
    const world = sqsWorld();
    const queue = await world.provisioning(false).queue("faults");
    world.fake.fail("SendMessage", service("ServiceUnavailable"));
    const sendError = await queue.enqueue({ body: 1 }).catch((error: unknown) => error);
    expect(sendError).toBeInstanceOf(SqsQueueError);
    expect((sendError as SqsQueueError).message).toBe("SQS SendMessage failed: ServiceUnavailable");
    expect((sendError as SqsQueueError).retryable).toBe(true);
    expect(String((sendError as SqsQueueError).message)).not.toContain("secret-queue");
    world.fake.fail("ReceiveMessage", service("AccessDeniedException"));
    const receiveError = await queue.receive().catch((error: unknown) => error);
    expect((receiveError as SqsQueueError).retryable).toBe(false);
    world.fake.fail("DeleteMessage", service("RequestThrottled"));
    await expect(queue.ack("h")).rejects.toMatchObject({ message: "SQS DeleteMessage failed: RequestThrottled", retryable: true });
    // A message not sent because SQS failed does not appear.
    expect(world.fake.stored(urlOf("faults"))).toHaveLength(0);
  });
});

// ---- Poison messages, dead letters, redrive ----

describe("poison messages: SQS's redrive policy moves them, and the adapter reaches the dead letters it can", () => {
  const setup = (options: { fifo?: boolean } = {}) => {
    const world = sqsWorld();
    const fifo = options.fifo === true;
    const queue = world.provisioning(fifo);
    return { world, open: () => queue.queue("jobs", { visibilityTimeoutSeconds: 10, maxReceiveCount: 2, ...(fifo ? { ordered: true } : {}) }), url: urlOf("jobs", fifo), dead: urlOf("jobs-dead", fifo) };
  };

  it("leaves a message that was received maxReceiveCount times without an ack to SQS, which moves it to the dead-letter queue with its id", async () => {
    const { world, open, url, dead } = setup();
    const queue = await open();
    const sent = await queue.enqueue({ body: "poison", attributes: { kind: "x" } });
    expect(await queue.receive()).toHaveLength(1);
    world.fake.advance(11);
    expect((await queue.receive())[0]!.receiveCount).toBe(2);
    world.fake.advance(11);
    expect(await queue.receive()).toEqual([]);
    expect(world.fake.stored(url)).toEqual([]);
    expect(world.fake.stored(dead).map((message) => message.messageId)).toEqual([sent.messageId]);
    // The adapter can look at it: SQS's move keeps the id and has no reason of ours.
    const listed = await queue.listDeadLetters();
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({ messageId: sent.messageId, body: "poison", reason: "max_receives", attributes: { kind: "x" } });
  });

  it("redrives a dead letter by its id as a new message with its count reset, and discards another", async () => {
    const { world, open, url, dead } = setup();
    const queue = await open();
    const a = await queue.enqueue({ body: { n: 1 }, attributes: { k: "v" } });
    const b = await queue.enqueue({ body: { n: 2 } });
    const c = await queue.enqueue({ body: { n: 3 } });
    for (let round = 0; round < 2; round += 1) {
      await queue.receive({ maxMessages: 10 });
      world.fake.advance(11);
    }
    expect(await queue.receive({ maxMessages: 10 })).toEqual([]);
    expect(world.fake.stored(dead)).toHaveLength(3);

    expect(await queue.redrive(b.messageId)).toBe(true);
    expect(world.fake.stored(dead).map((message) => message.messageId).sort()).toEqual([a.messageId, c.messageId].sort());
    const [back] = await queue.receive();
    expect(back).toMatchObject({ body: { n: 2 }, receiveCount: 1 });
    expect(await queue.redrive(b.messageId)).toBe(false);

    expect(await queue.discardDeadLetter(c.messageId)).toBe(true);
    expect(await queue.discardDeadLetter(c.messageId)).toBe(false);
    // The scan took messages to look at them and put every other one straight back: nothing is hidden or lost.
    expect(world.fake.stored(dead).map((message) => message.messageId)).toEqual([a.messageId]);
    expect(await queue.redrive("no-such-id")).toBe(false);
    const releases = world.fake.requests.filter((request) => request.operation === "ChangeMessageVisibility" && request.input.QueueUrl === dead);
    expect(releases.every((request) => request.input.VisibilityTimeout === 0)).toBe(true);
    void url;
  });

  it("stops a by-id scan at its limit rather than reading the dead-letter queue for ever", async () => {
    const world = sqsWorld({ adapter: { deadLetterScanLimit: 20 } });
    const provisioned = world.provisioning(false);
    const queue = await provisioned.queue("jobs", { visibilityTimeoutSeconds: 10, maxReceiveCount: 1 });
    for (let index = 0; index < 50; index += 1) await queue.enqueue({ body: index });
    for (let round = 0; round < 6; round += 1) await queue.receive({ maxMessages: 10 });
    world.fake.advance(11);
    for (let round = 0; round < 6; round += 1) await queue.receive({ maxMessages: 10 });
    expect(world.fake.stored(urlOf("jobs-dead"))).toHaveLength(50);
    const before = world.fake.requests.length;
    expect(await queue.redrive("not-there")).toBe(false);
    const receives = world.fake.requests.slice(before).filter((request) => request.operation === "ReceiveMessage");
    expect(receives.length).toBeLessThanOrEqual(6);
  });

  it("dead-letters a delivery on request: the message goes to the dead letters with a marker, then leaves the queue", async () => {
    const { world, open, url, dead } = setup();
    const queue = await open();
    const sent = await queue.enqueue({ body: { task: "t1" }, attributes: { kind: "dispatch" } });
    const [message] = await queue.receive();
    expect(await queue.deadLetter(message!.receiptHandle, "poison")).toBe(true);
    expect(world.fake.stored(url)).toEqual([]);
    const [stored] = world.fake.stored(dead);
    expect(JSON.parse(stored!.body)).toEqual({ task: "t1" });
    expect(Object.keys(stored!.attributes).sort()).toEqual(["kind", DEAD_LETTER_ATTRIBUTE].sort());
    const [listed] = (await queue.listDeadLetters()).items;
    // The marker carries the original id (the dead-letter copy has an id of its own) and the reason; the marker is not an attribute of the message.
    expect(listed).toMatchObject({ messageId: sent.messageId, body: { task: "t1" }, reason: "poison", attributes: { kind: "dispatch" }, receiveCount: 1 });
    expect(new Date(listed!.deadLetteredAt).toString()).not.toBe("Invalid Date");
    // Redriving it by that id puts it back without the marker.
    expect(await queue.redrive(sent.messageId)).toBe(true);
    const [again] = await queue.receive();
    expect(again).toMatchObject({ body: { task: "t1" }, attributes: { kind: "dispatch" }, receiveCount: 1 });
    expect(world.fake.stored(dead)).toEqual([]);
  });

  it("dead-letters on a FIFO queue into the FIFO dead-letter queue, in the same group, and redrives it into that group", async () => {
    const { world, open, url, dead } = setup({ fifo: true });
    const queue = await open();
    await queue.enqueue({ body: "g1", groupId: "grp" });
    const [message] = await queue.receive();
    expect(await queue.deadLetter(message!.receiptHandle, "poison")).toBe(true);
    expect(world.fake.stored(url)).toEqual([]);
    expect(world.fake.stored(dead)[0]!.groupId).toBe("grp");
    const [listed] = (await queue.listDeadLetters()).items;
    expect(await queue.redrive(listed!.messageId)).toBe(true);
    const [back] = await queue.receive();
    expect(back).toMatchObject({ body: "g1", groupId: "grp" });
  });

  it("keeps the message when the move fails: a failed send leaves it on the queue, a failed delete leaves it on both (at least once), never on neither", async () => {
    const { world, open, url, dead } = setup();
    const queue = await open();
    await queue.enqueue({ body: "keep" });
    const [first] = await queue.receive();
    world.fake.fail("SendMessage", service("ServiceUnavailable"));
    await expect(queue.deadLetter(first!.receiptHandle, "poison")).rejects.toBeInstanceOf(SqsQueueError);
    expect(world.fake.stored(url)).toHaveLength(1);
    expect(world.fake.stored(dead)).toEqual([]);
    world.fake.fail("DeleteMessage", service("ServiceUnavailable"));
    await expect(queue.deadLetter(first!.receiptHandle, "poison")).rejects.toBeInstanceOf(SqsQueueError);
    expect(world.fake.stored(url)).toHaveLength(1);
    expect(world.fake.stored(dead)).toHaveLength(1);
  });

  it("answers false for a delivery this process did not make (the handle holds no body), refuses without a dead-letter queue, and forgets a delivery once acknowledged", async () => {
    const { world, open } = setup();
    const queue = await open();
    await queue.enqueue({ body: "a" });
    expect(await queue.deadLetter("handle-from-another-process", "poison")).toBe(false);
    const [message] = await queue.receive();
    expect(await queue.ack(message!.receiptHandle)).toBe(true);
    expect(await queue.deadLetter(message!.receiptHandle, "late")).toBe(false);
    world.fake.createQueue(urlOf("no-dlq"));
    const bare = createSqsQueueServiceFromSettings({ queues: { bare: { url: urlOf("no-dlq") } } }, world.fake);
    const q = await bare.queue("bare");
    await q.enqueue({ body: "x" });
    const [got] = await q.receive();
    await expect(q.deadLetter(got!.receiptHandle, "poison")).rejects.toThrow(/no dead-letter queue/);
    await expect(q.listDeadLetters()).rejects.toThrow(/no dead-letter queue/);
    await expect(q.redrive("id")).rejects.toThrow(/no dead-letter queue/);
  });

  it("does not deliver a body that is not JSON, reports it, and lets SQS's receive count carry it to the dead letters while good messages flow", async () => {
    const malformed: { queue: string; messageId: string }[] = [];
    const world = sqsWorld({ adapter: { onMalformed: (event) => malformed.push(event) } });
    const queue = await world.provisioning(false).queue("jobs", { visibilityTimeoutSeconds: 10, maxReceiveCount: 2 });
    const planted = world.fake.plant(urlOf("jobs"), "this is not json");
    await queue.enqueue({ body: "good" });
    const first = await queue.receive({ maxMessages: 10 });
    expect(first.map((message) => message.body)).toEqual(["good"]);
    expect(malformed).toEqual([{ queue: "jobs", messageId: planted }]);
    world.fake.advance(11);
    await queue.receive({ maxMessages: 10 });
    world.fake.advance(11);
    await queue.receive({ maxMessages: 10 });
    expect(world.fake.stored(urlOf("jobs-dead")).map((message) => message.messageId)).toContain(planted);
    expect(world.fake.stored(urlOf("jobs")).map((message) => message.messageId)).not.toContain(planted);
    // It is in the dead letters but is not listed as a delivery-shaped message of ours.
    expect((await queue.listDeadLetters()).items.map((item) => item.messageId)).not.toContain(planted);
  });

  it("does not page a dead-letter queue, because SQS cannot", async () => {
    const { open } = setup();
    const queue = await open();
    await expect(queue.listDeadLetters({ cursor: "x" })).rejects.toThrow(/cannot page/);
    await expect(queue.listDeadLetters({ limit: 11 })).rejects.toThrow();
    expect(queue.capabilities.deadLettersById).toBe(false);
  });
});

// ---- The plug-in ----

describe("the sqs queue plug-in", () => {
  it("is an allowed module name and loads from a config entry, only when named (no AWS call at load)", async () => {
    expect(isAllowedModuleSpecifier("@rovara/aws-adapters/sqs")).toBe(true);
    const importer: ModuleImporter = async (specifier) => {
      if (specifier === "@rovara/aws-adapters/sqs") return sqsPluginModule;
      throw new Error(`unexpected module ${specifier}`);
    };
    const registry = createAdapterRegistry();
    await loadAdapters(parsePluginConfig({ version: 1, plugins: [{ point: "queue", name: "sqs", module: "@rovara/aws-adapters/sqs", settings: { region: "us-west-2", endpoint: "http://127.0.0.1:1", queues: { dispatch: { url: urlOf("dispatch"), deadLetterUrl: urlOf("dispatch-dead") } } } }] }), { registry, importModule: importer });
    expect(registry.require("queue")).toBeDefined();
  });

  it("checks its settings and builds nothing from a bad one", () => {
    const fake = new FakeSqs();
    expect(() => createSqsQueueServiceFromSettings({ queues: { a: { url: urlOf("a") } }, extra: 1 }, fake)).toThrow(/unknown setting/);
    expect(() => createSqsQueueServiceFromSettings({}, fake)).toThrow(/queues is an object/);
    expect(() => createSqsQueueServiceFromSettings({ queues: {} }, fake)).toThrow(/queues is an object/);
    expect(() => createSqsQueueServiceFromSettings({ queues: { a: { url: urlOf("a"), colour: "red" } } }, fake)).toThrow(/url and deadLetterUrl only/);
    expect(() => createSqsQueueServiceFromSettings({ queues: { a: { url: "" } } }, fake)).toThrow(/non-empty/);
    expect(() => createSqsQueueServiceFromSettings({ queues: { a: { url: urlOf("a") } }, endpoint: "ftp://x" }, fake)).toThrow(/http\(s\)/);
    expect(queuesOfSettings({ a: { url: urlOf("a") } })).toEqual({ a: { url: urlOf("a") } });
  });
});

// ---- The outbox's AWS triggers ----

const dispatchUrl = (fifo: boolean): string => urlOf("dispatch", fifo);

async function relayWorld(fifo: boolean, order: "oldest-first" | "shuffled" = "oldest-first") {
  const dynamo = dynamoWorld();
  const sqs = sqsWorld({ order });
  const outbox = createTransactionalOutbox({ store: dynamo.store, queues: sqs.provisioning(fifo) });
  const records: DynamoStreamRecord[] = [];
  dynamo.fake.onStream((record) => records.push(record));
  const reports: (OutboxRelayReport & { companyId: string })[] = [];
  const stage = (id: string, companyId = COMPANY, queue = "dispatch") => dynamo.store.transact([outbox.stage({ companyId, id, queue, body: { operationId: id }, attributes: { kind: "task" } })]);
  return { dynamo, sqs, outbox, records, reports, stage, hookOptions: { outbox, onReport: (report: OutboxRelayReport & { companyId: string }) => reports.push(report) } };
}

describe("the relay hook: a stream record leads to an enqueue, once by its idempotency key", () => {
  for (const fifo of [false, true]) {
    it(`relays a row staged in a transaction as soon as the stream reader hands its record over (${fifo ? "FIFO" : "standard"} queue)`, async () => {
      const world = await relayWorld(fifo);
      await world.dynamo.store.changes!.subscribe("outbox-relay", createOutboxRelayHook(world.hookOptions));
      expect(await world.stage("op-1")).toEqual({ applied: true });
      await world.dynamo.settled();
      const [message] = await (await world.sqs.service.queue("dispatch")).receive();
      expect(message).toMatchObject({ body: { operationId: "op-1" }, attributes: { kind: "task", outboxId: "op-1" } });
      expect(world.sqs.fake.stored(dispatchUrl(fifo))).toHaveLength(1);
      expect(world.reports).toEqual([{ companyId: COMPANY, delivered: 1, failed: 0, dead: 0 }]);
      // The row left the pending index.
      const row = await world.dynamo.store.get({ pk: companyScoped(COMPANY, "OUTBOX#op-1"), sk: "OUTBOX" });
      expect(row).toMatchObject({ status: "QUEUED" });
      expect(row![OUTBOX_PENDING_INDEX.partitionAttribute]).toBeUndefined();
    });

    it(`hands the same stream record over twice, one after the other, and the queue holds one message (${fifo ? "FIFO" : "standard"} queue)`, async () => {
      const world = await relayWorld(fifo);
      const hook = createOutboxRelayHook(world.hookOptions);
      await world.stage("op-2");
      const insert = world.records.find((record) => record.eventName === "INSERT")!;
      await hook([changeOfRecord(insert)]);
      await hook([changeOfRecord(insert)]);
      await hook([changeOfRecord(insert)]);
      expect(world.sqs.fake.stored(dispatchUrl(fifo))).toHaveLength(1);
      expect(world.reports.map((report) => report.delivered)).toEqual([1, 0, 0]);
    });

    it(`when two readers relay the same row at once the second is dropped by the idempotency key on FIFO, and carries the same outboxId on standard (${fifo ? "FIFO" : "standard"} queue)`, async () => {
      const world = await relayWorld(fifo);
      const hook = createOutboxRelayHook(world.hookOptions);
      await world.stage("op-3");
      const insert = changeOfRecord(world.records.find((record) => record.eventName === "INSERT")!);
      await Promise.all([hook([insert]), hook([insert])]);
      const stored = world.sqs.fake.stored(dispatchUrl(fifo));
      if (fifo) {
        // The deduplication id is the company-scoped outbox id, hashed.
        expect(stored).toHaveLength(1);
        expect(sends(world.sqs.fake, dispatchUrl(fifo)).every((request) => request.input.MessageDeduplicationId === sha(companyScoped(COMPANY, "OUTBOX#op-3")))).toBe(true);
      } else {
        // A standard queue may hold both copies. The consumer drops the second by the outboxId both carry.
        expect(stored.length).toBeGreaterThanOrEqual(1);
        expect(new Set(stored.map((message) => message.attributes.outboxId))).toEqual(new Set(["op-3"]));
      }
    });
  }

  it("is told once per company in a batch, with only that company's new rows", async () => {
    const world = await relayWorld(false);
    const relayed: { companyId: string; ids?: readonly string[] | undefined }[] = [];
    const hook = createOutboxRelayHook({ outbox: { relay: async (options) => { relayed.push(options); return { delivered: 0, failed: 0, dead: 0 }; } } });
    await world.stage("a1");
    await world.stage("a2");
    await world.stage("b1", OTHER);
    const changes = world.records.filter((record) => record.eventName === "INSERT").map((record) => changeOfRecord(record));
    await hook([...changes, ...changes]);
    expect(relayed).toEqual([{ companyId: COMPANY, ids: ["a1", "a2"] }, { companyId: OTHER, ids: ["b1"] }]);
  });

  it("ignores everything but a new, pending outbox row: other documents, the relay's own updates, removals, rows already handed over", async () => {
    const world = await relayWorld(false);
    const relayed: unknown[] = [];
    const hook = createOutboxRelayHook({ outbox: { relay: async (options) => { relayed.push(options); return { delivered: 0, failed: 0, dead: 0 }; } } });
    await world.dynamo.store.put({ item: { pk: companyScoped(COMPANY, "TASK#1"), sk: "META", status: "PENDING" } });
    await world.stage("op-4");
    // The relay's bookkeeping is a MODIFY of a still-pending row: it must not start another relay.
    await world.dynamo.store.update({ key: { pk: companyScoped(COMPANY, "OUTBOX#op-4"), sk: "OUTBOX" }, ops: [change.set("attempts", 1)], condition: when.eq("status", "PENDING") });
    await world.dynamo.store.update({ key: { pk: companyScoped(COMPANY, "OUTBOX#op-4"), sk: "OUTBOX" }, ops: [change.set("status", "QUEUED")], condition: when.eq("status", "PENDING") });
    await world.dynamo.store.delete({ key: { pk: companyScoped(COMPANY, "OUTBOX#op-4"), sk: "OUTBOX" } });
    const changes = world.records.map((record) => changeOfRecord(record));
    expect(changes.map((entry) => entry.kind)).toEqual(["insert", "insert", "modify", "modify", "remove"]);
    await hook(changes);
    expect(relayed).toEqual([{ companyId: COMPANY, ids: ["op-4"] }]);
    expect(pendingOutboxRow(changes[0]!)).toBeUndefined();
    expect(pendingOutboxRow(changes[1]!)).toEqual({ companyId: COMPANY, id: "op-4" });
    const queued = { ...changes[1]!, after: { ...changes[1]!.after!, status: "QUEUED" } } as DocumentChange;
    expect(pendingOutboxRow(queued)).toBeUndefined();
    expect(pendingOutboxRow({ ...changes[1]!, after: { ...changes[1]!.after!, companyId: "" } })).toBeUndefined();
  });

  it("lets a failure of the relay reach the feed, which retries the batch and then reports it poisoned; the row stays pending for the backstop", async () => {
    const world = await relayWorld(false);
    const failing = createOutboxRelayHook({ outbox: { relay: async () => { throw new Error("store unavailable"); } } });
    const poisoned: unknown[] = [];
    const feed = new DynamoStreamChangeFeed({ consumers: ["outbox-relay"], maxAttempts: 3, retryDelayMs: 1 });
    await feed.subscribe("outbox-relay", failing, { onPoison: (changes) => poisoned.push(changes) });
    world.sqs.provision("dispatch");
    await world.stage("op-5");
    await feed.deliver(world.records.filter((record) => record.eventName === "INSERT"));
    expect(poisoned).toHaveLength(1);
    expect(await world.dynamo.store.get({ pk: companyScoped(COMPANY, "OUTBOX#op-5"), sk: "OUTBOX" })).toMatchObject({ status: "PENDING" });
    expect(world.sqs.fake.stored(dispatchUrl(false))).toEqual([]);
  });

  it("leaves a row pending when SQS refuses, counts the failed attempt, and the next relay delivers it", async () => {
    const world = await relayWorld(false);
    await world.dynamo.store.changes!.subscribe("outbox-relay", createOutboxRelayHook(world.hookOptions));
    world.sqs.provision("dispatch");
    world.sqs.fake.fail("SendMessage", service("ServiceUnavailable"));
    await world.stage("op-6");
    await world.dynamo.settled();
    expect(world.reports).toEqual([{ companyId: COMPANY, delivered: 0, failed: 1, dead: 0 }]);
    expect(await world.dynamo.store.get({ pk: companyScoped(COMPANY, "OUTBOX#op-6"), sk: "OUTBOX" })).toMatchObject({ status: "PENDING", attempts: 1 });
    expect(await world.outbox.relay({ companyId: COMPANY })).toEqual({ delivered: 1, failed: 0, dead: 0 });
    expect(world.sqs.fake.stored(dispatchUrl(false))).toHaveLength(1);
  });
});

describe("the backstop: a row whose stream record was missed is picked up by the schedule", () => {
  it("relays pending rows no hook saw, for every company, and a second run finds nothing", async () => {
    const world = await relayWorld(false);
    // No hook is subscribed: the stream reader was down, so every insert record was missed.
    await world.stage("m1");
    await world.stage("m2");
    await world.stage("m3", OTHER);
    await world.dynamo.settled();
    expect(world.sqs.fake.has(dispatchUrl(false))).toBe(false);
    const backstop = createOutboxBackstop({ outbox: world.outbox, companies: async () => [COMPANY, OTHER], onReport: (report) => world.reports.push(report) });
    expect(await backstop()).toEqual({ delivered: 3, failed: 0, dead: 0, companies: 2, deferred: 0, errors: 0 });
    expect(world.sqs.fake.stored(dispatchUrl(false)).map((message) => message.attributes.outboxId).sort()).toEqual(["m1", "m2", "m3"]);
    expect(world.reports.map((report) => [report.companyId, report.delivered])).toEqual([[COMPANY, 2], [OTHER, 1]]);
    expect(await backstop()).toEqual({ delivered: 0, failed: 0, dead: 0, companies: 2, deferred: 0, errors: 0 });
    expect(world.sqs.fake.stored(dispatchUrl(false))).toHaveLength(3);
  });

  it("delivers a row the hook tried and could not (a failed hand-over) on the next run, and sets a row that keeps failing aside as DEAD", async () => {
    const dynamo = dynamoWorld();
    const sqs = sqsWorld({ order: "oldest-first" });
    const outbox = createTransactionalOutbox({ store: dynamo.store, queues: sqs.provisioning(false), maxAttempts: 3 });
    sqs.provision("dispatch");
    await dynamo.store.transact([outbox.stage({ companyId: COMPANY, id: "bad", queue: "dispatch", body: 1 })]);
    sqs.fake.fail("SendMessage", service("ServiceUnavailable"), 3);
    const backstop = createOutboxBackstop({ outbox, companies: async () => [COMPANY] });
    expect((await backstop()).failed).toBe(1);
    expect((await backstop()).failed).toBe(1);
    expect((await backstop()).dead).toBe(1);
    expect(await dynamo.store.get({ pk: companyScoped(COMPANY, "OUTBOX#bad"), sk: "OUTBOX" })).toMatchObject({ status: "DEAD", attempts: 3 });
    expect((await backstop()).delivered).toBe(0);
    expect(sqs.fake.stored(dispatchUrl(false))).toEqual([]);
  });

  it("goes on to the next company when one relay throws, and reports it", async () => {
    const errors: string[] = [];
    const relayed: string[] = [];
    const backstop = createOutboxBackstop({
      companies: async () => [COMPANY, OTHER],
      outbox: { relay: async ({ companyId }) => { if (companyId === COMPANY) throw new Error("store unavailable"); relayed.push(companyId); return { delivered: 2, failed: 0, dead: 0 }; } },
      onError: (companyId) => errors.push(companyId),
    });
    expect(await backstop()).toEqual({ delivered: 2, failed: 0, dead: 0, companies: 1, deferred: 0, errors: 1 });
    expect(errors).toEqual([COMPANY]);
    expect(relayed).toEqual([OTHER]);
  });

  it("stops starting new companies when its budget is spent and leaves the rest for the next run, but always does the first", async () => {
    let clock = 0;
    const relayed: string[] = [];
    const backstop = createOutboxBackstop({
      companies: async () => ["c1", "c2", "c3"],
      budgetMs: 1_000,
      now: () => clock,
      limitPerCompany: 7,
      outbox: { relay: async (options) => { relayed.push(`${options.companyId}:${String(options.limit)}`); clock += 600; return { delivered: 1, failed: 0, dead: 0 }; } },
    });
    expect(await backstop()).toEqual({ delivered: 2, failed: 0, dead: 0, companies: 2, deferred: 1, errors: 0 });
    expect(relayed).toEqual(["c1:7", "c2:7"]);
    clock = 0;
    const slow = createOutboxBackstop({ companies: async () => ["c1", "c2"], budgetMs: 0, now: () => clock, outbox: { relay: async () => { clock += 5; return { delivered: 0, failed: 0, dead: 0 }; } } });
    expect(await slow()).toMatchObject({ companies: 1, deferred: 1 });
  });

  it("carries one row's queue name through: the row decides its queue, and two queues are served in one run", async () => {
    const world = await relayWorld(false);
    await world.stage("q1", COMPANY, "alpha");
    await world.stage("q2", COMPANY, "beta");
    const backstop = createOutboxBackstop({ outbox: world.outbox, companies: async () => [COMPANY] });
    expect((await backstop()).delivered).toBe(2);
    expect(world.sqs.fake.stored(urlOf("alpha")).map((message) => message.attributes.outboxId)).toEqual(["q1"]);
    expect(world.sqs.fake.stored(urlOf("beta")).map((message) => message.attributes.outboxId)).toEqual(["q2"]);
  });
});

describe("what the outbox does not promise about order (so nothing may depend on it)", () => {
  it("relays one ordered group in the order it was staged, when one relay runs at a time (which is all the port promises)", async () => {
    const world = await relayWorld(true);
    for (const id of ["g1", "g2", "g3"]) {
      await world.dynamo.store.transact([world.outbox.stage({ companyId: COMPANY, id, queue: "dispatch", body: id, groupId: "grp" })]);
      await new Promise((resolve) => setTimeout(resolve, 3));
    }
    // One relay at a time: the order of staging.
    expect(await world.outbox.relay({ companyId: COMPANY })).toEqual({ delivered: 3, failed: 0, dead: 0 });
    const queue = await world.sqs.service.queue("dispatch");
    const order: unknown[] = [];
    for (let round = 0; round < 3; round += 1) {
      const [message] = await queue.receive();
      order.push(message!.body);
      await queue.ack(message!.receiptHandle);
    }
    expect(order).toEqual(["g1", "g2", "g3"]);
  });
});
