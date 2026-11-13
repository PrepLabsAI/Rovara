// TE-R1 part A: the pure rules of the reply-set store, golden and adversarial. Central cases: provenance is written once and never changes (a task_made reply stays task_made after the join and after a second task reads it);
// a base-commit entry the store has not seen is task_made; nothing the sandbox writes reaches before_task or independent; the round set puts counted replies first; the join appends and is all or none.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ModelReplySetFileSchema,
  ModelReplySetSchema,
  createRovaraIndependentDecision,
  decideFromBase,
  modelReplyEntrySha256,
  modelReplySetDigest,
  parseModelReplySetFileBytes,
  stampReplyProvenance,
  type ModelReplyFileEntry,
  type ModelReplySetFile,
} from "../../packages/contracts/src/model-reply-set.js";
import {
  REAL_RECORDING_MAX_BYTES,
  REAL_RECORDING_MAX_PER_FAMILY,
  REPLY_SET_HEAD_MAX_ENTRIES,
  type ReplyOverlay,
  type ReplySetHead,
} from "../../packages/contracts/src/model-reply-store.js";
import {
  capRealRecordings,
  emptyReplyHead,
  joinTaskReplies,
  planImport,
  reconcileBaseDecisions,
  replyEditId,
  replyHeadCounts,
  resolveHead,
  resolveRoundSet,
  unseenCandidateReplies,
} from "../../packages/contracts/src/model-reply-store-rules.js";

const reply = (id: string, text = `answer ${id}`, match: ModelReplyFileEntry["match"] = {}): ModelReplyFileEntry => ({ id, match, response: { text, finish: "stop" } });
const sha = (entry: ModelReplyFileEntry): string => modelReplyEntrySha256(entry);
const file = (replies: ModelReplyFileEntry[], family: ModelReplySetFile["family"] = "gemini"): ModelReplySetFile => ({ version: 1, family, replies });
const bodiesOf = (...replies: ModelReplyFileEntry[]): Map<string, unknown> => new Map(replies.map((entry) => [sha(entry), { id: entry.id, match: entry.match, response: entry.response }]));

/** Builds a head through the real import rule, so every digest is the real one. */
function headWith(entries: ReplyBodiesInput, family: ModelReplySetFile["family"] = "gemini"): { head: ReplySetHead; bodies: Map<string, unknown> } {
  let head = emptyReplyHead(family, "main");
  const bodies = new Map<string, unknown>();
  for (const [provenance, replies] of entries) {
    if (provenance === "before_task") {
      const planned = planImport(head, file(replies, family), { origin: "customer_written", source: "repo_import", commit: "a".repeat(40), notImportedShas: new Set(), bodies });
      if (!planned.ok) throw new Error(`setup refused: ${planned.reason}`);
      head = planned.head;
      for (const body of planned.newBodies) bodies.set(sha(body), body);
    } else {
      const overlay = overlayOf(replies.map((entry) => ({ entry, provenance })));
      for (const [key, body] of bodiesOf(...replies)) bodies.set(key, body);
      const joined = joinTaskReplies(head, overlay, { bodies });
      if (!joined.ok) throw new Error(`setup refused: ${joined.reason}`);
      head = joined.head;
    }
  }
  return { head, bodies };
}
type ReplyBodiesInput = readonly (readonly ["before_task" | "task_made" | "independent", ModelReplyFileEntry[]])[];
function overlayOf(entries: readonly { entry: ModelReplyFileEntry; provenance: "task_made" | "independent" | "before_task" }[], family: ModelReplySetFile["family"] = "gemini"): ReplyOverlay {
  return { kind: "model_reply_overlay", schemaVersion: 1, family, taskId: "task-1", revision: 1, entries: entries.map(({ entry, provenance }) => ({ id: entry.id, entrySha256: sha(entry), provenance: provenance as "task_made" | "independent" })) };
}

