// Slack thread replies as a lessons source (lane L4-SRC-SL; the owner's privacy decision, DEC 254zzz3/4). Every rule is a check in code, so every rule has a test that fails when the check is removed:
// the place (bound channel only, never a DM or a shared space), the words (replies in the task's own thread, plain messages), the people (linked members with a project role now, not erased, not opted out, no bots,
// no other organisation), the correction filter, the project's Pause (STOP: not even asked), the weak-source gate (seen twice, never on its own), no raw message stored, and the person's erase.
import { OrgIdSchema } from "@agentx/contracts";
import { describe, expect, it, vi } from "vitest";
import { MAX_PEOPLE_PER_READ, MAX_REPLIES_READ, MAX_SLACK_REPLY_SPANS, SLACK_READ_DEADLINE_MS, SLACK_PAUSE_KEY, SLACK_REPLY_MAX_CHARS, slackReplySpans, type SlackReplyFact, type SlackThreadFacts, type SlackThreadReader } from "../../../packages/broker/src/lessons/slack-source.js";
import { citesSlackReply, isWeakSlackOnly } from "../../../packages/broker/src/lessons/weak-source.js";
import { earnedAttention, processDraft, type ProcessDeps } from "../../../packages/broker/src/lessons/process.js";
import { buildReflectorInput } from "../../../packages/broker/src/lessons/reflect-input.js";
import { reflectSubject } from "../../../packages/broker/src/lessons/reflect.js";
import { trialBlockers } from "../../../packages/broker/src/lessons/trial.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import { LessonProvenanceSchema, SPAN_KINDS } from "../../../packages/broker/src/lessons/types.js";
import { Alerts, Audit, Clock, KEY, MemoryVectors, autoSettings, ScriptedModel, Spend, candidateJson, draft, embedder, facts, lessonRecord, memberSpan, reply, settings, subject, verifier } from "./lesson-helpers.js";

const COMPANY = OrgIdSchema.parse("org_aaaaaaaaaaaaaaaaaaaa");
const PROJECT = "payments";
const PLACE = "slack:T0123456789/C0123456789";
const SAY = "Use the shared retry helper instead of writing a new retry loop by hand.";
const SAY_TWO = "Never call the billing API from tests, use the recorded fake instead.";

const reply1 = (over: Partial<SlackReplyFact> = {}): SlackReplyFact => ({ id: "1700000001.000100", text: SAY, bot: false, external: false, plain: true, person: "ann", ...over });
const thread = (messages: SlackReplyFact[], over: Partial<SlackThreadFacts> = {}): SlackThreadFacts => ({ place: PLACE, boundToProject: true, private: false, shared: false, direct: false, messages, ...over });

/** The source over fixed answers; `reads` counts how often the thread was asked for. */
function source(facts_: SlackThreadFacts | undefined, over: { standing?: Record<string, "member" | "outsider" | undefined>; optedOut?: string[]; optedOutThrows?: boolean; paused?: boolean; pausedThrows?: boolean; readerThrows?: boolean; standingThrows?: boolean } = {}) {
  const state = { reads: 0, standingAsked: [] as string[], optOutAsked: [] as string[] };
  const reader: SlackThreadReader = { async read() { state.reads += 1; if (over.readerThrows) throw new Error("slack down"); return facts_; } };
  const options = {
    reader,
    async standingOf(person: string) { state.standingAsked.push(person); if (over.standingThrows) throw new Error("people down"); return over.standing === undefined ? "member" as const : (person in over.standing ? over.standing[person] : "outsider" as const); },
    async optedOut(person: string) { state.optOutAsked.push(person); if (over.optedOutThrows) throw new Error("store down"); return (over.optedOut ?? []).includes(person); },
    async paused() { if (over.pausedThrows) throw new Error("flags down"); return over.paused === true; },
    now: () => Date.parse("2026-11-18T08:00:00.000Z"),
  };
  return { state, run: () => slackReplySpans(options, { companyId: COMPANY, project: PROJECT, taskId: "task-1" }) };
}

