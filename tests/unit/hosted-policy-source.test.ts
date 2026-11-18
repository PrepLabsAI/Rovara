// L4-HW3d: the deployed broker's merge tracking reads each project's CI mode (`real_check`) from the project's stored settings and the company's rules lock, through one cached,
// company-scoped policy source (aws/core-policy-source.ts), not "their_ci_fix" for everyone. Two companies throughout; the stored row and the rules service are the real readers
// (the same ones the settings page and the per-task limit reader use), over a fake table and a fake signed rules service.
import { describe, expect, it } from "vitest";
import { companyScoped, type PolicyResolveRequest } from "@agentx/contracts";
import { policyCiReporting } from "../../packages/broker/src/aws/core-job-services.js";
import { hostedPolicySource, HOSTED_POLICY_FAILURE_TTL_MS, HOSTED_POLICY_TTL_MS } from "../../packages/broker/src/aws/core-policy-source.js";
import { CI_MODE_UNREADABLE_WORDS } from "../../packages/broker/src/core-host/switch-blockers.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { ISSUER, fakeService, makeKey, settingsFor, signerOf } from "./policy-hook-fixture.js";
import { COMPANY_A_ID, COMPANY_B_ID } from "../../packages/testing/src/isolation/two-company.js";

const A = COMPANY_A_ID, B = COMPANY_B_ID;
const T0 = Date.parse("2026-11-18T10:00:00.000Z");

function world(options: { locks?: (cid: string, pid: string | undefined) => Record<string, unknown> | Error; lifetime?: number; withHook?: boolean; ttlMs?: number; maxEntries?: number } = {}) {
  const db = new FakeDynamoDb();
  let at = T0;
  const reads: Array<{ pk: string; sk: string }> = [];
  const client = { async send(command: { constructor: { name: string }; input?: { Key?: { pk: string; sk: string } } }) {
    if (command.constructor.name === "GetCommand") reads.push({ ...command.input!.Key! });
    return await (db as unknown as { send(c: unknown): Promise<unknown> }).send(command);
  } };
  const install = makeKey("install"); const hookKey = makeKey("hook");
  const service = fakeService({ key: hookKey, now: () => at, ...(options.lifetime === undefined ? {} : { lifetime: options.lifetime }), answer: (asked) => {
    const locks = (options.locks ?? (() => ({})))(String(asked.q["cid"]), typeof asked.q["pid"] === "string" ? asked.q["pid"] : undefined);
    return locks instanceof Error ? locks : { locks };
  } });
  const hookFor = () => (options.withHook === false ? undefined : { settings: settingsFor(hookKey), install: { issuer: ISSUER, signer: signerOf(install) }, fetch: service.fetch });
  const source = hostedPolicySource({ documentClient: client, tableName: "state", now: () => at }, hookFor, { ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }), ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }) });
  const reporting = policyCiReporting(source);
  const row = (companyId: string, project: string, overrides: Record<string, unknown>, extra: Record<string, unknown> = {}) => db.set({
    pk: companyScoped(companyId, `PROJECT_SETTINGS#${project}`), sk: "META", entityType: "PROJECT_SETTINGS", companyId, projectName: project, overrides, revision: 1, updatedAt: new Date(at).toISOString(), updatedBy: "d".repeat(64), ...extra,
  });
  const mode = (orgId: string, project: string) => reporting.ciMode({ orgId, project } as never);
  return { db, source, reporting, row, mode, reads, service, advance: (ms: number) => { at += ms; }, scope: (c: string, p: string) => ({ key: `company/${c}/project/${p}` }) };
}

describe("the stored project policy and the company's lock decide merge tracking's CI mode", () => {
  it("a project with nothing stored is today's their_ci_fix; a stored preset or override changes it", async () => {
    const w = world({ withHook: false });
    expect(await w.mode(A, "web")).toBe("their_ci_fix");
    w.row(A, "web", {}, { preset: "lightweight" });
    w.advance(HOSTED_POLICY_TTL_MS);
    expect(await w.mode(A, "web")).toBe("their_ci_watch");
    w.row(A, "web", { real_check: "sandbox_only" });
    w.advance(HOSTED_POLICY_TTL_MS);
    expect(await w.mode(A, "web")).toBe("sandbox_only");
    w.row(A, "web", {}, { preset: "careful" });
    w.advance(HOSTED_POLICY_TTL_MS);
    expect(await w.mode(A, "web")).toBe("rovara_real_run");
  });

  it("the company's lock wins over the project's own choice, and a lock never loosens it", async () => {
    const w = world({ locks: () => ({ real_check: "rovara_real_run" }) });
    w.row(A, "web", { real_check: "sandbox_only" });
    expect(await w.mode(A, "web")).toBe("rovara_real_run");
    const loose = world({ locks: () => ({ real_check: "sandbox_only" }) });
    loose.row(A, "web", { real_check: "their_ci_watch" });
    expect(await loose.mode(A, "web")).toBe("their_ci_watch");
    // No stored row at all: the lock still applies over today's default.
    const none = world({ locks: () => ({ real_check: "rovara_real_run" }) });
    expect(await none.mode(A, "web")).toBe("rovara_real_run");
  });

  it("a company's lock is asked for under that company and project only", async () => {
    const w = world({ locks: (cid, pid) => (cid === A && pid === "web" ? { real_check: "rovara_real_run" } : {}) });
    expect(await w.mode(A, "web")).toBe("rovara_real_run");
    expect(await w.mode(B, "web")).toBe("their_ci_fix");
    expect(await w.mode(A, "api")).toBe("their_ci_fix");
    expect(w.service.asked.map((entry) => `${String(entry.q["cid"])}/${String(entry.q["pid"])}`).sort()).toEqual([`${A}/api`, `${A}/web`, `${B}/web`].sort());
  });
});

