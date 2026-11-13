import { beforeEach, describe, expect, it } from "vitest";
import type { Citation, WorkflowReviewFinding } from "@rovara-code/contracts";
import {
  claimCitations, downgradeSourceOnlyFindings, documentCitationStore, fetchLiveFacts, recheckCitations, replayCitation, sourceCritiquePoints, type ReplayDependencies, type StoredCitation,
} from "../../../packages/core/src/context-sources/citations.js";
import { buildClaimSources, clearLiveFactsCache } from "../../../packages/core/src/context-sources/plan-sources.js";
import { documentResultStore } from "../../../packages/core/src/context-sources/quotes.js";
import { renderPlanDocument } from "../../../packages/core/src/aws/plan-page/render-plan.js";
import { resultDigest } from "../../../packages/core/src/context-sources/present.js";
import { INDEX_EXPIRY_ATTRIBUTE } from "@rovara-code/contracts";
import { MemoryDocumentStore } from "../../../packages/core/src/ports/memory-document-store.js";
import { TASK_FLOW_INDEXES } from "../../../packages/core/src/core/task-flow/flow.js";
import { planDocument } from "../../support/plan-documents.js";
import { GET_TOOL, NOW, ORG, SEARCH_TOOL, source } from "./fixtures.js";

const sha = (char: string) => char.repeat(64);
const citation = (over: Partial<Citation> = {}): Citation => ({ sourceId: "sim", itemRef: "P123456", title: "Login fails", fetchedAt: "2026-11-01T10:00:00Z", digest: sha("a"), standing: "outsider", ...over });
const stored = (over: Partial<StoredCitation> = {}, c: Partial<Citation> = {}): StoredCitation => ({
  citation: citation(c), stage: "PLAN", operationId: "op1", replay: { tool: "src_sim_get_ticket", arguments: { id: "P123456" } }, recordedAt: "2026-11-01T10:00:00Z", ...over,
});

describe("the citation store", () => {
  it("keeps the call that fetched an item, by stage, and does not serve a damaged item", async () => {
    const table = new MemoryDocumentStore({ indexes: TASK_FLOW_INDEXES, ttlAttribute: INDEX_EXPIRY_ATTRIBUTE });
    const store = documentCitationStore({ store: table, now: () => NOW });
    await store.record({ orgId: ORG, taskId: "task1", operationId: "op1", stage: "PLAN", citation: citation(), replay: { tool: "src_sim_get_ticket", arguments: { id: "P123456" } } });
    await store.record({ orgId: ORG, taskId: "task1", operationId: "op2", stage: "REVIEW", citation: citation({ itemRef: "P2" }), replay: { tool: "src_sim_get_ticket", arguments: { id: "P2" } } });
    expect((await store.list(ORG, "task1")).map((entry) => entry.citation.itemRef).sort()).toEqual(["P123456", "P2"]);
    expect((await store.list(ORG, "task1", { stage: "PLAN" })).map((entry) => entry.replay.arguments)).toEqual([{ id: "P123456" }]);
    expect(await store.list(ORG, "task2")).toEqual([]);
    // the same item read again in the same stage replaces the earlier row
    await store.record({ orgId: ORG, taskId: "task1", operationId: "op3", stage: "PLAN", citation: citation({ digest: sha("b") }), replay: { tool: "src_sim_get_ticket", arguments: { id: "P123456" } } });
    expect((await store.list(ORG, "task1", { stage: "PLAN" })).map((entry) => entry.citation.digest)).toEqual([sha("b")]);
  });
});

describe("a claim cites an item", () => {
  const sources = [source(), source({ sourceId: "wiki", label: "Team wiki" })];
  it("matches a marker to what a stage read, with any case, and flags one that matches nothing", () => {
    const claims = [{ id: "1", text: "The login bug [sim p123456] is in the retry loop [SIM P999999].", children: [{ id: "1.1", text: "See [Team wiki PAGE-12] and no marker here." }] }, { id: "2", text: "No source for this." }];
    const result = claimCitations(claims, [stored(), stored({}, { sourceId: "wiki", itemRef: "PAGE-12" })], sources);
    expect(result.map((entry) => [entry.claimId, entry.verified.map((item) => item.citation.itemRef), entry.unverified])).toEqual([
      ["1", ["P123456"], ["[SIM P999999]"]],
      ["1.1", ["PAGE-12"], []],
    ]);
  });
  it("does not let a claim cite an item of a source the project does not have", () => {
    const result = claimCitations([{ id: "1", text: "From [Jira X-1]." }], [stored()], sources);
    expect(result).toEqual([{ claimId: "1", verified: [], unverified: ["[Jira X-1]"] }]);
  });
});

