import { describe, expect, it } from "vitest";
import { ContextSourceSchema } from "@rovara-code/contracts";
import { confirmSourceChange, proposeSourceChange, readContextSources, rejectSourceChange, validateContextSource, type SettingsActor, type SettingsDependencies } from "../../../packages/core/src/context-sources/settings.js";
import { documentContextSourceStore } from "../../../packages/core/src/context-sources/store.js";
import { INDEX_EXPIRY_ATTRIBUTE } from "@rovara-code/contracts";
import { MemoryDocumentStore } from "../../../packages/core/src/ports/memory-document-store.js";
import { TASK_FLOW_INDEXES } from "../../../packages/core/src/core/task-flow/flow.js";
import { CONNECTION, GET_TOOL, NOW, ORG, PLAIN_TOOL, SEARCH_TOOL, WRITE_TOOL, environment, source } from "./fixtures.js";

const admin = (developerId: string, orgRole = "admin"): SettingsActor => ({ orgId: ORG, developerId, orgRole });

function world(env = environment()) {
  const table = new MemoryDocumentStore({ indexes: TASK_FLOW_INDEXES, ttlAttribute: INDEX_EXPIRY_ATTRIBUTE });
  let counter = 0;
  const audit: string[] = [];
  const deps: SettingsDependencies = {
    store: documentContextSourceStore({ store: table, now: () => NOW }), env, now: () => NOW,
    newId: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`, audit: async (event) => { audit.push(`${event.action}:${event.sourceId}`); },
  };
  return { deps, audit };
}

describe("the shape of a source", () => {
  it("does not parse a source that lists Build (IMPLEMENT), however it is written", () => {
    expect(ContextSourceSchema.safeParse({ ...source(), stages: ["PLAN", "IMPLEMENT"] }).success).toBe(false);
    expect(ContextSourceSchema.safeParse({ ...source(), stages: ["implement"] }).success).toBe(false);
    expect(ContextSourceSchema.safeParse(source()).success).toBe(true);
  });
  it("does not parse a field it does not know, and holds no secret", () => {
    expect(ContextSourceSchema.safeParse({ ...source(), token: "x" }).success).toBe(false);
  });
});

describe("validation: read-only, enforced before the call", () => {
  it("refuses a connection that can also write", async () => {
    const result = await validateContextSource(environment({ connection: async () => ({ type: "mcp", access: "read_write" }) }), ORG, source());
    expect(result.problems.join(" ")).toMatch(/read-only connection/);
  });
  it("refuses a connection of another org (it reads as missing)", async () => {
    const result = await validateContextSource(environment({ connection: async () => undefined }), ORG, source());
    expect(result.problems.join(" ")).toMatch(/does not exist/);
  });
  it("refuses a tool that says it changes things, and one the server does not offer", async () => {
    const env = environment({ tools: [SEARCH_TOOL, WRITE_TOOL] });
    const ticked = source({}, [SEARCH_TOOL, WRITE_TOOL]);
    expect((await validateContextSource(env, ORG, ticked)).problems.join(" ")).toMatch(/close_ticket says it changes things/);
    expect((await validateContextSource(environment({ tools: [SEARCH_TOOL] }), ORG, source())).problems.join(" ")).toMatch(/get_ticket is not offered/);
  });
  it("refuses a tool that changed since it was ticked (the hash no longer matches)", async () => {
    const changed = { ...SEARCH_TOOL, inputSchema: { type: "object", properties: { query: { type: "string" }, extra: { type: "string" } } } };
    const result = await validateContextSource(environment({ tools: [changed, GET_TOOL] }), ORG, source());
    expect(result.problems.join(" ")).toMatch(/changed since it was shown/);
  });
  it("needs a second admin for a tool with no read-only annotation, and refuses it without the confirmation", async () => {
    const env = environment({ tools: [PLAIN_TOOL] });
    const unconfirmed = source({}, [PLAIN_TOOL]);
    expect((await validateContextSource(env, ORG, unconfirmed)).problems.join(" ")).toMatch(/does not say it only reads/);
    const confirmed = { ...unconfirmed, tools: unconfirmed.tools.map((tool) => ({ ...tool, attestedReadOnly: true })) };
    const result = await validateContextSource(env, ORG, confirmed);
    expect(result.problems).toEqual([]);
    expect(result.secondAdminReasons.join(" ")).toMatch(/lookup_page does not say it only reads/);
  });
  it("treats a read-only tool whose name sounds like a change the same way", async () => {
    const odd = { ...SEARCH_TOOL, name: "send_digest" };
    const result = await validateContextSource(environment({ tools: [odd] }), ORG, source({}, [odd]));
    expect(result.problems.join(" ")).toMatch(/name that sounds like a change/);
  });
  it("refuses a confirmation on a tool that needs none", async () => {
    const ticked = source({}, [SEARCH_TOOL]);
    const result = await validateContextSource(environment({ tools: [SEARCH_TOOL] }), ORG, { ...ticked, tools: ticked.tools.map((tool) => ({ ...tool, attestedReadOnly: true })) });
    expect(result.problems.join(" ")).toMatch(/needs no confirmation/);
  });
  it("keeps Slack to citations only and live only", async () => {
    const result = await validateContextSource(environment(), ORG, source({ system: "slack", quotes: "project_members", retention: "team_record" }));
    expect(result.problems.join(" ")).toMatch(/citations only/);
    expect(result.problems.join(" ")).toMatch(/read live and never kept/);
    expect((await validateContextSource(environment(), ORG, source({ system: "slack", quotes: "citations_only", retention: "live_only" }))).problems).toEqual([]);
  });
  it("refuses 'people allowed at the source' where no per-person check exists", async () => {
    expect((await validateContextSource(environment(), ORG, source({ quotes: "source_acl" }))).problems.join(" ")).toMatch(/per-person check/);
    expect((await validateContextSource(environment({ perUserCheckAvailable: () => true }), ORG, source({ quotes: "source_acl" }))).problems).toEqual([]);
  });
  it("asks for a second look before a third-party connection may receive code, and not for a server on the owner's own network", async () => {
    const snippets = source({ sendCodeSnippets: true });
    expect((await validateContextSource(environment(), ORG, snippets)).secondAdminReasons.join(" ")).toMatch(/receive code/);
    const registered = source({ sendCodeSnippets: true, server: { kind: "registered_server", serverId: "mcpabc12345" } });
    expect((await validateContextSource(environment(), ORG, registered)).secondAdminReasons).toEqual([]);
  });
  it("refuses an unapproved registered server", async () => {
    const registered = source({ server: { kind: "registered_server", serverId: "mcpabc12345" } });
    const result = await validateContextSource(environment({ registeredServer: async () => ({ status: "awaiting_approval" }) }), ORG, registered);
    expect(result.problems.join(" ")).toMatch(/not been approved/);
  });
  it("refuses a package-run server while package-run servers are off, and when the install does not say", async () => {
    const registered = source({ server: { kind: "registered_server", serverId: "mcpabc12345" } });
    const stdio = async () => ({ status: "approved" as const, transport: "stdio" as const });
    for (const over of [{ stdioAvailable: () => false }, {}]) {
      const result = await validateContextSource(environment({ registeredServer: stdio, ...over }), ORG, registered);
      expect(result.problems.join(" "), JSON.stringify(over)).toMatch(/runs from a package.*switched off/);
    }
    // the same server is fine when the install runs package-run servers, and an address-based server never depends on the switch
    expect((await validateContextSource(environment({ registeredServer: stdio, stdioAvailable: () => true }), ORG, registered)).problems).toEqual([]);
    expect((await validateContextSource(environment({ registeredServer: async () => ({ status: "approved", transport: "http" }), stdioAvailable: () => false }), ORG, registered)).problems).toEqual([]);
  });
  it("fails closed when the server cannot be listed, and says nothing about why", async () => {
    const result = await validateContextSource(environment({ discoverTools: async () => { throw new Error("connect ECONNREFUSED 10.1.2.3:443"); } }), ORG, source());
    expect(result.problems).toEqual(["server: Rovara could not list that server's tools right now; try again"]);
  });
});

describe("the pending change", () => {
  it("is for an owner or admin only", async () => {
    const { deps } = world();
    await expect(proposeSourceChange(deps, admin("dev1", "member"), "proj", { kind: "set", source: source() })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(readContextSources(deps, admin("dev1", "member"), "proj")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("applies nothing until it is confirmed, then saves a new revision", async () => {
    const { deps, audit } = world();
    const change = await proposeSourceChange(deps, admin("dev1"), "proj", { kind: "set", source: source() });
    expect((await readContextSources(deps, admin("dev1"), "proj")).document).toEqual({ revision: 0, sources: [] });
    const document = await confirmSourceChange(deps, admin("dev1"), "proj", change.changeId);
    expect(document.revision).toBe(1);
    expect(document.sources.map((entry) => entry.sourceId)).toEqual(["sim"]);
    expect((await readContextSources(deps, admin("dev1"), "proj")).pending).toEqual([]);
    expect(audit).toEqual(["context_source.proposed:sim", "context_source.applied:sim"]);
  });
  it("keeps another project's sources apart", async () => {
    const { deps } = world();
    const change = await proposeSourceChange(deps, admin("dev1"), "proj", { kind: "set", source: source() });
    await confirmSourceChange(deps, admin("dev1"), "proj", change.changeId);
    expect((await readContextSources(deps, admin("dev1"), "other")).document.sources).toEqual([]);
    await expect(confirmSourceChange(deps, admin("dev1"), "other", change.changeId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("needs a different admin for a change with second-admin reasons, and lets the proposer confirm one without", async () => {
    const env = environment({ tools: [PLAIN_TOOL] });
    const { deps } = world(env);
    const ticked = source({}, [PLAIN_TOOL]);
    const change = await proposeSourceChange(deps, admin("dev1"), "proj", { kind: "set", source: { ...ticked, tools: ticked.tools.map((tool) => ({ ...tool, attestedReadOnly: true })) } });
    expect(change.secondAdminReasons.length).toBeGreaterThan(0);
    await expect(confirmSourceChange(deps, admin("dev1"), "proj", change.changeId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await confirmSourceChange(deps, admin("dev2", "owner"), "proj", change.changeId)).sources).toHaveLength(1);
  });
  it("re-checks the source at confirmation: a tool that changed after the proposal blocks it", async () => {
    let tools = [SEARCH_TOOL, GET_TOOL];
    const { deps } = world(environment({ discoverTools: async () => tools }));
    const change = await proposeSourceChange(deps, admin("dev1"), "proj", { kind: "set", source: source() });
    tools = [{ ...SEARCH_TOOL, description: "x", inputSchema: { type: "object", properties: { q: { type: "string" } } } }, GET_TOOL];
    await expect(confirmSourceChange(deps, admin("dev1"), "proj", change.changeId)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect((await readContextSources(deps, admin("dev1"), "proj")).document.sources).toEqual([]);
  });
  it("refuses a change made against an older revision, and a second confirmation of the same change", async () => {
    const { deps } = world();
    const first = await proposeSourceChange(deps, admin("dev1"), "proj", { kind: "set", source: source() });
    const second = await proposeSourceChange(deps, admin("dev1"), "proj", { kind: "set", source: source({ sourceId: "wiki", label: "Wiki" }) });
    await confirmSourceChange(deps, admin("dev1"), "proj", first.changeId);
    await expect(confirmSourceChange(deps, admin("dev1"), "proj", second.changeId)).rejects.toMatchObject({ code: "CHANGE_STALE" });
    await expect(confirmSourceChange(deps, admin("dev1"), "proj", first.changeId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("removes a source, and refuses to remove one that is not there", async () => {
    const { deps } = world();
    const added = await proposeSourceChange(deps, admin("dev1"), "proj", { kind: "set", source: source() });
    await confirmSourceChange(deps, admin("dev1"), "proj", added.changeId);
    await expect(proposeSourceChange(deps, admin("dev1"), "proj", { kind: "remove", sourceId: "nope" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const removal = await proposeSourceChange(deps, admin("dev1"), "proj", { kind: "remove", sourceId: "sim" });
    expect((await confirmSourceChange(deps, admin("dev1"), "proj", removal.changeId)).sources).toEqual([]);
  });
  it("can be turned down, once", async () => {
    const { deps, audit } = world();
    const change = await proposeSourceChange(deps, admin("dev1"), "proj", { kind: "set", source: source() });
    await rejectSourceChange(deps, admin("dev2"), "proj", change.changeId);
    await expect(rejectSourceChange(deps, admin("dev2"), "proj", change.changeId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(audit).toContain("context_source.rejected:sim");
  });
  it("refuses a proposal that names the connection of a source with a wrong shape, with the reason and not the value", async () => {
    const { deps } = world();
    await expect(proposeSourceChange(deps, admin("dev1"), "proj", { kind: "set", source: { ...source(), stages: ["IMPLEMENT"], token: "sk-secret-value" } })).rejects.toSatisfy((error: Error) => !error.message.includes("sk-secret-value"));
    expect(CONNECTION).toBeTruthy();
  });
});

describe("one owner decides: the person who proposed a change may confirm it", () => {
  it("refuses the proposer a change that carries reasons, unless the install says one owner decides", async () => {
    const { deps } = world(environment());
    const change = await proposeSourceChange(deps, admin("dev1"), "proj", { kind: "set", source: source({ sendCodeSnippets: true }) });
    expect(change.secondAdminReasons.join(" ")).toMatch(/receive code/);
    await expect(confirmSourceChange(deps, admin("dev1"), "proj", change.changeId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await confirmSourceChange(deps, admin("dev2"), "proj", change.changeId)).sources).toHaveLength(1);
  });
  it("lets the proposer confirm it when one owner decides, and still records the reasons on the change", async () => {
    const { deps } = world(environment());
    const change = await proposeSourceChange({ ...deps, ownerConfirmsOwn: true }, admin("dev1"), "proj", { kind: "set", source: source({ sendCodeSnippets: true }) });
    expect(change.secondAdminReasons.join(" ")).toMatch(/receive code/);
    expect((await confirmSourceChange({ ...deps, ownerConfirmsOwn: true }, admin("dev1"), "proj", change.changeId)).sources).toHaveLength(1);
  });
});