describe("resolveHead", () => {
  it("builds the file in head order and the decisions the stamp takes: before_task with origin, task_made, independent", () => {
    const { head, bodies } = headWith([["before_task", [reply("a"), reply("b")]], ["task_made", [reply("c")]], ["independent", [reply("d")]]]);
    const resolved = resolveHead(head, bodies);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.file.replies.map((entry) => entry.id)).toEqual(["a", "b", "c", "d"]); // head order: the two joins happened in this order
    expect(resolved.set.replies.map((entry) => [entry.id, entry.provenance, entry.origin])).toEqual([
      ["a", "before_task", "customer_written"], ["b", "before_task", "customer_written"], ["c", "task_made", undefined], ["d", "independent", undefined],
    ]);
    expect(resolved.digest).toBe(modelReplySetDigest(resolved.set));
    expect(resolved.digest).toBe(head.digest);
    expect(ModelReplySetSchema.safeParse(resolved.set).success).toBe(true);
    expect(ModelReplySetFileSchema.safeParse(resolved.file).success).toBe(true);
  });
  it("gives the same answer as stamping the file with the returned decisions (the worker's own call)", () => {
    const { head, bodies } = headWith([["before_task", [reply("a")]], ["task_made", [reply("c")]]]);
    const resolved = resolveHead(head, bodies);
    if (!resolved.ok) throw new Error("expected ok");
    expect(stampReplyProvenance(resolved.file, resolved.decisions)).toEqual(resolved.set);
  });
  it("refuses a body that is missing, a body whose content no longer hashes to its key, and a body that is not a reply", () => {
    const { head, bodies } = headWith([["before_task", [reply("a"), reply("b")]]]);
    const missing = new Map(bodies);
    missing.delete(sha(reply("b")));
    expect(resolveHead(head, missing)).toMatchObject({ ok: false, word: "not_found", reason: "body_missing" });
    const changed = new Map(bodies);
    changed.set(sha(reply("b")), { ...reply("b"), response: { text: "tampered", finish: "stop" } });
    expect(resolveHead(head, changed)).toMatchObject({ ok: false, reason: "body_changed" });
    const junk = new Map(bodies);
    junk.set(sha(reply("b")), { id: "b", provenance: "before_task" });
    expect(resolveHead(head, junk)).toMatchObject({ ok: false, reason: "body_changed" });
  });
  it("refuses a head whose digest is not the resolved set's, an id that is not the body's, and a head that is not a head", () => {
    const { head, bodies } = headWith([["before_task", [reply("a")]]]);
    expect(resolveHead({ ...head, digest: "0".repeat(64) }, bodies)).toMatchObject({ ok: false, reason: "digest_mismatch" });
    expect(resolveHead({ ...head, entries: [{ ...head.entries[0]!, id: "renamed" }] }, bodies)).toMatchObject({ ok: false, reason: "id_mismatch" });
    expect(resolveHead({ ...head, entries: [{ ...head.entries[0]!, provenance: "before_task", origin: undefined }] }, bodies)).toMatchObject({ ok: false, reason: "head_invalid" });
    expect(resolveHead("nope", bodies)).toMatchObject({ ok: false, reason: "head_invalid" });
    expect(resolveHead(undefined, bodies)).toMatchObject({ ok: false, reason: "head_invalid" });
  });
  it("cannot be made to say before_task by a head entry that says independent, or independent by a forged decision", () => {
    const { head, bodies } = headWith([["task_made", [reply("a")]]]);
    const resolved = resolveHead(head, bodies);
    if (!resolved.ok) throw new Error("expected ok");
    expect(resolved.set.replies[0]!.provenance).toBe("task_made");
    // a plain object that looks like an independent decision stamps task_made
    const forged = new Map([["a", { provenance: "independent" as const, contentSha256: sha(reply("a")) } as never]]);
    expect(stampReplyProvenance(resolved.file, forged).replies[0]!.provenance).toBe("task_made");
  });
  it("accepts a derived edit id for the same body, and an empty head", () => {
    const edited = reply("a", "edited");
    const { head, bodies } = headWith([["before_task", [reply("a")]], ["task_made", [edited]]]);
    expect(head.entries.map((entry) => entry.id)).toEqual(["a", replyEditId("a", sha(edited))]);
    expect(resolveHead(head, bodies).ok).toBe(true);
    expect(resolveHead(emptyReplyHead("cohere", "main"), new Map()).ok).toBe(true);
  });
});

