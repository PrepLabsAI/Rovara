/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- route answers are parsed JSON read field by field */
// Answers feed the wiki (lead 4, J5): the gap list read from answer records, "Not right", and the flag on a wiki claim whose own place Code could not find. Two projects and two companies never meet,
// one person cannot inflate a topic, no asker is ever named, an erased or expired record takes its gap with it, every list is bounded, and a flag is only ever added by Code's own check.
import { describe, expect, it } from "vitest";
import {
  ANSWER_FEEDBACK_LIMITS, ANSWER_FEEDBACK_WORDS, ANSWER_WORDS, AnswerGapsResponseSchema, NotRightResponseSchema, WIKI_ANSWER_RETENTION_DAYS, WIKI_NEEDS_MAINTAINER, WIKI_PROJECT_NOT_FOUND, type OrgId, type ProjectRole,
  type WikiAnswerRecordWrite, type WikiStore,
} from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createWikiStore } from "../../packages/broker/src/core/wiki/store.js";
import { gapKindOf, listGaps, pressNotRight, topicKey, topicWords } from "../../packages/broker/src/core/answers/feedback.js";
import { routeHostedWikiCorrections, type HostedWikiCorrectionsWiring } from "../../packages/broker/src/core-host/wiki-corrections-routes.js";
import { isAnswersPath, routeHostedAnswers, type HostedAnswersWiring } from "../../packages/broker/src/core-host/answer-routes.js";
import { A, B, HEAD, OLD, T0, answer, body, goodSentence, page, scriptedModel, tool, world } from "../support/answer-world.js";

const ADA = "ada";
const BOB = "bob";
const SRC = { repo: "web", path: "src/refund.ts", commit: HEAD, line: 3, quote: "export const MAX_REFUND_DAYS = 30;" };

function record(over: Partial<WikiAnswerRecordWrite> & { answerId: string }): WikiAnswerRecordWrite {
  return { askedBy: ADA, channel: "web", question: "How long do refunds last?", answer: "Thirty days.", outcome: "answered", sources: [SRC], pagesRead: ["billing"], ...over };
}
async function memory() {
  const store = new MemoryDocumentStore();
  const clock = { now: T0 };
  let n = 0;
  const wikiOf = (companyId: OrgId): WikiStore => createWikiStore({ store, companyId, now: () => clock.now, newId: () => `id-${companyId.slice(-4)}-${String(++n).padStart(4, "0")}` });
  return { store, clock, wikiOf };
}

describe("topics: the few words a question is about", () => {
  it("the same words in another order, with plurals, links, mentions and filler, are one topic", () => {
    expect(topicKey("How do refunds work?")).toBe(topicKey("work refund how do"));
    expect(topicKey("What is the refund limit for orders? https://example.com/x <@U123ABC> @maya")).toBe(topicKey("orders: limit of refund"));
    expect(topicKey("refund limit")).not.toBe(topicKey("payout limit"));
  });
  it("a question with no usable words has no topic; a topic keeps at most eight words and never an id-like number", () => {
    expect(topicWords("why?")).toEqual([]);
    expect(topicWords("alpha beta gamma delta epsilon zeta theta iota kappa lambda")).toHaveLength(ANSWER_FEEDBACK_LIMITS.topicWords);
    expect(topicWords("order 123456789 failed")).toEqual(["order", "failed"]);
  });
});

describe("which answers are a gap", () => {
  const base = { askedBy: ADA, channel: "web" as const, question: "q", answer: "a", sources: [SRC], pagesRead: ["billing"], createdAt: "2026-11-17T10:00:00.000Z", expiresAt: 1 };
  it("not found, partly, an answer the code carried with no wiki page read, and a Not right are gaps; a whole answer that used the wiki is not", () => {
    expect(gapKindOf({ ...base, answerId: "a1xx", outcome: "dont_know", sources: [] })).toBe("not_found");
    expect(gapKindOf({ ...base, answerId: "a2xx", outcome: "partly" })).toBe("partly");
    expect(gapKindOf({ ...base, answerId: "a3xx", outcome: "answered", pagesRead: [] })).toBe("wiki_empty");
    expect(gapKindOf({ ...base, answerId: "a4xx", outcome: "answered", notRight: true })).toBe("not_right");
    expect(gapKindOf({ ...base, answerId: "a5xx", outcome: "answered" })).toBeUndefined();
    // No sources and no wiki page: nothing the code carried.
    expect(gapKindOf({ ...base, answerId: "a6xx", outcome: "answered", pagesRead: [], sources: [] })).toBeUndefined();
  });
});