describe("asking again", () => {
  function deps(options: { answer?: () => { isError?: boolean; content?: Array<{ type: string; text?: string }>; structuredContent?: unknown }; openFails?: boolean; tools?: typeof GET_TOOL[] } = {}): ReplayDependencies & { calls: unknown[] } {
    const calls: unknown[] = [];
    return {
      calls, now: () => NOW,
      sources: async () => [source({ liveFacts: ["status"] })],
      servers: { open: async () => {
        if (options.openFails === true) throw new Error("down");
        return { hosts: ["sim.example.com"], tools: options.tools ?? [SEARCH_TOOL, GET_TOOL], close: async () => undefined,
          call: async (name, args) => { calls.push({ name, args }); return (options.answer ?? (() => ({ content: [{ type: "text", text: "x" }], structuredContent: { key: "P123456", body: "same", status: "Open" } })))(); } };
      } },
    };
  }
  const original = (status: string) => resultDigest({ structuredContent: { key: "P123456", body: "same", status }, text: "x" }, ["status"]);

  it("finds an item unchanged when only its live fact moved", async () => {
    const [result] = await recheckCitations(deps({ answer: () => ({ content: [{ type: "text", text: "x" }], structuredContent: { key: "P123456", body: "same", status: "Closed" } }) }), { orgId: ORG, project: "proj", cited: [stored({}, { digest: original("Open") })] });
    expect(result!.check).toBe("unchanged");
  });
  it("flags an item that changed, one that is gone, and one that could not be asked", async () => {
    const changed = await recheckCitations(deps({ answer: () => ({ content: [{ type: "text", text: "x" }], structuredContent: { key: "P123456", body: "different" } }) }), { orgId: ORG, project: "proj", cited: [stored({}, { digest: original("Open") })] });
    expect(changed[0]!.check).toBe("changed");
    expect((await recheckCitations(deps({ answer: () => ({ isError: true, content: [{ type: "text", text: "not found" }] }) }), { orgId: ORG, project: "proj", cited: [stored()] }))[0]!.check).toBe("gone");
    expect((await recheckCitations(deps({ answer: () => ({ content: [] }) }), { orgId: ORG, project: "proj", cited: [stored()] }))[0]!.check).toBe("gone");
    expect((await recheckCitations(deps({ openFails: true }), { orgId: ORG, project: "proj", cited: [stored()] }))[0]!.check).toBe("unavailable");
  });
  it("does not ask when the tool changed since it was ticked, or the call is no longer allowed", async () => {
    const changedTool = { ...GET_TOOL, inputSchema: { type: "object", properties: { id: { type: "string" }, more: { type: "string" } } } };
    const world = deps({ tools: [SEARCH_TOOL, changedTool] });
    expect((await replayCitation(world, { orgId: ORG, project: "proj", stored: stored() })).outcome).toBe("unavailable");
    expect(world.calls).toEqual([]);
    const offList = deps();
    expect((await replayCitation(offList, { orgId: ORG, project: "proj", stored: stored({ replay: { tool: "src_sim_delete_ticket", arguments: {} } }) })).outcome).toBe("unavailable");
    expect((await replayCitation(offList, { orgId: ORG, project: "proj", stored: stored({ replay: { tool: "src_sim_get_ticket", arguments: { id: "https://evil.example.net/x" } } }) })).outcome).toBe("unavailable");
    expect(offList.calls).toEqual([]);
  });
  it("bounds how many items it asks about", async () => {
    const world = deps();
    const many = Array.from({ length: 30 }, (_, index) => stored({ replay: { tool: "src_sim_get_ticket", arguments: { id: `P${index}` } } }, { itemRef: `P${index}` }));
    expect(await recheckCitations(world, { orgId: ORG, project: "proj", cited: many })).toHaveLength(20);
    expect(world.calls).toHaveLength(20);
  });
  it("fetches live facts fresh, and says unavailable when it cannot", async () => {
    expect(await fetchLiveFacts(deps(), { orgId: ORG, project: "proj", stored: stored() })).toEqual({ status: "fresh", facts: { status: "Open" }, fetchedAt: new Date(NOW).toISOString() });
    expect(await fetchLiveFacts(deps({ openFails: true }), { orgId: ORG, project: "proj", stored: stored() })).toEqual({ status: "unavailable" });
    expect(await fetchLiveFacts(deps({ answer: () => ({ content: [{ type: "text", text: "x" }], structuredContent: { key: "P123456" } }) }), { orgId: ORG, project: "proj", stored: stored() })).toEqual({ status: "unavailable" });
  });
  it("never turns live facts into a stored value: a second fetch asks the source again", async () => {
    const world = deps();
    await fetchLiveFacts(world, { orgId: ORG, project: "proj", stored: stored() });
    await fetchLiveFacts(world, { orgId: ORG, project: "proj", stored: stored() });
    expect(world.calls).toHaveLength(2);
  });
});

