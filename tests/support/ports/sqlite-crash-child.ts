// Port lane L3: the child process of the crash-and-reopen tests. It works on a database file and is killed with SIGKILL by its parent
// at a point it announces on stdout, so nothing here ever closes the file cleanly.
//   usage: node --import tsx sqlite-crash-child.ts <mode> <database path> [clock ms]
import { writeSync } from "node:fs";
import { OUTBOX_PENDING_INDEX, change, type DocumentChange } from "@agentx/contracts";
import { SqliteDatabase, SqliteDocumentStore, SqliteQueueService } from "../../../packages/local-adapters/src/index.js";

const [mode, path, clock] = process.argv.slice(2);
const say = (line: string): void => void writeSync(1, `${line}\n`);
const forever = (): Promise<never> => new Promise(() => setInterval(() => undefined, 1_000));
const PK = "ORG#org_aaaaaaaaaaaaaaaaaaaa#CRASH#1";

async function main(): Promise<void> {
  if (path === undefined) throw new Error("no database path");
  if (mode === "counters") {
    // Two counters that must always be equal, moved together by one transaction, as fast as possible.
    const store = SqliteDocumentStore.open({ path, indexes: [OUTBOX_PENDING_INDEX], changeFeed: false });
    await store.put({ item: { pk: PK, sk: "L", n: 0 } });
    await store.put({ item: { pk: PK, sk: "R", n: 0 } });
    for (let round = 1; ; round += 1) {
      await store.transact([
        { kind: "update", key: { pk: PK, sk: "L" }, ops: [change.add("n", 1)] },
        { kind: "update", key: { pk: PK, sk: "R" }, ops: [change.add("n", 1)] },
        { kind: "put", item: { pk: PK, sk: `ROUND#${String(round).padStart(6, "0")}`, round } },
      ]);
      if (round === 50) say("READY");
      if (round % 10 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
  } else if (mode === "uncommitted") {
    const store = SqliteDocumentStore.open({ path, changeFeed: false });
    await store.put({ item: { pk: PK, sk: "COMMITTED", v: 1 } });
    // A second connection opens a transaction, writes, and never commits.
    const raw = new SqliteDatabase({ path });
    raw.exec("BEGIN IMMEDIATE");
    raw.run("INSERT INTO rv_doc (pk, sk, doc) VALUES (?, ?, ?)", PK, "UNCOMMITTED", JSON.stringify({ pk: PK, sk: "UNCOMMITTED" }));
    raw.run("UPDATE rv_doc SET doc = ? WHERE pk = ? AND sk = ?", JSON.stringify({ pk: PK, sk: "COMMITTED", v: 2 }), PK, "COMMITTED");
    say("READY");
    await forever();
  } else if (mode === "feed") {
    const store = SqliteDocumentStore.open({ path, changeFeed: { pollMs: 20, retryDelayMs: 2 } });
    let hang = false;
    const handled: string[] = [];
    await store.changes!.subscribe("c1", async (batch: readonly DocumentChange[]) => {
      if (hang) await forever();
      handled.push(...batch.map((entry) => entry.key.sk));
    });
    await store.put({ item: { pk: PK, sk: "1" } });
    for (let waited = 0; handled.length < 1 && waited < 10_000; waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
    if (handled.length < 1) throw new Error("the first change was never handled");
    // Wait for the checkpoint to be stored, which follows the handler.
    await store.settled();
    say("HANDLED");
    hang = true;
    await store.put({ item: { pk: PK, sk: "2" } });
    await store.put({ item: { pk: PK, sk: "3" } });
    say("WRITTEN");
    await forever();
  } else if (mode === "queue") {
    const now = Number(clock);
    const service = SqliteQueueService.open({ path, now: () => now });
    const queue = await service.queue("jobs", { visibilityTimeoutSeconds: 30 });
    await queue.enqueue({ body: "m1" });
    await queue.enqueue({ body: "m2" });
    await queue.enqueue({ body: "m3" });
    const [one] = await queue.receive({ maxMessages: 1 });
    const [two, three] = await queue.receive({ maxMessages: 2 });
    if (one === undefined || two === undefined || three === undefined) throw new Error("the messages were not received");
    // m1 and m2 are in flight and never acknowledged; m3 is dead-lettered.
    await queue.deadLetter(three.receiptHandle, "bad");
    say("READY");
    await forever();
  } else {
    throw new Error(`unknown mode ${String(mode)}`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