describe("resolveRoundSet", () => {
  it("puts COUNTED entries first (head before_task and independent, then the task's independent), then NOT-counted (head task_made, then the task's task_made)", () => {
    const { head, bodies } = headWith([["task_made", [reply("hm", "head task_made")]], ["before_task", [reply("hb")]], ["independent", [reply("hi")]]]);
    const overlayEntries = [
      { entry: reply("tm"), provenance: "task_made" as const },
      { entry: reply("ti"), provenance: "independent" as const },
    ];
    const all = new Map([...bodies, ...bodiesOf(reply("tm"), reply("ti"))]);
    const round = resolveRoundSet(head, overlayOf(overlayEntries), all);
    expect(round.ok && round.set.replies.map((entry) => `${entry.id}:${entry.provenance}`)).toEqual(["hb:before_task", "hi:independent", "ti:independent", "hm:task_made", "tm:task_made"]);
  });
  it("lets a counted reply win over a not-counted one for the same prompt (the first match wins)", () => {
    const taskMade = reply("tm", "not counted", { promptContains: "weather" });
    const counted = reply("bt", "counted", { promptContains: "weather" });
    const { head, bodies } = headWith([["task_made", [taskMade]], ["before_task", [counted]]]);
    const round = resolveRoundSet(head, undefined, bodies);
    expect(round.ok && round.set.replies[0]!.id).toBe("bt");
    expect(resolveHead(head, bodies).ok && (resolveHead(head, bodies) as { set: { replies: { id: string }[] } }).set.replies[0]!.id).toBe("tm"); // head order is not the round order
  });
  it("does not add an overlay entry the head already lists, and keeps the head's provenance (a task_made copy never downgrades)", () => {
    const { head, bodies } = headWith([["before_task", [reply("a")]]]);
    const round = resolveRoundSet(head, overlayOf([{ entry: reply("a"), provenance: "task_made" }]), bodies);
    expect(round.ok && round.set.replies.map((entry) => `${entry.id}:${entry.provenance}`)).toEqual(["a:before_task"]);
  });
  it("gives an overlay edit of an existing id the derived id, after the original, and an overlay-internal id clash the derived id too", () => {
    const { head, bodies } = headWith([["before_task", [reply("a")]]]);
    const edit = reply("a", "edit");
    const clash = reply("a", "other edit");
    const all = new Map([...bodies, ...bodiesOf(edit, clash)]);
    const round = resolveRoundSet(head, overlayOf([{ entry: edit, provenance: "task_made" }, { entry: clash, provenance: "task_made" }]), all);
    expect(round.ok && round.set.replies.map((entry) => entry.id)).toEqual(["a", replyEditId("a", sha(edit)), replyEditId("a", sha(clash))]);
  });
  it("refuses an overlay entry that says before_task, an overlay of another family and an overlay that is not one", () => {
    const { head, bodies } = headWith([["before_task", [reply("a")]]]);
    const bad = overlayOf([{ entry: reply("x"), provenance: "before_task" }]);
    expect(resolveRoundSet(head, bad, new Map([...bodies, ...bodiesOf(reply("x"))]))).toMatchObject({ ok: false, word: "not_allowed", reason: "before_task_overlay" });
    expect(resolveRoundSet(head, overlayOf([], "cohere"), bodies)).toMatchObject({ ok: false, reason: "family_mismatch" });
    expect(resolveRoundSet(head, { nope: 1 }, bodies)).toMatchObject({ ok: false, reason: "overlay_invalid" });
  });
  it("works with an empty head and with no overlay, and refuses a body that is missing", () => {
    const empty = emptyReplyHead("gemini", "main");
    expect(resolveRoundSet(empty, overlayOf([{ entry: reply("a"), provenance: "task_made" }]), bodiesOf(reply("a"))).ok).toBe(true);
    expect(resolveRoundSet(empty, undefined, new Map()).ok).toBe(true);
    expect(resolveRoundSet(empty, overlayOf([{ entry: reply("a"), provenance: "task_made" }]), new Map())).toMatchObject({ ok: false, reason: "body_missing" });
  });
});

