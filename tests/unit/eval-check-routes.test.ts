// L4-EVCI2: the setup card's "Eval check from your CI": the hosted route (core-host/eval-check-routes.ts), the laptop's (local/app/eval-check.ts) and the shared card (core/ci-evidence/eval-check-card.ts).
//   GET /v1/app/projects/{project}/ci-eval-check -> { project, canManage, confirmed, proposals, explanation }; PUT { requestId, check } -> the same view.
// Rules under test: setup proposes (the workflow files, as data) and a maintainer confirms one, or none; only a check Rovara just proposed is taken (never the browser's word); a company owner or admin, or the project's
// administrator, confirms; any role on the project reads the confirmed check, and only a manager sees the proposals; everyone else, another company's project, a missing one and a malformed name get the SAME 404; a reader's
// change is 403; the audit record is written BEFORE the row; the same request id with the same choice is one act; every row is keyed by company AND project. Mutants are listed in the PR body with the test that kills each.
/* eslint-disable @typescript-eslint/no-explicit-any -- a JSON answer is read field by field */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GITHUB_ACTIONS_APP_ID, IMPLICIT_COMPANY_ID, type AuditEvent, type OrgId } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { isEvalCheckPath, routeHostedEvalCheck, type HostedEvalCheckWiring } from "../../packages/broker/src/core-host/eval-check-routes.js";
import type { SetupRunStanding } from "../../packages/broker/src/core-host/setup-run-routes.js";
import { createLocalEvalCheck } from "../../packages/broker/src/local/app/eval-check.js";
import { EVAL_CHECK_WORDS, ciDefinitionReaderOf, setEvalCheck } from "../../packages/broker/src/core/ci-evidence/eval-check-card.js";
import { evalCheckEvidencePort, evalCheckKey, readEvalCheckSetting } from "../../packages/broker/src/core/ci-evidence/eval-check-setting.js";
import { parseCiEvidenceSettings } from "@agentx/contracts";
import type { CiDefinitionReader } from "../../packages/broker/src/rovara-code/ci-checks.js";
import { COMPANY_A, COMPANY_B } from "../support/wiki-build-fixtures.js";

const T0 = Date.parse("2026-11-18T08:00:00.000Z");
const OWNER = "o1".repeat(32);
const ADMIN = "a1".repeat(32);
const PROJECT_ADMIN = "p1".repeat(32);
const VIEWER = "v1".repeat(32);
const OUTSIDER = "x1".repeat(32);
const ACTIONS = String(GITHUB_ACTIONS_APP_ID);
type Body = Record<string, any>;

const WORKFLOW = [
  "name: ci", "on: pull_request", "jobs:",
  "  unit:", "    runs-on: ubuntu-latest", "    steps:", "      - run: npm test",
  "  evals:", "    runs-on: ubuntu-latest", "    steps:", "      - run: npx promptfoo eval",
  "  Quality gate:", "    name: Quality gate", "    runs-on: ubuntu-latest", "    steps:", "      - run: ./evals/run.sh",
].join("\n");
const NO_EVAL_WORKFLOW = ["name: ci", "on: pull_request", "jobs:", "  unit:", "    runs-on: ubuntu-latest", "    steps:", "      - run: npm test"].join("\n");

function readerOf(files: Record<string, string>): CiDefinitionReader {
  return {
    list: async (path) => (path === ".github/workflows" ? { entries: Object.keys(files).map((name) => ({ name, path: `.github/workflows/${name}`, type: "file" })), truncated: false } : undefined),
    read: async (path) => { const text = files[path.split("/").pop()!]; return text === undefined ? undefined : { text }; },
  };
}

const standingOf = (company: OrgId, project: string, person: string): SetupRunStanding => {
  if (company === COMPANY_A) {
    if (person === OWNER) return { access: "manage", basis: "company-owner" };
    if (person === ADMIN) return { access: "manage", basis: "company-admin" };
    if (person === PROJECT_ADMIN && project === "beacon") return { access: "manage", basis: "project-admin" };
    if (person === VIEWER && project === "beacon") return { access: "view" };
  }
  if (company === COMPANY_B && person === "b1".repeat(32)) return { access: "manage", basis: "company-owner" };
  return { access: "none" };
};