describe("the capture: a member's correction in the task's own thread becomes a slack_reply span", () => {
  it("carries the person, a pointer (team, channel, time), a source key, the place and the project's audience for a public channel", async () => {
    const spans = await source(thread([reply1()])).run();
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ kind: "slack_reply", text: SAY, trust: "member", authorId: "ann", eventId: `${PLACE}#1700000001.000100`, sourceKey: "slack:C0123456789", scopes: [PLACE], audience: { kind: "project" } });
  });
  it("a private channel keeps its own audience (DEC 34): restricted to the space, naming no one, so only a record of the space's readers can open it", async () => {
    const spans = await source(thread([reply1()], { private: true })).run();
    expect(spans[0]!.audience).toEqual({ kind: "restricted", acl: { source: "slack", scope: PLACE, capturedAt: "2026-11-18T08:00:00.000Z", liveCheck: "none" } });
  });
  it("cleans the words: mentions become a neutral word, secrets are redacted, and the text is cut to the bound", async () => {
    const [mention] = await source(thread([reply1({ text: `<@U0123456789> please use the shared retry helper instead of a new loop, ${"x".repeat(20)}` })])).run();
    expect(mention!.text).not.toContain("U0123456789");
    expect(mention!.text).toContain("@member");
    const [long] = await source(thread([reply1({ text: `Use the shared helper instead. ${"a".repeat(2000)}` })])).run();
    expect(long!.text.length).toBeLessThanOrEqual(SLACK_REPLY_MAX_CHARS);
    const [secret] = await source(thread([reply1({ text: "Use the shared helper instead; the key is AKIAIOSFODNN7EXAMPLE and must not be pasted." })])).run();
    expect(secret!.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });
  it("keeps only the newest replies when there are more than the one total limit, and never looks past the read limit", async () => {
    const many = Array.from({ length: MAX_SLACK_REPLY_SPANS + 5 }, (_, i) => reply1({ id: `1700000001.${String(i).padStart(6, "0")}`, text: `Use helper number ${i} instead of writing the loop by hand.` }));
    const spans = await source(thread(many)).run();
    expect(spans).toHaveLength(MAX_SLACK_REPLY_SPANS);
    expect(spans.at(-1)!.eventId).toBe(`${PLACE}#${many.at(-1)!.id}`);
    const flood = Array.from({ length: MAX_REPLIES_READ + 50 }, (_, i) => reply1({ id: `1700000002.${String(i).padStart(6, "0")}`, person: i < MAX_REPLIES_READ ? undefined : "ann" }));
    expect(await source(thread(flood)).run()).toEqual([]);
  });
});

describe("one total limit", () => {
  it("keeps the NEWEST replies when there are more than the limit, in thread order", async () => {
    const many = Array.from({ length: MAX_SLACK_REPLY_SPANS + 3 }, (_, i) => reply1({ id: `1700000001.${String(i).padStart(6, "0")}`, text: `Use helper number ${i} instead of writing the loop by hand.` }));
    const spans = await source(thread(many)).run();
    expect(spans.map((s) => s.eventId)).toEqual(many.slice(-MAX_SLACK_REPLY_SPANS).map((m) => `${PLACE}#${m.id}`));
  });
  it("looks up at most a bounded number of different people, and the rest of a crowded thread is not read", async () => {
    // None of these reads as a correction, so no span fills up and the walk goes on through the whole crowd.
    const crowd = Array.from({ length: MAX_PEOPLE_PER_READ + 5 }, (_, i) => reply1({ id: `1700000001.${String(i).padStart(6, "0")}`, person: `p${i}`, text: "ok thanks" }));
    const out = source(thread(crowd), { standing: Object.fromEntries(crowd.map((m) => [m.person!, "member" as const])) });
    // Newest first: the last 25 people are looked up, the first 5 never are.
    const spans = await out.run();
    expect(out.state.standingAsked).toHaveLength(MAX_PEOPLE_PER_READ);
    expect(spans).toEqual([]);
    expect(out.state.standingAsked).not.toContain("p0");
  });
  it("says only a count when the thread had more replies than one read takes", async () => {
    const logs: Array<[string, Record<string, string | number>]> = [];
    const options = { reader: { async read() { return thread([reply1()], { truncated: true }); } }, standingOf: async () => "member" as const, optedOut: async () => false, paused: async () => false, now: () => 1, log: (e: string, f: Record<string, string | number>) => { logs.push([e, f]); } };
    expect(await slackReplySpans(options, { companyId: COMPANY, project: PROJECT, taskId: "t" })).toHaveLength(1);
    expect(logs).toEqual([["learning.slack_truncated", { replies: 1 }]]);
  });
});

