import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { IMPLICIT_COMPANY_ID } from "@agentx/contracts";
import { createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM, call, issuer } from "../support/slack-broker.js";
import { membershipReadFailed } from "../../packages/broker/src/core/membership-read.js";
import { ADMIN_NAME_COLLISION_MESSAGE } from "../../packages/broker/src/aws/admin-name-collision.js";

// DEC 254zzz6 D2 (rows 3651/3655): the old /v1/admin project routes find an administrator's grant by project NAME only. (1) A name-only admin route refuses, with one
// fixed answer, a name that a named company (not the implicit one) also uses; the implicit company's own legacy projects answer exactly as before. (2) Production sets
// the company membership reader on the developer configuration only, so the admin reads are now given it from there and their company checks apply.

const ADMIN = { subject: "admin-subject", admin: true };
const ADMIN_KEY = createHash("sha256").update(issuer).update("\0").update(ADMIN.subject).digest("hex");
const COMPANY_A = "org_aaaaaaaaaaaaaaaaaaaa";
const COMPANY_B = "org_bbbbbbbbbbbbbbbbbbbb";
const FIXED = { status: 403, body: { error: { code: "FORBIDDEN", message: ADMIN_NAME_COLLISION_MESSAGE } } };

type Held = string | undefined | Error;
async function world(held?: { [ownerKey: string]: Held }) {
  const companyOf = vi.fn(async (personId: string) => {
    const value = held?.[personId];
    if (value instanceof Error) throw value;
    return value;
  });
  const broker = await createDeveloperTaskBroker(held === undefined ? {} : { developerExtra: { companies: { companyOf } } });
  const prepare = (projectName = "payments") => call(broker.handler, {
    method: "POST", path: "/v1/admin/workspaces/prepare", user: ADMIN, body: { requestId: randomUUID(), projectName, projectRevision: 1, ownerSubject: ADMIN.subject },
  });
  const workspaces = () => broker.db.find((row) => row.entityType === "WORKSPACE");
  /** The named company's own catalog row for `payments` (ORG#<company>#PROJECT_CATALOG). */
  const companyCatalog = (company: string, name = "payments") => broker.db.set({ pk: `ORG#${company}#PROJECT_CATALOG`, sk: `PROJECT#${name}`, entityType: "PROJECT_CATALOG", companyId: company, name, latestRevision: 1 });
  /** Every legacy revision row of `payments` (PROJECT#payments / REV#...) stamped with `company`. */
  const stampRevisions = (company: unknown) => { for (const row of broker.db.find((item) => item.pk === "PROJECT#payments" && String(item.sk).startsWith("REV#"))) broker.db.set({ ...row, companyId: company }); };
  const stampCatalog = (company: unknown) => { for (const row of broker.db.find((item) => item.pk === "PROJECT_CATALOG" && item.sk === "PROJECT#payments")) broker.db.set({ ...row, companyId: company }); };
  return { ...broker, held, companyOf, prepare, workspaces, companyCatalog, stampRevisions, stampCatalog };
}

describe("D2 (1): a name-only admin route and a named company's project of the same name", () => {
  it("golden: no company reader and no named company: the implicit company's legacy project answers exactly as before", async () => {
    const broker = await world();
    const answer = await broker.prepare();
    expect(answer.status, JSON.stringify(answer.body)).toBe(202);
    expect(broker.workspaces()).toHaveLength(1);
  });

  it("no collision: the administrator in the implicit company, or in no company, or in a named company without that name, still gets the route", async () => {
    for (const held of [IMPLICIT_COMPANY_ID, undefined, COMPANY_A] as const) {
      const broker = await world({ [ADMIN_KEY]: held });
      // The implicit company's own catalog row of its legacy project is no collision; a named company's row of ANOTHER name is none either.
      broker.companyCatalog(IMPLICIT_COMPANY_ID);
      broker.companyCatalog(COMPANY_A, "billing");
      broker.stampRevisions(IMPLICIT_COMPANY_ID);
      const answer = await broker.prepare();
      expect(answer.status, `${String(held)}: ${JSON.stringify(answer.body)}`).toBe(202);
      expect(broker.workspaces()).toHaveLength(1);
    }
  });

  it("collision (caller's company): the administrator's named company has its own project called 'payments'; the legacy route is refused with the fixed answer, nothing written", async () => {
    const broker = await world({ [ADMIN_KEY]: COMPANY_A });
    broker.companyCatalog(COMPANY_A);
    const answer = await broker.prepare();
    expect(answer).toMatchObject(FIXED);
    expect(JSON.stringify(answer.body)).not.toMatch(/org_|payments/u);
    expect(broker.workspaces()).toEqual([]);
    expect(broker.companyOf).toHaveBeenCalledWith(ADMIN_KEY);
  });

  it("cross-company: the legacy project is a named company's (its latest revision says so) and the administrator is in another company or in none: refused, nothing written", async () => {
    for (const held of [COMPANY_A, undefined, IMPLICIT_COMPANY_ID] as const) {
      const broker = await world({ [ADMIN_KEY]: held });
      broker.stampRevisions(COMPANY_B);
      const answer = await broker.prepare();
      expect(answer, String(held)).toMatchObject(FIXED);
      expect(broker.workspaces()).toEqual([]);
    }
    // Without any company reader (company sign-in off) the legacy row still says whose project it is.
    const off = await world();
    off.stampRevisions(COMPANY_B);
    expect(await off.prepare()).toMatchObject(FIXED);
  });

  it("cross-company: the legacy catalog row names a named company: refused", async () => {
    const broker = await world();
    broker.stampCatalog(COMPANY_B);
    expect(await broker.prepare()).toMatchObject(FIXED);
    expect(broker.workspaces()).toEqual([]);
  });

  it("fails closed: an unreadable membership, or a company value that does not parse, refuses with the same fixed answer and never its cause", async () => {
    for (const setup of [
      // Set after the world is built: its own setup (registration, binding) runs with a readable membership.
      async () => { const b = await world({}); b.held![ADMIN_KEY] = new Error("sign-in table timed out at shard 7"); return b; },
      async () => { const b = await world({}); b.held![ADMIN_KEY] = "not-a-company"; return b; },
      async () => { const b = await world(); b.stampRevisions("ORG#evil"); return b; },
      async () => { const b = await world(); b.stampCatalog(42); return b; },
    ]) {
      const broker = await setup();
      const answer = await broker.prepare();
      expect(answer).toMatchObject(FIXED);
      expect(JSON.stringify(answer.body)).not.toMatch(/shard|timed out|evil|not-a-company/u);
      expect(broker.workspaces()).toEqual([]);
    }
  });

  it("a caller without the grant gets exactly today's answer, whatever the collision (the check runs after the grant)", async () => {
    const noGrantKey = createHash("sha256").update(issuer).update("\0").update("no-grant-admin").digest("hex");
    const broker = await world({ [ADMIN_KEY]: COMPANY_A, [noGrantKey]: COMPANY_A });
    broker.companyCatalog(COMPANY_A);
    broker.stampRevisions(COMPANY_B);
    const answer = await call(broker.handler, {
      method: "POST", path: "/v1/admin/workspaces/prepare", user: { subject: "no-grant-admin", admin: true }, body: { requestId: randomUUID(), projectName: "payments", projectRevision: 1, ownerSubject: "x" },
    });
    expect(answer).toMatchObject({ status: 404, body: { error: { code: "NOT_FOUND", message: "project not found" } } });
  });

  it("the other name-only routes share the guard: a Slack channel binding of the colliding name is refused", async () => {
    const broker = await world({ [ADMIN_KEY]: COMPANY_A });
    broker.companyCatalog(COMPANY_A);
    const answer = await call(broker.handler, { method: "PUT", path: `/v1/admin/slack/bindings/${SLACK_TEAM}/C0OTHER01`, user: ADMIN, body: { projectName: "payments" } });
    expect(answer).toMatchObject(FIXED);
    expect(broker.db.find((row) => row.channelId === "C0OTHER01")).toEqual([]);
  });
});