interface Options { store?: MemoryDocumentStore; company?: OrgId; audit?: (event: AuditEvent) => Promise<void>; projects?: string[]; reader?: CiDefinitionReader | undefined | "throws"; standing?: HostedEvalCheckWiring["standing"] }
function hosted(options: Options = {}) {
  const store = options.store ?? new MemoryDocumentStore();
  const company = options.company ?? COMPANY_A;
  const audited: AuditEvent[] = [];
  const readerCalls: unknown[] = [];
  const projects = options.projects ?? ["beacon", "other"];
  const flow = { store, projects: { latest: async (name: string) => (projects.includes(name) ? { definition: { repositories: [{ name: "app", url: "https://github.com/acme/app", defaultBranch: "main" }] } } : undefined) } } as never;
  const reader = "reader" in options ? options.reader : readerOf({ "ci.yml": WORKFLOW });
  const wiring: HostedEvalCheckWiring = {
    standing: options.standing ?? (async (person, org, project) => standingOf(org, project, person)),
    readerFor: async (org, repository) => { readerCalls.push({ org, repository: repository.name }); if (reader === "throws") throw new Error("host down"); return reader; },
  };
  const audit = { stage: () => [], record: options.audit ?? (async (event: AuditEvent) => { audited.push(event); }) };
  const call = async (person: string, method: "GET" | "PUT", project: string, body?: unknown) => {
    const answer = await routeHostedEvalCheck({
      request: { method, path: `/v1/app/projects/${project}/ci-eval-check`, headers: {}, body: body === undefined ? "" : JSON.stringify(body) }, path: `/v1/app/projects/${project}/ci-eval-check`,
      principal: { companyId: company, personId: person, displayName: "x", roles: [], provider: "test" }, companyId: company, flow, wiring, audit, now: () => T0,
    });
    return { status: answer.statusCode, body: JSON.parse(answer.body) as Body };
  };
  const port = (org: OrgId = company) => evalCheckEvidencePort({ store, companyId: org });
  return { store, company, audited, readerCalls, call, port };
}
const put = (w: ReturnType<typeof hosted>, person: string, project: string, body: unknown) => w.call(person, "PUT", project, body);
const choose = (name: string, source: string | undefined = ACTIONS) => ({ requestId: randomUUID(), check: { name, ...(source === undefined ? {} : { source }) } });
const task = (org: OrgId, project: string) => ({ orgId: org, project });
const EVALS = { name: "evals", source: ACTIONS };

describe("the path", () => {
  it("is GET and PUT of one project's ci-eval-check, nothing else", () => {
    expect(isEvalCheckPath("/v1/app/projects/beacon/ci-eval-check", "GET")).toBe(true);
    expect(isEvalCheckPath("/v1/app/projects/beacon/ci-eval-check", "PUT")).toBe(true);
    for (const [path, method] of [["/v1/app/projects/beacon/ci-eval-check", "POST"], ["/v1/app/projects/beacon/ci-eval-check", "DELETE"], ["/v1/app/projects/beacon/ci-eval-check/x", "GET"], ["/v1/app/projects/beacon/ci-eval-checks", "GET"], ["/v1/app/projects/a/b/ci-eval-check", "GET"]] as const) expect(isEvalCheckPath(path, method), `${method} ${path}`).toBe(false);
  });
});

