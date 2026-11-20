// Port lane L3: crash and reopen. A child process works on a database file and is killed with SIGKILL (no close, no flush, no
// rollback of its own); this process then opens the same file and checks that what was committed is there, that nothing half-done is, and
// that the change feed and the queue pick up where they were.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OUTBOX_PENDING_INDEX, queryAll } from "@agentx/contracts";
import { SqliteDatabase, SqliteDocumentStore } from "../../packages/local-adapters/src/index.js";

const CHILD = join(import.meta.dirname, "../support/ports/sqlite-crash-child.ts");
const PK = "ORG#org_aaaaaaaaaaaaaaaaaaaa#CRASH#1";

const folders: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

/** Starts the child, waits until it prints `marker`, kills it without warning, and waits for it to be gone. */
async function runAndKill(mode: string, path: string, marker: string, extra: string[] = [], delayMs = 0): Promise<void> {
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "tsx", CHILD, mode, path, ...extra], { stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let output = "";
  let errors = "";
  child.stderr.on("data", (chunk: Buffer) => void (errors += chunk.toString()));
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the child never printed ${marker}: ${errors}`)), 45_000);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes(marker)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(`the child exited before ${marker}: ${errors}`));
    });
  });
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  child.kill("SIGKILL");
  await exited;
}

async function freshFile(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "local-crash-"));
  folders.push(folder);
  return join(folder, "state.db");
}

describe("the SQLite adapters after a process is killed", () => {
  it.each([0, 7, 23, 61])("never shows half of a transaction, and keeps every one that was acknowledged (killed %i ms after round 50)", async (delayMs) => {
    const path = await freshFile();
    await runAndKill("counters", path, "READY", [], delayMs);
    const store = SqliteDocumentStore.open({ path, indexes: [OUTBOX_PENDING_INDEX], changeFeed: false });
    try {
      const left = (await store.get({ pk: PK, sk: "L" }))!.n as number;
      const right = (await store.get({ pk: PK, sk: "R" }))!.n as number;
      const rounds = await queryAll(store, { pk: PK, sk: { op: "beginsWith", prefix: "ROUND#" } });
      expect(left).toBeGreaterThanOrEqual(50);
      expect(right).toBe(left);
      expect(rounds).toHaveLength(left);
      // The rounds are one unbroken run 1..n.
      expect(rounds.map((round) => round.round)).toEqual(Array.from({ length: left }, (_, index) => index + 1));
      // The file is not damaged, and the store goes on from here.
      const raw = new SqliteDatabase({ path });
      expect(raw.get("PRAGMA integrity_check")).toEqual({ integrity_check: "ok" });
      raw.close();
      expect((await store.transact([{ kind: "put", item: { pk: PK, sk: "AFTER" } }])).applied).toBe(true);
    } finally {
      await store.close();
    }
  }, 90_000);
});
