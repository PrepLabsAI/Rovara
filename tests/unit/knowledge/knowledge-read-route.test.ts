// Agent knowledge, step (b), at the broker: the lessons route and the table of contents as a tool OUTSIDE Rovara uses them. Owner limits (2026-11-17): at most 10 units and 2 KB an answer, 300 reads a day per person with a fixed
// refusal, no bulk mode, one audit record per answer with unit ids and no text, one admin notice a day above 150 distinct units; the `lessons` token permission ("Team knowledge") and the project and company scope hold.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LOCAL_KNOWLEDGE_DAY_CALLS_MAX, LOCAL_KNOWLEDGE_DAY_LIMIT_MESSAGE, LOCAL_KNOWLEDGE_NO_BULK_MESSAGE } from "@agentx/contracts";
import { createAdapterRegistry } from "../../../packages/broker/src/ports/adapter-registry.js";
import { createLocalOwnerApprovers, createLocalOwnerIdentity, createPriceTableMetering, localOwnerPrincipal } from "../../../packages/broker/src/ports/policy-defaults.js";
import { createMemoryModelKeyStore } from "../../../packages/broker/src/ports/model-key-stores.js";
import { builtinModelProviderBook } from "../../../packages/broker/src/local/model-proxy/index.js";
import { createLocalLessons, type LocalLessons } from "../../../packages/broker/src/local/app/lessons.js";
import { createLessonRoutes } from "../../../packages/broker/src/local/app/lessons-routes.js";
import { setLearnedLessonsGate } from "../../../packages/broker/src/lessons/policy.js";
import { COMPANY, createHarness, definition, type Harness } from "../../support/task-flow-harness.js";
import { draft, lessonRecord } from "../lessons/lesson-helpers.js";

afterEach(() => setLearnedLessonsGate(undefined));

const REPO_PAY = "https://github.com/example/demo.git";
const REPO_BILL = "https://github.com/example/billing.git";
const OTHER_COMPANY = "org_zzzzzzzzzzzzzzzzzzzz";
const TEXT = "BODYTEXTMARKER";

interface World { h: Harness; lessons: LocalLessons; notices: { queueAdmin: ReturnType<typeof vi.fn> } }

async function world(): Promise<World> {
  const h = createHarness({ audit: "recording" });
  await h.registerProject({ ...definition, repositories: [{ ...definition.repositories[0]!, url: REPO_PAY }] });
  await h.registerProject({ ...definition, name: "billing", repositories: [{ ...definition.repositories[0]!, name: "ledger", url: REPO_BILL }] });
  const owner = localOwnerPrincipal({ companyId: COMPANY });
  const registry = createAdapterRegistry();
  registry.register("storage", "memory", h.store, { isDefault: true });
  registry.register("queue", "memory", h.queues, { isDefault: true });
  registry.register("code-host", "github", { kind: "github", repositoryIdentity: async () => ({ id: "77", fullName: "example/demo", private: true }) } as never, { isDefault: true });
  const lessons = createLocalLessons({
    flow: h.deps, registry, companyId: COMPANY, owner, blobs: { get: async () => undefined } as never, milestones: { register: () => () => undefined },
    audit: h.deps.audit, admission: h.deps.admission, metering: createPriceTableMetering({ currency: "USD", models: {} }),
    approvers: createLocalOwnerApprovers({ owner, verifySession: () => false }), identity: createLocalOwnerIdentity({ companyId: COMPANY, linkedAccounts: [{ provider: "github", tenant: "", accountId: "owner-gh" }] }),
    model: { choice: async () => ({ provider: "anthropic", model: "claude-test" }), keys: createMemoryModelKeyStore({ anthropic: ["sk", "ant", "test", "never", "real"].join("-") }), providers: builtinModelProviderBook(), fetch: (async () => new Response("{}", { status: 500 })) as typeof fetch },
    enabled: () => true, now: () => h.clock.now, log: () => undefined,
  });
  return { h, lessons, notices: { queueAdmin: vi.fn(async () => 1) } };
}