describe("propose, confirm, stored", () => {
  it("a manager reads the proposals from the workflow files, with the card's one explanation, and nothing is confirmed yet", async () => {
    const w = hosted();
    const answer = await w.call(OWNER, "GET", "beacon");
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ project: "beacon", canManage: true, confirmed: null, explanation: "Rovara shows this check's result on its pull requests.", proposals: { verdict: "proposals", cut: false } });
    const items = (answer.body["proposals"] as { items: Array<Record<string, unknown>> }).items;
    const names = items.map((item) => item["name"]);
    // The job whose id or name says eval, the one whose commands run an eval tool and the "evals/" script: the plain unit job is not offered.
    expect(names).toEqual(["evals", "Quality gate"]);
    expect(items[0]).toEqual({ name: "evals", source: ACTIONS, workflow: ".github/workflows/ci.yml", repository: "app", basis: "name" });
    expect(w.audited).toEqual([]);
    expect(await w.port()(task(COMPANY_A, "beacon"))).toBeUndefined();
  });

  it("confirms one proposed check: the row is stored, the audit record names the person and why, and the port answers it as evalCheck with nothing marked", async () => {
    const w = hosted();
    const answer = await put(w, OWNER, "beacon", choose("evals"));
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ project: "beacon", canManage: true, confirmed: { name: "evals", source: ACTIONS, changedAt: new Date(T0).toISOString() } });
    expect(w.audited).toHaveLength(1);
    expect(w.audited[0]).toMatchObject({ companyId: COMPANY_A, actor: { type: "person", id: OWNER }, action: "ci_eval_check.set", subject: { type: "project", id: "beacon" }, details: { project: "beacon", basis: "company-owner", check: "evals", source: ACTIONS, previous: "none" } });
    const stored = await w.store.get(evalCheckKey({ orgId: COMPANY_A, project: "beacon" }));
    expect(stored).toMatchObject({ entityType: "CI_EVAL_CHECK", orgId: COMPANY_A, project: "beacon", check: EVALS });
    expect(stored).not.toHaveProperty("personId");
    const settings = await w.port()(task(COMPANY_A, "beacon"));
    expect(parseCiEvidenceSettings(settings)).toMatchObject({ ok: true, settings: { evalCheck: EVALS, markedChecks: [], shareLogs: false } });
    // A reader sees the confirmed check, not the proposals.
    const reader = await w.call(VIEWER, "GET", "beacon");
    expect(reader.body).toMatchObject({ canManage: false, confirmed: { name: "evals", source: ACTIONS }, proposals: null });
  });

  it("None clears: the row says none, the port answers nothing named, and the audit record keeps what it replaced", async () => {
    const w = hosted();
    await put(w, OWNER, "beacon", choose("evals"));
    const cleared = await put(w, OWNER, "beacon", { requestId: randomUUID(), check: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body["confirmed"]).toBeNull();
    expect(w.audited[1]).toMatchObject({ action: "ci_eval_check.set", details: { check: "none", previous: "evals" } });
    expect(w.audited[1]!.details).not.toHaveProperty("source");
    expect(await w.port()(task(COMPANY_A, "beacon"))).toBeUndefined();
    expect(await readEvalCheckSetting({ store: w.store, companyId: COMPANY_A }, "beacon")).toMatchObject({ changedAt: new Date(T0).toISOString() });
    expect((await readEvalCheckSetting({ store: w.store, companyId: COMPANY_A }, "beacon"))?.check).toBeUndefined();
    // And it can be confirmed again.
    expect((await put(w, OWNER, "beacon", choose("Quality gate"))).body["confirmed"]).toMatchObject({ name: "Quality gate" });
  });

  it("a check Rovara did not propose is refused, however it is spelled; nothing is recorded or stored", async () => {
    const w = hosted();
    for (const check of [{ name: "unit", source: ACTIONS }, { name: "evals", source: "999" }, { name: "evals" }, { name: "EVALS", source: ACTIONS }, { name: "evals ", source: ACTIONS }]) {
      const answer = await put(w, OWNER, "beacon", { requestId: randomUUID(), check });
      expect(answer, JSON.stringify(check)).toMatchObject({ status: 400, body: { error: { code: "CONFIG_INVALID", message: EVAL_CHECK_WORDS.notProposed } } });
    }
    expect(w.audited).toEqual([]);
    expect(await w.store.get(evalCheckKey({ orgId: COMPANY_A, project: "beacon" }))).toBeUndefined();
  });

  it("a confirm when the workflow files cannot be read is refused in fixed words, but None always works", async () => {
    for (const reader of [undefined, "throws" as const, readerOf({ "ci.yml": "jobs: [not a map" })]) {
      const w = hosted({ reader });
      const answer = await put(w, OWNER, "beacon", choose("evals"));
      expect(answer).toMatchObject({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: EVAL_CHECK_WORDS.cannotRead } } });
      expect(w.audited).toEqual([]);
      const read = await w.call(OWNER, "GET", "beacon");
      expect(read.body["proposals"]).toEqual({ verdict: "unknown", items: [], cut: false });
      const none = await put(w, OWNER, "beacon", { requestId: randomUUID(), check: null });
      expect(none.status).toBe(200);
      expect(w.audited).toHaveLength(1);
    }
  });

  it("a repository with no eval-looking job says so, and no check can be confirmed", async () => {
    const w = hosted({ reader: readerOf({ "ci.yml": NO_EVAL_WORKFLOW }) });
    expect((await w.call(OWNER, "GET", "beacon")).body["proposals"]).toEqual({ verdict: "none_found", items: [], cut: false });
    expect((await put(w, OWNER, "beacon", choose("unit"))).status).toBe(400);
  });
});

