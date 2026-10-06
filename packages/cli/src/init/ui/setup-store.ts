// The install page in the cloud: what the installer job and the setup page share, in one DynamoDB
// table. The job runs `agentx init --cloud` with the hub it always has; the relay (relay.ts) writes
// the hub's state here and reads the answers the page posts. The page (setup-handler.ts) reads the
// state and writes the answers. Neither side reaches the other directly.
//
// One partition per install (`install#<env>`):
//   state             the page's snapshot, as the job last wrote it
//   answer#<key>      an answer the page posted, until the job reads it (then deleted)
//   verdict#<key>     the job's reply to that answer, until the page reads it (then deleted)
//   close             the page asked the run to close
//
// FR-012 still holds: an answer may be a secret, so it lives here only between the page's write
// and the job's next poll (about a second), is deleted as it is read, and expires within minutes
// even when no job reads it. The table is encrypted with its own KMS key (the bootstrap stack's).
import { randomUUID } from "node:crypto";
import { DeleteItemCommand, GetItemCommand, PutItemCommand, QueryCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { AnswerReply, WizardSnapshot } from "./protocol.js";

/** How long an answer, a verdict or a close request is kept when nobody reads it. */
export const SETUP_ITEM_TTL_SECONDS = 10 * 60;
/** The state snapshot's log is cut to this many lines: an item holds at most 400 KB. */
export const SETUP_LOG_LINES = 200;

export interface SetupAnswer { key: string; id: string; value: string }
export interface StoredSetupState { snapshot: WizardSnapshot; closed: boolean }

export interface SetupStore {
  /** The job: the page's state, replacing the last one. `closed` once the run is over. */
  putState(snapshot: WizardSnapshot, closed: boolean): Promise<void>;
  /** The page: the state the job last wrote, or undefined before it wrote any. */
  getState(): Promise<StoredSetupState | undefined>;
  /** The page: one posted answer. Returns the key its verdict will carry. */
  putAnswer(id: string, value: string): Promise<string>;
  /** The job: every answer waiting, oldest first, each deleted as it is returned. */
  takeAnswers(): Promise<SetupAnswer[]>;
  /** The job: its reply to the answer with this key. */
  putVerdict(key: string, reply: AnswerReply): Promise<void>;
  /** The page: the job's reply to this answer, deleted as it is read; undefined while none. */
  takeVerdict(key: string): Promise<AnswerReply | undefined>;
  /** The page: the operator pressed Close installer. */
  requestClose(): Promise<void>;
  /** The job: true once, when the page asked to close. */
  takeClose(): Promise<boolean>;
}

const partition = (env: string) => `install#${env}`;
const expiry = (now: number) => String(Math.floor(now / 1000) + SETUP_ITEM_TTL_SECONDS);

/** The snapshot as stored: the log cut to its last SETUP_LOG_LINES lines. */
export function storableSnapshot(snapshot: WizardSnapshot): WizardSnapshot {
  return snapshot.log.length <= SETUP_LOG_LINES ? snapshot : { ...snapshot, log: snapshot.log.slice(-SETUP_LOG_LINES) };
}

export function dynamoSetupStore(input: { client: Pick<DynamoDBClient, "send">; table: string; env: string; now?: () => number }): SetupStore {
  const { client, table } = input;
  const now = input.now ?? Date.now;
  const pk = { S: partition(input.env) };
  const take = async (sk: string) =>
    (await client.send(new DeleteItemCommand({ TableName: table, Key: { pk, sk: { S: sk } }, ReturnValues: "ALL_OLD" }))).Attributes;
  return {
    async putState(snapshot, closed) {
      await client.send(new PutItemCommand({
        TableName: table,
        Item: { pk, sk: { S: "state" }, snapshot: { S: JSON.stringify(storableSnapshot(snapshot)) }, closed: { BOOL: closed }, updatedAt: { N: String(now()) } },
      }));
    },
    async getState() {
      const item = (await client.send(new GetItemCommand({ TableName: table, Key: { pk, sk: { S: "state" } }, ConsistentRead: true }))).Item;
      const raw = item?.snapshot?.S;
      if (raw === undefined) return undefined;
      return { snapshot: JSON.parse(raw) as WizardSnapshot, closed: item?.closed?.BOOL === true };
    },
    async putAnswer(id, value) {
      // Sorted by time first, so takeAnswers returns them in the order they were posted.
      const key = `${String(now()).padStart(15, "0")}-${randomUUID()}`;
      await client.send(new PutItemCommand({
        TableName: table,
        Item: { pk, sk: { S: `answer#${key}` }, questionId: { S: id }, value: { S: value }, expiresAt: { N: expiry(now()) } },
      }));
      return key;
    },
    async takeAnswers() {
      const found = await client.send(new QueryCommand({
        TableName: table, KeyConditionExpression: "pk = :pk AND begins_with(sk, :answer)",
        ExpressionAttributeValues: { ":pk": pk, ":answer": { S: "answer#" } }, ConsistentRead: true,
      }));
      const answers: SetupAnswer[] = [];
      for (const item of found.Items ?? []) {
        const sk = item.sk?.S;
        if (sk === undefined) continue;
        // Deleted before it is used: an answer is handled once, even if two jobs ever poll.
        const removed = await take(sk);
        const id = removed?.questionId?.S;
        const value = removed?.value?.S;
        if (id !== undefined && value !== undefined) answers.push({ key: sk.slice("answer#".length), id, value });
      }
      return answers;
    },
    async putVerdict(key, reply) {
      await client.send(new PutItemCommand({
        TableName: table,
        Item: { pk, sk: { S: `verdict#${key}` }, reply: { S: JSON.stringify(reply) }, expiresAt: { N: expiry(now()) } },
      }));
    },
    async takeVerdict(key) {
      const raw = (await take(`verdict#${key}`))?.reply?.S;
      return raw === undefined ? undefined : JSON.parse(raw) as AnswerReply;
    },
    async requestClose() {
      await client.send(new PutItemCommand({ TableName: table, Item: { pk, sk: { S: "close" }, expiresAt: { N: expiry(now()) } } }));
    },
    async takeClose() {
      return (await take("close")) !== undefined;
    },
  };
}

/** The same store in memory, for tests and for one process that is both sides. */
export function memorySetupStore(): SetupStore & { answers: Map<string, SetupAnswer> } {
  let state: StoredSetupState | undefined;
  const answers = new Map<string, SetupAnswer>();
  const verdicts = new Map<string, AnswerReply>();
  let close = false;
  let counter = 0;
  return {
    answers,
    async putState(snapshot, closed) { state = { snapshot: storableSnapshot(structuredClone(snapshot)), closed }; },
    async getState() { return state === undefined ? undefined : structuredClone(state); },
    async putAnswer(id, value) {
      counter += 1;
      const key = String(counter).padStart(15, "0");
      answers.set(key, { key, id, value });
      return key;
    },
    async takeAnswers() {
      const taken = [...answers.values()].sort((a, b) => a.key.localeCompare(b.key));
      answers.clear();
      return taken;
    },
    async putVerdict(key, reply) { verdicts.set(key, reply); },
    async takeVerdict(key) {
      const reply = verdicts.get(key);
      verdicts.delete(key);
      return reply;
    },
    async requestClose() { close = true; },
    async takeClose() {
      const wanted = close;
      close = false;
      return wanted;
    },
  };
}