describe("joinTaskReplies", () => {
  it("appends after the existing entries (independent first, then task_made): a joined reply never shadows an existing one", () => {
    const { head, bodies } = headWith([["before_task", [reply("a", "x", { promptContains: "p" })]]]);
    const mine = reply("c", "mine", { promptContains: "p" });
    const theirs = reply("i", "independent", { promptContains: "p" });
    const all = new Map([...bodies, ...bodiesOf(mine, theirs)]);
    const joined = joinTaskReplies(head, overlayOf([{ entry: mine, provenance: "task_made" }, { entry: theirs, provenance: "independent" }]), { bodies: all });
    if (!joined.ok) throw new Error(joined.reason);
    expect(joined.head.entries.map((entry) => `${entry.id}:${entry.provenance}`)).toEqual(["a:before_task", "i:independent", "c:task_made"]);
    expect(joined.head.revision).toBe(head.revision + 1);
    expect(joined.added.map((entry) => entry.addedBy)).toEqual([{ taskId: "task-1", source: "independent_channel" }, { taskId: "task-1", source: "task_join" }]);
    expect(joined.head.digest).toBe(resolveHead(joined.head, all).ok ? (resolveHead(joined.head, all) as { digest: string }).digest : "x");
  });
  it("never downgrades: a task_made copy of a before_task reply leaves it before_task", () => {
    const { head, bodies } = headWith([["before_task", [reply("a")]]]);
    const joined = joinTaskReplies(head, overlayOf([{ entry: reply("a"), provenance: "task_made" }]), { bodies });
    expect(joined).toMatchObject({ ok: true, skipped: 1 });
    if (joined.ok) {
      expect(joined.head).toEqual(head); // nothing changed, not even the revision
      expect(joined.added).toEqual([]);
    }
  });
  it("never upgrades: an independent copy of a task_made reply, and a before_task copy, leave it task_made", () => {
    const { head, bodies } = headWith([["task_made", [reply("a")]]]);
    const copy = joinTaskReplies(head, overlayOf([{ entry: reply("a"), provenance: "independent" }]), { bodies });
    expect(copy.ok && copy.head.entries.map((entry) => entry.provenance)).toEqual(["task_made"]);
    // a before_task copy arrives only through an import, which skips a content the head lists
    const imported = planImport(head, file([reply("a")]), { origin: "customer_written", source: "repo_import", notImportedShas: new Set(), bodies });
    expect(imported).toMatchObject({ ok: true, added: 0, skipped: 1 });
    expect(imported.ok && imported.head.entries.map((entry) => entry.provenance)).toEqual(["task_made"]);
  });
  it("joins an edit of an existing id as a NEW entry with the derived id, task_made, after the original", () => {
    const { head, bodies } = headWith([["before_task", [reply("a", "original")]]]);
    const edit = reply("a", "edited");
    const joined = joinTaskReplies(head, overlayOf([{ entry: edit, provenance: "task_made" }]), { bodies: new Map([...bodies, ...bodiesOf(edit)]) });
    if (!joined.ok) throw new Error(joined.reason);
    expect(joined.head.entries.map((entry) => `${entry.id}:${entry.provenance}`)).toEqual(["a:before_task", `${replyEditId("a", sha(edit))}:task_made`]);
    expect(replyEditId("a", sha(edit))).toMatch(/^a\.edit-[0-9a-f]{8}$/u);
    expect(replyEditId("x".repeat(64), sha(edit))).toHaveLength(64);
  });
  it("refuses an overlay entry that says before_task (the overlay can only hold task_made and independent), and joins nothing", () => {
    const { head, bodies } = headWith([["before_task", [reply("a")]]]);
    const forged = overlayOf([{ entry: reply("x"), provenance: "before_task" }]);
    expect(joinTaskReplies(head, forged, { bodies: new Map([...bodies, ...bodiesOf(reply("x"))]) })).toMatchObject({ ok: false, word: "not_allowed", reason: "before_task_overlay" });
    expect(joinTaskReplies(head, { ...overlayOf([]), entries: [{ id: "x", entrySha256: sha(reply("x")), provenance: "before_task", origin: "customer_written" }] }, { bodies })).toMatchObject({ ok: false, word: "not_allowed" });
    expect(joinTaskReplies(head, undefined, { bodies })).toMatchObject({ ok: false, reason: "overlay_invalid" });
    expect(joinTaskReplies(head, overlayOf([], "cohere"), { bodies })).toMatchObject({ ok: false, reason: "family_mismatch" });
  });
  it("is all or none over 1,000 entries (too_many), and refuses a set over 4 MiB (too_large)", () => {
    const replies = Array.from({ length: REPLY_SET_HEAD_MAX_ENTRIES }, (_, index) => reply(`r${index}`));
    const { head, bodies } = headWith([["before_task", replies]]);
    expect(head.entries).toHaveLength(REPLY_SET_HEAD_MAX_ENTRIES);
    const extra = reply("extra");
    expect(joinTaskReplies(head, overlayOf([{ entry: extra, provenance: "task_made" }]), { bodies: new Map([...bodies, ...bodiesOf(extra)]) })).toMatchObject({ ok: false, word: "too_many", reason: "head_full" });
    // 999 + 2 over the cap: none joins
    const nearly = headWith([["before_task", replies.slice(0, 999)]]);
    const two = [reply("e1"), reply("e2")];
    const result = joinTaskReplies(nearly.head, overlayOf(two.map((entry) => ({ entry, provenance: "task_made" as const }))), { bodies: new Map([...nearly.bodies, ...bodiesOf(...two)]) });
    expect(result).toMatchObject({ ok: false, word: "too_many" });
    // 20 replies of 256 KiB each is over the 4 MiB set cap
    const big = Array.from({ length: 20 }, (_, index) => reply(`big${index}`, `${index}`.padEnd(250 * 1024, "x")));
    const base = emptyReplyHead("gemini", "main");
    const tooBig = joinTaskReplies(base, overlayOf(big.map((entry) => ({ entry, provenance: "task_made" as const }))), { bodies: bodiesOf(...big) });
    expect(tooBig).toMatchObject({ ok: false, word: "too_large", reason: "set_too_large" });
  });
  it("is pure: the same inputs give the same head, and the inputs are not changed", () => {
    const { head, bodies } = headWith([["before_task", [reply("a")]]]);
    const mine = overlayOf([{ entry: reply("c"), provenance: "task_made" }, { entry: reply("d"), provenance: "independent" }]);
    const all = new Map([...bodies, ...bodiesOf(reply("c"), reply("d"))]);
    const headBefore = JSON.stringify(head);
    const overlayBefore = JSON.stringify(mine);
    const one = joinTaskReplies(head, mine, { bodies: all });
    const two = joinTaskReplies(head, mine, { bodies: all });
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
    expect(JSON.stringify(head)).toBe(headBefore);
    expect(JSON.stringify(mine)).toBe(overlayBefore);
  });
  it("keeps task_made after the join and after a second task reads it (the central rule)", () => {
    const { head, bodies } = headWith([["before_task", [reply("a")]]]);
    const mine = reply("c", "agent's reply");
    const all = new Map([...bodies, ...bodiesOf(mine)]);
    const joined = joinTaskReplies(head, overlayOf([{ entry: mine, provenance: "task_made" }]), { bodies: all });
    if (!joined.ok) throw new Error(joined.reason);
    const read = resolveHead(joined.head, all);
    expect(read.ok && read.set.replies.map((entry) => entry.provenance)).toEqual(["before_task", "task_made"]);
    const second = resolveRoundSet(joined.head, overlayOf([]), all);
    expect(second.ok && second.set.replies.map((entry) => entry.provenance)).toEqual(["before_task", "task_made"]);
    const again = joinTaskReplies(joined.head, overlayOf([{ entry: mine, provenance: "task_made" }]), { bodies: all });
    expect(again.ok && again.head).toEqual(joined.head);
  });
});