describe("who", () => {
  it("a company owner, a company admin and the project's administrator confirm; the audit record names why", async () => {
    const w = hosted();
    for (const [person, basis] of [[OWNER, "company-owner"], [ADMIN, "company-admin"], [PROJECT_ADMIN, "project-admin"]] as const) {
      const answer = await put(w, person, "beacon", choose("evals"));
      expect(answer.status, person).toBe(200);
      expect(w.audited.at(-1)).toMatchObject({ actor: { id: person }, details: { basis } });
    }
  });

  it("a reader (a person who uses the project) cannot confirm or clear: 403, and nothing is written or recorded", async () => {
    const w = hosted();
    await put(w, OWNER, "beacon", choose("evals"));
    const before = w.audited.length;
    for (const body of [choose("evals"), { requestId: randomUUID(), check: null }]) {
      expect(await put(w, VIEWER, "beacon", body)).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN", message: EVAL_CHECK_WORDS.notAllowed } } });
    }
    expect(w.audited).toHaveLength(before);
    expect((await w.call(OWNER, "GET", "beacon")).body["confirmed"]).toMatchObject({ name: "evals" });
  });

  it("the project's administrator of ANOTHER project is not a manager here; a person with no role, a missing project and a malformed name all get the same 404", async () => {
    const w = hosted();
    const same = { status: 404, body: { error: { code: "NOT_FOUND", message: "project not found" } } };
    expect(await put(w, PROJECT_ADMIN, "other", choose("evals"))).toMatchObject(same);
    expect(await w.call(PROJECT_ADMIN, "GET", "other")).toMatchObject(same);
    expect(await w.call(OUTSIDER, "GET", "beacon")).toMatchObject(same);
    expect(await put(w, OUTSIDER, "beacon", choose("evals"))).toMatchObject(same);
    expect(await w.call(OWNER, "GET", "missing")).toMatchObject(same);
    expect(await w.call(OWNER, "GET", "..%2Fx")).toMatchObject(same);
    expect(await w.call(OWNER, "GET", "-bad")).toMatchObject(same);
    expect(w.audited).toEqual([]);
    expect(w.readerCalls).toEqual([]);
  });

  it("the card itself refuses a person it was told may not manage (it is never the only guard, and never reaches the audit record or the row)", async () => {
    const store = new MemoryDocumentStore();
    const act = { project: "beacon", canManage: false, repositories: [], record: async () => { throw new Error("must not be recorded"); } };
    await expect(setEvalCheck({ store, companyId: COMPANY_A, now: () => T0, readerFor: async () => readerOf({ "ci.yml": WORKFLOW }) }, act, { requestId: randomUUID(), check: null })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await store.get(evalCheckKey({ orgId: COMPANY_A, project: "beacon" }))).toBeUndefined();
  });

  it("a standing that cannot be read, or that says something unknown, is no access (never manage)", async () => {
    const down = hosted({ standing: async () => { throw new Error("members down"); } });
    expect(await down.call(OWNER, "GET", "beacon")).toMatchObject({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: EVAL_CHECK_WORDS.unreadable } } });
    const odd = hosted({ standing: async () => ({ access: "manage", basis: "stranger" }) as never });
    expect((await put(odd, OWNER, "beacon", choose("evals"))).status).toBe(404);
    expect(odd.audited).toEqual([]);
  });
});