describe("what the plan check adds", () => {
  const sources = [source()];
  it("blocks on an item that is gone, notes a change, an unverified marker and a source that could not be asked, and quotes nothing from the source", () => {
    const one = stored();
    const points = sourceCritiquePoints({
      claims: [{ claimId: "1", verified: [one], unverified: ["[SIM P9]"] }],
      checks: [{ stored: one, check: "gone" }, { stored: stored({}, { itemRef: "P2" }), check: "changed" }, { stored: stored({}, { itemRef: "P3" }), check: "unavailable" }, { stored: stored({}, { itemRef: "P4" }), check: "unchanged" }],
      sources,
    });
    expect(points.map((point) => [point.severity, point.claimId])).toEqual([["blocking", "1"], ["note", undefined], ["note", undefined], ["note", "1"]]);
    expect(points[0]!.text).toContain("SIM P123456");
    expect(points.map((point) => point.text).join(" ")).not.toContain("Login fails");
  });
  it("keeps to ten points", () => {
    const many = Array.from({ length: 15 }, (_, index) => ({ stored: stored({}, { itemRef: `P${index}` }), check: "gone" as const }));
    expect(sourceCritiquePoints({ claims: [], checks: many, sources })).toHaveLength(10);
  });
});

describe("reviews", () => {
  const finding = (over: Partial<WorkflowReviewFinding>): WorkflowReviewFinding => ({ text: "Needs a retry limit.", origin: "INTRODUCED", ...over });
  it("makes a finding that cites only a source advisory, and leaves the others alone", () => {
    const out = downgradeSourceOnlyFindings([
      finding({ text: "The ticket [SIM P123456] says the limit is 3, but the code has none." }),
      finding({ text: "The ticket [SIM P123456] says the limit is 3, but the code has none.", file: "src/retry.ts", line: 12 }),
      finding({ text: "Other [Jira X-1] claim." }),
      finding({ text: "No marker.", severity: "HIGH" }),
    ], [{ label: "SIM" }]);
    expect(out.map((entry) => entry.advisory)).toEqual([true, undefined, undefined, undefined]);
    expect(out[0]!.text).toMatch(/does not block\)$/u);
    expect(out[0]!.text.length).toBeLessThanOrEqual(600);
  });
  it("stays within 600 characters for a long finding", () => {
    const [out] = downgradeSourceOnlyFindings([finding({ text: `[SIM P1] ${"x".repeat(590)}` })], [{ label: "SIM" }]);
    expect(out!.text.length).toBeLessThanOrEqual(600);
    expect(out!.advisory).toBe(true);
  });
});

