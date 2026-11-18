// L4-WKS: the company's "Knowledge stays in Rovara" switch for the MCP wiki tools (`wiki_list`, `wiki_read`; owner decision 2026-11-17: every MCP knowledge and wiki tool answers the one fixed sentence). The wiki routes
// are the Rovara web app's own Wiki tab too, so the switch holds back only a caller that is NOT the web app's verified sign-in (a CLI token, another client, a script token). Switch on: the fixed sentence, and nothing of the
// wiki, its repositories or its store is read. Switch off: byte-identical to before. Two companies: one company's switch never reaches another's wiki.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { KNOWLEDGE_STAYS_SENTENCE, WikiToolsOffSchema, type AuditSink, type OrgId, type WikiPageWrite } from "@agentx/contracts";
import { createScriptToken } from "../../packages/broker/src/core/script-tokens/store.js";
import { createWikiStore } from "../../packages/broker/src/core/wiki/store.js";
import { createCoreDevRoutes } from "../../packages/broker/src/core-host/dev-routes.js";
import { createCoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { developerIdOf } from "../../packages/broker/src/core/sessions/create.js";
import { DocumentLocalToolsSettings } from "../../packages/broker/src/lessons/document-settings.js";
import { LocalLessonsUnavailable, wikiToolsGate } from "../../packages/broker/src/lessons/local-tools.js";
import { setLearnedLessonsGate, type LearningSettings, type LearningSettingsReader } from "../../packages/broker/src/lessons/policy.js";
import { deployedCallerFromMembership } from "../../packages/broker/src/aws/core-engine-root.js";
import { createFakeWorld, FAKE_COMPANY } from "../support/core-host-fakes.js";

const OTHER = "org_corehost00000000000b";
const paths = ["/v1/app/projects/alpha/wiki", "/v1/app/projects/alpha/wiki/pages/overview", "/v1/app/projects/alpha/wiki/search?q=alpha", "/v1/app/projects/alpha/wiki/pages/overview/sources"] as const;
const page = (tag: string): WikiPageWrite => ({ pageId: "overview", kind: "overview", title: tag, summary: tag, order: 0, repos: [{ repo: "web", commit: "a".repeat(40) }], blocks: [{ kind: "heading", blockId: "head-1", level: 2, text: tag }], claims: [], buildId: "build-0001" });
afterEach(() => { setLearnedLessonsGate(undefined); });

/** The learning settings a project has, per company (a gate test needs the preset and the mode). */
const learning = (over: Partial<LearningSettings> = {}): LearningSettingsReader => ({ read: async () => ({ preset: "standard", mode: "On", ...over }) });

async function world(options: { learning?: Partial<LearningSettings>; gateFails?: boolean } = {}) {
  setLearnedLessonsGate(() => true);
  const w = createFakeWorld();
  const audit: AuditSink = { stage: (event) => [{ kind: "put", item: { pk: `ORG#${event.companyId}#AUDIT_OUTBOX`, sk: `EVENT#${event.eventId}` } }], record: async () => undefined };
  const deps = { store: w.store, audit, now: () => w.clock.now };
  const localTools = new DocumentLocalToolsSettings(w.store);
  const app = createCoreHostApp({ env: { ROVARA_CORE_ENGINE: "on" }, modules: w.modules, context: () => w.context(), nowMs: () => w.clock.now, runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(w.clock.now), log: () => undefined, services: () => ({ "merge-tracking": { pass: async () => ({}) }, "session-sweep": { pass: async () => ({}) }, "notify-deliver": { pass: async () => ({}) }, "admission-hold-sweep": { pass: async () => ({}) } }), ciReporting: { honest: true, ciMode: () => "their_ci_fix" } }) });
  let standing: "view" | "none" = "view";
  const events: string[] = [];
  // Every row the wiki's own partitions are asked for, whoever asks: after the gate answers, this must not move.
  const store = w.store as unknown as Record<string, unknown>;
  for (const name of [...Object.getOwnPropertyNames(Object.getPrototypeOf(w.store) as object), ...Object.getOwnPropertyNames(store)]) {
    const original = store[name];
    if (typeof original !== "function" || name === "constructor") continue;
    store[name] = (...args: unknown[]) => { if (JSON.stringify(args, (_k, v) => (typeof v === "bigint" ? String(v) : v)).includes("#WIKI#")) events.push(`store.${name}`); return (original as (...a: unknown[]) => unknown).apply(w.store, args); };
  }
  const routes = createCoreDevRoutes({
    app, companyOf: async (c) => ({ companyId: c.principal.companyId, role: "owner" }),
    wiring: () => ({
      origin: () => "https://api.example", scriptTokens: { enabled: () => true },
      wiki: {
        standing: async (_person, company, project) => { events.push(`standing ${company}/${project}`); return { access: standing }; },
        projectRepositories: async () => { events.push("repositories"); return ["web"]; },
        toolGate: async (companyId: OrgId, project: string) => {
          events.push(`gate ${companyId}/${project}`);
          if (options.gateFails === true) throw new LocalLessonsUnavailable("settings");
          return await wikiToolsGate({ localTools, settings: learning(options.learning) }, { workspaceId: companyId, project });
        },
      },
    }),
  });
  for (const [company, project, tag] of [[FAKE_COMPANY, "alpha", "A-alpha"], [OTHER, "alpha", "B-alpha"]]) await createWikiStore({ store: w.store, companyId: company!, now: deps.now }).writePage(project!, page(tag!));
  const principalOf = (companyId: string) => localOwnerPrincipal({ companyId });
  /** A person's own sign-in token (the CLI's, an AI tool's): not the web app. */
  const tool = async (path: string, companyId: string = FAKE_COMPANY) => routes.route({ method: "GET", path, headers: {} }, { principal: principalOf(companyId) });
  /** The Rovara web app's own verified sign-in client. */
  const webApp = async (path: string, companyId: string = FAKE_COMPANY) => routes.route({ method: "GET", path, headers: {} }, { principal: principalOf(companyId), webApp: true });
  const scriptToken = async (path: string, companyId: string = FAKE_COMPANY) => {
    const p = principalOf(companyId);
    const made = await createScriptToken(deps, { orgId: companyId, developerId: developerIdOf(p), personId: p.personId, orgRole: "owner" }, { requestId: randomUUID(), name: "wiki reader", projects: ["alpha"], permissions: ["wiki"] }, async () => undefined);
    return await routes.route({ method: "GET", path, headers: {} }, { principal: p, scriptToken: { tokenId: made.token.tokenId } });
  };
  const stays = async (companyId: string, on: boolean) => { await localTools.setCompany(companyId, on, w.clock.now); };
  return { w, events, tool, webApp, scriptToken, stays, denyRole: () => { standing = "none"; }, localTools };
}