describe("planImport (the seed)", () => {
  it("adds replies as before_task with the origin and addedBy, after the existing ones, and skips what the head lists", () => {
    const base = headWith([["before_task", [reply("a")]]]);
    const planned = planImport(base.head, file([reply("a"), reply("b")]), { origin: "setup_agent_from_fakes", source: "setup_agent", commit: "b".repeat(40), notImportedShas: new Set(), bodies: base.bodies });
    if (!planned.ok) throw new Error(planned.reason);
    expect(planned).toMatchObject({ added: 1, skipped: 1 });
    expect(planned.head.entries.at(-1)).toEqual({ id: "b", entrySha256: sha(reply("b")), provenance: "before_task", origin: "setup_agent_from_fakes", addedBy: { source: "setup_agent", commit: "b".repeat(40) } });
    expect(planned.head.revision).toBe(base.head.revision + 1);
  });
  it("does NOT import a reply a Rovara task wrote (it stays task_made) or one an open task's overlay holds", () => {
    const planned = planImport(emptyReplyHead("gemini", "main"), file([reply("a"), reply("b")]), { origin: "customer_written", source: "repo_import", notImportedShas: new Set([sha(reply("a"))]), bodies: new Map() });
    expect(planned).toMatchObject({ ok: true, added: 1, skipped: 1 });
    expect(planned.ok && planned.head.entries.map((entry) => entry.id)).toEqual(["b"]);
  });
  it("gives an edited reply of an existing id the derived id and goes after the original", () => {
    const base = headWith([["before_task", [reply("a")]]]);
    const edit = reply("a", "human edit");
    const planned = planImport(base.head, file([edit]), { origin: "customer_written", source: "repo_import", notImportedShas: new Set(), bodies: base.bodies });
    expect(planned.ok && planned.head.entries.map((entry) => entry.id)).toEqual(["a", replyEditId("a", sha(edit))]);
  });
  it("is all or none over 1,000 entries and refuses another family", () => {
    const base = headWith([["before_task", Array.from({ length: 999 }, (_, index) => reply(`r${index}`))]]);
    expect(planImport(base.head, file([reply("x1"), reply("x2")]), { origin: "customer_written", source: "repo_import", notImportedShas: new Set(), bodies: base.bodies })).toMatchObject({ ok: false, word: "too_many" });
    expect(planImport(base.head, file([reply("x1")], "cohere"), { origin: "customer_written", source: "repo_import", notImportedShas: new Set(), bodies: base.bodies })).toMatchObject({ ok: false, reason: "family_mismatch" });
  });
  it("applies the recording cap: 25 per family, 64 KiB each", () => {
    const options = { origin: "real_recording_capped" as const, source: "recording_intake" as const, notImportedShas: new Set<string>(), bodies: new Map<string, unknown>() };
    const some = Array.from({ length: REAL_RECORDING_MAX_PER_FAMILY }, (_, index) => reply(`rec${index}`));
    expect(planImport(emptyReplyHead("gemini", "main"), file(some), { ...options, existingRecordings: 0 })).toMatchObject({ ok: true, added: REAL_RECORDING_MAX_PER_FAMILY });
    expect(planImport(emptyReplyHead("gemini", "main"), file([reply("one-more")]), { ...options, existingRecordings: REAL_RECORDING_MAX_PER_FAMILY })).toMatchObject({ ok: false, word: "too_many", reason: "recording_cap" });
    expect(planImport(emptyReplyHead("gemini", "main"), file([reply("big", "x".repeat(REAL_RECORDING_MAX_BYTES))]), { ...options, existingRecordings: 0 })).toMatchObject({ ok: false, word: "too_large" });
  });
  it("refuses a reply over 256 KiB", () => {
    const huge = reply("huge", "x".repeat(256 * 1024));
    expect(planImport(emptyReplyHead("gemini", "main"), file([huge]), { origin: "customer_written", source: "repo_import", notImportedShas: new Set(), bodies: new Map() })).toMatchObject({ ok: false, word: "too_large" });
  });
});

