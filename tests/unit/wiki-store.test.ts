// The project wiki store (lead 4, W2): rows only, one partition per company AND project. Two-project and two-company isolation on every read and write; the agents' read; quotes redacted
// and cut; removed repositories; the person erase step; answer expiry; the company purge removes every wiki row (no purge change).
import { describe, expect, it } from "vitest";
import { WIKI_FLAG_SCAN_MAX, WIKI_QUOTE_MAX, wikiPartition, type OrgId, type StoredDocument, type WikiPageWrite, type WikiStore } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { DocumentAuditSink } from "../../packages/broker/src/plugins/audit-sink/document/sink.js";
import { WIKI_FORMER_MEMBER, createWikiStore, storedQuote } from "../../packages/broker/src/core/wiki/store.js";
import { COMPANY_PURGE_COOLING_OFF_MS, requestCompanyPurge, runCompanyPurge, type CompanyPurgeDeps } from "../../packages/broker/src/core/company/purge.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const SHA = "a".repeat(40);
const T0 = Date.parse("2026-11-17T10:00:00.000Z");

function world() {
  const store = new MemoryDocumentStore();
  const clock = { now: T0 };
  let n = 0;
  const make = (companyId: OrgId): WikiStore => createWikiStore({ store, companyId, now: () => clock.now, newId: () => `id-${companyId.slice(-4)}-${String(++n).padStart(4, "0")}` });
  return { store, clock, a: make(A), b: make(B) };
}

/** A page whose every text carries `tag`, so a leak shows as the other side's tag. */
function page(tag: string, over: Partial<WikiPageWrite> = {}): WikiPageWrite {
  return {
    pageId: "overview", kind: "overview", title: `Overview ${tag}`, summary: `Summary ${tag}`, order: 0,
    repos: [{ repo: "web", commit: SHA }],
    blocks: [
      { kind: "heading", blockId: "h0001", level: 2, text: `Heading ${tag}` },
      { kind: "paragraph", blockId: "p0001", text: `First ${tag}`, claimIds: ["c0001"] },
      { kind: "paragraph", blockId: "p0002", text: `Second ${tag}`, claimIds: ["c0002"] },
    ],
    claims: [
      { claimId: "c0001", text: `Claim one ${tag}`, citations: [{ repo: "web", path: "src/a.ts", commit: SHA, line: 3, quote: `export const one = "${tag}";` }], source: "found", checkedAt: "2026-11-17T09:00:00.000Z" },
      { claimId: "c0002", text: `Claim two ${tag}`, citations: [{ repo: "web", path: "src/b.ts", commit: SHA, line: 9, quote: `export const two = "${tag}";` }], source: "found", checkedAt: "2026-11-17T09:00:00.000Z" },
    ],
    buildId: "build-0001",
    ...over,
  };
}

async function everything(store: MemoryDocumentStore): Promise<StoredDocument[]> {
  const out: StoredDocument[] = [];
  let cursor: string | undefined;
  do {
    const next = await store.scanPage({ limit: 1_000, ...(cursor === undefined ? {} : { cursor }) });
    out.push(...next.items);
    cursor = next.cursor;
  } while (cursor !== undefined);
  return out;
}