describe("the MCP wiki tools answer the company switch", () => {
  it("switch ON: a tool outside Rovara gets the one fixed sentence on every wiki read, and nothing of the wiki, its repositories or its store is read", async () => {
    const h = await world();
    await h.stays(FAKE_COMPANY, true);
    for (const path of paths) {
      h.events.length = 0;
      const answer = await h.tool(path);
      expect(answer?.statusCode, path).toBe(200);
      const body = JSON.parse(answer!.body as string) as unknown;
      expect(WikiToolsOffSchema.parse(body), path).toEqual({ status: "off", reason: "company_stays", message: KNOWLEDGE_STAYS_SENTENCE });
      expect(JSON.stringify(body)).not.toMatch(/A-alpha|B-alpha|overview|web/u);
      // The order: the person's standing, then the gate, and then nothing at all (no repositories read, no prune, no wiki row asked for).
      expect(h.events, path).toEqual([`standing ${FAKE_COMPANY}/alpha`, `gate ${FAKE_COMPANY}/alpha`]);
    }
  });

  it("switch ON: a script token with the wiki permission is held to it too", async () => {
    const h = await world();
    await h.stays(FAKE_COMPANY, true);
    // A script token reaches only the two reads the MCP tools use (the index and a page); search and sources are the web app's.
    for (const path of [paths[0], paths[1]]) {
      const answer = await h.scriptToken(path);
      expect(answer?.statusCode, path).toBe(200);
      expect(JSON.parse(answer!.body as string)).toEqual({ status: "off", reason: "company_stays", message: KNOWLEDGE_STAYS_SENTENCE });
    }
  });

  it("switch OFF: the same reads answer exactly what the web app is given (nothing changed)", async () => {
    const h = await world();
    for (const path of paths) {
      const tool = await h.tool(path);
      const app = await h.webApp(path);
      expect(tool?.statusCode, path).toBe(200);
      expect(tool?.body, path).toBe(app?.body);
      expect(tool?.body).not.toContain("Your company keeps");
      if (!path.endsWith("/sources")) expect(tool?.body, path).toContain("A-alpha");
    }
    // Switching it on and off again leaves no trace.
    await h.stays(FAKE_COMPANY, true);
    await h.stays(FAKE_COMPANY, false);
    expect(JSON.parse((await h.tool(paths[0]))!.body as string)).toMatchObject({ project: "alpha", state: "ready" });
  });

  it("switch ON: the Rovara web app's own Wiki tab is NOT held back (only tools outside Rovara are)", async () => {
    const h = await world();
    await h.stays(FAKE_COMPANY, true);
    for (const path of paths) {
      h.events.length = 0;
      const answer = await h.webApp(path);
      expect(answer?.statusCode, path).toBe(200);
      expect(answer!.body).not.toContain("Your company keeps team knowledge");
      expect(h.events.some((event) => event.startsWith("gate")), path).toBe(false);
    }
    expect((await h.webApp(paths[1]))!.body).toContain("A-alpha");
  });

  it("two companies: one company's switch never reaches the other's wiki, in either direction", async () => {
    const h = await world();
    await h.stays(FAKE_COMPANY, true);
    // Company A is on, B is off: B's tool reads B's own wiki, A's tool is told the sentence.
    const b = await h.tool(paths[1], OTHER);
    expect(b?.statusCode).toBe(200);
    expect(b!.body).toContain("B-alpha");
    expect(b!.body).not.toMatch(/A-alpha|Your company keeps/u);
    expect(JSON.parse((await h.tool(paths[1]))!.body as string)).toMatchObject({ status: "off" });
    // And the other way round.
    await h.stays(FAKE_COMPANY, false);
    await h.stays(OTHER, true);
    expect((await h.tool(paths[1]))!.body).toContain("A-alpha");
    expect(JSON.parse((await h.tool(paths[1], OTHER))!.body as string)).toMatchObject({ status: "off", message: KNOWLEDGE_STAYS_SENTENCE });
  });

  it("a person with no standing on the project still gets 'project not found', never the sentence (the switch cannot be used to probe projects)", async () => {
    const h = await world();
    await h.stays(FAKE_COMPANY, true);
    h.denyRole();
    for (const path of paths) {
      h.events.length = 0;
      const answer = await h.tool(path);
      expect(answer?.statusCode, path).toBe(404);
      expect(answer!.body).not.toContain("Your company keeps");
      expect(h.events.some((event) => event.startsWith("gate"))).toBe(false);
    }
  });

  it("a setting that cannot be read fails closed (503, no wiki), not open", async () => {
    const h = await world({ gateFails: true });
    for (const path of paths) {
      h.events.length = 0;
      const answer = await h.tool(path);
      expect(answer?.statusCode, path).toBe(503);
      expect(answer!.body).not.toMatch(/A-alpha|web/u);
      expect(h.events.includes("repositories")).toBe(false);
    }
  });

  it("the Regulated preset closes it for tools too, even when the project's learning is Off", async () => {
    for (const over of [{ preset: "regulated" as const }, { preset: "regulated" as const, mode: "Off" as const }]) {
      const h = await world({ learning: over });
      const answer = await h.tool(paths[0]);
      expect(JSON.parse(answer!.body as string)).toEqual({ status: "off", reason: "regulated", message: KNOWLEDGE_STAYS_SENTENCE });
    }
  });
});