describe("D2 (2): the admin reads are given the company reader production sets", () => {
  it("the developer configuration's reader (production's only one) reaches the admin reads: the bindings list asks it for the caller's company and is company-scoped", async () => {
    const baseline = await world();
    const before = await call(baseline.handler, { method: "GET", path: "/v1/admin/slack/bindings", user: ADMIN });
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect(JSON.stringify(before.body)).toContain(SLACK_CHANNEL);

    const broker = await world({ [ADMIN_KEY]: COMPANY_A });
    const scoped = await call(broker.handler, { method: "GET", path: "/v1/admin/slack/bindings", user: ADMIN });
    expect(broker.companyOf).toHaveBeenCalledWith(ADMIN_KEY);
    // With no workspace of the caller's company, the company-scoped read refuses instead of listing the install team's bindings.
    expect(scoped.status).not.toBe(200);
    expect(JSON.stringify(scoped.body)).not.toContain(SLACK_CHANNEL);
  });
});

// MEMBERSHIP-READ-FAILS-SAFE (re-check SHOULD, mutant row 26): the task-company check of the admin task routes (broker.ts administratorOfTaskCompany).
describe("an administrator's task route reads their company: a failed read is the retryable 503, never the 'not an administrator' 403", () => {
  const TASK = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const replay = (broker: Awaited<ReturnType<typeof world>>) => call(broker.handler, { method: "POST", path: `/v1/admin/tasks/${TASK}/share-mode`, user: ADMIN, body: { requestId: randomUUID(), mode: "owner_only" } });
  const seeded = async (held: Held) => {
    // The company reader answers while the world is set up, and gives `held` (an answer, no company, or a failure) when the route asks.
    const open: { [ownerKey: string]: Held } = { [ADMIN_KEY]: IMPLICIT_COMPANY_ID };
    const broker = await world(open);
    open[ADMIN_KEY] = held;
    broker.db.set({ pk: `MEMBER#${ADMIN_KEY}`, sk: "PROJECT#payments", entityType: "MEMBERSHIP", projectName: "payments", role: "administrator" });
    broker.db.set({ pk: `DEVTASK#${TASK}`, sk: "META", entityType: "DEVTASK", taskId: TASK, project: "payments" });
    return broker;
  };

  it("a read that FAILED (marked) answers 503 RUNTIME_UNAVAILABLE; a read that says no company, or an unmarked error, is still the 403", async () => {
    const failed = await replay(await seeded(membershipReadFailed()));
    expect(failed, JSON.stringify(failed.body)).toMatchObject({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE" } } });
    for (const held of [undefined, new Error("not a membership read")] as const) {
      const refused = await replay(await seeded(held));
      expect(refused, JSON.stringify(refused.body)).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN", message: "administrator project membership is required" } } });
    }
  });

  it("control: the administrator of the task's own company passes the check (the answer is not the 403)", async () => {
    const answer = await replay(await seeded(IMPLICIT_COMPANY_ID));
    expect(JSON.stringify(answer.body)).not.toContain("administrator project membership is required");
  });
});