describe("wiki store: two companies and two projects never meet", () => {
  it("acknowledges changed notes only in their company and project, recording actor and time", async () => {
    const w = world();
    await w.a.writePage("alpha", page("A-alpha"));
    await w.a.writePage("beta", page("A-beta"));
    await w.b.writePage("alpha", page("B-alpha"));
    const own = await w.a.addNote("alpha", { pageId: "overview", text: "check source", authorId: "person-1" });
    const beta = await w.a.addNote("beta", { pageId: "overview", text: "beta", authorId: "person-2" });
    const other = await w.b.addNote("alpha", { pageId: "overview", text: "other company", authorId: "person-3" });
    w.clock.now += 5000;
    expect(await w.a.acknowledgeNote("alpha", "overview", own.noteId, "person-1")).toMatchObject({ changedAcknowledgement: { by: "person-1", at: new Date(w.clock.now).toISOString() } });
    expect(await w.a.acknowledgeNote("alpha", "overview", beta.noteId, "person-1")).toBeUndefined();
    expect(await w.a.acknowledgeNote("alpha", "overview", other.noteId, "person-1")).toBeUndefined();
    expect((await w.a.readPage("beta", "overview", "person"))?.notes[0]?.changedAcknowledgement).toBeUndefined();
    expect((await w.b.readPage("alpha", "overview", "person"))?.notes[0]?.changedAcknowledgement).toBeUndefined();
  });

  it("a project that has no wiki reads as empty, even when another project or company has the same page", async () => {
    const w = world();
    await w.a.writePage("alpha", page("A-alpha"));
    await w.b.writePage("gamma", page("B-gamma"));
    expect(await w.a.readIndex("gamma")).toEqual([]);
    expect(await w.a.readPage("gamma", "overview", "person")).toBeUndefined();
    expect(await w.b.readIndex("alpha")).toEqual([]);
    expect(await w.b.readPage("alpha", "overview", "agent")).toBeUndefined();
  });

  it("every write of one company and project leaves the other company's and project's rows byte for byte", async () => {
    const w = world();
    await w.b.writePage("alpha", page("B-alpha"));
    await w.a.writePage("beta", page("A-beta"));
    const untouched = (await everything(w.store)).filter((item) => item.pk !== wikiPartition(A, "alpha"));
    const before = JSON.stringify(untouched);
    await w.a.writePage("alpha", page("A-alpha"));
    const note = await w.a.addNote("alpha", { pageId: "overview", text: "n", authorId: "person-1" });
    await w.a.approveNote("alpha", "overview", note.noteId, "person-2");
    await w.a.addFlag("alpha", { pageId: "overview", by: { kind: "person", personId: "person-1" } });
    await w.a.markClaims("alpha", "overview", [{ claimId: "c0001", source: "changed" }]);
    await w.a.resolveFlags("alpha", "overview");
    await w.a.writeAnswer("alpha", { answerId: "answer-0001", askedBy: "person-1", channel: "web", question: "q", answer: "a", outcome: "answered", sources: [], pagesRead: [] });
    await w.a.erasePerson(["alpha"], "person-1");
    await w.a.deleteRepository("alpha", "web");
    await w.a.writePage("alpha", page("A-alpha"));
    await w.a.pruneRepositories("alpha", []);
    await w.a.writePage("alpha", page("A-alpha"));
    await w.a.pageSink("alpha").deletePages(["overview"]);
    await w.a.deleteWiki("alpha");
    expect(JSON.stringify((await everything(w.store)).filter((item) => item.pk !== wikiPartition(A, "alpha")))).toBe(before);
  });

  it("a note, flag or approval aimed at another project's or company's page finds nothing", async () => {
    const w = world();
    await w.b.writePage("alpha", page("B-alpha"));
    await w.a.writePage("beta", page("A-beta"));
    await expect(w.a.addNote("alpha", { pageId: "overview", text: "n", authorId: "person-1" })).rejects.toThrow("That wiki page is not there.");
    await expect(w.a.addFlag("alpha", { pageId: "overview", by: { kind: "person", personId: "person-1" } })).rejects.toThrow("That wiki page is not there.");
    const bNote = await w.b.addNote("alpha", { pageId: "overview", text: "b's note", authorId: "person-9" });
    expect(await w.a.approveNote("alpha", "overview", bNote.noteId, "person-1")).toBeUndefined();
    expect(await w.a.deleteNote("alpha", "overview", bNote.noteId)).toBe(false);
    expect(await w.a.approveNote("beta", "overview", bNote.noteId, "person-1")).toBeUndefined();
    expect((await w.b.readPage("alpha", "overview", "person"))?.notes.map((note) => note.approval.state)).toEqual(["pending"]);
    expect(await w.a.deletePage("alpha", "overview")).toBe(false);
    expect(await w.a.markClaims("alpha", "overview", [{ claimId: "c0001", source: "not_found" }])).toBe(0);
    expect((await w.b.readPage("alpha", "overview", "person"))?.page.claims[0]?.source).toBe("found");
    expect(await w.a.deleteRepository("alpha", "web")).toEqual({ pages: 0, notes: 0, flags: 0 });
    expect(await w.b.readIndex("alpha")).toHaveLength(1);
  });

  it("refuses a row a store hands back from another partition (the key check behind the query)", async () => {
    const w = world();
    await w.b.writePage("alpha", page("B-alpha"));
    const foreign = (await everything(w.store)).filter((item) => item.pk === wikiPartition(B, "alpha"));
    // A store that answers a query of A's partition with B's rows, relabelled with A's company: only the partition check can catch it.
    const lying = { ...w.store, get: w.store.get.bind(w.store), getMany: async (keys: readonly { pk: string; sk: string }[]) => await w.store.getMany(keys.map((key) => ({ pk: wikiPartition(B, "alpha"), sk: key.sk }))).then((items) => items.map((item) => (item === undefined ? undefined : { ...item, companyId: A }))),
      query: async (request: Parameters<MemoryDocumentStore["query"]>[0]) => ({ items: foreign.filter((item) => item.sk.startsWith((request.sk as { prefix?: string } | undefined)?.prefix ?? "")).map((item) => ({ ...item, companyId: A })) }) } as unknown as MemoryDocumentStore;
    const fooled = createWikiStore({ store: lying, companyId: A, now: () => T0 });
    await expect(fooled.readIndex("alpha")).rejects.toThrow("A wiki row could not be read.");
    await expect(fooled.readPage("alpha", "overview", "person")).rejects.toThrow("A wiki row could not be read.");
  });

  it("deleting a page never takes the notes or flags of a page whose id it begins (overview vs overview-2)", async () => {
    const w = world();
    await w.a.writePage("alpha", page("one"));
    await w.a.writePage("alpha", page("two", { pageId: "overview-2" }));
    await w.a.addNote("alpha", { pageId: "overview-2", text: "second page note", authorId: "person-1" });
    await w.a.addFlag("alpha", { pageId: "overview-2", claimId: "c0001", by: { kind: "person", personId: "person-1" } });
    await w.a.addNote("alpha", { pageId: "overview", text: "first page note", authorId: "person-1" });
    // Reading one page never shows the other's notes or flags, and a mark on overview-2 never hides overview from agents.
    await w.a.addFlag("alpha", { pageId: "overview-2", by: { kind: "person", personId: "person-1" } });
    const first = (await w.a.readPage("alpha", "overview", "person"))!;
    expect(first.notes.map((note) => note.text)).toEqual(["first page note"]);
    expect(first.flags).toEqual([]);
    expect(await w.a.readPage("alpha", "overview", "agent")).toBeDefined();
    expect(await w.a.readPage("alpha", "overview-2", "agent")).toBeUndefined();
    expect(await w.a.deletePage("alpha", "overview")).toBe(true);
    const second = (await w.a.readPage("alpha", "overview-2", "person"))!;
    expect(second.notes.map((note) => note.text)).toEqual(["second page note"]);
    expect(second.flags).toHaveLength(2);
  });


});