const active = (over: Parameters<typeof lessonRecord>[0] = {}) => lessonRecord({
  workspaceId: COMPANY, project: "payments", type: "convention", tier: 1, tierReasons: [], approvals: [{ approvalId: "a1", by: "local-owner", at: 1, mode: "one" }], scope: {}, citations: [], citationChecks: [], stages: ["UNDERSTAND", "PLAN", "IMPLEMENT", "REVIEW"],
  provenance: { ...draft().provenance, supportTasks: [] }, title: "Use the retry helper", description: "Retries go through withRetry.", body: "Wrap network calls in withRetry instead of looping by hand.", ...over,
});
async function put(w: World, ...list: ReturnType<typeof lessonRecord>[]): Promise<void> {
  for (const lesson of list) {
    const key = { workspaceId: lesson.workspaceId, project: lesson.project };
    await w.lessons.runtime.store.commit(key, await w.lessons.runtime.store.setVersion(key), [lesson], 1);
  }
}
type Caller = Harness["owner"] & { scriptToken?: { tokenId: string; name: string; permissions: ReadonlyArray<"read" | "start" | "lessons">; projects: readonly string[] } };
const route = (w: World) => createLessonRoutes({ lessons: w.lessons, flow: w.h.deps, notices: w.notices });
async function post(w: World, path: string, body: unknown, caller: Caller = w.h.owner): Promise<{ status: number | undefined; body: Record<string, any> }> {
  const answer = await route(w)({ method: "POST", path, headers: {}, body: JSON.stringify(body) }, caller);
  return { status: answer?.statusCode, body: answer === undefined ? {} : JSON.parse(answer.body) };
}
const ask = (w: World, body: unknown = {}, project = "payments", caller?: Caller) => post(w, `/v1/dev/projects/${project}/lessons`, body, caller);
const areas = (w: World, body: unknown = {}, project = "payments", caller?: Caller) => post(w, `/v1/dev/projects/${project}/knowledge/areas`, body, caller);
const person = (w: World, personId: string): Caller => ({ ...w.h.owner, principal: { ...w.h.owner.principal, personId } });
const knowledgeAudit = (w: World) => w.h.audit.filter((event) => event.action === "lesson.knowledge_read");

describe("the day's limit: 300 reads a person, a fixed refusal after that", () => {
  it("refuses the 301st read with fixed words and no lesson, counts per person, and opens again on the next UTC day", async () => {
    const w = await world();
    await put(w, active());
    for (let n = 0; n < LOCAL_KNOWLEDGE_DAY_CALLS_MAX; n += 1) {
      if (n % 50 === 0) w.h.clock.advance(60);
      expect((await ask(w)).status, String(n)).toBe(200);
    }
    w.h.clock.advance(60);
    const refused = await ask(w);
    expect(refused).toMatchObject({ status: 429, body: { error: { code: "TOO_MANY_REQUESTS", message: LOCAL_KNOWLEDGE_DAY_LIMIT_MESSAGE } } });
    expect(JSON.stringify(refused.body)).not.toContain("withRetry");
    // The table of contents counts toward the same day.
    expect((await areas(w)).status).toBe(429);
    // Another person has their own day.
    expect((await ask(w, {}, "payments", person(w, "person-bob"))).status).toBe(200);
    // The next UTC day opens again.
    w.h.clock.advance(86_400);
    expect((await ask(w)).status).toBe(200);
    // A refused read writes no audit record (nothing left Rovara).
    expect(knowledgeAudit(w)).toHaveLength(LOCAL_KNOWLEDGE_DAY_CALLS_MAX + 2);
  });
});

describe("audit: one record per answer, unit ids only", () => {
  it("records the tool, how it asked and the ids, never a title, a reason, a body, the task text, a file or a repository", async () => {
    const w = await world();
    await put(w, active({ id: "les_aaaa1111", title: "Title-should-not-leak" }), active({ id: "les_bbbb2222", title: "Another-title" }));
    const token: Caller = { ...w.h.owner, scriptToken: { tokenId: "stk_abc", name: "tool", permissions: ["lessons"], projects: ["payments"] } };
    const answer = await ask(w, { task: "TASK-WORDS-never-audited", files: ["src/secret-file.ts"], repo: REPO_PAY }, "payments", token);
    expect(answer.status).toBe(200);
    expect(answer.body["lessons"]).toHaveLength(2);
    const events = knowledgeAudit(w);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: { id: w.h.owner.principal.personId }, details: { tool: "lessons", via: "token", units: 2 } });
    const details = events[0]!.details as Record<string, unknown>;
    expect([details["u1"], details["u2"]].sort()).toEqual(["les_aaaa1111", "les_bbbb2222"]);
    const written = JSON.stringify(events);
    for (const secret of ["Title-should-not-leak", "Another-title", "withRetry", TEXT, "TASK-WORDS", "secret-file", "example/demo"]) expect(written, secret).not.toContain(secret);
    // An answer of no lessons is still one record, with none.
    expect((await ask(w, { files: ["x"] }, "billing")).status).toBe(200);
    expect(knowledgeAudit(w)).toHaveLength(2);
  });

  it("no record, no answer: when the audit cannot be written, nothing is returned", async () => {
    const w = await world();
    await put(w, active());
    const real = w.h.deps.audit.record.bind(w.h.deps.audit);
    w.h.deps.audit.record = async (event) => { if (event.action === "lesson.knowledge_read") throw new Error("ledger down"); return real(event); };
    const answer = await ask(w);
    expect(answer.status).toBe(503);
    expect(JSON.stringify(answer.body)).not.toContain("withRetry");
  });
});