describe("the act", () => {
  it("the audit record is written BEFORE the row: when it cannot be written nothing is stored", async () => {
    const w = hosted({ audit: async () => { throw new Error("audit down"); } });
    const answer = await put(w, OWNER, "beacon", choose("evals"));
    expect(answer).toMatchObject({ status: 503, body: { error: { code: "AUDIT_UNAVAILABLE", message: EVAL_CHECK_WORDS.auditUnavailable } } });
    expect(await w.store.get(evalCheckKey({ orgId: COMPANY_A, project: "beacon" }))).toBeUndefined();
    expect(await w.port()(task(COMPANY_A, "beacon"))).toBeUndefined();
  });

  it("the same request id with the same choice is one act (one record); the same id with another choice is a new act", async () => {
    const w = hosted();
    const body = choose("evals");
    await put(w, OWNER, "beacon", body);
    await put(w, OWNER, "beacon", body);
    expect(w.audited).toHaveLength(1);
    await put(w, OWNER, "beacon", { requestId: body.requestId, check: { name: "Quality gate", source: ACTIONS } });
    expect(w.audited).toHaveLength(2);
    expect(new Set(w.audited.map((event) => event.eventId)).size).toBe(2);
    expect((await w.call(OWNER, "GET", "beacon")).body["confirmed"]).toMatchObject({ name: "Quality gate" });
  });

  it("replaying an OLD request id after a later change is a new act: it is recorded again (the record names what it replaced) and the row follows", async () => {
    const w = hosted();
    const first = choose("evals");
    await put(w, OWNER, "beacon", first);
    await put(w, OWNER, "beacon", choose("Quality gate"));
    expect(w.audited).toHaveLength(2);
    const replay = await put(w, OWNER, "beacon", first);
    expect(replay.body["confirmed"]).toMatchObject({ name: "evals" });
    expect(w.audited).toHaveLength(3);
    expect(w.audited[2]).toMatchObject({ details: { check: "evals", previous: "Quality gate" } });
    expect(new Set(w.audited.map((event) => event.eventId)).size).toBe(3);
  });

  it("bodies are strict: an unknown field, a bad request id, an empty or over-long name and a missing check are refused in fixed words", async () => {
    const w = hosted();
    const bad: unknown[] = [
      { ...choose("evals"), extra: 1 }, { requestId: "not-a-uuid", check: { name: "evals" } }, { check: { name: "evals" } }, { requestId: randomUUID() },
      { requestId: randomUUID(), check: { name: "" } }, { requestId: randomUUID(), check: { name: "x".repeat(201) } }, { requestId: randomUUID(), check: { name: "evals", other: "x" } }, { requestId: randomUUID(), check: "evals" }, "evals", [],
    ];
    for (const body of bad) {
      const answer = await put(w, OWNER, "beacon", body);
      expect(answer, JSON.stringify(body)).toMatchObject({ status: 400, body: { error: { code: "CONFIG_INVALID", message: EVAL_CHECK_WORDS.invalid } } });
    }
    const notJson = await routeHostedEvalCheck({
      request: { method: "PUT", path: "/v1/app/projects/beacon/ci-eval-check", headers: {}, body: "{nope" }, path: "/v1/app/projects/beacon/ci-eval-check",
      principal: { companyId: COMPANY_A, personId: OWNER, displayName: "x", roles: [], provider: "test" }, companyId: COMPANY_A,
      flow: { store: w.store, projects: { latest: async () => ({ definition: { repositories: [] } }) } } as never, wiring: { standing: async () => ({ access: "manage", basis: "company-owner" }), readerFor: async () => undefined }, audit: { stage: () => [], record: async () => undefined }, now: () => T0,
    });
    expect(notJson.statusCode).toBe(400);
    expect(w.audited).toEqual([]);
  });

  it("a name a person or a repository wrote is never echoed in a refusal", async () => {
    const w = hosted();
    const secret = "SECRET-NAME-do-not-echo";
    const answer = await put(w, OWNER, "beacon", { requestId: randomUUID(), check: { name: secret, source: ACTIONS } });
    expect(JSON.stringify(answer.body)).not.toContain(secret);
  });
});