describe("the plan page", () => {
  beforeEach(() => { clearLiveFactsCache(); });
  async function page(options: { viewer: string; member?: boolean; liveFails?: boolean; opens?: { count: number }; clock?: () => number }) {
    const table = new MemoryDocumentStore({ indexes: TASK_FLOW_INDEXES, ttlAttribute: INDEX_EXPIRY_ATTRIBUTE });
    const citations = documentCitationStore({ store: table, now: () => NOW });
    const results = documentResultStore({ store: table, now: () => NOW });
    await citations.record({ orgId: ORG, taskId: "task1", operationId: "op1", stage: "PLAN", citation: citation({ url: "https://sim.example.com/P123456", title: "Login <b>fails</b>" }), replay: { tool: "src_sim_get_ticket", arguments: { id: "P123456" } } });
    await results.keep({ orgId: ORG, taskId: "task1", operationId: "op1", sourceId: "sim", itemRef: "P123456", digest: sha("a"), text: "SECRET TICKET BODY", retention: "team_record", quotes: "project_members", fetchedAt: "t" });
    const plan = planDocument({ claims: [{ id: "1", text: "Fix it [SIM P123456] and also [SIM P000000]." }, { id: "2", text: "Nothing cited." }] });
    const sources = [source({ quotes: "project_members", liveFacts: ["status"] })];
    const map = await buildClaimSources({
      citations, results, quotes: { isProjectMember: async () => options.member !== false },
      replay: { now: options.clock ?? (() => NOW), sources: async () => sources, servers: { open: async () => {
        if (options.opens) options.opens.count += 1;
        if (options.liveFails === true) throw new Error("down");
        return { hosts: ["sim.example.com"], tools: [SEARCH_TOOL, GET_TOOL], close: async () => undefined, call: async () => ({ content: [{ type: "text", text: "x" }], structuredContent: { key: "P123456", status: "Open" } }) };
      } } },
    }, { viewer: { orgId: ORG, developerId: options.viewer }, orgId: ORG, taskId: "task1", project: "proj", claims: plan.claims, sources, flags: new Map([["sim\u0000P123456", "changed"]]) });
    return renderPlanDocument({ anchor: "coding-plan", kind: "plan", version: 1, approved: false, current: true, plan, openWhatChanged: false, claimSources: map });
  }
  it("shows a member the title, the link, the quote, the live status with its time, and what the plan check found", async () => {
    const html = await page({ viewer: "dev1" });
    expect(html).toContain('<a href="https://sim.example.com/P123456" rel="noopener noreferrer">Login &lt;b&gt;fails&lt;/b&gt;</a>');
    expect(html).toContain("SECRET TICKET BODY");
    expect(html).toContain("status: Open (fetched 10:00)");
    expect(html).toContain("Changed at the source since it was read");
    expect(html).toContain("Written by someone outside the company: untrusted");
    expect(html).toContain("Unverified: no stage read this item");
    expect(html).not.toContain("<b>fails</b>");
  });
  it("shows someone without access the citation and never the quote", async () => {
    const html = await page({ viewer: "stranger", member: false });
    expect(html).toContain("Login");
    expect(html).not.toContain("SECRET TICKET BODY");
  });
  it("asks the source for live facts only for someone who may see the item, and not again within a minute", async () => {
    clearLiveFactsCache();
    const stranger = { count: 0 };
    const html = await page({ viewer: "stranger", member: false, opens: stranger });
    expect(stranger.count).toBe(0);
    expect(html).not.toContain("status: Open");
    let clock = NOW;
    const member = { count: 0 };
    await page({ viewer: "dev1", opens: member, clock: () => clock });
    const first = member.count;
    expect(first).toBeGreaterThan(0);
    await page({ viewer: "dev1", opens: member, clock: () => clock });
    expect(member.count).toBe(first);
    clock = NOW + 61_000;
    await page({ viewer: "dev1", opens: member, clock: () => clock });
    expect(member.count).toBeGreaterThan(first);
  });
  it("says the status is unavailable rather than showing an old one", async () => {
    const html = await page({ viewer: "dev1", liveFails: true });
    expect(html).toContain("status unavailable");
    expect(html).not.toContain("status: Open");
  });
  it("refuses a link that is not https", async () => {
    const table = new MemoryDocumentStore({ indexes: TASK_FLOW_INDEXES, ttlAttribute: INDEX_EXPIRY_ATTRIBUTE });
    const citations = documentCitationStore({ store: table, now: () => NOW });
    await citations.record({ orgId: ORG, taskId: "task1", operationId: "op1", stage: "PLAN", citation: citation({ url: "https://sim.example.com/x" }), replay: { tool: "src_sim_get_ticket", arguments: {} } });
    const map = new Map([["1", [{ label: "SIM", itemRef: "P1", title: "t", url: "javascript:alert(1)", verified: true, outsider: false }]]]);
    const html = await renderPlanDocument({ anchor: "coding-plan", kind: "plan", version: 1, approved: false, current: true, plan: planDocument(), openWhatChanged: false, claimSources: map });
    expect(html).not.toContain("javascript:");
  });
});