describe("wikiToolsGate", () => {
  const key = { workspaceId: FAKE_COMPANY, project: "alpha" };
  const settings = (value: { projectOn?: boolean; companyStays: boolean } | "throw") => ({ read: async () => { if (value === "throw") throw new Error("unreadable"); return value; } }) as never;
  it("is closed only by the company-level reasons; the lessons-only reasons leave the wiki as it was", async () => {
    setLearnedLessonsGate(() => true);
    expect(await wikiToolsGate({ localTools: settings({ companyStays: true }), settings: learning() }, key)).toEqual({ status: "off", reason: "company_stays", message: KNOWLEDGE_STAYS_SENTENCE });
    expect(await wikiToolsGate({ localTools: settings({ companyStays: false }), settings: learning() }, key)).toBeUndefined();
    // A project in learning Off (standard preset) and the project's own local-tools setting are about lessons.
    expect(await wikiToolsGate({ localTools: settings({ companyStays: false }), settings: learning({ mode: "Off" }) }, key)).toBeUndefined();
    expect(await wikiToolsGate({ localTools: settings({ companyStays: false, projectOn: false }), settings: learning() }, key)).toBeUndefined();
    // The install's lessons switch is a lessons matter: it does not open the wiki for a company that turned the switch on, and it does not close it for one that did not.
    setLearnedLessonsGate(() => false);
    expect(await wikiToolsGate({ localTools: settings({ companyStays: true }), settings: learning() }, key)).toEqual({ status: "off", reason: "company_stays", message: KNOWLEDGE_STAYS_SENTENCE });
    expect(await wikiToolsGate({ localTools: settings({ companyStays: false }), settings: learning() }, key)).toBeUndefined();
  });
  it("a company with no lessons runtime (no learning settings) is still held to its own switch", async () => {
    setLearnedLessonsGate(() => false);
    expect(await wikiToolsGate({ localTools: settings({ companyStays: true }) }, key)).toEqual({ status: "off", reason: "company_stays", message: KNOWLEDGE_STAYS_SENTENCE });
    expect(await wikiToolsGate({ localTools: settings({ companyStays: false }) }, key)).toBeUndefined();
    await expect(wikiToolsGate({ localTools: settings("throw") }, key)).rejects.toBeInstanceOf(LocalLessonsUnavailable);
  });
  it("a caller that says nothing about being the web app is held to the switch (the route's default is closed)", async () => {
    const h = await world();
    await h.stays(FAKE_COMPANY, true);
    const { routeHostedWiki } = await import("../../packages/broker/src/core-host/wiki-routes.js");
    const answer = await routeHostedWiki({ request: { method: "GET", path: paths[0], headers: {} }, path: paths[0], personId: "p", companyId: FAKE_COMPANY as OrgId, store: h.w.store, now: () => h.w.clock.now, wiring: { standing: async () => ({ access: "view" }), projectRepositories: async () => ["web"], toolGate: async (companyId, project) => await wikiToolsGate({ localTools: h.localTools }, { workspaceId: companyId, project }) } });
    expect(JSON.parse(answer.body as string)).toMatchObject({ status: "off" });
  });
  it("throws LocalLessonsUnavailable when the setting cannot be read", async () => {
    setLearnedLessonsGate(() => true);
    await expect(wikiToolsGate({ localTools: settings("throw"), settings: learning() }, key)).rejects.toBeInstanceOf(LocalLessonsUnavailable);
  });
});

describe("the web app marker reaches the wiki route", () => {
  it("deployedCallerFromMembership carries webApp only when the broker's sign-in set it", async () => {
    const caller = deployedCallerFromMembership(async () => ({ companyId: FAKE_COMPANY as OrgId, role: "member" }));
    const base = { developerId: "dev-1", sessionId: "s1", name: "Ann" };
    expect((await caller(base))?.webApp).toBeUndefined();
    expect((await caller({ ...base, webApp: true }))?.webApp).toBe(true);
    expect(Object.keys((await caller(base))!)).not.toContain("webApp");
  });
});