describe("two companies, two projects", () => {
  it("a confirmed check is the company's and the project's own: the same project name in another company, and another project, read nothing", async () => {
    const store = new MemoryDocumentStore();
    const a = hosted({ store, company: COMPANY_A });
    const b = hosted({ store, company: COMPANY_B });
    await put(a, OWNER, "beacon", choose("evals"));
    // Another company's route and port, over the same store.
    expect((await b.call("b1".repeat(32), "GET", "beacon")).body["confirmed"]).toBeNull();
    expect(await b.port()(task(COMPANY_B, "beacon"))).toBeUndefined();
    // Another project of the same company.
    expect((await a.call(OWNER, "GET", "other")).body["confirmed"]).toBeNull();
    expect(await a.port()(task(COMPANY_A, "other"))).toBeUndefined();
    // A task of another company asked of this company's port: nothing.
    expect(await a.port()(task(COMPANY_B, "beacon"))).toBeUndefined();
    expect(await a.port()({ orgId: COMPANY_A })).toBeUndefined();
    expect(await a.port()({ orgId: COMPANY_A, project: 7 })).toBeUndefined();
    expect(await a.port()(task(COMPANY_A, "beacon"))).toMatchObject({ evalCheck: EVALS });
    // Each company confirms its own, and neither overwrites the other.
    await put(b, "b1".repeat(32), "beacon", { requestId: randomUUID(), check: null });
    expect(await a.port()(task(COMPANY_A, "beacon"))).toMatchObject({ evalCheck: EVALS });
    expect(await store.get(evalCheckKey({ orgId: COMPANY_B, project: "beacon" }))).toMatchObject({ orgId: COMPANY_B });
    expect(evalCheckKey({ orgId: COMPANY_A, project: "beacon" }).pk).not.toBe(evalCheckKey({ orgId: COMPANY_B, project: "beacon" }).pk);
    expect(evalCheckKey({ orgId: COMPANY_A, project: "beacon" }).pk).not.toBe(evalCheckKey({ orgId: COMPANY_A, project: "other" }).pk);
  });

  it("a row copied under another company's or project's key reads as nothing named (its body names its own company and project)", async () => {
    const store = new MemoryDocumentStore();
    const a = hosted({ store, company: COMPANY_A });
    await put(a, OWNER, "beacon", choose("evals"));
    const row = (await store.get(evalCheckKey({ orgId: COMPANY_A, project: "beacon" })))!;
    const { pk, sk, ...body } = row;
    void pk; void sk;
    await store.put({ item: { ...evalCheckKey({ orgId: COMPANY_B, project: "beacon" }), ...body } });
    await store.put({ item: { ...evalCheckKey({ orgId: COMPANY_A, project: "other" }), ...body } });
    expect(await evalCheckEvidencePort({ store, companyId: COMPANY_B })(task(COMPANY_B, "beacon"))).toBeUndefined();
    expect(await evalCheckEvidencePort({ store, companyId: COMPANY_A })(task(COMPANY_A, "other"))).toBeUndefined();
  });

  it("a damaged row (a name that does not read, a wrong entity) is nothing named and says so in fixed words, never what it held", async () => {
    const logs: Array<[string, Record<string, unknown>]> = [];
    const store = new MemoryDocumentStore();
    const base = { ...evalCheckKey({ orgId: COMPANY_A, project: "beacon" }), entityType: "CI_EVAL_CHECK", orgId: COMPANY_A, project: "beacon", changedAt: new Date(T0).toISOString() };
    for (const damaged of [{ ...base, check: { name: "", secret: "do-not-echo" } }, { ...base, check: "evals" }, { ...base, entityType: "OTHER", check: EVALS }, { ...base, changedAt: 5, check: EVALS }]) {
      await store.put({ item: damaged });
      const port = evalCheckEvidencePort({ store, companyId: COMPANY_A, log: (event, fields) => { logs.push([event, fields]); } });
      expect(await port(task(COMPANY_A, "beacon"))).toBeUndefined();
    }
    expect(logs.map(([event]) => event)).toEqual(Array(4).fill("ci_eval_check.row_invalid"));
    expect(JSON.stringify(logs)).not.toContain("do-not-echo");
  });

  it("a store that cannot answer throws from the port (merge tracking then tries the pass again) and is 503 on the route, never 'none'", async () => {
    const store = new MemoryDocumentStore();
    const failing = { get: async () => { throw new Error("store down"); }, put: store.put.bind(store) } as never;
    await expect(evalCheckEvidencePort({ store: failing, companyId: COMPANY_A })(task(COMPANY_A, "beacon"))).rejects.toThrow();
    const w = hosted();
    (w.store as unknown as { get: unknown }).get = async () => { throw new Error("store down"); };
    expect(await w.call(OWNER, "GET", "beacon")).toMatchObject({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: EVAL_CHECK_WORDS.unreadable } } });
    expect(await put(w, OWNER, "beacon", choose("evals"))).toMatchObject({ status: 503 });
    expect(w.audited).toEqual([]);
  });
});

