// TE-R1 part A (DECISIONS 166a, 161, 150): the conformance suite for the Rovara-side reply-set store. ONE suite: the Code service over the in-memory store and over SQLite, and Cloud's implementation over its state
// table, must all pass it (Cloud copies the runner and adds its harness; it does not weaken a case).
//
// An implementation's test file calls `runReplySetStoreConformance(name, harness)`. The harness builds a fresh store for each test; `create` takes the company resolver (so the fail-closed cases can make it throw or answer
// nothing) and a clock (so the expiry case can move time). The suite drives only `ReplySetStoreService` (`@agentx/contracts`), so it needs nothing of the adapter beneath.
//
// What it pins: the provenance rule (written once, never changes; `task_made` stays `task_made` after a join and after a second task reads it; `independent` only through the channel; an import never promotes a task's
// reply), the round-set order, the join (idempotent, appends, never edits), branch inheritance, the caps, expiry, erase, and the two-company kit (DECISIONS 150): another company's project answers the same `not_found`
// as a missing one, no write, join, import, overlay, delete or erase touches the other company, the same raw ids stay two sets, and the company resolver failing closes every operation.
import { describe, expect, it } from "vitest";
import {
  REAL_RECORDING_MAX_BYTES,
  REAL_RECORDING_MAX_PER_FAMILY,
  REPLY_ENTRY_BODY_MAX_BYTES,
  REPLY_OVERLAY_TTL_DAYS,
  REPLY_STORE_WORDS,
  ReplyStoreRefusal,
  modelReplyEntrySha256,
  modelReplySetDigest,
  type HostScope,
  type ModelReplyFileEntry,
  type ReplySetStoreService,
  type ServedModelFamily,
} from "@agentx/contracts";
import { createRovaraIndependentDecision } from "@agentx/contracts/independent-channel";
import {
  COMPANY_A,
  COMPANY_B,
  SHARED_RAW_IDS,
  assertFailsClosed,
  assertSurfacesIsolated,
  attempt,
  type FailClosedProbe,
  type IsolationCompany,
  type IsolationSurface,
  type ResolverFailure,
} from "../isolation/two-company.js";

export interface ReplySetStoreCreateOptions {
  /** Which company a call is for. Absent: the scope's own `orgId`. */
  readonly resolveCompany?: (scope: HostScope) => string | undefined | Promise<string | undefined>;
  /** The clock the store uses for the expiry of overlays and join markers. Absent: the real clock. */
  readonly now?: () => Date;
}
export interface ReplySetStoreUnderTest {
  readonly service: ReplySetStoreService;
  dispose?(): Promise<void>;
}
export interface ReplySetStoreHarness {
  /** A fresh, empty store. */
  create(options?: ReplySetStoreCreateOptions): Promise<ReplySetStoreUnderTest>;
}

const FAMILY: ServedModelFamily = "gemini";
const COMMIT = "c".repeat(40);
const scopeOf = (company: IsolationCompany): HostScope => company.scope;
const PROJECT = SHARED_RAW_IDS.project;
const BRANCH = SHARED_RAW_IDS.branch;
const DEFAULT_BRANCH = "main";
const TASK = "task-shared";

const reply = (id: string, text = `answer ${id}`, match: ModelReplyFileEntry["match"] = {}): ModelReplyFileEntry => ({ id, match, response: { text, finish: "stop" } });
const bytesOf = (replies: readonly ModelReplyFileEntry[], family: ServedModelFamily = FAMILY): Uint8Array => new TextEncoder().encode(JSON.stringify({ version: 1, family, replies }));
const sha = (entry: ModelReplyFileEntry): string => modelReplyEntrySha256(entry);

async function withStore<T>(harness: ReplySetStoreHarness, body: (service: ReplySetStoreService) => Promise<T>, options?: ReplySetStoreCreateOptions): Promise<T> {
  const under = await harness.create(options);
  try {
    return await body(under.service);
  } finally {
    await under.dispose?.();
  }
}

type Provenances = readonly { id: string; provenance: string; origin?: string | undefined }[];
const provenanceOf = (read: { ok: true; set: { replies: Provenances } } | { ok: false }): Record<string, string> =>
  read.ok ? Object.fromEntries(read.set.replies.map((entry) => [entry.id, entry.origin === undefined ? entry.provenance : `${entry.provenance}/${entry.origin}`])) : {};

const query = (over: Partial<{ project: string; branch: string; defaultBranch: string; family: ServedModelFamily }> = {}) => ({ project: PROJECT, branch: BRANCH, family: FAMILY, ...over });
const importFile = (service: ReplySetStoreService, scope: HostScope, replies: readonly ModelReplyFileEntry[], over: Partial<{ project: string; branch: string; defaultBranch: string; origin: "customer_written" | "setup_agent_from_fakes" | "prompt_and_expected_shape" }> = {}) =>
  service.importFromRepoFile(scope, { ...query(over), baseCommitSha: COMMIT, bytes: bytesOf(replies), origin: over.origin ?? "customer_written" });