describe("rule 1: which place", () => {
  it("a space that is not bound to the task's project is not read", async () => {
    expect(await source(thread([reply1()], { boundToProject: false })).run()).toEqual([]);
  });
  it("a direct message and a group direct message are never read, bound or not", async () => {
    expect(await source(thread([reply1()], { direct: true })).run()).toEqual([]);
  });
  it("a space shared with another organisation (Slack Connect) is never read", async () => {
    expect(await source(thread([reply1()], { shared: true })).run()).toEqual([]);
  });
  it("a place fact that is not a plain true or false (a malformed answer) is not read", async () => {
    expect(await source(thread([reply1()], { private: undefined as never })).run()).toEqual([]);
    expect(await source(thread([reply1()], { direct: undefined as never })).run()).toEqual([]);
    expect(await source(thread([reply1()], { shared: undefined as never })).run()).toEqual([]);
  });
  it("a task with no thread teaches nothing from Slack, and a reader that fails gives no span", async () => {
    expect(await source(undefined).run()).toEqual([]);
    expect(await source(thread([reply1()]), { readerThrows: true }).run()).toEqual([]);
  });
});

describe("rule 3: whose words", () => {
  it("an app, a bot and a message no person wrote are dropped (Rovara's own messages are apps)", async () => {
    expect(await source(thread([reply1({ bot: true })])).run()).toEqual([]);
  });
  it("a person of another organisation is dropped even when linked to a member", async () => {
    expect(await source(thread([reply1({ external: true })])).run()).toEqual([]);
  });
  it("a notice that is not a plain message (a join, a topic change, an edit marker) is dropped", async () => {
    expect(await source(thread([reply1({ plain: false })])).run()).toEqual([]);
  });
  it("a Slack account nobody linked has no person: dropped", async () => {
    expect(await source(thread([reply1({ person: undefined }), reply1({ person: "" })])).run()).toEqual([]);
  });
  it("a person with no role on the project (a guest, an outsider) is dropped, and the check is made now, per person", async () => {
    const guest = source(thread([reply1({ person: "guest" })]), { standing: { guest: "outsider" } });
    expect(await guest.run()).toEqual([]);
    const mixed = source(thread([reply1({ person: "guest", id: "1700000001.000200" }), reply1({ person: "ann", id: "1700000001.000300" })]), { standing: { guest: "outsider", ann: "member" } });
    expect((await mixed.run()).map((s) => s.authorId)).toEqual(["ann"]);
  });
  it("an erased person is dropped (their standing reads as nobody's), and a standing that cannot be read drops the person too", async () => {
    expect(await source(thread([reply1()]), { standing: { ann: undefined } }).run()).toEqual([]);
    expect(await source(thread([reply1()]), { standingThrows: true }).run()).toEqual([]);
  });
  it("a person who switched \"Don't learn from my Slack messages\" on is dropped, and an unreadable switch reads as on (fail closed)", async () => {
    const out = source(thread([reply1({ person: "ann", id: "1700000001.000200" }), reply1({ person: "bob", id: "1700000001.000300", text: SAY_TWO })]), { standing: { ann: "member", bob: "member" }, optedOut: ["ann"] });
    expect((await out.run()).map((s) => s.authorId)).toEqual(["bob"]);
    expect(await source(thread([reply1()]), { optedOutThrows: true }).run()).toEqual([]);
  });
  it("the person is judged BEFORE their words are looked at: an opted-out person's text is never cleaned or filtered", async () => {
    const out = source(thread([reply1({ text: "Use the shared helper instead of writing the loop by hand." })]), { optedOut: ["ann"] });
    expect(await out.run()).toEqual([]);
    expect(out.state.optOutAsked).toEqual(["ann"]);
  });
  it("a person is asked about once, however many replies they wrote", async () => {
    const out = source(thread([reply1({ id: "1700000001.000200" }), reply1({ id: "1700000001.000300", text: SAY_TWO })]));
    expect(await out.run()).toHaveLength(2);
    expect(out.state.standingAsked).toEqual(["ann"]);
    expect(out.state.optOutAsked).toEqual(["ann"]);
  });
});