describe("capRealRecordings", () => {
  it("accepts up to the cap counting what exists, refuses the rest with fixed words", () => {
    const incoming = [reply("a"), reply("b"), reply("c")];
    expect(capRealRecordings(23, incoming)).toEqual({ accepted: [incoming[0], incoming[1]], refused: [{ id: "c", word: "too_many" }] });
    expect(capRealRecordings(0, [reply("big", "x".repeat(REAL_RECORDING_MAX_BYTES))]).refused).toEqual([{ id: "big", word: "too_large" }]);
    expect(capRealRecordings(Number.NaN, [reply("a")]).accepted).toHaveLength(1);
  });
});

describe("a base-commit entry the store has never seen is task_made (fail closed)", () => {
  it("lists the candidate's replies the head does not hold, to be written as the task's task_made overlay", () => {
    const { head } = headWith([["before_task", [reply("a")]]]);
    const unseen = unseenCandidateReplies(head, file([reply("a"), reply("edited-outside-rovara", "a human changed the repo file"), reply("new")]));
    expect(Array.isArray(unseen) ? (unseen as ModelReplyFileEntry[]).map((entry) => entry.id) : unseen).toEqual(["edited-outside-rovara", "new"]);
    expect(unseenCandidateReplies(head, file([], "cohere"))).toMatchObject({ ok: false, reason: "family_mismatch" });
  });
});

