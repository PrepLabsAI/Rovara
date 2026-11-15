// The correction log the "same mistake twice" measure reads on Code (lessons/correction-log.ts): a member's own corrections, once each, no text, a keyed signature, in the company's own partition; the
// signature matcher (no model); and the person erase's part.
import { describe, expect, it } from "vitest";
import { companyScoped, type OrgId } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../../packages/broker/src/ports/memory-document-store.js";
import {
  correctionLogPk, correctionLogSource, eraseLoggedCorrections, logTaskCorrections, readSignatureKey, signatureMatcher, signatureOf, NEGATED_MARK,
} from "../../../packages/broker/src/lessons/correction-log.js";
import { sameMistakeTwice } from "../../../packages/broker/src/lessons/metric.js";
import type { TaskCorrection } from "../../../packages/broker/src/lessons/counters.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";

const A = "org_corehost00000000000a" as OrgId;
const B = "org_corehost00000000000b" as OrgId;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 1);
const correction = (text: string, over: Partial<TaskCorrection> = {}): TaskCorrection => ({ kind: "review_comment", paths: [], text, at: T0, authorId: "ann", ...over });
const rowsOf = async (store: MemoryDocumentStore, companyId: OrgId, project = "payments") => (await store.query({ pk: correctionLogPk(companyId, project) })).items;

describe("logging a task's corrections", () => {
  it("logs only a member's own words, once per correction, with no text, in the company's own partition, with a time-to-live", async () => {
    const store = new MemoryDocumentStore({ ttlAttribute: "expiresAt" });
    const corrections: TaskCorrection[] = [
      correction("Always wrap network calls in withRetry before calling the payments API"),
      correction("The task was corrected.", { kind: "send_back", fixed: true }),
      { kind: "review_comment", paths: [], text: "Some words with no author", at: T0 },
    ];
    expect(await logTaskCorrections(store, { companyId: A, project: "payments", taskId: "t1", corrections, now: T0 })).toEqual({ logged: 1 });
    // A second reflection of the same task logs nothing again.
    expect(await logTaskCorrections(store, { companyId: A, project: "payments", taskId: "t1", corrections, now: T0 + DAY })).toEqual({ logged: 0 });
    const rows = await rowsOf(store, A);
    const logged = rows.filter((row) => row["entityType"] === "LESSON_CORRECTION");
    expect(logged).toHaveLength(1);
    expect(logged[0]!.pk.startsWith(companyScoped(A, ""))).toBe(true);
    expect(logged[0]).toMatchObject({ taskId: "t1", at: T0, kind: "review_comment", member: true, authorId: "ann" });
    expect(typeof logged[0]!["expiresAt"]).toBe("number");
    expect(logged[0]!["expiresAt"]).toBe(Math.floor(T0 / 1000) + 180 * 86_400);
    // No text anywhere: not in any row of the partition, not in the key row.
    const all = JSON.stringify([...rows, ...(await store.query({ pk: companyScoped(A, "LESSON_CORRECTION_KEY#payments") })).items]);
    for (const word of ["withRetry", "network", "payments API", "no author"]) expect(all.includes(word), word).toBe(false);
    expect(await rowsOf(store, B)).toEqual([]);
  });

  it("the signature is keyed per project: the same words under another key share no hash, and 'never' is marked", async () => {
    const one = signatureOf("Never call the payments API without withRetry", "a".repeat(64));
    const two = signatureOf("Never call the payments API without withRetry", "b".repeat(64));
    expect(one).toContain(NEGATED_MARK);
    expect(one.filter((h) => two.includes(h) && h !== NEGATED_MARK)).toEqual([]);
    expect(signatureOf("", "a".repeat(64))).toEqual([]);
  });

  it("two companies with the same project name keep separate keys and rows", async () => {
    const store = new MemoryDocumentStore();
    await logTaskCorrections(store, { companyId: A, project: "payments", taskId: "t1", corrections: [correction("Use withRetry for the payments client calls")], now: T0 });
    await logTaskCorrections(store, { companyId: B, project: "payments", taskId: "t1", corrections: [correction("Use withRetry for the payments client calls")], now: T0 });
    const keyA = await readSignatureKey(store, A, "payments");
    const keyB = await readSignatureKey(store, B, "payments");
    expect(keyA).toMatch(/^[a-f0-9]{64}$/u);
    expect(keyB).not.toBe(keyA);
    // A source built for A never reads B's rows, even when asked with B's key.
    const source = correctionLogSource(store, A);
    expect((await source.list({ workspaceId: B, project: "payments" }, { since: 0, until: T0 + DAY }, 100)).corrections).toEqual([]);
    expect((await source.list({ workspaceId: A, project: "payments" }, { since: 0, until: T0 + DAY }, 100)).corrections).toHaveLength(1);
  });
});

