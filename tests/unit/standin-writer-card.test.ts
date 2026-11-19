// L4-E7: the setup card shows the sample-data writer's cost BEFORE the run, inside the run's own limit (the setup cap's wording), on the broker's view and on the laptop page; with no AI connected it says to connect one first.
import { describe, expect, it } from "vitest";
import { SETUP_AGENT_LIMITS_DEFAULT, SetupAgentViewSchema, STANDIN_WRITER_WORDS, standInReferencePrice, standInWriterCard, standInWriterCeilingCents } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { getSetupAgent, verifiedView, type SetupAgentDeps, type SetupAgentView } from "../../packages/broker/src/core/setup-agent/agent.js";
import { renderSetupPage } from "../../packages/broker/src/core/local-pages/setup-page.js";
import type { SetupPageView } from "../../packages/broker/src/core/local-pages/views.js";
import { COMPANY_A } from "../../packages/testing/src/isolation/two-company.js";

const context = { base: "/local", nonce: "nonce", sessionId: "session", formToken: () => "token" };
const deps = (over: Partial<SetupAgentDeps> = {}): SetupAgentDeps => ({
  store: new MemoryDocumentStore(), companyId: COMPANY_A.orgId, now: () => Date.parse("2026-11-18T10:00:00.000Z"), starter: undefined, modelAccessConfigured: true,
  latest: async (project) => (project === "demo" ? { revision: 1, definition: { repositories: [] } } : undefined), ...over,
});
const none: SetupAgentView = { status: "none", basedOnRevision: 1, limits: { ...SETUP_AGENT_LIMITS_DEFAULT } };

describe("the broker's setup view carries the writer's cost before the run", () => {
  it("says what the writer does and the most it can cost, inside the run's limit, in the cap's own format", async () => {
    const view = await getSetupAgent(deps(), "demo");
    expect(view.standInWriter).toEqual(standInWriterCard({ connected: true, capCents: SETUP_AGENT_LIMITS_DEFAULT.budgetCents }));
    expect(view.standInWriter!.connected).toBe(true);
    expect(view.standInWriter!.ceilingCents).toBe(standInWriterCeilingCents(standInReferencePrice()));
    expect(view.standInWriter!.words).toMatch(/^Rovara will also write realistic sample data for your tests with your own AI .*: about \$\d+(\.\d\d)?, inside this run's \$4 limit\./u);
  });
  it("uses the run's own limit (a project that lowered it sees the lower figure, or that there is no room)", async () => {
    const view = await verifiedView(deps(), { repositories: [] }, { ...none, limits: { ...SETUP_AGENT_LIMITS_DEFAULT, budgetCents: 150 } });
    expect(view.standInWriter!.words).toContain("inside this run's $1.50 limit");
    const tiny = await verifiedView(deps(), { repositories: [] }, { ...none, limits: { ...SETUP_AGENT_LIMITS_DEFAULT, budgetCents: 5 } });
    expect(tiny.standInWriter).toEqual({ connected: true, words: STANDIN_WRITER_WORDS.cardNoRoom });
  });
  it("with no AI connected, says to connect one first, promises no cost, and never says Rovara pays", async () => {
    const view = await getSetupAgent(deps({ modelAccessConfigured: undefined }), "demo");
    expect(view.standInWriter).toEqual({ connected: false, words: STANDIN_WRITER_WORDS.noAi });
    expect(view.standInWriter!.words).toContain("Connect your AI first");
    expect(view.standInWriter!.words).not.toMatch(/\$/u);
  });
  it("is part of the web contract (additive: an older reader that ignores it still reads the view)", () => {
    const parsed = SetupAgentViewSchema.parse({ ...none, standInWriter: standInWriterCard({ connected: true, capCents: 400 }) });
    expect(parsed.standInWriter?.ceilingCents).toBeGreaterThan(0);
    expect(SetupAgentViewSchema.safeParse(none).success).toBe(true);
    expect(SetupAgentViewSchema.safeParse({ ...none, standInWriter: { connected: true, words: "x", extra: 1 } }).success).toBe(false);
  });
});

describe("the laptop's setup page shows the same line next to the run's limit", () => {
  const page = (over: Partial<SetupPageView> = {}): SetupPageView => ({
    project: "demo", revision: 1, status: "none", limits: { ...SETUP_AGENT_LIMITS_DEFAULT }, items: [], verified: false, journal: [], hostAsks: [], check: { status: "unchecked" }, approvedHosts: [], ...over,
  });
  it("shows the line, escaped, after the limit line and before the run starts", () => {
    const words = standInWriterCard({ connected: true, capCents: 400 }).words;
    const html = renderSetupPage(context, page({ standInWriter: words }));
    expect(html).toContain("A run is limited to 40 commands, 45 minutes and about $4.00 of model use.");
    expect(html).toContain(words.replace(/'/gu, "&#39;"));
    expect(html.indexOf("A run is limited to")).toBeLessThan(html.indexOf("sample data"));
    const hostile = renderSetupPage(context, page({ standInWriter: "<script>alert(1)</script>" }));
    expect(hostile).not.toContain("<script>alert(1)</script>");
  });
  it("shows nothing extra when the page has no line (an older server, the feature off)", () => {
    expect(renderSetupPage(context, page())).not.toContain("sample data");
  });
});