describe("the proposals across repositories", () => {
  it("offers a name proposed in two repositories once, and reads at most the first three repositories", async () => {
    const store = new MemoryDocumentStore();
    const four = ["a", "b", "c", "d"].map((name) => ({ name, url: `https://github.com/acme/${name}`, defaultBranch: "main" }));
    const flow = { store, projects: { latest: async () => ({ definition: { repositories: four } }) } } as never;
    const reads: string[] = [];
    const wiring: HostedEvalCheckWiring = { standing: async () => ({ access: "manage", basis: "company-owner" }), readerFor: async (_org, repository) => { reads.push(repository.name); return readerOf({ "ci.yml": WORKFLOW }); } };
    const answer = await routeHostedEvalCheck({
      request: { method: "GET", path: "/v1/app/projects/beacon/ci-eval-check", headers: {}, body: "" }, path: "/v1/app/projects/beacon/ci-eval-check",
      principal: { companyId: COMPANY_A, personId: OWNER, displayName: "x", roles: [], provider: "test" }, companyId: COMPANY_A, flow, wiring, audit: { stage: () => [], record: async () => undefined }, now: () => T0,
    });
    expect(reads.sort()).toEqual(["a", "b", "c"]);
    const body = JSON.parse(answer.body) as Body;
    expect((body["proposals"] as { items: Array<Record<string, unknown>> }).items.map((item) => [item["name"], item["repository"]])).toEqual([["evals", "a"], ["Quality gate", "a"]]);
  });

  it("one repository that cannot be read makes a list with no proposal 'unknown', never 'none found'", async () => {
    const store = new MemoryDocumentStore();
    const two = ["a", "b"].map((name) => ({ name, url: `https://github.com/acme/${name}`, defaultBranch: "main" }));
    const flow = { store, projects: { latest: async () => ({ definition: { repositories: two } }) } } as never;
    const wiring: HostedEvalCheckWiring = { standing: async () => ({ access: "manage", basis: "company-owner" }), readerFor: async (_org, repository) => (repository.name === "a" ? readerOf({ "ci.yml": NO_EVAL_WORKFLOW }) : undefined) };
    const answer = await routeHostedEvalCheck({
      request: { method: "GET", path: "/v1/app/projects/beacon/ci-eval-check", headers: {}, body: "" }, path: "/v1/app/projects/beacon/ci-eval-check",
      principal: { companyId: COMPANY_A, personId: OWNER, displayName: "x", roles: [], provider: "test" }, companyId: COMPANY_A, flow, wiring, audit: { stage: () => [], record: async () => undefined }, now: () => T0,
    });
    expect((JSON.parse(answer.body) as Body)["proposals"]).toEqual({ verdict: "unknown", items: [], cut: false });
  });
});

describe("on a laptop", () => {
  const OWNER_ID = "owner-1";
  function local(options: { reader?: CiDefinitionReader | undefined; audit?: (event: AuditEvent) => Promise<void>; store?: MemoryDocumentStore; project?: string } = {}) {
    const store = options.store ?? new MemoryDocumentStore();
    const audited: AuditEvent[] = [];
    const routes = createLocalEvalCheck({
      flow: { store, projects: { latest: async (name: string) => (name === (options.project ?? "beacon") ? { definition: { repositories: [{ name: "app", url: "https://github.com/acme/app", defaultBranch: "main" }] } } : undefined) } } as never,
      registry: {} as never, audit: { stage: () => [], record: options.audit ?? (async (event: AuditEvent) => { audited.push(event); }) }, now: () => T0,
      readerFor: async () => ("reader" in options ? options.reader : readerOf({ "ci.yml": WORKFLOW })),
    });
    const call = async (method: "GET" | "PUT" | "POST", path: string, body?: unknown, caller: Record<string, unknown> = {}) => {
      const answer = await routes.routes({ method, path, headers: {}, body: body === undefined ? "" : JSON.stringify(body) }, { principal: { companyId: IMPLICIT_COMPANY_ID, personId: OWNER_ID, displayName: "o", roles: ["owner"], provider: "local" }, ...caller });
      return answer === undefined ? undefined : { status: answer.statusCode, body: JSON.parse(answer.body) as Body };
    };
    return { store, audited, call };
  }

  it("propose, confirm, stored, None clears; the audit record names the install's owner; the port reads the install's one company", async () => {
    const l = local();
    const path = "/v1/app/projects/beacon/ci-eval-check";
    expect((await l.call("GET", path))!.body).toMatchObject({ canManage: true, confirmed: null, proposals: { verdict: "proposals" } });
    const done = await l.call("PUT", path, choose("evals"));
    expect(done!.status).toBe(200);
    expect(done!.body["confirmed"]).toMatchObject({ name: "evals", source: ACTIONS });
    expect(l.audited[0]).toMatchObject({ actor: { id: OWNER_ID }, action: "ci_eval_check.set", companyId: IMPLICIT_COMPANY_ID, details: { basis: "install-owner", check: "evals" } });
    expect(await evalCheckEvidencePort({ store: l.store, companyId: IMPLICIT_COMPANY_ID })(task(IMPLICIT_COMPANY_ID, "beacon"))).toMatchObject({ evalCheck: EVALS });
    expect((await l.call("PUT", path, { requestId: randomUUID(), check: null }))!.body["confirmed"]).toBeNull();
    expect(await evalCheckEvidencePort({ store: l.store, companyId: IMPLICIT_COMPANY_ID })(task(IMPLICIT_COMPANY_ID, "beacon"))).toBeUndefined();
  });

  it("only the owner on the API session: a script token or a non-owner is refused; a missing project is 404; an unproposed check is 400; a failing audit stores nothing; other paths are not its", async () => {
    const l = local();
    const path = "/v1/app/projects/beacon/ci-eval-check";
    expect((await l.call("GET", path, undefined, { scriptToken: { tokenId: "t" } }))!.status).toBe(403);
    expect((await l.call("PUT", path, choose("evals"), { principal: { companyId: IMPLICIT_COMPANY_ID, personId: "p", displayName: "p", roles: [], provider: "local" } }))!.status).toBe(403);
    expect((await l.call("GET", "/v1/app/projects/ghost/ci-eval-check"))!.status).toBe(404);
    expect((await l.call("PUT", path, choose("unit")))!.status).toBe(400);
    expect(await l.call("POST", path, choose("evals"))).toBeUndefined();
    expect(await l.call("GET", "/v1/app/projects/beacon/upkeep")).toBeUndefined();
    expect(l.audited).toEqual([]);
    const failing = local({ audit: async () => { throw new Error("down"); } });
    expect((await failing.call("PUT", path, choose("evals")))!.status).toBe(503);
    expect(await failing.store.get(evalCheckKey({ orgId: IMPLICIT_COMPANY_ID, project: "beacon" }))).toBeUndefined();
  });

  it("no reader on this install: nothing can be confirmed, None still works", async () => {
    const l = local({ reader: undefined });
    const path = "/v1/app/projects/beacon/ci-eval-check";
    expect((await l.call("GET", path))!.body["proposals"]).toEqual({ verdict: "unknown", items: [], cut: false });
    expect((await l.call("PUT", path, choose("evals")))!.status).toBe(503);
    expect((await l.call("PUT", path, { requestId: randomUUID(), check: null }))!.status).toBe(200);
  });
});