describe("the gap list", () => {
  it("groups questions of one topic, counts different people (one person cannot inflate it), shows the worst kind, and never names anyone", async () => {
    const m = await memory();
    const wiki = m.wikiOf(A);
    await wiki.writeAnswer("alpha", record({ answerId: "a0001", askedBy: ADA, question: "How do refunds work?", outcome: "partly" }));
    m.clock.now += 1000;
    await wiki.writeAnswer("alpha", record({ answerId: "a0002", askedBy: ADA, question: "work refund how", outcome: "dont_know", sources: [] }));
    await wiki.writeAnswer("alpha", record({ answerId: "a0003", askedBy: BOB, question: "Refunds: how do they work", outcome: "partly" }));
    await wiki.writeAnswer("alpha", record({ answerId: "a0004", askedBy: ADA, question: "Where is the payout schedule?", outcome: "answered", pagesRead: [] }));
    await wiki.writeAnswer("alpha", record({ answerId: "a0005", askedBy: ADA, question: "What does the login page do?", outcome: "answered" }));
    const list = AnswerGapsResponseSchema.parse(await listGaps(wiki, "alpha"));
    expect(list.items.map((item) => [item.kind, item.people, item.questions])).toEqual([["not_found", 2, 3], ["wiki_empty", 1, 1]]);
    expect(list.more).toBe(false);
    expect(JSON.stringify(list)).not.toMatch(/ada|bob|askedBy/iu);
    // A day, not a moment: a topic one person asked cannot be matched to a message by its time.
    expect(list.items.every((item) => /^\d{4}-\d{2}-\d{2}$/u.test(item.lastAskedAt))).toBe(true);
  });

  it("is bounded: at most 50 topics (the worst and widest first), and a project with more than the scan limit says so", async () => {
    const m = await memory();
    const wiki = m.wikiOf(A);
    const names = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima", "mike", "november", "oscar", "papa", "quebec", "romeo", "sierra", "tango"];
    for (let i = 0; i < 60; i += 1) await wiki.writeAnswer("alpha", record({ answerId: `a${String(i).padStart(4, "0")}`, question: `Where is ${names[i % 20]!} ${names[Math.floor(i / 20) + 3]!}x${String(i)}`, outcome: "partly", askedBy: `p${String(i)}` }));
    const list = await listGaps(wiki, "alpha");
    expect(list.items).toHaveLength(ANSWER_FEEDBACK_LIMITS.gaps);
    expect(list.more).toBe(true);
    // A project with more records than the scan holds says so, and an expired row not yet swept does not use up the scan.
    const few = await listGaps(wiki, "alpha", 20);
    expect(few.more).toBe(true);
    expect(few.items.length).toBeLessThanOrEqual(20);
    const capped = await wiki.listAnswers("alpha", 10);
    expect(capped.records).toHaveLength(10);
    expect(capped.more).toBe(true);
    m.clock.now += (WIKI_ANSWER_RETENTION_DAYS * 86_400 + 1) * 1000;
    expect(await listGaps(wiki, "alpha", 20)).toMatchObject({ items: [], more: false });
  });

  it("an erased asker's questions and an expired record leave the list (the topic is gone with its words)", async () => {
    const m = await memory();
    const wiki = m.wikiOf(A);
    await wiki.writeAnswer("alpha", record({ answerId: "a0001", askedBy: ADA, question: "How do refunds work?", outcome: "partly" }));
    await wiki.writeAnswer("alpha", record({ answerId: "a0002", askedBy: BOB, question: "Where is the payout schedule?", outcome: "partly" }));
    expect((await listGaps(wiki, "alpha")).items).toHaveLength(2);
    await wiki.erasePerson(["alpha"], ADA);
    expect((await listGaps(wiki, "alpha")).items.map((item) => item.topic)).toEqual(["Where is the payout schedule?"]);
    m.clock.now += (WIKI_ANSWER_RETENTION_DAYS * 86_400 + 1) * 1000;
    expect((await listGaps(wiki, "alpha")).items).toEqual([]);
  });
});