describe("unreadable fails closed: never a default, never looser", () => {
  const unreadable = async (w: ReturnType<typeof world>, company = A, project = "web") => {
    await expect(w.mode(company, project)).rejects.toThrow(CI_MODE_UNREADABLE_WORDS);
  };
  it("a rules service that gives no answer", async () => {
    const w = world({ locks: () => new Error("private-canary") });
    w.row(A, "web", { real_check: "sandbox_only" });
    await unreadable(w);
    await expect(w.source.resolve(w.scope(A, "web"), {})).rejects.toThrow("policy_unavailable");
  });
  it("an install whose rules service is configured but unusable (no signer)", async () => {
    const db = new FakeDynamoDb();
    const source = hostedPolicySource({ documentClient: db, tableName: "state", now: () => T0 }, () => { throw new Error("the policy hook is not usable"); });
    await expect(policyCiReporting(source).ciMode({ orgId: A, project: "web" } as never)).rejects.toThrow(CI_MODE_UNREADABLE_WORDS);
  });
  it("a stored row that does not parse, or names another company or project", async () => {
    const w = world({ withHook: false });
    w.row(A, "web", { real_check: "private-canary" });
    await unreadable(w);
    w.row(A, "web", { real_check: "sandbox_only" }, { companyId: B });
    w.advance(HOSTED_POLICY_FAILURE_TTL_MS);
    await unreadable(w);
    w.row(A, "web", { real_check: "sandbox_only" }, { projectName: "api" });
    w.advance(HOSTED_POLICY_FAILURE_TTL_MS);
    await unreadable(w);
  });
  it("a table that fails", async () => {
    const down = hostedPolicySource({ documentClient: { async send() { throw new Error("private-canary"); } }, tableName: "state", now: () => T0 }, () => undefined);
    await expect(policyCiReporting(down).ciMode({ orgId: A, project: "web" } as never)).rejects.toThrow(CI_MODE_UNREADABLE_WORDS);
  });
  it("a scope that is not the root's own company/project form refuses without reading anything", async () => {
    const w = world({ withHook: false });
    for (const key of ["", "web", `${A}/web`, `company/${A}`, `company/${A}/project/`, `company/${A}/project/web/extra`, `company/not-an-org/project/web`, `company/${A}/project/.hidden`, `company/${A}/project/${"a".repeat(101)}`, `COMPANY/${A}/project/web`]) {
      await expect(w.source.resolve({ key }, {})).rejects.toThrow("policy_unavailable");
    }
    await expect(w.source.resolve(undefined as never, {})).rejects.toThrow("policy_unavailable");
    expect(w.reads).toEqual([]);
  });
  it("the refusal never echoes what the reader said", async () => {
    const w = world({ locks: () => new Error("private-canary") });
    await expect(w.source.resolve(w.scope(A, "web"), {})).rejects.toThrow(/^policy_unavailable$/u);
  });
});

describe("two companies", () => {
  it("each company reads only its own project row and asks for its own lock; the same project name under another company is never read", async () => {
    const w = world({ locks: () => ({}) });
    w.row(A, "web", { real_check: "sandbox_only" });
    w.row(B, "web", { real_check: "rovara_real_run" });
    expect(await w.mode(A, "web")).toBe("sandbox_only");
    expect(w.reads.every((read) => read.pk === companyScoped(A, "PROJECT_SETTINGS#web"))).toBe(true);
    expect(w.service.asked.every((entry) => entry.q["cid"] === A)).toBe(true);
    w.reads.length = 0; w.service.asked.length = 0;
    expect(await w.mode(B, "web")).toBe("rovara_real_run");
    expect(w.reads.every((read) => read.pk === companyScoped(B, "PROJECT_SETTINGS#web"))).toBe(true);
    expect(w.service.asked.every((entry) => entry.q["cid"] === B)).toBe(true);
  });
  it("one company's cached answer is never served to the other, and one project's never to another project", async () => {
    const w = world({ withHook: false });
    w.row(A, "web", { real_check: "sandbox_only" });
    w.row(A, "api", { real_check: "their_ci_watch" });
    w.row(B, "web", { real_check: "rovara_real_run" });
    for (let round = 0; round < 2; round += 1) {
      expect(await w.mode(A, "web")).toBe("sandbox_only");
      expect(await w.mode(B, "web")).toBe("rovara_real_run");
      expect(await w.mode(A, "api")).toBe("their_ci_watch");
    }
  });
  it("a company with no row of its own does not read another company's", async () => {
    const w = world({ withHook: false });
    w.row(B, "web", { real_check: "sandbox_only" });
    expect(await w.mode(A, "web")).toBe("their_ci_fix");
  });
});