describe("for a project that keeps mocks in the repo: F2's decideFromBase before_task is accepted only if the store lists the same content", () => {
  const baseFile = file([reply("a"), reply("b"), reply("c")]);
  it("accepts before_task for an entry the store lists as before_task, with the store's origin", () => {
    const { head } = headWith([["before_task", [reply("a")]]]);
    const decided = decideFromBase(baseFile, baseFile, "customer_written");
    const out = reconcileBaseDecisions(decided.decisions, head);
    expect(out).toBeInstanceOf(Map);
    const map = out as Map<string, { provenance: string; origin?: string }>;
    expect(map.get("a")).toMatchObject({ provenance: "before_task", origin: "customer_written" });
  });
  it("makes the entries the store has not seen, and one it lists as task_made, task_made", () => {
    const { head } = headWith([["before_task", [reply("a")]], ["task_made", [reply("b")]]]);
    const decided = decideFromBase(baseFile, baseFile, "customer_written");
    const map = reconcileBaseDecisions(decided.decisions, head) as Map<string, { provenance: string }>;
    expect(decided.decisions.get("b")!.provenance).toBe("before_task"); // F2 alone would have counted it
    expect(map.get("b")!.provenance).toBe("task_made");
    expect(map.get("c")!.provenance).toBe("task_made");
    // and the stamp agrees
    const stamped = stampReplyProvenance(baseFile, map);
    expect(stamped.replies.map((entry) => entry.provenance)).toEqual(["before_task", "task_made", "task_made"]);
  });
  it("keeps a task_made decision task_made even if the store lists the content as before_task (the store never promotes)", () => {
    const { head } = headWith([["before_task", [reply("a", "edited")]]]);
    const candidate = file([reply("a", "edited")]);
    const decided = decideFromBase(file([reply("a")]), candidate, "customer_written");
    expect(decided.decisions.get("a")!.provenance).toBe("task_made");
    const map = reconcileBaseDecisions(decided.decisions, head) as Map<string, { provenance: string }>;
    expect(map.get("a")!.provenance).toBe("task_made");
  });
  it("reports a store-listed independent entry as independent (the one Rovara-side decision)", () => {
    const { head } = headWith([["independent", [reply("a")]]]);
    const decided = decideFromBase(file([reply("a")]), file([reply("a")]), "customer_written");
    const map = reconcileBaseDecisions(decided.decisions, head) as Map<string, { provenance: string }>;
    expect(map.get("a")!.provenance).toBe("independent");
    expect(stampReplyProvenance(file([reply("a")]), map).replies[0]!.provenance).toBe("independent");
  });
});