describe("Not right", () => {
  async function withAnswer(over: Partial<WikiAnswerRecordWrite> = {}) {
    const m = await memory();
    const wiki = m.wikiOf(A);
    await wiki.writePage("alpha", page("A-alpha", { repos: [{ repo: "web", commit: HEAD }], claims: [
      { claimId: "c0001", text: "Refund limit lives in refund.ts", citations: [{ repo: "web", path: "src/refund.ts", commit: HEAD, line: 3, quote: "export const MAX_REFUND_DAYS = 30;" }], source: "found", checkedAt: "2026-11-17T09:00:00.000Z" },
      { claimId: "c0002", text: "Retries are in retry.ts", citations: [{ repo: "web", path: "src/retry.ts", commit: HEAD, line: 40, quote: "export const RETRY_LIMIT = 200;" }], source: "found", checkedAt: "2026-11-17T09:00:00.000Z" },
    ], blocks: [
      { kind: "heading", blockId: "h0001", level: 2, text: "Refunds" },
      { kind: "paragraph", blockId: "p0001", text: "Refunds run through refund.ts.", claimIds: ["c0001"] },
      { kind: "paragraph", blockId: "p0002", text: "Retries run through retry.ts.", claimIds: ["c0002"] },
    ] }));
    await wiki.writeAnswer("alpha", record({ answerId: "a0001", ...over }));
    return { m, wiki };
  }

  it("the asker's press queues the claims the answer rested on for the next refresh: marked may be out of date, NOT hidden from agents; other claims are untouched; the gap list shows it", async () => {
    const { wiki } = await withAnswer();
    const done = NotRightResponseSchema.parse(await pressNotRight(wiki, { project: "alpha", answerId: "a0001", personId: ADA }));
    expect(done).toEqual({ answerId: "a0001", state: "queued", claims: 1 });
    const read = (await wiki.readPage("alpha", "billing", "person"))!;
    expect(read.page.claims.map((claim) => [claim.claimId, claim.source])).toEqual([["c0001", "changed"], ["c0002", "found"]]);
    expect(read.flags).toEqual([]);
    // The refresh's own plan (pages with changed claims) now picks the page up, and agents still read the claim.
    expect((await wiki.readIndex("alpha"))[0]!.claims.changed).toBe(1);
    expect((await wiki.readPage("alpha", "billing", "agent"))!.page.claims.map((claim) => claim.claimId)).toEqual(["c0001", "c0002"]);
    expect((await listGaps(wiki, "alpha")).items[0]).toMatchObject({ kind: "not_right", people: 1 });
  });

  it("the store itself refuses another person's, an expired and an unknown record (a second wall behind the module's check)", async () => {
    const { m, wiki } = await withAnswer();
    expect(await wiki.markAnswerNotRight("alpha", "a0001", BOB)).toBeUndefined();
    expect(await m.wikiOf(B).markAnswerNotRight("alpha", "a0001", ADA)).toBeUndefined();
    expect(await wiki.markAnswerNotRight("beta", "a0001", ADA)).toBeUndefined();
    expect(await wiki.markAnswerNotRight("alpha", "a9999", ADA)).toBeUndefined();
    expect(await wiki.markAnswerNotRight("alpha", "a0001", ADA)).toBe("marked");
    expect(await wiki.markAnswerNotRight("alpha", "a0001", ADA)).toBe("already");
  });

  it("a claim written or re-checked after the answer was given is not queued (an already refreshed page is left alone)", async () => {
    const { m, wiki } = await withAnswer();
    m.clock.now += 60_000;
    await wiki.writePage("alpha", page("A-alpha", { repos: [{ repo: "web", commit: HEAD }], claims: [
      { claimId: "c0001", text: "Refund limit lives in refund.ts", citations: [{ repo: "web", path: "src/refund.ts", commit: HEAD, line: 3, quote: "export const MAX_REFUND_DAYS = 30;" }], source: "found", checkedAt: new Date(m.clock.now).toISOString() },
    ], blocks: [{ kind: "heading", blockId: "h0001", level: 2, text: "Refunds" }] }));
    expect(await pressNotRight(wiki, { project: "alpha", answerId: "a0001", personId: ADA })).toEqual({ answerId: "a0001", state: "noted", claims: 0 });
    expect((await wiki.readPage("alpha", "billing", "person"))!.page.claims[0]!.source).toBe("found");
  });
});

// ---- The flag on a wiki claim whose own place Code could not find ----------------------------------------------------------------------------------------------------------------------------