describe("the cache bounds the calls of one pass", () => {
  it("many tasks of one project in one pass: one row read and one rules-service question", async () => {
    const w = world({ locks: () => ({ real_check: "rovara_real_run" }) });
    w.row(A, "web", { real_check: "sandbox_only" });
    for (let i = 0; i < 40; i += 1) expect(await w.mode(A, "web")).toBe("rovara_real_run");
    expect(w.reads).toHaveLength(1);
    expect(w.service.asked).toHaveLength(1);
  });
  it("tasks asked at the same moment share one read", async () => {
    const w = world({ withHook: false });
    w.row(A, "web", { real_check: "sandbox_only" });
    expect(await Promise.all(Array.from({ length: 10 }, async () => await w.mode(A, "web")))).toEqual(Array(10).fill("sandbox_only"));
    expect(w.reads).toHaveLength(1);
  });
  it("a change is read after the short TTL, not before", async () => {
    const w = world({ withHook: false });
    w.row(A, "web", { real_check: "sandbox_only" });
    expect(await w.mode(A, "web")).toBe("sandbox_only");
    w.row(A, "web", { real_check: "rovara_real_run" });
    w.advance(HOSTED_POLICY_TTL_MS - 1);
    expect(await w.mode(A, "web")).toBe("sandbox_only");
    w.advance(1);
    expect(await w.mode(A, "web")).toBe("rovara_real_run");
    expect(w.reads).toHaveLength(2);
  });
  it("an answer is never used past the rules service's own expiry", async () => {
    const w = world({ lifetime: 10, locks: () => ({ real_check: "rovara_real_run" }) });
    await w.mode(A, "web");
    w.advance(9_000);
    await w.mode(A, "web");
    expect(w.service.asked).toHaveLength(1);
    w.advance(1_000);
    await w.mode(A, "web");
    expect(w.service.asked).toHaveLength(2);
  });
  it("a failure is remembered only briefly: a pass does not ask again for every task, and the next pass reads again", async () => {
    let failing = true;
    const w = world({ locks: () => (failing ? new Error("down") : {}) });
    for (let i = 0; i < 20; i += 1) await expect(w.mode(A, "web")).rejects.toThrow(CI_MODE_UNREADABLE_WORDS);
    expect(w.reads).toHaveLength(1);
    failing = false;
    w.advance(HOSTED_POLICY_FAILURE_TTL_MS);
    expect(await w.mode(A, "web")).toBe("their_ci_fix");
  });
  it("a request that carries anything (a task's raise) is not cached, and does not fill the cache for a later plain ask", async () => {
    const w = world({ withHook: false });
    w.row(A, "web", { real_check: "sandbox_only" });
    const request = { taskRaises: {} } as unknown as PolicyResolveRequest;
    await w.source.resolve(w.scope(A, "web"), request).catch(() => undefined);
    await w.source.resolve(w.scope(A, "web"), request).catch(() => undefined);
    expect(w.reads).toHaveLength(2);
    expect(await w.mode(A, "web")).toBe("sandbox_only");
    expect(w.reads).toHaveLength(3);
  });
  it("one company's remembered failure does not touch another company's answer at the same moment", async () => {
    const w = world({ locks: (cid) => (cid === A ? new Error("down") : { real_check: "rovara_real_run" }) });
    const [a, b] = await Promise.allSettled([w.mode(A, "web"), w.mode(B, "web")]);
    expect(a.status).toBe("rejected");
    expect(b).toEqual({ status: "fulfilled", value: "rovara_real_run" });
    await expect(w.mode(A, "web")).rejects.toThrow(CI_MODE_UNREADABLE_WORDS);
    expect(await w.mode(B, "web")).toBe("rovara_real_run");
    expect(w.service.asked).toHaveLength(2);
  });
  it("what a caller does to its answer does not change the next one", async () => {
    const w = world({ withHook: false });
    w.row(A, "web", { real_check: "sandbox_only" });
    const first = await w.source.resolve(w.scope(A, "web"), {});
    (first.values as Record<string, { value: unknown }>)["real_check"]!.value = "their_ci_fix";
    expect((await w.source.resolve(w.scope(A, "web"), {})).values["real_check"]!.value).toBe("sandbox_only");
  });
  it("the cache holds at most maxEntries projects", async () => {
    const w = world({ withHook: false, maxEntries: 2 });
    await w.mode(A, "p1"); await w.mode(A, "p2"); await w.mode(A, "p3");
    expect(w.reads).toHaveLength(3);
    await w.mode(A, "p3");
    expect(w.reads).toHaveLength(3);
    await w.mode(A, "p1");
    expect(w.reads).toHaveLength(4);
  });
});
