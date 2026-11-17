// The project wiki store (lead 4, W2): rows only, one partition per company AND project. Two-project and two-company isolation on every read and write; the agents' read; quotes redacted
// and cut; removed repositories; the person erase step; answer expiry; the company purge removes every wiki row (no purge change).
import { describe, expect, it } from "vitest";
import { WIKI_QUOTE_MAX, wikiPartition, type OrgId, type StoredDocument, type WikiPageWrite, type WikiStore } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { DocumentAuditSink } from "../../packages/local-adapters/src/document-audit-sink.js";
import { WIKI_FORMER_MEMBER, createWikiStore, storedQuote } from "../../packages/broker/src/core/wiki/store.js";
import { COMPANY_PURGE_COOLING_OFF_MS, requestCompanyPurge, runCompanyPurge, type CompanyPurgeDeps } from "../../packages/broker/src/core/company/purge.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const SHA = "a".repeat(40);
const SHA2 = "c".repeat(40);
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
  it("every read of company A, project alpha sees only its own rows (index, page, notes, flags, builds, answers)", async () => {
    const w = world();
    // The same project name, page id and repo in both companies; and a second project in company A.
    for (const [store, project, tag] of [[w.a, "alpha", "A-alpha"], [w.a, "beta", "A-beta"], [w.b, "alpha", "B-alpha"]] as const) {
      await store.writePage(project, page(tag));
      await store.addNote(project, { pageId: "overview", text: `note ${tag}`, authorId: "person-1" });
      await store.addFlag(project, { pageId: "overview", claimId: "c0002", by: { kind: "person", personId: "person-1" }, reason: `reason ${tag}` });
      await store.writeBuild(project, { buildId: "build-0001", kind: "first", state: "done", startedAt: "2026-11-17T09:00:00.000Z", repos: [{ repo: "web", commit: SHA }], counts: { pagesWritten: 1, claimsKept: 2, claimsDropped: 0, skipped: 0 }, dropped: [], skipped: [], stopReason: undefined } as never);
      await store.writeAnswer(project, { answerId: "answer-0001", askedBy: "person-1", channel: "web", question: `q ${tag}`, answer: `a ${tag}`, outcome: "answered", sources: [], pagesRead: ["overview"] });
    }
    const seen = async (store: WikiStore, project: string): Promise<string> => JSON.stringify([
      await store.readIndex(project), await store.readPage(project, "overview", "person"), await store.readPage(project, "overview", "agent"), await store.lastBuild(project), await store.readBuild(project, "build-0001"), await store.readAnswer(project, "answer-0001"),
    ]);
    const aAlpha = await seen(w.a, "alpha");
    expect(aAlpha).toContain("A-alpha");
    expect(aAlpha).not.toContain("A-beta");
    expect(aAlpha).not.toContain("B-alpha");
    const aBeta = await seen(w.a, "beta");
    expect(aBeta).toContain("A-beta");
    expect(aBeta).not.toContain("A-alpha");
    const bAlpha = await seen(w.b, "alpha");
    expect(bAlpha).toContain("B-alpha");
    expect(bAlpha).not.toMatch(/A-alpha|A-beta/u);
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

  it("refuses a row in the right key that names another company or project (a second wall behind the key)", async () => {
    const w = world();
    await w.a.writePage("alpha", page("A-alpha"));
    const row = await w.store.get({ pk: wikiPartition(A, "alpha"), sk: "PAGE#overview" });
    await w.store.put({ item: { ...row!, companyId: B } });
    await expect(w.a.readIndex("alpha")).rejects.toThrow("A wiki row could not be read.");
    await w.store.put({ item: { ...row!, project: "beta" } });
    await expect(w.a.readIndex("alpha")).rejects.toThrow("A wiki row could not be read.");
    await expect(w.a.readPage("alpha", "overview", "person")).rejects.toThrow("A wiki row could not be read.");
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

  it("a row copied into another company's partition is refused, not shown", async () => {
    const w = world();
    await w.a.writePage("alpha", page("A-alpha"));
    for (const item of await everything(w.store)) await w.store.put({ item: { ...item, pk: wikiPartition(B, "alpha") } });
    await expect(w.b.readIndex("alpha")).rejects.toThrow("A wiki row could not be read.");
    await expect(w.b.readPage("alpha", "overview", "person")).rejects.toThrow("A wiki row could not be read.");
  });

  it.each(["Alpha", "alpha#x", "", "a".repeat(64)])("refuses a malformed project name %j", async (project) => {
    const w = world();
    await expect(w.a.readIndex(project)).rejects.toThrow("That is not a valid wiki input.");
    await expect(w.a.writePage(project, page("x"))).rejects.toThrow("That is not a valid wiki input.");
  });

  it("refuses to be made for a malformed company", () => {
    expect(() => createWikiStore({ store: new MemoryDocumentStore(), companyId: "acme", now: () => T0 })).toThrow();
  });
});

describe("wiki store: pages and claims", () => {
  it("writes the index row and body together and keeps notes and flags across a rewrite", async () => {
    const w = world();
    await w.a.writePage("alpha", page("v1"));
    await w.a.addNote("alpha", { pageId: "overview", text: "keep me", authorId: "person-1" });
    await w.a.addFlag("alpha", { pageId: "overview", claimId: "c0001", by: { kind: "person", personId: "person-1" } });
    await w.a.writePage("alpha", page("v2"));
    const read = await w.a.readPage("alpha", "overview", "person");
    expect(read?.page.title).toBe("Overview v2");
    expect(read?.notes.map((note) => note.text)).toEqual(["keep me"]);
    expect(read?.flags).toHaveLength(1);
    expect(await w.a.readIndex("alpha")).toEqual([expect.objectContaining({ pageId: "overview", claims: { found: 2, changed: 0 }, flagged: false })]);
  });

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

  it("refuses a claim whose source was not found, and a citation at another commit", async () => {
    const w = world();
    await expect(w.a.writePage("alpha", page("x", { claims: [{ ...page("x").claims[0]!, source: "not_found" }, page("x").claims[1]!] }))).rejects.toThrow("That is not a valid wiki input.");
    await expect(w.a.writePage("alpha", page("x", { claims: [{ ...page("x").claims[0]!, citations: [{ ...page("x").claims[0]!.citations[0]!, commit: SHA2 }] }, page("x").claims[1]!] }))).rejects.toThrow("That is not a valid wiki input.");
    expect(await everything(w.store)).toEqual([]);
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

  it("marks claims changed or not found and counts them in the index", async () => {
    const w = world();
    await w.a.writePage("alpha", page("x"));
    expect(await w.a.markClaims("alpha", "overview", [{ claimId: "c0001", source: "changed" }, { claimId: "c0009", source: "changed" }])).toBe(1);
    expect((await w.a.readIndex("alpha"))[0]?.claims).toEqual({ found: 1, changed: 1 });
    expect((await w.a.readPage("alpha", "overview", "person"))?.staleBlockIds).toEqual(["p0001"]);
  });
});

describe("wiki store: what agents get", () => {
  it("only approved notes; no flagged or not-found claim, nor the blocks resting on them; no person's reason", async () => {
    const w = world();
    await w.a.writePage("alpha", page("x", {
      blocks: [...page("x").blocks, { kind: "paragraph", blockId: "p0003", text: "Third", claimIds: ["c0003"] }, { kind: "paragraph", blockId: "p0004", text: "Fourth", claimIds: ["c0004"] }],
      claims: [...page("x").claims,
        { claimId: "c0003", text: "Claim three", citations: [{ repo: "web", path: "src/c.ts", commit: SHA, line: 1, quote: "export const three = 3;" }], source: "found", checkedAt: "2026-11-17T09:00:00.000Z" },
        { claimId: "c0004", text: "Claim four", citations: [{ repo: "web", path: "src/d.ts", commit: SHA, line: 1, quote: "export const four = 4;" }], source: "found", checkedAt: "2026-11-17T09:00:00.000Z" }],
    }));
    const pending = await w.a.addNote("alpha", { pageId: "overview", text: "pending words", authorId: "person-1" });
    const approved = await w.a.addNote("alpha", { pageId: "overview", text: "approved words", authorId: "person-1" });
    await w.a.approveNote("alpha", "overview", approved.noteId, "person-2");
    await w.a.addFlag("alpha", { pageId: "overview", claimId: "c0002", by: { kind: "person", personId: "person-1" }, reason: "my private reason" });
    await w.a.markClaims("alpha", "overview", [{ claimId: "c0003", source: "not_found" }, { claimId: "c0004", source: "changed" }]);
    const agent = (await w.a.readPage("alpha", "overview", "agent"))!;
    expect(agent.notes.map((note) => note.noteId)).toEqual([approved.noteId]);
    expect(agent.page.claims.map((claim) => claim.claimId)).toEqual(["c0001", "c0004"]);
    expect(agent.page.blocks.map((block) => block.blockId)).toEqual(["h0001", "p0001", "p0004"]);
    expect(agent.staleBlockIds).toEqual(["p0004"]);
    expect(JSON.stringify(agent)).not.toContain("my private reason");
    expect(agent.flags.map((flag) => Object.keys(flag).sort())).toEqual([["claimId", "flagId", "pageId", "state"]]);
    expect(agent.flags[0]).toMatchObject({ pageId: "overview", claimId: "c0002", state: "open" });
    expect(JSON.stringify(agent)).not.toContain("pending words");
    const person = (await w.a.readPage("alpha", "overview", "person"))!;
    expect(person.notes.map((note) => note.noteId).sort()).toEqual([pending.noteId, approved.noteId].sort());
    expect(person.page.claims).toHaveLength(4);
  });

  it("a page marked wrong as a whole is not given to agents at all, until its flags are resolved", async () => {
    const w = world();
    await w.a.writePage("alpha", page("x"));
    await w.a.addFlag("alpha", { pageId: "overview", by: { kind: "task", taskId: "00000000-0000-4000-8000-000000000001" } });
    expect(await w.a.readPage("alpha", "overview", "agent")).toBeUndefined();
    expect((await w.a.readIndex("alpha"))[0]?.flagged).toBe(true);
    expect(await w.a.readPage("alpha", "overview", "person")).toBeDefined();
    expect(await w.a.resolveFlags("alpha", "overview")).toBe(1);
    expect(await w.a.readPage("alpha", "overview", "agent")).toBeDefined();
    expect((await w.a.readIndex("alpha"))[0]?.flagged).toBe(false);
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

  it("pruning keeps pages whose repositories are all current and deletes the rest, in this project only", async () => {
    const w = world();
    await w.a.writePage("alpha", page("web", { pageId: "repo-web", kind: "repo" }));
    await w.a.writePage("alpha", page("links", { pageId: "connections", kind: "connections", repos: [{ repo: "web", commit: SHA }, { repo: "api", commit: SHA }] }));
    await w.a.writePage("beta", page("beta-web", { pageId: "repo-web", kind: "repo" }));
    await w.b.writePage("alpha", page("b-web", { pageId: "repo-web", kind: "repo" }));
    expect(await w.a.pruneRepositories("alpha", ["web", "api"])).toEqual({ pages: 0, notes: 0, flags: 0 });
    expect(await w.a.pruneRepositories("alpha", ["web"])).toEqual({ pages: 1, notes: 0, flags: 0 });
    expect((await w.a.readIndex("alpha")).map((entry) => entry.pageId)).toEqual(["repo-web"]);
    expect(await w.a.pruneRepositories("alpha", [])).toEqual({ pages: 1, notes: 0, flags: 0 });
    expect(await w.a.readIndex("beta")).toHaveLength(1);
    expect(await w.b.readIndex("alpha")).toHaveLength(1);
    await expect(w.a.pruneRepositories("alpha", ["Bad#name"])).rejects.toThrow("That is not a valid wiki input.");
  });

  it("deleting the wiki removes every row of the project (pages, notes, flags, builds, answers) and nothing else", async () => {
    const w = world();
    await w.a.writePage("alpha", page("x"));
    await w.a.writePage("beta", page("y"));
    await w.a.addNote("alpha", { pageId: "overview", text: "n", authorId: "person-1" });
    await w.a.writeAnswer("alpha", { answerId: "answer-0001", askedBy: "person-1", channel: "slack", question: "q", answer: "a", outcome: "answered", sources: [], pagesRead: [] });
    await w.a.deleteWiki("alpha");
    expect((await everything(w.store)).filter((item) => item.pk === wikiPartition(A, "alpha"))).toEqual([]);
    expect(await w.a.readIndex("beta")).toHaveLength(1);
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
    expect(raw).toMatch(/their reason beta/u);
    expect(raw).toMatch(/their question alpha/u);
    expect(raw).toContain("b note");
    const flags = (await w.a.readPage("alpha", "overview", "person"))!.flags;
    expect(flags.find((flag) => flag.claimId === "c0001")?.by).toEqual({ kind: "person", personId: WIKI_FORMER_MEMBER });
    expect(raw).not.toMatch(/"personId":"person-1"/u);
  });

  it("redacts every stored answer source quote and cuts it to 200 characters", async () => {
    const w = world();
    const secret = ["ghp", "_", "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2"].join("");
    await w.a.writeAnswer("alpha", { answerId: "answer-0001", askedBy: "person-1", channel: "web", question: "q", answer: "a", outcome: "answered", sources: [{ repo: "web", path: "src/a.ts", commit: SHA, line: 1, quote: `token = "${secret}" ${"y".repeat(300)}` }], pagesRead: [] });
    expect(JSON.stringify(await everything(w.store))).not.toContain(secret);
    const quote = (await w.a.readAnswer("alpha", "answer-0001"))!.sources[0]!.quote;
    expect(quote).toContain("[REDACTED]");
    expect([...quote].length).toBeLessThanOrEqual(WIKI_QUOTE_MAX);
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

  it("an answer record is gone 30 days after it was written (app-driven expiry: no table TTL attribute)", async () => {
    const w = world();
    const written = await w.a.writeAnswer("alpha", { answerId: "answer-0001", askedBy: "person-1", channel: "web", question: "q", answer: "a", outcome: "answered", sources: [], pagesRead: [] });
    expect(written.expiresAt).toBe(Math.floor(T0 / 1000) + 30 * 86_400);
    const row = await w.store.get({ pk: wikiPartition(A, "alpha"), sk: "ANSWER#answer-0001" });
    expect(row?.["indexExpiresAt"]).toBeUndefined();
    expect(row?.["expiresAt"]).toBe(written.expiresAt);
    w.clock.now = T0 + 30 * 86_400_000 - 1_000;
    expect(await w.a.readAnswer("alpha", "answer-0001")).toBeDefined();
    w.clock.now = T0 + 30 * 86_400_000;
    expect(await w.a.readAnswer("alpha", "answer-0001")).toBeUndefined();
  });
});

describe("wiki store: the answer expiry sweep", () => {
  const answer = (answerId: string) => ({ answerId, askedBy: "person-1", channel: "web" as const, question: `q ${answerId}`, answer: "a", outcome: "answered" as const, sources: [], pagesRead: [] });
  it("deletes expired answer records, keeps current ones, and stays in its own project and company", async () => {
    const w = world();
    await w.a.writeAnswer("alpha", answer("old-0001"));
    await w.a.writeAnswer("beta", answer("old-0002"));
    await w.b.writeAnswer("alpha", answer("old-0003"));
    w.clock.now = T0 + 30 * 86_400_000;
    await w.a.writeAnswer("alpha", answer("new-0001")); // the write runs the sweep
    const left = async (company: OrgId, project: string) => (await everything(w.store)).filter((item) => item.pk === wikiPartition(company, project) && item.sk.startsWith("ANSWER#")).map((item) => item.sk);
    expect(await left(A, "alpha")).toEqual(["ANSWER#new-0001"]);
    expect(await left(A, "beta")).toEqual(["ANSWER#old-0002"]);
    expect(await left(B, "alpha")).toEqual(["ANSWER#old-0003"]);
    expect(await w.a.expireAnswers("beta")).toBe(1);
    expect(await left(A, "beta")).toEqual([]);
    expect(await left(B, "alpha")).toEqual(["ANSWER#old-0003"]);
  });

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
