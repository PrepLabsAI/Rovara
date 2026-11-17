import { describe, expect, it } from "vitest";
import {
  WIKI_LIMITS, WikiCitationSchema, WikiFlagAddSchema, WikiFlagSchema, WikiPageWriteSchema, WikiPathSchema, wikiAnswerKey, wikiBodyKey, wikiBuildKey, wikiFlagKey, wikiNoteKey, wikiPageKey, wikiPartition,
  type WikiPageWrite,
} from "../../packages/contracts/src/wiki-store.js";
import { COMPANY_A_ID, COMPANY_B_ID } from "../../packages/testing/src/isolation/two-company.js";
import type { OrgId } from "../../packages/contracts/src/browser-ids.js";

const COMPANY_A = COMPANY_A_ID as OrgId;
const COMPANY_B = COMPANY_B_ID as OrgId;

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const citation = { repo: "beacon-api", path: "billing/refund.ts", commit: SHA, line: 12, quote: "export async function refund(order: Order)" };
const page = (over: Partial<WikiPageWrite> = {}): WikiPageWrite => ({
  pageId: "beacon-api--billing", kind: "module", title: "Billing", summary: "How refunds go out.", order: 0,
  repos: [{ repo: "beacon-api", commit: SHA }],
  blocks: [{ kind: "heading", blockId: "h0001", level: 2, text: "Refunds" }, { kind: "paragraph", blockId: "p0001", text: "Refunds start in refund.", claimIds: ["c0001"] }],
  claims: [{ claimId: "c0001", text: "Refunds start in `refund`.", citations: [citation], source: "found", checkedAt: "2026-11-17T10:00:00.000Z" }],
  buildId: "build-0001",
  ...over,
});

describe("wiki store contract", () => {
  it("keys every row under the company AND the project, in one partition per project", () => {
    expect(wikiPartition(COMPANY_A, "alpha")).toBe(`ORG#${COMPANY_A}#WIKI#alpha`);
    expect(wikiPartition(COMPANY_A, "alpha")).not.toBe(wikiPartition(COMPANY_A, "beta"));
    expect(wikiPartition(COMPANY_A, "alpha")).not.toBe(wikiPartition(COMPANY_B, "alpha"));
    const keys = [wikiPageKey(COMPANY_A, "alpha", "overview"), wikiBodyKey(COMPANY_A, "alpha", "overview"), wikiNoteKey(COMPANY_A, "alpha", "overview", "note-1"), wikiFlagKey(COMPANY_A, "alpha", "overview", "flag-1"), wikiBuildKey(COMPANY_A, "alpha", "build-1"), wikiAnswerKey(COMPANY_A, "alpha", "answer-1")];
    for (const key of keys) expect(key.pk).toBe(`ORG#${COMPANY_A}#WIKI#alpha`);
    expect(new Set(keys.map((key) => key.sk)).size).toBe(keys.length);
  });
  it.each([["a project with a #", () => wikiPartition(COMPANY_A, "alpha#x")], ["an upper-case project", () => wikiPartition(COMPANY_A, "Alpha")], ["a page id with a #", () => wikiPageKey(COMPANY_A, "alpha", "a#b")], ["a malformed company", () => wikiPartition("org_bad", "alpha")], ["an id with a #", () => wikiNoteKey(COMPANY_A, "alpha", "overview", "no#te")]])("refuses %s in a key", (_name, make) => {
    expect(make).toThrow();
  });
  it("accepts a page whose claims were all found at the page's commits", () => expect(WikiPageWriteSchema.safeParse(page()).success).toBe(true));
  it.each<[string, WikiPageWrite]>([
    ["a claim not found", page({ claims: [{ ...page().claims[0]!, source: "changed" }] })],
    ["a citation at another commit", page({ claims: [{ ...page().claims[0]!, citations: [{ ...citation, commit: OTHER_SHA }] }] })],
    ["a block naming a missing claim", page({ blocks: [{ kind: "paragraph", blockId: "p0001", text: "x", claimIds: ["c0009"] }] })],
    ["a repeated claim id", page({ claims: [page().claims[0]!, page().claims[0]!] })],
    ["a page over 8 KB", page({ blocks: [{ kind: "paragraph", blockId: "p0001", text: "x".repeat(4_000), claimIds: [] }, { kind: "paragraph", blockId: "p0002", text: "x".repeat(4_000), claimIds: [] }, { kind: "paragraph", blockId: "p0003", text: "x".repeat(400), claimIds: [] }] })],
    ["its own parent", page({ parentId: "beacon-api--billing" })],
  ])("refuses %s", (_name, value) => expect(WikiPageWriteSchema.safeParse(value).success).toBe(false));
  it("refuses a quote over 200 characters and a control character in it", () => {
    expect(WikiCitationSchema.safeParse({ ...citation, quote: "x".repeat(201) }).success).toBe(false);
    expect(WikiCitationSchema.safeParse({ ...citation, quote: "x".repeat(200) }).success).toBe(true);
    expect(WikiCitationSchema.safeParse({ ...citation, quote: "abc‮def ghij klmn" }).success).toBe(false);
  });
  it.each(["/etc/passwd", "../x", "a/../b", "a\\b", "a//b", ""])("refuses an unsafe path %j", (path) => expect(WikiPathSchema.safeParse(path).success).toBe(false));
  it("lets only a person's flag carry a reason", () => {
    expect(WikiFlagAddSchema.safeParse({ pageId: "overview", by: { kind: "person", personId: "p1" }, reason: "wrong file" }).success).toBe(true);
    expect(WikiFlagAddSchema.safeParse({ pageId: "overview", by: { kind: "task", taskId: "00000000-0000-4000-8000-000000000000" }, reason: "x" }).success).toBe(false);
    expect(WikiFlagSchema.safeParse({ flagId: "flag-1", pageId: "overview", by: { kind: "answer", answerId: "ans-1" }, reason: "x", createdAt: "2026-11-17T10:00:00.000Z", state: "open" }).success).toBe(false);
  });
  it("keeps the published limits", () => expect(WIKI_LIMITS.pagesPerProject).toBe(300));
});