describe("nothing the sandbox writes reaches before_task or independent", () => {
  it("refuses a candidate file with a provenance or origin key (the file form has none)", () => {
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    for (const extra of [{ provenance: "before_task" }, { provenance: "independent" }, { origin: "customer_written" }]) {
      expect(parseModelReplySetFileBytes(bytes({ version: 1, family: "gemini", replies: [{ ...reply("a"), ...extra }] })).ok).toBe(false);
    }
  });
  it("makes a candidate file's replies task_made through every path in the lane: unseen replies, an overlay, a copy of a decision", () => {
    const { head, bodies } = headWith([["before_task", [reply("a")]]]);
    const candidate = file([reply("a"), reply("sneaky", "claims to be old")]);
    const unseen = unseenCandidateReplies(head, candidate) as ModelReplyFileEntry[];
    const mine = overlayOf(unseen.map((entry) => ({ entry, provenance: "task_made" as const })));
    const round = resolveRoundSet(head, mine, new Map([...bodies, ...bodiesOf(...unseen)]));
    expect(round.ok && round.set.replies.map((entry) => entry.provenance)).toEqual(["before_task", "task_made"]);
    // a copy of an independent decision, a spread of it, and a structured clone are all task_made
    const real = createRovaraIndependentDecision(sha(reply("sneaky", "claims to be old")));
    for (const copy of [{ ...real }, structuredClone(real), Object.assign(Object.create(null) as object, real), JSON.parse(JSON.stringify(real)) as unknown]) {
      const stamped = stampReplyProvenance(file([reply("sneaky", "claims to be old")]), new Map([["sneaky", copy as never]]));
      expect(stamped.replies[0]!.provenance).toBe("task_made");
    }
    expect(stampReplyProvenance(file([reply("sneaky", "claims to be old")]), new Map([["sneaky", real]])).replies[0]!.provenance).toBe("independent");
  });
});

describe("counts and the empty head", () => {
  it("counts by provenance and has a stable empty head", () => {
    const { head } = headWith([["before_task", [reply("a")]], ["task_made", [reply("b")]], ["independent", [reply("c")]]]);
    expect(replyHeadCounts(head)).toEqual({ before_task: 1, independent: 1, task_made: 1 });
    expect(emptyReplyHead("gemini", "main")).toEqual(emptyReplyHead("gemini", "main"));
    expect(emptyReplyHead("gemini", "main").digest).toBe(modelReplySetDigest({ version: 1, family: "gemini", replies: [] }));
  });
});

describe("where createRovaraIndependentDecision is called", () => {
  it("is called in exactly one place in this lane's code (decisionForEntry); R2's channel is not built here", () => {
    const root = join(__dirname, "..", "..");
    const laneFiles = [
      "packages/contracts/src/model-reply-store.ts",
      "packages/contracts/src/model-reply-store-rules.ts",
      "packages/broker/src/core/test-env/reply-set-store.ts",
    ];
    const callers = laneFiles.filter((path) => /createRovaraIndependentDecision\(/u.test(readFileSync(join(root, path), "utf8")));
    expect(callers).toEqual(["packages/contracts/src/model-reply-store-rules.ts"]);
    const rules = readFileSync(join(root, "packages/contracts/src/model-reply-store-rules.ts"), "utf8");
    expect(rules.split("\n").filter((line) => /createRovaraIndependentDecision\(/u.test(line) && !line.trim().startsWith("*") && !line.trim().startsWith("//"))).toHaveLength(1);
  });
  it("is not called anywhere else in packages (outside F2-A's own file) except the store's tests and conformance suite", () => {
    const root = join(__dirname, "..", "..");
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".ts") && /createRovaraIndependentDecision\(/u.test(readFileSync(path, "utf8"))) hits.push(path.slice(root.length + 1));
      }
    };
    walk(join(root, "packages"));
    expect(hits.sort()).toEqual([
      "packages/contracts/src/model-reply-set.ts",
      "packages/contracts/src/model-reply-store-rules.ts",
      "packages/testing/src/ports/reply-set-store-conformance.ts",
    ]);
  });
});

describe("speed: 1,000 replies near 4 MiB", () => {
  it("resolves a full head and joins into it well under a second", () => {
    const text = "x".repeat(3_500);
    const replies = Array.from({ length: REPLY_SET_HEAD_MAX_ENTRIES - 1 }, (_, index) => reply(`r${index}`, `${index} ${text}`));
    const { head, bodies } = headWith([["before_task", replies]]);
    const started = performance.now();
    const resolved = resolveHead(head, bodies);
    const extra = reply("last", "last");
    const joined = joinTaskReplies(head, overlayOf([{ entry: extra, provenance: "task_made" }]), { bodies: new Map([...bodies, ...bodiesOf(extra)]) });
    const elapsed = performance.now() - started;
    expect(resolved.ok && joined.ok).toBe(true);
    expect(elapsed).toBeLessThan(1_500);
  });
});
