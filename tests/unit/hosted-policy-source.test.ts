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
});

describe("unreadable fails closed: never a default, never looser", () => {
  const unreadable = async (w: ReturnType<typeof world>, company = A, project = "web") => {
    await expect(w.mode(company, project)).rejects.toThrow(CI_MODE_UNREADABLE_WORDS);
  };
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
  it("a scope that is not the root's own company/project form refuses without reading anything", async () => {
    const w = world({ withHook: false });
    for (const key of ["", "web", `${A}/web`, `company/${A}`, `company/${A}/project/`, `company/${A}/project/web/extra`, `company/not-an-org/project/web`, `company/${A}/project/.hidden`, `company/${A}/project/${"a".repeat(101)}`, `COMPANY/${A}/project/web`]) {
      await expect(w.source.resolve({ key }, {})).rejects.toThrow("policy_unavailable");
    }
    await expect(w.source.resolve(undefined as never, {})).rejects.toThrow("policy_unavailable");
    expect(w.reads).toEqual([]);
  });
});

describe("the cache bounds the calls of one pass", () => {
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