export function runReplySetStoreConformance(name: string, harness: ReplySetStoreHarness): void {
  describe(`reply set store conformance: ${name}`, () => {
    const A = scopeOf(COMPANY_A);
    const B = scopeOf(COMPANY_B);

    describe("the provenance rule", () => {
      it("answers not_found for a set nobody wrote", () => withStore(harness, async (service) => {
        expect(await service.readSet(A, query())).toEqual({ ok: false, word: "not_found" });
        expect(await service.readRoundSet(A, { ...query(), taskId: TASK })).toEqual({ ok: false, word: "not_found" });
        expect(await service.listHeads(A, PROJECT)).toEqual({ ok: false, word: "not_found" });
      }));

      it("imports a base file as before_task with its origin, and the set's digest is the resolved set's", () => withStore(harness, async (service) => {
        expect(await importFile(service, A, [reply("a"), reply("b")], { origin: "setup_agent_from_fakes" })).toMatchObject({ ok: true, added: 2, skipped: 0 });
        const read = await service.readSet(A, query());
        expect(read.ok).toBe(true);
        if (!read.ok) return;
        expect(provenanceOf(read)).toEqual({ a: "before_task/setup_agent_from_fakes", b: "before_task/setup_agent_from_fakes" });
        expect(read.digest).toBe(modelReplySetDigest(read.set));
        expect(read.revision).toBe(1);
        expect(await importFile(service, A, [reply("a"), reply("b")])).toMatchObject({ ok: true, added: 0, skipped: 2 });
        const again = await service.readSet(A, query());
        expect(again.ok && again.revision).toBe(1);
        expect(again.ok && provenanceOf(again)).toEqual({ a: "before_task/setup_agent_from_fakes", b: "before_task/setup_agent_from_fakes" });
      }));

      it("keeps a task's reply task_made after the join, after a second task reads it, and after an import of the same content", () => withStore(harness, async (service) => {
        await importFile(service, A, [reply("base")]);
        expect(await service.putOverlay(A, { project: PROJECT, taskId: "task-one", family: FAMILY, replies: [reply("base"), reply("mine", "written by the coding agent")] })).toMatchObject({ ok: true, stored: 2 });
        const round = await service.readRoundSet(A, { ...query(), taskId: "task-one" });
        expect(round.ok && provenanceOf(round)).toEqual({ base: "before_task/customer_written", mine: "task_made" });
        expect(await service.joinTask(A, { project: PROJECT, taskId: "task-one", family: FAMILY, branch: BRANCH })).toEqual({ ok: true, status: "joined", added: 1 });
        const afterJoin = await service.readSet(A, query());
        expect(afterJoin.ok && provenanceOf(afterJoin)).toEqual({ base: "before_task/customer_written", mine: "task_made" });
        // another task reads the merged set: the joined reply is still not counted
        const second = await service.readRoundSet(A, { ...query(), taskId: "task-two" });
        expect(second.ok && provenanceOf(second)).toEqual({ base: "before_task/customer_written", mine: "task_made" });
        // a later import that carries the same content does not promote it
        expect(await importFile(service, A, [reply("base"), reply("mine", "written by the coding agent")])).toMatchObject({ ok: true, added: 0, skipped: 2 });
        const last = await service.readSet(A, query());
        expect(last.ok && provenanceOf(last)).toEqual({ base: "before_task/customer_written", mine: "task_made" });
      }));

      it("does not import a reply an open task's overlay holds", () => withStore(harness, async (service) => {
        await importFile(service, A, [reply("base")]);
        await service.putOverlay(A, { project: PROJECT, taskId: "task-one", family: FAMILY, replies: [reply("pending", "x")] });
        expect(await importFile(service, A, [reply("pending", "x")])).toMatchObject({ ok: true, added: 0, skipped: 1 });
        const read = await service.readSet(A, query());
        expect(read.ok && provenanceOf(read)).toEqual({ base: "before_task/customer_written" });
      }));

      it("puts an edit of an existing id after the original under a derived id, task_made, and never lets it shadow the original", () => withStore(harness, async (service) => {
        await importFile(service, A, [reply("a", "original")]);
        const edited = reply("a", "edited by the agent");
        await service.putOverlay(A, { project: PROJECT, taskId: "task-one", family: FAMILY, replies: [edited] });
        const round = await service.readRoundSet(A, { ...query(), taskId: "task-one" });
        const derived = `a.edit-${sha(edited).slice(0, 8)}`;
        expect(round.ok && round.set.replies.map((entry) => entry.id)).toEqual(["a", derived]);
        await service.joinTask(A, { project: PROJECT, taskId: "task-one", family: FAMILY, branch: BRANCH });
        const read = await service.readSet(A, query());
        expect(read.ok && provenanceOf(read)).toEqual({ a: "before_task/customer_written", [derived]: "task_made" });
      }));

      it("accepts independent replies only from the channel, keeps them independent after the join, and counts them before the task_made ones in the round set", () => withStore(harness, async (service) => {
        const mine = reply("agent", "same prompt, coding agent's answer");
        const theirs = reply("indep", "same prompt, independent answer");
        await service.putOverlay(A, { project: PROJECT, taskId: "task-one", family: FAMILY, replies: [mine] });
        const forged = { provenance: "independent" as const, contentSha256: sha(theirs) };
        const refused = await service.putIndependentOverlay(A, { project: PROJECT, taskId: "task-one", family: FAMILY, entries: [{ reply: theirs, decision: forged as never }] });
        expect(refused).toEqual({ ok: false, word: "not_allowed" });
        const spread = { ...createRovaraIndependentDecision(sha(theirs)) };
        expect(await service.putIndependentOverlay(A, { project: PROJECT, taskId: "task-one", family: FAMILY, entries: [{ reply: theirs, decision: spread }] })).toEqual({ ok: false, word: "not_allowed" });
        // the decision is for ONE content: another reply with this decision is refused, and nothing is written (all or none)
        expect(await service.putIndependentOverlay(A, { project: PROJECT, taskId: "task-one", family: FAMILY, entries: [{ reply: theirs, decision: createRovaraIndependentDecision(sha(theirs)) }, { reply: reply("other"), decision: createRovaraIndependentDecision(sha(theirs)) }] })).toEqual({ ok: false, word: "not_allowed" });
        const before = await service.readRoundSet(A, { ...query(), taskId: "task-one" });
        expect(before.ok && provenanceOf(before)).toEqual({ agent: "task_made" });
        expect(await service.putIndependentOverlay(A, { project: PROJECT, taskId: "task-one", family: FAMILY, entries: [{ reply: theirs, decision: createRovaraIndependentDecision(sha(theirs)) }] })).toEqual({ ok: true, stored: 1, skipped: [] });
        const round = await service.readRoundSet(A, { ...query(), taskId: "task-one" });
        expect(round.ok && round.set.replies.map((entry) => `${entry.id}:${entry.provenance}`)).toEqual(["indep:independent", "agent:task_made"]);
        await service.joinTask(A, { project: PROJECT, taskId: "task-one", family: FAMILY, branch: BRANCH });
        const read = await service.readSet(A, query());
        expect(read.ok && provenanceOf(read)).toEqual({ indep: "independent", agent: "task_made" });
        const next = await service.readRoundSet(A, { ...query(), taskId: "task-two" });
        expect(next.ok && provenanceOf(next)).toEqual({ indep: "independent", agent: "task_made" });
      }));

      it("puts counted replies before not-counted ones in the round set, so a counted reply wins for the same prompt", () => withStore(harness, async (service) => {
        const taskMadeFirst = reply("tm", "task_made answer", { promptContains: "weather" });
        await service.putOverlay(A, { project: PROJECT, taskId: "task-one", family: FAMILY, replies: [taskMadeFirst] });
        await service.joinTask(A, { project: PROJECT, taskId: "task-one", family: FAMILY, branch: BRANCH });
        await importFile(service, A, [reply("bt", "before_task answer", { promptContains: "weather" })]);
        const read = await service.readSet(A, query());
        expect(read.ok && read.set.replies.map((entry) => entry.id)).toEqual(["tm", "bt"]); // head order: the join came first
        const round = await service.readRoundSet(A, { ...query(), taskId: "task-two" });
        expect(round.ok && round.set.replies.map((entry) => entry.id)).toEqual(["bt", "tm"]); // the round set puts the counted one first
      }));

      it("refuses a before_task origin the import may not name (a recording has its own intake)", () => withStore(harness, async (service) => {
        const outcome = await service.importFromRepoFile(A, { ...query(), baseCommitSha: COMMIT, bytes: bytesOf([reply("a")]), origin: "real_recording_capped" as never });
        expect(outcome).toEqual({ ok: false, word: "not_allowed" });
        expect(await service.readSet(A, query())).toEqual({ ok: false, word: "not_found" });
      }));

      it("refuses a file of another family, a file that is not a reply set and a bad commit", () => withStore(harness, async (service) => {
        expect(await service.importFromRepoFile(A, { ...query(), baseCommitSha: COMMIT, bytes: bytesOf([reply("a")], "cohere"), origin: "customer_written" })).toEqual({ ok: false, word: "not_allowed" });
        expect(await service.importFromRepoFile(A, { ...query(), baseCommitSha: COMMIT, bytes: new TextEncoder().encode("not json"), origin: "customer_written" })).toEqual({ ok: false, word: "not_allowed" });
        expect(await service.importFromRepoFile(A, { ...query(), baseCommitSha: "nope", bytes: bytesOf([reply("a")]), origin: "customer_written" })).toEqual({ ok: false, word: "not_found" });
      }));
    });

    describe("the join", () => {
      it("is idempotent: a second join changes nothing, and a late overlay write for a joined task is refused", () => withStore(harness, async (service) => {
        await service.putOverlay(A, { project: PROJECT, taskId: "task-one", family: FAMILY, replies: [reply("x")] });
        expect(await service.joinTask(A, { project: PROJECT, taskId: "task-one", family: FAMILY, branch: BRANCH })).toEqual({ ok: true, status: "joined", added: 1 });
        const first = await service.readSet(A, query());
        expect(await service.joinTask(A, { project: PROJECT, taskId: "task-one", family: FAMILY, branch: BRANCH })).toEqual({ ok: true, status: "already_joined", added: 1 });
        const second = await service.readSet(A, query());
        expect(second).toEqual(first);
        expect(await service.putOverlay(A, { project: PROJECT, taskId: "task-one", family: FAMILY, replies: [reply("late")] })).toEqual({ ok: false, word: "not_allowed" });
        const after = await service.readSet(A, query());
        expect(after.ok && after.revision).toBe(first.ok ? first.revision : -1);
      }));

      it("answers not_found for a task that wrote nothing, and moves no head when every reply is already listed", () => withStore(harness, async (service) => {
        expect(await service.joinTask(A, { project: PROJECT, taskId: "task-none", family: FAMILY, branch: BRANCH })).toEqual({ ok: false, word: "not_found" });
        await importFile(service, A, [reply("a")]);
        await service.putOverlay(A, { project: PROJECT, taskId: "task-one", family: FAMILY, replies: [reply("a")] });
        expect(await service.joinTask(A, { project: PROJECT, taskId: "task-one", family: FAMILY, branch: BRANCH })).toEqual({ ok: true, status: "joined", added: 0 });
        const read = await service.readSet(A, query());
        expect(read.ok && read.revision).toBe(1);
      }));

      it("appends after the existing replies, in the order independent then task_made, and refuses everything over the head's cap", () => withStore(harness, async (service) => {
        await importFile(service, A, [reply("a"), reply("b")]);
        await service.putOverlay(A, { project: PROJECT, taskId: "task-one", family: FAMILY, replies: [reply("c"), reply("d")] });
        await service.putIndependentOverlay(A, { project: PROJECT, taskId: "task-one", family: FAMILY, entries: [{ reply: reply("i"), decision: createRovaraIndependentDecision(sha(reply("i"))) }] });
        await service.joinTask(A, { project: PROJECT, taskId: "task-one", family: FAMILY, branch: BRANCH });
        const read = await service.readSet(A, query());
        expect(read.ok && read.set.replies.map((entry) => entry.id)).toEqual(["a", "b", "i", "c", "d"]);
      }));
    });

    describe("branches", () => {
      it("reads the default branch's head for a branch with none (marked), and gives the branch its own head at its first write", () => withStore(harness, async (service) => {
        await importFile(service, A, [reply("a")], { branch: DEFAULT_BRANCH });
        const inherited = await service.readSet(A, query({ defaultBranch: DEFAULT_BRANCH }));
        expect(inherited).toMatchObject({ ok: true, inheritedFrom: DEFAULT_BRANCH, branch: BRANCH });
        expect(await service.readSet(A, query())).toEqual({ ok: false, word: "not_found" }); // no default named: no inheritance
        expect(await importFile(service, A, [reply("b")], { defaultBranch: DEFAULT_BRANCH })).toMatchObject({ ok: true, added: 1 });
        const own = await service.readSet(A, query({ defaultBranch: DEFAULT_BRANCH }));
        expect(own.ok && "inheritedFrom" in own).toBe(false);
        expect(own.ok && provenanceOf(own)).toEqual({ a: "before_task/customer_written", b: "before_task/customer_written" });
        const main = await service.readSet(A, query({ branch: DEFAULT_BRANCH }));
        expect(main.ok && provenanceOf(main)).toEqual({ a: "before_task/customer_written" });
      }));

      it("keeps two projects, and two families of one branch, apart", () => withStore(harness, async (service) => {
        await importFile(service, A, [reply("a")]);
        expect(await service.readSet(A, query({ project: "another-project" }))).toEqual({ ok: false, word: "not_found" });
        expect(await service.readSet(A, query({ family: "cohere" }))).toEqual({ ok: false, word: "not_found" });
        expect((await service.listHeads(A, PROJECT)).ok).toBe(true);
      }));

      it("lists heads as counts and digests, never bodies", () => withStore(harness, async (service) => {
        await importFile(service, A, [reply("a", "secret body text")]);
        await service.putOverlay(A, { project: PROJECT, taskId: "task-one", family: FAMILY, replies: [reply("b")] });
        await service.joinTask(A, { project: PROJECT, taskId: "task-one", family: FAMILY, branch: BRANCH });
        const listed = await service.listHeads(A, PROJECT);
        expect(listed).toMatchObject({ ok: true, heads: [{ branch: BRANCH, family: FAMILY, revision: 2, entryCount: 2, counts: { before_task: 1, independent: 0, task_made: 1 } }] });
        expect(JSON.stringify(listed)).not.toContain("secret body text");
      }));
    });

    describe("caps and expiry", () => {
      it("does not store a reply over 256 KiB, names it, and stores the others", () => withStore(harness, async (service) => {
        const big = reply("big", "x".repeat(REPLY_ENTRY_BODY_MAX_BYTES));
        const outcome = await service.putOverlay(A, { project: PROJECT, taskId: "task-one", family: FAMILY, replies: [big, reply("small")] });
        expect(outcome).toEqual({ ok: true, stored: 1, tooLarge: ["big"] });
        const round = await service.readRoundSet(A, { ...query(), taskId: "task-one" });
        expect(round.ok && round.set.replies.map((entry) => entry.id)).toEqual(["small"]);
      }));

      it("deletes an overlay after 30 days: it is gone for the round set and cannot be joined", async () => {
        let clock = new Date("2026-11-13T00:00:00Z");
        await withStore(harness, async (service) => {
          await service.putOverlay(A, { project: PROJECT, taskId: "task-one", family: FAMILY, replies: [reply("x")] });
          expect((await service.readRoundSet(A, { ...query(), taskId: "task-one" })).ok).toBe(true);
          clock = new Date(clock.getTime() + (REPLY_OVERLAY_TTL_DAYS * 86_400 - 60) * 1000);
          expect((await service.readRoundSet(A, { ...query(), taskId: "task-one" })).ok).toBe(true);
          clock = new Date(clock.getTime() + 120 * 1000);
          expect(await service.readRoundSet(A, { ...query(), taskId: "task-one" })).toEqual({ ok: false, word: "not_found" });
          expect(await service.joinTask(A, { project: PROJECT, taskId: "task-one", family: FAMILY, branch: BRANCH })).toEqual({ ok: false, word: "not_found" });
        }, { now: () => clock });
      });

      it("keeps heads and bodies when an overlay expires (they are the project's data)", async () => {
        let clock = new Date("2026-11-13T00:00:00Z");
        await withStore(harness, async (service) => {
          await importFile(service, A, [reply("a")]);
          clock = new Date(clock.getTime() + 400 * 86_400 * 1000);
          expect((await service.readSet(A, query())).ok).toBe(true);
        }, { now: () => clock });
      });

      it("takes at most 25 capped real recordings per project and family, each at most 64 KiB, and refuses the whole intake over the cap", () => withStore(harness, async (service) => {
        const many = (from: number, count: number) => Array.from({ length: count }, (_, index) => reply(`rec-${from + index}`));
        expect(await service.importRecordings(A, { ...query(), replies: many(0, REAL_RECORDING_MAX_PER_FAMILY) })).toMatchObject({ ok: true, added: REAL_RECORDING_MAX_PER_FAMILY });
        expect(await service.importRecordings(A, { ...query(), replies: many(100, 1) })).toEqual({ ok: false, word: "too_many" });
        expect(await service.importRecordings(A, { ...query({ family: "cohere" }), replies: [reply("big", "x".repeat(REAL_RECORDING_MAX_BYTES))] })).toEqual({ ok: false, word: "too_large" });
        const read = await service.readSet(A, query());
        expect(read.ok && read.set.replies.every((entry) => entry.provenance === "before_task" && entry.origin === "real_recording_capped")).toBe(true);
        expect(read.ok && read.set.replies.length).toBe(REAL_RECORDING_MAX_PER_FAMILY);
      }));

      it("refuses a fixed word set that never echoes an id or a body", () => {
        for (const text of Object.values(REPLY_STORE_WORDS)) expect(text).not.toMatch(/[#]|org_|task/u);
      });
    });

    describe("a reply the coding agent wrote is never imported as before_task (the durable MADE record, review H1)", () => {
      const task = { project: PROJECT, taskId: "task-one", family: FAMILY };
      const base = (service: ReplySetStoreService) => importFile(service, A, [reply("base")]);
      const ids = async (service: ReplySetStoreService) => {
        const read = await service.readSet(A, query());
        return read.ok ? read.set.replies.map((entry) => `${entry.id}:${entry.provenance}`) : [];
      };

      it("expiry: 31 days after the overlay was written an import of the same content leaves it out", async () => {
        let clock = new Date("2026-11-13T00:00:00Z");
        await withStore(harness, async (service) => {
          await base(service);
          await service.putOverlay(A, { ...task, replies: [reply("hand", "agent wrote this")] });
          clock = new Date(clock.getTime() + 31 * 86_400 * 1000);
          expect(await importFile(service, A, [reply("base"), reply("hand", "agent wrote this")])).toMatchObject({ ok: true, added: 0, skipped: 2 });
          expect(await ids(service)).toEqual(["base:before_task"]);
        }, { now: () => clock });
      });
      it("deleteOverlay: an import of the same content leaves it out", () => withStore(harness, async (service) => {
        await base(service);
        await service.putOverlay(A, { ...task, replies: [reply("hand", "agent wrote this")] });
        await service.deleteOverlay(A, task);
        expect(await importFile(service, A, [reply("hand", "agent wrote this")])).toMatchObject({ ok: true, added: 0, skipped: 1 });
        expect(await ids(service)).toEqual(["base:before_task"]);
      }));
      it("a failed join (an id clash the agent builds from public hashes): the reply never joins and is never imported", () => withStore(harness, async (service) => {
        await importFile(service, A, [reply("a", "original")]);
        const x = reply("a", "agent edit");
        const y = reply(`a.edit-${sha(x).slice(0, 8)}`, "agent's decoy");
        await service.putOverlay(A, { ...task, replies: [y, x] });
        expect(await service.joinTask(A, { ...task, branch: BRANCH })).toEqual({ ok: false, word: "id_clash" });
        await service.deleteOverlay(A, task);
        expect(await importFile(service, A, [x, y])).toMatchObject({ ok: true, added: 0, skipped: 2 });
        expect(await ids(service)).toEqual(["a:before_task"]);
      }));
      it("a full head (1,000 entries): the join is refused and the reply is never imported", () => withStore(harness, async (service) => {
        await importFile(service, A, Array.from({ length: 999 }, (_, index) => reply(`r${index}`)));
        await service.putOverlay(A, { ...task, replies: [reply("e1", "agent"), reply("e2", "agent")] });
        expect(await service.joinTask(A, { ...task, branch: BRANCH })).toEqual({ ok: false, word: "too_many" });
        await service.deleteOverlay(A, task);
        expect(await importFile(service, A, [reply("e1", "agent")])).toMatchObject({ ok: true, added: 0, skipped: 1 });
        const read = await service.readSet(A, query());
        expect(read.ok && read.set.replies.some((entry) => entry.id === "e1")).toBe(false);
      }));
      it("a refused late write still marks its content: after the join marker, and over the overlay's 1,000 entries", () => withStore(harness, async (service) => {
        await base(service);
        await service.putOverlay(A, { ...task, replies: [reply("one")] });
        await service.joinTask(A, { ...task, branch: BRANCH });
        expect(await service.putOverlay(A, { ...task, replies: [reply("late", "after the join")] })).toEqual({ ok: false, word: "not_allowed" });
        expect(await importFile(service, A, [reply("late", "after the join")])).toMatchObject({ ok: true, added: 0, skipped: 1 });
        const many = Array.from({ length: 1_001 }, (_, index) => reply(`big${index}`));
        expect(await service.putOverlay(A, { project: PROJECT, taskId: "task-big", family: FAMILY, replies: many })).toEqual({ ok: false, word: "too_many" });
        expect(await importFile(service, A, [reply("big7")])).toMatchObject({ ok: true, added: 0, skipped: 1 });
      }));
      it("content-equal variants are recorded too: another id, and toolCalls absent or empty", () => withStore(harness, async (service) => {
        await base(service);
        await service.putOverlay(A, { ...task, replies: [reply("hand", "agent wrote this")] });
        const renamed = reply("another-id", "agent wrote this");
        const emptyCalls: ModelReplyFileEntry = { id: "hand", match: {}, response: { text: "agent wrote this", finish: "stop", toolCalls: [] } };
        expect(await importFile(service, A, [renamed])).toMatchObject({ ok: true, added: 0, skipped: 1 });
        expect(await importFile(service, A, [emptyCalls])).toMatchObject({ ok: true, added: 0, skipped: 1 });
        expect(await importFile(service, A, [reply("other", "a different answer")])).toMatchObject({ ok: true, added: 1 });
        expect(await ids(service)).toEqual(["base:before_task", "other:before_task"]);
      }));
      it("independent overlay content is not recorded: an identical import counts as before_task (accepted)", () => withStore(harness, async (service) => {
        const ind = reply("ind", "independent answer");
        await service.putIndependentOverlay(A, { ...task, entries: [{ reply: ind, decision: createRovaraIndependentDecision(sha(ind)) }] });
        expect(await importFile(service, A, [ind])).toMatchObject({ ok: true, added: 1 });
        expect(await ids(service)).toEqual(["ind:before_task"]);
      }));
    });

    describe("erase leaves a tombstone: no import into an erased project until a maintainer clears it", () => {
      const task = { project: PROJECT, taskId: "task-one", family: FAMILY };
      it("refuses importFromRepoFile and importRecordings with the fixed erased word, then imports after clearErasure", () => withStore(harness, async (service) => {
        await importFile(service, A, [reply("a")]);
        await service.putOverlay(A, { ...task, replies: [reply("hand", "agent wrote this")] });
        expect(await service.eraseProject(A, { project: PROJECT })).toMatchObject({ ok: true });
        expect(await importFile(service, A, [reply("a"), reply("hand", "agent wrote this")])).toEqual({ ok: false, word: "erased" });
        expect(await service.importRecordings(A, { ...query(), replies: [reply("rec")] })).toEqual({ ok: false, word: "erased" });
        expect(await service.readSet(A, query())).toEqual({ ok: false, word: "not_found" });
        // overlays and joins are not blocked (they write task_made only)
        expect(await service.putOverlay(A, { ...task, replies: [reply("x")] })).toMatchObject({ ok: true });
        expect(await service.clearErasure(A, { project: PROJECT })).toEqual({ ok: true });
        expect(await importFile(service, A, [reply("a")])).toMatchObject({ ok: true, added: 1 });
      }));
      it("an erase that deleted nothing leaves no tombstone, and a second erase keeps the first one", () => withStore(harness, async (service) => {
        expect(await service.eraseProject(A, { project: PROJECT })).toEqual({ ok: true, deleted: 0 });
        expect(await importFile(service, A, [reply("a")])).toMatchObject({ ok: true, added: 1 });
        await service.eraseProject(A, { project: PROJECT });
        expect(await service.eraseProject(A, { project: PROJECT })).toEqual({ ok: true, deleted: 0 });
        expect(await importFile(service, A, [reply("a")])).toEqual({ ok: false, word: "erased" });
      }));
      it("is per company and per project: another company's erase, and another project, are not blocked", () => withStore(harness, async (service) => {
        await importFile(service, A, [reply("a")]);
        await importFile(service, B, [reply("a")]);
        await service.eraseProject(A, { project: PROJECT });
        expect(await importFile(service, B, [reply("b")])).toMatchObject({ ok: true, added: 1 });
        expect(await importFile(service, A, [reply("a")], { project: "another-project" })).toMatchObject({ ok: true, added: 1 });
        expect(await service.clearErasure(B, { project: PROJECT })).toEqual({ ok: true });
        expect(await importFile(service, A, [reply("a")])).toEqual({ ok: false, word: "erased" });
      }));
    });

    describe("two companies (DECISIONS 150)", () => {
      const plantFor = async (service: ReplySetStoreService, company: IsolationCompany, extra: { taskId?: string } = {}) => {
        const scope = scopeOf(company);
        const canaryReply = reply("canary", company.canary, { promptContains: company.canary });
        expect(await importFile(service, scope, [reply("base", `base of ${company.label}`), canaryReply])).toMatchObject({ ok: true });
        expect(await service.putOverlay(scope, { project: PROJECT, taskId: extra.taskId ?? TASK, family: FAMILY, replies: [reply("overlay", `overlay ${company.canary}`)] })).toMatchObject({ ok: true });
      };
      const seen = async (service: ReplySetStoreService, company: IsolationCompany) => ({
        set: await service.readSet(scopeOf(company), query()),
        round: await service.readRoundSet(scopeOf(company), { ...query(), taskId: TASK }),
        heads: await service.listHeads(scopeOf(company), PROJECT),
      });

      it("keeps two companies that share every raw id apart: nothing written, read or listed for one is seen by the other", () => withStore(harness, async (service) => {
        const surfaces: IsolationSurface[] = [
          { kind: "write", name: "import and overlay", plant: async (me) => void (await plantFor(service, me)), observe: async (as) => seen(service, as) },
          {
            kind: "read",
            name: "the set by the shared raw project and branch",
            plant: async () => undefined,
            observe: async (as) => service.readSet(scopeOf(as), query()),
          },
          { kind: "list", name: "heads of the shared project", plant: async () => undefined, observe: async (as) => service.listHeads(scopeOf(as), PROJECT), expectOwn: false },
          {
            kind: "write",
            name: "the join of the shared task id",
            plant: async () => undefined,
            observe: async (as) => {
              const joined = await service.joinTask(scopeOf(as), { project: PROJECT, taskId: TASK, family: FAMILY, branch: BRANCH });
              return { joined, set: await service.readSet(scopeOf(as), query()) };
            },
          },
        ];
        await assertSurfacesIsolated(surfaces);
      }));

      it("answers one not_found for a missing project, another company's project and another project", () => withStore(harness, async (service) => {
        await service.importFromRepoFile(A, { project: "only-a", branch: BRANCH, family: FAMILY, baseCommitSha: COMMIT, bytes: bytesOf([reply("a", COMPANY_A.canary)]), origin: "customer_written" });
        await service.putOverlay(A, { project: "only-a", taskId: "only-a-task", family: FAMILY, replies: [reply("o", COMPANY_A.canary)] });
        const ask = async (scope: HostScope, project: string, taskId = "only-a-task") => ({
          set: await service.readSet(scope, { project, branch: BRANCH, family: FAMILY }),
          round: await service.readRoundSet(scope, { project, branch: BRANCH, family: FAMILY, taskId }),
          heads: await service.listHeads(scope, project),
          join: await service.joinTask(scope, { project, taskId, family: FAMILY, branch: BRANCH }),
        });
        const missing = await ask(B, "never-written");
        const otherCompany = await ask(B, "only-a");
        const otherProject = await ask(A, "never-written");
        expect(otherCompany).toEqual(missing);
        expect(otherProject).toEqual(missing);
        expect(JSON.stringify(missing)).toContain(`"word":"not_found"`);
        // the owner still sees its data: a positive control
        expect((await service.readSet(A, { project: "only-a", branch: BRANCH, family: FAMILY })).ok).toBe(true);
      }));

      it("never lets a write, join, import, overlay, delete or erase of one company touch the other's", () => withStore(harness, async (service) => {
        await plantFor(service, COMPANY_A);
        await plantFor(service, COMPANY_B);
        const before = await seen(service, COMPANY_A);
        // B acts on the SHARED raw ids in every way
        await importFile(service, B, [reply("more", COMPANY_B.canary)]);
        await service.putOverlay(B, { project: PROJECT, taskId: TASK, family: FAMILY, replies: [reply("overlay2", COMPANY_B.canary)] });
        expect(await service.joinTask(B, { project: PROJECT, taskId: TASK, family: FAMILY, branch: BRANCH })).toMatchObject({ ok: true, status: "joined" });
        await service.deleteOverlay(B, { project: PROJECT, taskId: TASK, family: FAMILY });
        expect(await service.eraseProject(B, { project: PROJECT })).toMatchObject({ ok: true });
        expect(await seen(service, COMPANY_A)).toEqual(before);
        expect((await seen(service, COMPANY_B)).set).toEqual({ ok: false, word: "not_found" });
        // and A erasing leaves a new B alone (the erase left B's project a tombstone: a maintainer clears it)
        expect(await service.clearErasure(B, { project: PROJECT })).toEqual({ ok: true });
        await plantFor(service, COMPANY_B);
        const b = await seen(service, COMPANY_B);
        expect(await service.eraseProject(A, { project: PROJECT })).toMatchObject({ ok: true });
        expect(await seen(service, COMPANY_B)).toEqual(b);
        expect((await seen(service, COMPANY_A)).set).toEqual({ ok: false, word: "not_found" });
      }));

      it("cannot join, delete or read another company's task by its id", () => withStore(harness, async (service) => {
        await service.putOverlay(A, { project: PROJECT, taskId: "task-of-a", family: FAMILY, replies: [reply("x", COMPANY_A.canary)] });
        expect(await service.joinTask(B, { project: PROJECT, taskId: "task-of-a", family: FAMILY, branch: BRANCH })).toEqual({ ok: false, word: "not_found" });
        await service.deleteOverlay(B, { project: PROJECT, taskId: "task-of-a", family: FAMILY });
        expect((await service.readRoundSet(A, { ...query(), taskId: "task-of-a" })).ok).toBe(true);
        expect(await service.readRoundSet(B, { ...query(), taskId: "task-of-a" })).toEqual({ ok: false, word: "not_found" });
        expect(await service.joinTask(A, { project: PROJECT, taskId: "task-of-a", family: FAMILY, branch: BRANCH })).toMatchObject({ ok: true, status: "joined" });
      }));

      it("never puts a canary in an error or a refusal", () => withStore(harness, async (service) => {
        await plantFor(service, COMPANY_A);
        const outcomes = await Promise.all([
          attempt(() => service.readSet(B, query())),
          attempt(() => service.importFromRepoFile(B, { ...query(), baseCommitSha: COMMIT, bytes: new TextEncoder().encode(COMPANY_A.canary), origin: "customer_written" })),
          attempt(() => service.putOverlay(B, { project: PROJECT, taskId: TASK, family: FAMILY, replies: [{ id: "A".repeat(3), match: {}, response: { text: "x", finish: "stop" } }] })),
        ]);
        for (const outcome of outcomes) expect(JSON.stringify(outcome)).not.toContain(COMPANY_A.canary);
      }));

      it("fails closed when the company resolver throws or answers nothing: every operation is refused and nothing is written", async () => {
        let mode: ResolverFailure | "ok" = "ok";
        await withStore(harness, async (service) => {
          const operations: Record<string, () => Promise<unknown>> = {
            readSet: () => service.readSet(A, query()),
            readRoundSet: () => service.readRoundSet(A, { ...query(), taskId: TASK }),
            listHeads: () => service.listHeads(A, PROJECT),
            putOverlay: () => service.putOverlay(A, { project: PROJECT, taskId: "task-two", family: FAMILY, replies: [reply("w", COMPANY_A.canary)] }),
            putIndependentOverlay: () => service.putIndependentOverlay(A, { project: PROJECT, taskId: "task-two", family: FAMILY, entries: [{ reply: reply("w"), decision: createRovaraIndependentDecision(sha(reply("w"))) }] }),
            importFromRepoFile: () => importFile(service, A, [reply("w", COMPANY_A.canary)]),
            importRecordings: () => service.importRecordings(A, { ...query(), replies: [reply("w", COMPANY_A.canary)] }),
            joinTask: () => service.joinTask(A, { project: PROJECT, taskId: TASK, family: FAMILY, branch: BRANCH }),
            deleteOverlay: () => service.deleteOverlay(A, { project: PROJECT, taskId: TASK, family: FAMILY }),
            eraseProject: () => service.eraseProject(A, { project: PROJECT }),
            clearErasure: () => service.clearErasure(A, { project: PROJECT }),
          };
          const probes: FailClosedProbe[] = Object.entries(operations).map(([operation, run]) => ({
            name: operation,
            async prepare() {
              mode = "ok";
              await importFile(service, A, [reply("base", COMPANY_A.canary)]);
              await service.putOverlay(A, { project: PROJECT, taskId: TASK, family: FAMILY, replies: [reply("overlay", COMPANY_A.canary)] });
            },
            async attempt(failure) {
              mode = failure;
              try {
                return await run();
              } finally {
                mode = "ok";
              }
            },
          }));
          await assertFailsClosed(probes);
          // every refusal is the fixed one, and a refused write changed nothing
          for (const failure of ["throws", "undefined"] as const) {
            mode = failure;
            for (const [operation, run] of Object.entries(operations)) {
              const outcome = await attempt(run);
              expect(outcome.ok, `${operation} when the resolver ${failure}`).toBe(false);
              if (!outcome.ok) expect(outcome.refused).toBe(`ReplyStoreRefusal: ${REPLY_STORE_WORDS.not_allowed}`);
            }
            mode = "ok";
          }
          const read = await service.readSet(A, query());
          expect(read.ok && provenanceOf(read)).toEqual({ base: "before_task/customer_written" });
          expect(new ReplyStoreRefusal().word).toBe("not_allowed");
        }, {
          resolveCompany: (scope) => {
            if (mode === "throws") throw new Error(`the resolver is down for ${COMPANY_A.canary}`);
            if (mode === "undefined") return undefined;
            return "orgId" in scope ? scope.orgId : undefined;
          },
        });
      });

      it("erases only this project's rows of this lane, idempotently", () => withStore(harness, async (service) => {
        await importFile(service, A, [reply("a")]);
        await importFile(service, A, [reply("keep")], { project: "other-project" });
        await service.putOverlay(A, { project: PROJECT, taskId: "task-one", family: FAMILY, replies: [reply("o")] });
        expect(await service.eraseProject(A, { project: PROJECT })).toMatchObject({ ok: true });
        expect(await service.eraseProject(A, { project: PROJECT })).toEqual({ ok: true, deleted: 0 });
        expect(await service.readSet(A, query())).toEqual({ ok: false, word: "not_found" });
        expect(await service.readRoundSet(A, { ...query(), taskId: "task-one" })).toEqual({ ok: false, word: "not_found" });
        expect((await service.readSet(A, query({ project: "other-project" }))).ok).toBe(true);
      }));
    });
  });
}