describe("wiki store: pages and claims", () => {

  it("redacts every stored quote and cuts it to 200 characters", async () => {
    const w = world();
    const secret = ["ghp", "_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join("");
    const long = `const token = "${secret}"; ${"x".repeat(400)}`;
    await w.a.writePage("alpha", page("q", { claims: [{ ...page("q").claims[0]!, citations: [{ ...page("q").claims[0]!.citations[0]!, quote: long }] }, page("q").claims[1]!] }));
    const raw = JSON.stringify(await everything(w.store));
    expect(raw).not.toContain(secret);
    const quote = (await w.a.readPage("alpha", "overview", "person"))!.page.claims[0]!.citations[0]!.quote;
    expect([...quote].length).toBeLessThanOrEqual(WIKI_QUOTE_MAX);
    expect(storedQuote("a‮b\nc")).toBe("a b c");
  });

  it("refuses a new page past 300 pages, but rewrites an existing one; reads never fail on the cap", async () => {
    const w = world();
    await w.a.writePage("alpha", page("x"));
    const row = (await w.store.get({ pk: wikiPartition(A, "alpha"), sk: "PAGE#overview" }))!;
    for (let i = 0; i < 300; i += 1) await w.store.put({ item: { ...row, sk: `PAGE#p${String(i).padStart(3, "0")}`, pageId: `p${String(i).padStart(3, "0")}` } });
    await expect(w.a.writePage("alpha", page("x", { pageId: "brand-new" }))).rejects.toThrow("The wiki already has as many pages as a project can.");
    await w.a.writePage("alpha", page("x2"));
    // 301 pages (two writes at once can pass the cap by one): the index still answers, with at most 300.
    expect(await w.a.readIndex("alpha")).toHaveLength(300);
  });

  it("only open marks count toward a page's mark limit", async () => {
    const w = world();
    await w.a.writePage("alpha", page("x"));
    for (let i = 0; i < 200; i += 1) await w.a.addFlag("alpha", { pageId: "overview", claimId: "c0001", by: { kind: "task", taskId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}` } });
    await expect(w.a.addFlag("alpha", { pageId: "overview", claimId: "c0001", by: { kind: "person", personId: "person-1" } })).rejects.toThrow("This page has as many marks as it can hold.");
    await w.a.resolveFlags("alpha", "overview");
    await expect(w.a.addFlag("alpha", { pageId: "overview", claimId: "c0001", by: { kind: "person", personId: "person-1" } })).resolves.toMatchObject({ state: "open" });
  });

});

describe("wiki store: what agents get", () => {

  it("openClaimFlagPages says it did not read everything (complete false) past the scan limit, and refuses a row that is not this project's", async () => {
    const w = world();
    await w.a.writePage("alpha", page("A"));
    const flag = (n: number, state: "open" | "resolved") => ({
      pk: wikiPartition(A, "alpha"), sk: `FLAG#overview#flag-${String(n).padStart(5, "0")}`, entityType: "WIKI_FLAG", companyId: A, project: "alpha",
      flag: { flagId: `flag-${String(n).padStart(5, "0")}`, pageId: "overview", claimId: "c0001", by: { kind: "person", personId: "person-1" }, createdAt: new Date(T0).toISOString(), state },
    }) as unknown as StoredDocument;
    for (let n = 0; n < WIKI_FLAG_SCAN_MAX; n += 1) await w.store.put({ item: flag(n, "resolved") });
    expect(await w.a.openClaimFlagPages("alpha")).toEqual({ pages: [], complete: true });
    await w.store.put({ item: flag(WIKI_FLAG_SCAN_MAX, "open") });
    expect((await w.a.openClaimFlagPages("alpha")).complete).toBe(false);
    await w.store.put({ item: { ...flag(0, "open"), sk: "FLAG#overview#aaaa-other", project: "beta" } });
    await expect(w.a.openClaimFlagPages("alpha")).rejects.toThrow("A wiki row could not be read.");
  });

  it("refuses an audience that is neither a person nor an agent", async () => {
    const w = world();
    await w.a.writePage("alpha", page("x"));
    await expect(w.a.readPage("alpha", "overview", "admin" as never)).rejects.toThrow("That is not a valid wiki input.");
  });

  it("refuses a flag on a claim the page does not have", async () => {
    const w = world();
    await w.a.writePage("alpha", page("x"));
    await expect(w.a.addFlag("alpha", { pageId: "overview", claimId: "c0099", by: { kind: "person", personId: "person-1" } })).rejects.toThrow("That claim is not on the page.");
  });
});

describe("wiki store: deleting", () => {
  it("a removed repository takes its own pages and every cross-repo page naming it, with their notes and flags, at once", async () => {
    const w = world();
    await w.a.writePage("alpha", page("web", { pageId: "repo-web", kind: "repo" }));
    await w.a.writePage("alpha", page("api", {
      pageId: "repo-api", kind: "repo", repos: [{ repo: "api", commit: SHA }],
      claims: page("api").claims.map((claim) => ({ ...claim, citations: claim.citations.map((citation) => ({ ...citation, repo: "api" })) })),
    }));
    await w.a.writePage("alpha", page("links", {
      pageId: "connections", kind: "connections", repos: [{ repo: "web", commit: SHA }, { repo: "api", commit: SHA }],
    }));
    await w.a.addNote("alpha", { pageId: "connections", text: "n", authorId: "person-1" });
    await w.a.addFlag("alpha", { pageId: "repo-web", by: { kind: "person", personId: "person-1" } });
    expect(await w.a.deleteRepository("alpha", "web")).toEqual({ pages: 2, notes: 1, flags: 1 });
    expect((await w.a.readIndex("alpha")).map((entry) => entry.pageId)).toEqual(["repo-api"]);
    expect(JSON.stringify(await everything(w.store))).not.toMatch(/repo-web|connections/u);
    // A cross-repo page goes whichever place the removed repository has in its list.
    await w.a.writePage("alpha", page("links", { pageId: "connections", kind: "connections", repos: [{ repo: "web", commit: SHA }, { repo: "api", commit: SHA }] }));
    expect(await w.a.deleteRepository("alpha", "api")).toEqual({ pages: 2, notes: 0, flags: 0 });
    expect(await w.a.readIndex("alpha")).toEqual([]);
  });

  it("the company purge removes every wiki row of the company and leaves the other company's (no purge change)", async () => {
    const w = world();
    await w.a.writePage("alpha", page("A"));
    await w.a.addNote("alpha", { pageId: "overview", text: "n", authorId: "person-1" });
    await w.a.writeAnswer("alpha", { answerId: "answer-0001", askedBy: "person-1", channel: "slack", question: "q", answer: "a", outcome: "answered", sources: [], pagesRead: [] });
    await w.b.writePage("alpha", page("B"));
    const bRows = JSON.stringify((await everything(w.store)).filter((item) => item.pk.startsWith(`ORG#${B}#WIKI#`)));
    const audit = new DocumentAuditSink({ store: () => w.store });
    const deps: CompanyPurgeDeps = { store: w.store, objects: { deleteEveryVersion: async () => true }, audit, now: () => w.clock.now, companyClosure: async () => ({ closed: true, closeId: "close-1" }) };
    await requestCompanyPurge(deps, { companyId: A, by: { kind: "operator", operatorId: "ops_ana" }, requestId: "11111111-2222-4333-8444-555555555555" });
    w.clock.now += COMPANY_PURGE_COOLING_OFF_MS + 1;
    let outcome = "";
    for (let call = 0; call < 50 && outcome !== "done"; call += 1) { outcome = (await runCompanyPurge(deps, A, 60_000)).outcome; w.clock.now += 70_000; }
    expect(outcome).toBe("done");
    expect((await everything(w.store)).filter((item) => item.pk.startsWith(`ORG#${A}#WIKI#`))).toEqual([]);
    expect(JSON.stringify((await everything(w.store)).filter((item) => item.pk.startsWith(`ORG#${B}#WIKI#`)))).toBe(bRows);
  });
});

describe("wiki store: person erase and answer expiry", () => {
  it("deletes the person's notes and answers and removes their reasons in every given project; others' words stay", async () => {
    const w = world();
    for (const project of ["alpha", "beta"]) {
      await w.a.writePage(project, page(project));
      await w.a.addNote(project, { pageId: "overview", text: `erase me ${project}`, authorId: "person-1" });
      await w.a.addNote(project, { pageId: "overview", text: `keep me ${project}`, authorId: "person-2" });
      const acknowledged = await w.a.addNote(project, { pageId: "overview", text: `ack by erased ${project}`, authorId: "person-2" });
      await w.a.acknowledgeNote(project, "overview", acknowledged.noteId, "person-1");
      const approved = await w.a.addNote(project, { pageId: "overview", text: `approved by erased ${project}`, authorId: "person-2" });
      await w.a.approveNote(project, "overview", approved.noteId, "person-1");
      await w.a.acknowledgeNote(project, "overview", approved.noteId, "person-2");
      await w.a.addFlag(project, { pageId: "overview", claimId: "c0001", by: { kind: "person", personId: "person-1" }, reason: `my reason ${project}` });
      await w.a.addFlag(project, { pageId: "overview", claimId: "c0002", by: { kind: "person", personId: "person-2" }, reason: `their reason ${project}` });
      await w.a.writeAnswer(project, { answerId: "answer-0001", askedBy: "person-1", channel: "slack", question: `my question ${project}`, answer: "a", outcome: "answered", sources: [], pagesRead: [] });
      await w.a.writeAnswer(project, { answerId: "answer-0002", askedBy: "person-2", channel: "slack", question: `their question ${project}`, answer: "a", outcome: "answered", sources: [], pagesRead: [] });
    }
    // The same person in company B is not this company's to erase.
    await w.b.writePage("alpha", page("B"));
    await w.b.addNote("alpha", { pageId: "overview", text: "b note", authorId: "person-1" });
    expect(await w.a.erasePerson(["alpha", "beta"], "person-1")).toEqual({ notes: 2, reasons: 2, answers: 2 });
    const raw = JSON.stringify(await everything(w.store));
    expect(raw).not.toMatch(/erase me|my reason|my question/u);
    expect(raw).toMatch(/keep me alpha/u);
    expect(raw).toMatch(/ack by erased alpha/u);
    expect(raw).toContain('"text":"approved by erased alpha"');
    expect(raw).toContain('"changedAcknowledgement":{"by":"person-2"');
    expect(raw).not.toContain('"changedAcknowledgement":{"by":"person-1"');
    expect(raw).toMatch(/their reason beta/u);
    expect(raw).toMatch(/their question alpha/u);
    expect(raw).toContain("b note");
    const flags = (await w.a.readPage("alpha", "overview", "person"))!.flags;
    expect(flags.find((flag) => flag.claimId === "c0001")?.by).toEqual({ kind: "person", personId: WIKI_FORMER_MEMBER });
    expect(raw).not.toMatch(/"personId":"person-1"/u);
  });

  it("the erase also stops naming the person as a note's approver or a build's starter", async () => {
    const w = world();
    await w.a.writePage("alpha", page("x"));
    const note = await w.a.addNote("alpha", { pageId: "overview", text: "someone else's", authorId: "person-2" });
    await w.a.approveNote("alpha", "overview", note.noteId, "person-1");
    await w.a.writeBuild("alpha", { buildId: "build-0001", kind: "first", state: "done", startedBy: "person-1", startedAt: "2026-11-17T09:00:00.000Z", repos: [], counts: { pagesWritten: 0, claimsKept: 0, claimsDropped: 0, skipped: 0 }, dropped: [], skipped: [] });
    await w.a.erasePerson(["alpha"], "person-1");
    expect(JSON.stringify(await everything(w.store))).not.toContain("person-1");
    expect((await w.a.readPage("alpha", "overview", "person"))!.notes[0]!.approval).toMatchObject({ state: "approved", by: WIKI_FORMER_MEMBER });
    expect((await w.a.readBuild("alpha", "build-0001"))!.startedBy).toBe(WIKI_FORMER_MEMBER);
  });

});

describe("wiki store: the answer expiry sweep", () => {
  const answer = (answerId: string) => ({ answerId, askedBy: "person-1", channel: "web" as const, question: `q ${answerId}`, answer: "a", outcome: "answered" as const, sources: [], pagesRead: [] });

  it("deletes at most its bound in one sweep", async () => {
    const w = world();
    for (let i = 0; i < 5; i += 1) await w.a.writeAnswer("alpha", answer(`old-000${String(i)}`));
    w.clock.now = T0 + 31 * 86_400_000;
    expect(await w.a.expireAnswers("alpha", 2)).toBe(2);
    expect(await w.a.expireAnswers("alpha", 2)).toBe(2);
    expect(await w.a.expireAnswers("alpha", 2)).toBe(1);
    expect(await w.a.expireAnswers("alpha", 2)).toBe(0);
    await expect(w.a.expireAnswers("alpha", 201)).rejects.toThrow("That is not a valid wiki input.");
    await expect(w.a.expireAnswers("alpha", 0)).rejects.toThrow("That is not a valid wiki input.");
  });
});

describe("wiki store: the build's page sink", () => {
  it("is fixed to its company and project", async () => {
    const w = world();
    const sink = w.a.pageSink("alpha");
    expect([sink.companyId, sink.project]).toEqual([A, "alpha"]);
    await sink.putPage(page("x"));
    expect((await sink.listPages()).map((entry) => entry.pageId)).toEqual(["overview"]);
    expect(await w.a.pageSink("beta").listPages()).toEqual([]);
    expect(await w.b.pageSink("alpha").listPages()).toEqual([]);
    expect(await w.b.pageSink("alpha").deletePages(["overview"])).toBe(0);
    expect(await sink.deletePages(["overview", "missing"])).toBe(1);
    expect(await sink.listPages()).toEqual([]);
  });
});