describe("the workflow reader of a code host", () => {
  const host = (files: Record<string, string>, over: Record<string, unknown> = {}) => {
    const calls: string[] = [];
    return {
      calls,
      host: {
        baseBranchHead: async (_repository: unknown, branch: string) => { calls.push(`head ${branch}`); return "a".repeat(40); },
        directoryEntries: async (_repository: unknown, path: string, revision: string) => { calls.push(`list ${path}@${revision.slice(0, 3)}`); return { entries: Object.keys(files).map((name) => ({ name, kind: "file" as const })), complete: true }; },
        fileAtRevision: async (_repository: unknown, path: string, revision: string, _scope: unknown, options?: { maxBytes?: number }) => { calls.push(`read ${path}@${revision.slice(0, 3)} max ${String(options?.maxBytes)}`); return files[path.split("/").pop()!]; },
        ...over,
      } as never,
    };
  };
  it("lists and reads at ONE commit, the head of the default branch, and the proposals come out of it", async () => {
    const { host: h, calls } = host({ "ci.yml": WORKFLOW });
    const reader = await ciDefinitionReaderOf(h, { url: "https://github.com/acme/app", defaultBranch: "trunk" }, { orgId: COMPANY_A });
    const proposals = await (await import("../../packages/broker/src/core/ci-evidence/eval-check-proposal.js")).proposeEvalChecks(reader!);
    expect(proposals).toMatchObject({ verdict: "proposals", proposals: [{ check: { name: "evals" } }, { check: { name: "Quality gate" } }] });
    expect(calls[0]).toBe("head trunk");
    expect(calls.slice(1).every((call) => call.includes("@aaa"))).toBe(true);
    expect(calls).toContain("list .github/workflows@aaa");
    expect(calls.some((call) => call.startsWith("read .github/workflows/ci.yml@aaa max "))).toBe(true);
  });
  it("a host that cannot list gives no reader; one that cannot answer throws (the card then says it could not read)", async () => {
    expect(await ciDefinitionReaderOf({ baseBranchHead: async () => "a".repeat(40), fileAtRevision: async () => undefined }, { url: "u", defaultBranch: "main" }, { orgId: COMPANY_A })).toBeUndefined();
    const { host: down } = host({}, { baseBranchHead: async () => { throw new Error("down"); } });
    await expect(ciDefinitionReaderOf(down, { url: "u", defaultBranch: "main" }, { orgId: COMPANY_A })).rejects.toThrow();
  });
});