describe("rule 4: what counts is a correction (the free filter, no model)", () => {
  it("praise, a nit, an acknowledgement, a short reply and a bare question are not read", async () => {
    const texts = ["lgtm, thanks for the quick fix everyone", "nit: spacing in the second paragraph of the readme", "ok", "thanks!", "Which retry helper is this one?"];
    const spans = await source(thread(texts.map((text, i) => reply1({ text, id: `1700000001.00${i}000` })))).run();
    expect(spans).toEqual([]);
  });
  it("a question that is a request is a correction, and a quoted or forwarded text is not read at all", async () => {
    expect(await source(thread([reply1({ text: "Why not use the shared retry helper instead of this loop?" })])).run()).toHaveLength(1);
    expect(await source(thread([reply1({ text: "> Use the shared retry helper instead of writing a new loop by hand.\nagreed" })])).run()).toEqual([]);
  });
});

describe("one total limit: the read gives up after its deadline", () => {
  it("a read that takes longer than the deadline teaches nothing from Slack (no partial result) and says why", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const logs: string[] = [];
      const options = {
        reader: { async read() { vi.setSystemTime(Date.now() + SLACK_READ_DEADLINE_MS + 1); return thread([reply1()]); } },
        standingOf: async () => "member" as const, optedOut: async () => false, paused: async () => false, now: () => 1, log: (event: string) => { logs.push(event); },
      };
      expect(await slackReplySpans(options, { companyId: COMPANY, project: PROJECT, taskId: "t" })).toEqual([]);
      expect(logs).toEqual(["learning.slack_not_read"]);
    } finally { vi.useRealTimers(); }
  });
});

describe("rule 5: the project's pause stops the read", () => {
  it("a paused source asks Slack for nothing: the thread reader is not called, and nobody's standing or switch is read", async () => {
    const out = source(thread([reply1()]), { paused: true });
    expect(await out.run()).toEqual([]);
    expect(out.state).toEqual({ reads: 0, standingAsked: [], optOutAsked: [] });
  });
  it("a pause that cannot be read is a pause (fail closed)", async () => {
    const out = source(thread([reply1()]), { pausedThrows: true });
    expect(await out.run()).toEqual([]);
    expect(out.state.reads).toBe(0);
  });
  it("the pause key is the one `Where Rovara learns from` writes for a paused kind", () => {
    expect(SLACK_PAUSE_KEY).toBe("kind:slack_reply");
  });
});