describe("the source and the matcher", () => {
  it("reads the range asked (since inclusive, until exclusive), stops at the limit and says it was cut", async () => {
    const store = new MemoryDocumentStore();
    for (let i = 0; i < 5; i += 1) {
      await logTaskCorrections(store, { companyId: A, project: "payments", taskId: `t${i}`, corrections: [correction(`Rename the helper number ${i} to something clearer please`, { at: T0 + i * DAY })], now: T0 });
    }
    const source = correctionLogSource(store, A);
    const key = { workspaceId: A, project: "payments" };
    expect((await source.list(key, { since: T0 + DAY, until: T0 + 3 * DAY }, 100)).corrections.map((c) => c.taskId)).toEqual(["t1", "t2"]);
    expect(await source.list(key, { since: T0, until: T0 + 10 * DAY }, 3)).toMatchObject({ truncated: true });
    expect((await source.list(key, { since: T0, until: T0 + 10 * DAY }, 3)).corrections).toHaveLength(3);
  });

  it("a malformed row, another kind, or a row not marked member is left out", async () => {
    const store = new MemoryDocumentStore();
    const pk = correctionLogPk(A, "payments");
    await store.put({ item: { pk, sk: `C#${String(T0).padStart(16, "0")}#x#1`, entityType: "LESSON_CORRECTION", taskId: "x", at: T0, kind: "invented", member: true, signature: [] } });
    await store.put({ item: { pk, sk: `C#${String(T0).padStart(16, "0")}#x#2`, entityType: "LESSON_CORRECTION", taskId: "x", at: T0, kind: "send_back", member: false, signature: [] } });
    await store.put({ item: { pk, sk: `C#${String(T0).padStart(16, "0")}#x#3`, entityType: "LESSON_CORRECTION", taskId: "x", at: "soon", kind: "send_back", member: true, signature: [] } });
    expect((await correctionLogSource(store, A).list({ workspaceId: A, project: "payments" }, { since: 0, until: T0 + DAY }, 100)).corrections).toEqual([]);
  });

  it("the measure over the log: a correction said again on a later task is a repeat; different advice is not; 'never' against a plain rule is not", async () => {
    const store = new MemoryDocumentStore();
    const say = (taskId: string, text: string, at: number) => logTaskCorrections(store, { companyId: A, project: "payments", taskId, corrections: [correction(text, { at })], now: at });
    await say("t1", "Wrap every payments client network call in withRetry with backoff", T0 - 5 * DAY);
    await say("t2", "Please wrap every payments client network call in withRetry with backoff", T0 + DAY);
    await say("t3", "Document the new environment variable in the deployment readme file", T0 + 2 * DAY);
    await say("t4", "Never wrap every payments client network call in withRetry with backoff", T0 + 3 * DAY);
    const key = await readSignatureKey(store, A, "payments");
    const lessons = new InMemoryLessonStore();
    const result = await sameMistakeTwice({ corrections: correctionLogSource(store, A), matcher: signatureMatcher(key), store: lessons }, { workspaceId: A, project: "payments" }, { sinceMs: T0, untilMs: T0 + 30 * DAY });
    expect(result).toMatchObject({ corrections: 3, repeats: 1, unjudged: 0, split: { noLesson: 1, lessonLoaded: 0, lessonNotLoaded: 0 } });
  });

  it("with no key (nothing logged) or a row with no signature, the matcher cannot judge: unjudged, never a guess", async () => {
    const matcher = signatureMatcher(undefined);
    const record = { id: "x", taskId: "t", at: 1, kind: "send_back" as const, member: true, signature: ["abc"] };
    await expect(matcher.sameAsCorrection(record, record)).rejects.toThrow();
    await expect(signatureMatcher("a".repeat(64)).sameAsCorrection({ ...record, signature: [] }, record)).rejects.toThrow();
  });
});

describe("the person erase", () => {
  it("removes the person's logged corrections and claims, and no one else's", async () => {
    const store = new MemoryDocumentStore();
    await logTaskCorrections(store, { companyId: A, project: "payments", taskId: "t1", corrections: [correction("Use withRetry for every client call in payments", { authorId: "ann" }), correction("Prefer the shared logger over console output", { authorId: "bob" })], now: T0 });
    await logTaskCorrections(store, { companyId: B, project: "payments", taskId: "t1", corrections: [correction("Use withRetry for every client call in payments", { authorId: "ann" })], now: T0 });
    expect(await eraseLoggedCorrections(store, A, "payments", "ann")).toBe(2);
    expect((await rowsOf(store, A)).map((row) => row["authorId"])).toEqual(["bob", "bob"]);
    expect(await rowsOf(store, B)).toHaveLength(2);
  });
});