describe("no bulk path", () => {
  it("refuses `all` with fixed words, never returns more than 10 units, and has no route that lists everything", async () => {
    const w = await world();
    await put(w, ...Array.from({ length: 14 }, (_, i) => active({ id: `les_many${String(i).padStart(4, "0")}` })));
    expect(await ask(w, { all: true })).toMatchObject({ status: 400, body: { error: { code: "CONFIG_INVALID", message: `all: ${LOCAL_KNOWLEDGE_NO_BULK_MESSAGE}` } } });
    const answer = await ask(w, { all: false });
    expect(answer.status).toBe(200);
    expect(answer.body["lessons"].length).toBeLessThanOrEqual(10);
    expect(Buffer.byteLength(answer.body["markdown"], "utf8")).toBeLessThanOrEqual(2_048);
    for (const path of ["/v1/dev/projects/payments/knowledge", "/v1/dev/projects/payments/knowledge/all", "/v1/dev/projects/payments/lessons/all"]) expect((await post(w, path, {})).status, path).not.toBe(200);
  });
});

describe("the permission and the scope", () => {
  it("a token without the Team knowledge (lessons) permission, or for another project, is refused and reads, counts and audits nothing", async () => {
    const w = await world();
    await put(w, active());
    const token = (permissions: ReadonlyArray<"read" | "start" | "lessons">, projects: readonly string[]): Caller => ({ ...w.h.owner, scriptToken: { tokenId: "stk_x", name: "tool", permissions, projects } });
    for (const call of [(c: Caller) => ask(w, {}, "payments", c), (c: Caller) => areas(w, {}, "payments", c)]) {
      expect(await call(token(["read", "start"], ["payments"]))).toMatchObject({ status: 404, body: { error: { message: "No such project." } } });
      expect(await call(token(["lessons"], ["billing"]))).toMatchObject({ status: 404, body: { error: { message: "No such project." } } });
    }
    expect(knowledgeAudit(w)).toEqual([]);
    expect((await ask(w, {}, "payments", token(["lessons"], ["payments"]))).status).toBe(200);
    expect((await areas(w, {}, "payments", token(["lessons"], ["payments"]))).status).toBe(200);
  });

  it("two projects: a project's answer and tree hold only its own units; an unknown project and an unregistered repository answer alike", async () => {
    const w = await world();
    await put(w, active({ id: "les_pay00001", scope: { paths: ["src/pay/**"] } }), active({ id: "les_bill0001", project: "billing", scope: { paths: ["src/bill/**"] }, title: "Billing only" }));
    const pay = await ask(w, { files: ["src/pay/a.ts"] });
    expect(pay.body["lessons"].map((l: { id: string }) => l.id)).toEqual(["les_pay00001"]);
    const bill = await ask(w, { files: ["src/bill/a.ts"] }, "billing");
    expect(bill.body["lessons"].map((l: { id: string }) => l.id)).toEqual(["les_bill0001"]);
    expect((await ask(w, { files: ["src/bill/a.ts"] })).body["lessons"]).toEqual([]);
    const tree = await areas(w);
    expect(JSON.stringify(tree.body)).not.toContain("bill");
    expect((await ask(w, {}, "nope")).status).toBe(404);
    // A repository of the other project is not this project's: the same answer as a missing project.
    expect(await ask(w, { repo: REPO_BILL })).toMatchObject({ status: 404, body: { error: { message: "No such project." } } });
    expect(await areas(w, { repo: REPO_BILL })).toMatchObject({ status: 404, body: { error: { message: "No such project." } } });
  });

  it("two companies: another company's lessons are never read, and the day's counters are keyed by company", async () => {
    const w = await world();
    await put(w, active({ id: "les_other001", workspaceId: OTHER_COMPANY, title: "Other company" }), active({ id: "les_mine0001" }));
    const answer = await ask(w);
    expect(answer.body["lessons"].map((l: { id: string }) => l.id)).toEqual(["les_mine0001"]);
    expect(JSON.stringify((await areas(w)).body)).not.toContain("Other");
    const mine = await w.h.store.query({ pk: `ORG#${COMPANY}#KNOWLEDGE_READ_DAY` });
    const theirs = await w.h.store.query({ pk: `ORG#${OTHER_COMPANY}#KNOWLEDGE_READ_DAY` });
    expect(mine.items.length).toBe(1);
    expect(theirs.items).toEqual([]);
    // A caller of another company is refused outright.
    expect((await ask(w, {}, "payments", { ...w.h.owner, principal: { ...w.h.owner.principal, companyId: OTHER_COMPANY } } as Caller)).status).toBe(403);
  });
});