describe("the weak-source rules", () => {
  it("slack_reply is a kind this build writes and reads back as itself", () => {
    expect(SPAN_KINDS).toContain("slack_reply");
    expect(LessonProvenanceSchema.parse({ ...draft().provenance, sourceKinds: ["slack_reply", "not_a_kind"] }).sourceKinds).toEqual(["slack_reply", "other"]);
  });
  it("a lesson is weak only when a chat reply is the only person's evidence it cites", () => {
    expect(isWeakSlackOnly({ sourceKinds: ["slack_reply"] })).toBe(true);
    expect(isWeakSlackOnly({ sourceKinds: ["slack_reply", "review_finding"] })).toBe(true);
    for (const strong of ["send_back", "human_edit", "remembered", "close_reason", "plan_comment", "design_comment", "pr_comment"] as const) expect(isWeakSlackOnly({ sourceKinds: ["slack_reply", strong] }), strong).toBe(false);
    expect(isWeakSlackOnly({ sourceKinds: ["pr_comment"] })).toBe(false);
    expect(citesSlackReply({ sourceKinds: ["human_edit", "slack_reply"] })).toBe(true);
  });
  const slackLesson = (over: Record<string, unknown> = {}) => lessonRecord({ id: "les_sl000001", status: "candidate", provenance: { ...draft().provenance, sourceKinds: ["slack_reply"], authors: ["ann"], readFrom: ["ann"], memberSignal: false, measured: false, supportTasks: ["task-1"], ...over } });
  it("seen twice: one sighting waits (kept, not shown), a second task or a measured result puts it in front of people; a contradiction or a duplicate does not skip the wait", () => {
    expect(earnedAttention(slackLesson(), 1)).toBe(false);
    expect(earnedAttention({ ...slackLesson(), contradictsWith: "les_other" }, 1)).toBe(false);
    expect(earnedAttention({ ...slackLesson(), possibleDuplicateOf: "les_other" }, 1)).toBe(false);
    expect(earnedAttention(slackLesson(), 1, ["capability_request", "matches_rejected"])).toBe(false);
    expect(earnedAttention(slackLesson({ supportTasks: ["task-1", "task-2"] }), 1)).toBe(true);
    expect(earnedAttention(slackLesson({ supportTasks: ["task-1", "task-1"] }), 1)).toBe(false);
    // The owner's decision names no measured-result exception: a measured outcome alone does not skip the second sighting.
    expect(earnedAttention(slackLesson({ measured: true }), 1)).toBe(false);
    expect(earnedAttention(slackLesson({ measured: true }), 0)).toBe(false);
    // One task and a member signal (a strong source behind it) is NOT enough for a weak lesson: the member signal is only ever from a strong kind.
    expect(earnedAttention(slackLesson({ memberSignal: true }), 1)).toBe(false);
  });
  it("pausing the Slack row holds the lessons that cite a reply, and no others", async () => {
    const { attributableSources, isHeldBySource } = await import("../../../packages/broker/src/lessons/sources.js");
    const flags = { pausedSources: { [SLACK_PAUSE_KEY]: { at: 1, reason: "person" as const } } } as never;
    const slack = slackLesson().provenance;
    expect(attributableSources(slack)).toContain(SLACK_PAUSE_KEY);
    expect(isHeldBySource(flags, attributableSources(slack))).toBe(true);
    expect(isHeldBySource(flags, attributableSources(draft().provenance))).toBe(false);
  });
  it("a lesson that also cites a strong source is not made to wait because a chat reply sits beside it", () => {
    expect(earnedAttention(slackLesson({ sourceKinds: ["slack_reply", "human_edit"], memberSignal: true }), 1)).toBe(true);
  });
  it("never goes on trial, whatever else backs it (a member's correction, verified code, one repository)", () => {
    const base = lessonRecord({ id: "les_sl000002", provenance: { ...draft().provenance, sourceKinds: ["human_edit"], memberCorrection: true, claimsSupported: true } });
    const ctx = { projectRepos: new Set(["api"]), preset: "standard" as const, mode: "On" as never, trialAllowed: true, contradiction: false, refinement: false, reviewRequired: false, held: false, braked: false };
    expect(trialBlockers(base, 0, ctx)).not.toContain("slack_source");
    const withSlack = lessonRecord({ id: "les_sl000003", provenance: { ...base.provenance, sourceKinds: ["human_edit", "slack_reply"] } });
    expect(trialBlockers(withSlack, 0, ctx)).toContain("slack_source");
  });
});

function pipeline(store: InMemoryLessonStore): ProcessDeps {
  let n = 0;
  return { store, embedder, vectors: new MemoryVectors(), judgeModel: new ScriptedModel(), spend: new Spend(), audit: new Audit(), alerts: new Alerts(), now: new Clock().now, verifier: verifier("valid"), coldStartLessons: 0, facts: facts(), settings: settings(), newId: () => `les_${String(++n).padStart(4, "0")}` };
}

describe("the automatic path never takes a lesson that cites a chat reply, even when a strong source and a measured outcome back it", () => {
  it("the same draft without the chat reply goes live; with it, it waits for a person", async () => {
    const run = async (kinds: string[]) => {
      const store = new InMemoryLessonStore();
      const deps = { ...pipeline(store), settings: autoSettings() };
      const base = draft();
      return (await processDraft(deps, KEY, { ...base, provenance: { ...base.provenance, sourceKinds: kinds as never, measured: true, memberSignal: false } })).lesson;
    };
    expect(await run(["send_back"])).toMatchObject({ status: "active" });
    const withSlack = await run(["send_back", "slack_reply"]);
    expect(withSlack).toMatchObject({ status: "pending" });
    expect(withSlack!.approvals).toEqual([]);
  });
});