describe("a flag from an answer: only when Code itself did not find the claim's own place", () => {
  const stale = { claimId: "c0001", text: "The limit is the old constant", citations: [{ repo: "web", path: "src/refund.ts", commit: OLD, line: 3, quote: "export const OLD_LIMIT_DAYS = 14;" }], source: "found" as const, checkedAt: "2026-11-17T09:00:00.000Z" };
  const wrongCite = { repo: "web", path: "src/refund.ts", line: 3, quote: "export const OLD_LIMIT_DAYS = 14;" };
  const ready = () => { const w = world(); w.roles.add(`${A}/alpha/${ADA}`); w.roles.add(`${A}/beta/${ADA}`); w.roles.add(`${B}/alpha/${ADA}`); return w; };

  it("a sentence removed because its quote is not at the cited place points Code at the wiki claim that cites that place; Code finds the claim's quote nowhere and flags it, with an answer source and no reason", async () => {
    const w = ready();
    await w.wiki(A).writePage("alpha", page("A-alpha", { claims: [stale] }));
    const model = scriptedModel([tool({ tool: "wiki_read", page: "billing" }), answer([goodSentence, { text: "The refund limit is `OLD_LIMIT_DAYS` days.", cites: [wrongCite] }])]);
    const result = await w.service({ model }).ask({ personId: ADA, project: "alpha", body: body() });
    expect(result.outcome).toBe("partly");
    const read = (await w.wiki(A).readPage("alpha", "billing", "person"))!;
    expect(read.flags).toHaveLength(1);
    expect(read.flags[0]).toMatchObject({ claimId: "c0001", by: { kind: "answer", answerId: result.answerId } });
    expect(read.flags[0]!.reason).toBeUndefined();
    expect((await w.wiki(A).readPage("alpha", "billing", "agent"))!.page.claims).toEqual([]);
  });
});

// ---- The routes ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

describe("the gap list route (maintainers only)", () => {
  const ROLES: Record<string, ProjectRole> = { [`${A}/alpha/maya`]: "maintainer", [`${A}/alpha/ada`]: "contributor", [`${A}/alpha/vera`]: "viewer", [`${A}/beta/maya`]: "maintainer", [`${B}/alpha/maya`]: "maintainer" };
  async function setup() {
    const m = await memory();
    await m.wikiOf(A).writeAnswer("alpha", record({ answerId: "a0001", question: "How do refunds work?", outcome: "partly" }));
    await m.wikiOf(B).writeAnswer("alpha", record({ answerId: "a0002", question: "What about invoices?", outcome: "partly" }));
    const wiring: HostedWikiCorrectionsWiring = {
      projectRole: async (personId, companyId, project) => ROLES[`${companyId}/${project}/${personId}`],
      projectRepositories: async (_company, project) => (project === "alpha" || project === "beta" ? ["web"] : undefined),
    };
    const get = async (companyId: OrgId, personId: string, path = "/v1/app/projects/alpha/wiki/gaps", method = "GET") => {
      const done = await routeHostedWikiCorrections({ request: { method, path, headers: {} }, path, personId, companyId, store: m.store, wiring, now: () => m.clock.now });
      return { status: done.statusCode, body: JSON.parse(done.body) as Record<string, any>, raw: done.body };
    };
    return { get };
  }
  it("a maintainer reads their project's list; a contributor and a viewer get the fixed 403; no role, another company's project, a missing project all the same 404", async () => {
    const { get } = await setup();
    const ok = await get(A, "maya");
    expect(ok.status).toBe(200);
    expect(AnswerGapsResponseSchema.parse(ok.body).items.map((item) => item.topic)).toEqual(["How do refunds work?"]);
    expect(ok.raw).not.toContain("invoices");
    for (const person of ["ada", "vera"]) {
      const refused = await get(A, person);
      expect(refused.status).toBe(403);
      expect(refused.body["error"].message).toBe(WIKI_NEEDS_MAINTAINER);
    }
    for (const [company, person, path] of [[A, "stranger", undefined], [B, "ada", undefined], [A, "maya", "/v1/app/projects/ghost/wiki/gaps"], [A, "maya", "/v1/app/projects/Not%20A%20Name/wiki/gaps"]] as const) {
      const none = await get(company, person, path);
      expect(none.status, `${company} ${person} ${String(path)}`).toBe(404);
      expect(none.body["error"].message).toBe(WIKI_PROJECT_NOT_FOUND);
    }
    const bm = await get(B, "maya");
    expect(AnswerGapsResponseSchema.parse(bm.body).items.map((item) => item.topic)).toEqual(["What about invoices?"]);
    expect((await get(A, "maya", "/v1/app/projects/beta/wiki/gaps")).body["items"]).toEqual([]);
  });
  it("only GET: a POST to the gap path is not a route", async () => {
    const { get } = await setup();
    expect((await get(A, "maya", "/v1/app/projects/alpha/wiki/gaps", "POST")).status).toBe(404);
  });
});