describe("the admin notice: above 150 distinct units, once a day", () => {
  it("tells the install's admin once on the call that crosses the line, records it, and again the next day; repeats of the same units never count twice", async () => {
    const w = await world();
    await put(w, ...Array.from({ length: 152 }, (_, i) => active({ id: `les_dist${String(i).padStart(5, "0")}`, scope: { paths: [`src/f${String(i)}.ts`] } })));
    let calls = 0;
    const read = async (i: number) => { if (calls % 50 === 0) w.h.clock.advance(60); calls += 1; return ask(w, { files: [`src/f${String(i)}.ts`] }); };
    for (let i = 0; i < 150; i += 1) expect((await read(i)).body["lessons"]).toHaveLength(1);
    // The same units again: nothing new, so no notice.
    for (let i = 0; i < 20; i += 1) await read(i);
    expect(w.notices.queueAdmin).not.toHaveBeenCalled();
    await read(150);
    expect(w.notices.queueAdmin).toHaveBeenCalledTimes(1);
    expect(w.notices.queueAdmin.mock.calls[0]![0]).toMatchObject({ orgId: COMPANY, developerIds: [w.lessons.owner.id], kind: "knowledge_read", noticeId: expect.stringMatching(/^knowledge-2026-11-09-[0-9a-f]{16}$/u) });
    await read(151);
    expect(w.notices.queueAdmin).toHaveBeenCalledTimes(1);
    const alerts = w.h.audit.filter((event) => event.action === "lesson.knowledge_read_alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.details).toMatchObject({ distinct: 151, line: 150 });
    expect(JSON.stringify(w.notices.queueAdmin.mock.calls)).not.toMatch(/les_dist|src\/f/u);
    // The next day the same person crossing again is told again.
    w.h.clock.advance(86_400);
    for (let i = 0; i < 151; i += 1) await read(i);
    expect(w.notices.queueAdmin).toHaveBeenCalledTimes(2);
  });

  it("a counter fault while noting the units leaves the answer and logs one fixed event, no text", async () => {
    const w = await world();
    await put(w, active());
    const logs: Array<Record<string, unknown>> = [];
    w.h.deps.log = (entry: Record<string, unknown>) => { logs.push(entry); };
    const realPut = w.h.store.put.bind(w.h.store);
    w.h.store.put = (async (request: Parameters<typeof realPut>[0]) => { if (String(request.item.pk).includes("KNOWLEDGE_UNIT_DAY")) throw new Error("store down"); return realPut(request); }) as typeof realPut;
    expect((await ask(w)).status).toBe(200);
    expect(logs.filter((entry) => entry["event"] === "knowledge.note_failed")).toEqual([{ component: "lessons", event: "knowledge.note_failed", error: "Error" }]);
  });

  it("a person under the line is never told, and a failing notice never changes the answer", async () => {
    const w = await world();
    await put(w, active());
    for (let i = 0; i < 5; i += 1) await ask(w);
    expect(w.notices.queueAdmin).not.toHaveBeenCalled();
    const failing = await world();
    failing.notices.queueAdmin.mockRejectedValue(new Error("down"));
    await put(failing, ...Array.from({ length: 151 }, (_, i) => active({ id: `les_fail${String(i).padStart(5, "0")}`, scope: { paths: [`src/f${String(i)}.ts`] } })));
    let last: Awaited<ReturnType<typeof ask>> | undefined;
    for (let i = 0; i < 151; i += 1) { if (i % 50 === 0) failing.h.clock.advance(60); last = await ask(failing, { files: [`src/f${String(i)}.ts`] }); }
    expect(last!.status).toBe(200);
    expect(last!.body["lessons"]).toHaveLength(1);
  });
});

describe("the table of contents: a tree, names and numbers only", () => {
  it("groups by repository and top folder with counts per kind, holds no unit text or id, and is cut at 100 rows", async () => {
    const w = await world();
    await put(w,
      active({ id: "les_tree0001", scope: { repos: ["demo"], paths: ["src/billing/**"] }, title: "TITLE-NOT-IN-TREE" }),
      active({ id: "les_tree0002", scope: { repos: ["demo"], paths: ["src/queue/**", "tests/**"] } }),
      active({ id: "les_tree0003", scope: { paths: ["**/*.sql"] } }),
      active({ id: "les_tree0004", scope: {} }));
    const tree = await areas(w);
    expect(tree.status).toBe(200);
    expect(tree.body).toMatchObject({ status: "ok", project: "payments", complete: true, more: 0 });
    const demo = tree.body["repos"].find((r: { repo: string }) => r.repo === "demo");
    expect(demo.areas).toEqual([{ area: "src/", rules: 0, lessons: 2, facts: 0, skills: 0 }, { area: "tests/", rules: 0, lessons: 1, facts: 0, skills: 0 }]);
    const any = tree.body["repos"].find((r: { repo: string }) => r.repo === "any repository");
    expect(any.areas).toEqual([{ area: "any folder", rules: 0, lessons: 1, facts: 0, skills: 0 }, { area: "whole repository", rules: 0, lessons: 1, facts: 0, skills: 0 }]);
    const written = JSON.stringify(tree.body);
    for (const text of ["TITLE-NOT-IN-TREE", "les_tree", "withRetry", TEXT]) expect(written, text).not.toContain(text);
    // Narrowed to one repository (the checkout's remote): that repository's rows and the ones that apply to every repository.
    const only = await areas(w, { repo: REPO_PAY });
    expect(only.body["repos"].map((r: { repo: string }) => r.repo).sort()).toEqual(["any repository", "demo"]);
    // Cut at 100 rows, biggest first, with a count of the rest.
    const big = await world();
    await put(big, ...Array.from({ length: 130 }, (_, i) => active({ id: `les_big${String(i).padStart(5, "0")}`, scope: { paths: [`dir${String(i)}/**`] } })));
    const cut = await areas(big);
    expect(cut.body["repos"].flatMap((r: { areas: unknown[] }) => r.areas)).toHaveLength(100);
    expect(cut.body["more"]).toBe(30);
  });

  it("shows no secret-shaped label and no lesson whose scope names a person", async () => {
    const w = await world();
    const ownerName = w.lessons.owner.name;
    await put(w, active({ id: "les_secret01", scope: { repos: ["sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"], paths: ["src/**"] } }), active({ id: "les_person01", scope: { paths: [`${ownerName}/**`] } }), active({ id: "les_fine0001", scope: { paths: ["lib/**"] } }));
    const written = JSON.stringify((await areas(w)).body);
    expect(written).not.toContain("sk-ant-api03");
    expect(written).not.toContain(ownerName);
    expect(written).toContain("lib/");
    expect(written).toContain("any repository");
  });

  it("counts only what an answer could give: a pending lesson, a lesson on trial and a lesson that names a person are not counted", async () => {
    const w = await world();
    await put(w, active({ id: "les_ok000001", scope: { paths: ["src/**"] } }), active({ id: "les_pend0001", status: "pending", approvals: [], pendingExpiresAt: 1_900_000_000_000, scope: { paths: ["src/**"] } }),
      active({ id: "les_trial001", approvals: [{ approvalId: "tr", by: "system:trial", at: 1, mode: "trial" }], trial: { state: "trial", startedAt: 1 }, scope: { paths: ["src/**"] } }));
    const tree = await areas(w);
    expect(tree.body["repos"][0].areas).toEqual([{ area: "src/", rules: 0, lessons: 1, facts: 0, skills: 0 }]);
  });
});