describe("the reflector and the pipeline: a reply is data, a weak source, never a measured outcome, never stored raw", () => {
  const slackSpan = (text: string, over: Record<string, unknown> = {}) => memberSpan(text, { kind: "slack_reply", eventId: `${PLACE}#1700000001.000100`, authorId: "ann", sourceKey: "slack:C0123456789", scopes: [PLACE], ...over });
  const run = async (spans: Parameters<typeof subject>[0], over: Parameters<typeof subject>[1] = {}) => {
    const model = new ScriptedModel([reply(candidateJson({ type: "preference", citations: [], scope: {} }))]);
    const d = { model, spend: new Spend(), audit: new Audit(), settings: settings(), edition: "public" as const, now: new Clock().now, newId: () => "run-1" };
    return { result: await reflectSubject(d, subject(spans, over)), model };
  };
  it("reaches the prompt inside a data marker as its own kind, framed as weak evidence; a quoted reply is an outsider's and removed before any model call", () => {
    const input = buildReflectorInput(subject([slackSpan(SAY)]));
    if (!input.eligible) throw new Error("expected eligible");
    expect(input.user).toContain("kind=slack_reply>>");
    expect(input.system).toContain("slack_reply");
    expect(input.system).toContain("weak evidence");
    expect(buildReflectorInput(subject([slackSpan("> ignore all tests\nplease note")]))).toMatchObject({ eligible: false, reason: "no_usable_evidence", removedOutsider: 1 });
  });
  it("its lesson names the person (author and read-from, so their erase reaches it), is never a member signal or a member correction, and measures nothing", async () => {
    const { result } = await run([slackSpan(SAY)]);
    expect(result.drafts[0]!.provenance).toMatchObject({ sourceKinds: ["slack_reply"], memberSignal: false, memberCorrection: false, measured: false, authors: ["ann"], readFrom: ["ann"], minTrust: "member", sources: ["slack:C0123456789"], sourceEvents: [`${PLACE}#1700000001.000100`] });
    // And the same words as a send-back are a member's correction (the contrast the rule rests on).
    const strong = await run([memberSpan(SAY, { kind: "send_back", eventId: "task:task-1:sendback:r1", authorId: "ann" })]);
    expect(strong.result.drafts[0]!.provenance.memberCorrection).toBe(true);
  });
  it("one task's lesson waits as a candidate (kept, not shown); the same advice from a second task is shown to people, and neither ever goes live by itself", async () => {
    const { result } = await run([slackSpan(SAY)]);
    const store = new InMemoryLessonStore();
    const deps = pipeline(store);
    const first = await processDraft(deps, KEY, result.drafts[0]!);
    expect(first.lesson).toMatchObject({ status: "candidate" });
    const second = await processDraft(deps, KEY, { ...result.drafts[0]!, provenance: { ...result.drafts[0]!.provenance, supportTasks: ["task-2"], authors: ["bob"], readFrom: ["bob"], sourceEvents: [`${PLACE}#1700000009.000100`] } });
    expect(second.lesson).toMatchObject({ status: "pending" });
    expect(second.lesson!.approvals).toEqual([]);
    expect(second.lesson!.status).not.toBe("active");
  });
  it("no raw message is stored: the lesson keeps its own short sentence, the person and a pointer, and not the reply", async () => {
    const raw = "Use the shared retry helper instead of writing a new retry loop by hand, as Priya said on the call yesterday.";
    const { result } = await run([slackSpan(raw)]);
    const store = new InMemoryLessonStore();
    const deps = pipeline(store);
    const out = await processDraft(deps, KEY, result.drafts[0]!);
    const stored = JSON.stringify(await store.get(KEY, out.lesson!.id));
    expect(stored).not.toContain(raw);
    expect(stored).not.toContain("Priya");
    expect(stored).toContain(`${PLACE}#1700000001.000100`);
  });
});