describe("the Not right route (the asker, with a role now)", () => {
  async function setup(standings: Record<string, "view" | "manage"> = { [`${A}/alpha/ada`]: "view", [`${A}/alpha/bob`]: "view", [`${B}/alpha/ada`]: "view" }) {
    const m = await memory();
    await m.wikiOf(A).writePage("alpha", page("A-alpha", { repos: [{ repo: "web", commit: HEAD }], claims: [{ claimId: "c0001", text: "Refund limit lives in refund.ts", citations: [{ repo: "web", path: "src/refund.ts", commit: HEAD, line: 3, quote: "export const MAX_REFUND_DAYS = 30;" }], source: "found", checkedAt: "2026-11-17T09:00:00.000Z" }] }));
    await m.wikiOf(A).writeAnswer("alpha", record({ answerId: "a0001" }));
    const wiring = { standing: async (personId: string, companyId: string, project: string) => { const access = standings[`${companyId}/${project}/${personId}`]; return access === undefined ? undefined : { access, basis: "company" }; }, repositories: async () => undefined } as unknown as HostedAnswersWiring;
    const post = async (companyId: OrgId, personId: string, path = "/v1/app/projects/alpha/answers/a0001/not-right", body: unknown = {}) => {
      const done = await routeHostedAnswers({ request: { method: "POST", path, headers: {}, body: typeof body === "string" ? body : JSON.stringify(body) }, path, personId, companyId, store: m.store, wiring, now: () => m.clock.now });
      return { status: done.statusCode, body: JSON.parse(done.body) as Record<string, any>, raw: done.body };
    };
    return { m, post };
  }
  it("is a POST row next to the answer route, and nothing else of that shape", () => {
    expect(isAnswersPath("/v1/app/projects/alpha/answers/a0001/not-right", "POST")).toBe(true);
    for (const [method, path] of [["GET", "/v1/app/projects/alpha/answers/a0001/not-right"], ["PUT", "/v1/app/projects/alpha/answers/a0001/not-right"], ["POST", "/v1/app/projects/alpha/answers/a0001/not-right/x"], ["POST", "/v1/app/projects/alpha/answers//not-right"], ["POST", "/v1/app/projects/alpha/answers/a0001/right"]] as const) {
      expect(isAnswersPath(path, method), `${method} ${path}`).toBe(false);
    }
  });
  it("the asker presses it and the claim is queued; the same press again is 'already'", async () => {
    const { m, post } = await setup();
    const first = await post(A, ADA);
    expect(first.status).toBe(200);
    expect(NotRightResponseSchema.parse(first.body)).toEqual({ answerId: "a0001", state: "queued", claims: 1 });
    expect((await m.wikiOf(A).readPage("alpha", "billing", "person"))!.page.claims[0]!.source).toBe("changed");
    expect((await post(A, ADA)).body["state"]).toBe("already");
  });
  it("another person with a role, a person with none, another project and another company's answer all get the same 404 and queue nothing", async () => {
    const { m, post } = await setup();
    const same = JSON.stringify({ error: { code: "NOT_FOUND", message: ANSWER_FEEDBACK_WORDS.notYours } });
    const noRole = await post(A, "stranger");
    expect(noRole.status).toBe(404);
    expect(noRole.body["error"].message).toBe(ANSWER_WORDS.projectNotFound);
    for (const [company, person, path] of [[A, BOB, undefined], [B, ADA, undefined], [A, ADA, "/v1/app/projects/alpha/answers/a9999/not-right"]] as const) {
      const done = await post(company, person, path);
      expect(done.status, `${company} ${person}`).toBe(404);
      expect(done.raw).toBe(same);
    }
    expect((await m.wikiOf(A).readPage("alpha", "billing", "person"))!.page.claims[0]!.source).toBe("found");
  });
  it("the body must be {} and a bad request says fixed words without echoing it", async () => {
    const { post } = await setup();
    const bad = await post(A, ADA, undefined, { personId: "bob", secret: "echo-me" });
    expect(bad.status).toBe(400);
    expect(bad.raw).not.toContain("echo-me");
    expect((await post(A, ADA, undefined, "{not json")).status).toBe(400);
  });
  it("a standing that cannot be read is a fixed 503", async () => {
    const { m } = await setup();
    const wiring = { standing: async () => { throw new Error("down"); }, repositories: async () => undefined } as unknown as HostedAnswersWiring;
    const path = "/v1/app/projects/alpha/answers/a0001/not-right";
    const done = await routeHostedAnswers({ request: { method: "POST", path, headers: {}, body: "{}" }, path, personId: ADA, companyId: A, store: m.store, wiring, now: () => m.clock.now });
    expect(done.statusCode).toBe(503);
    expect(done.body).not.toContain("down");
  });
});
