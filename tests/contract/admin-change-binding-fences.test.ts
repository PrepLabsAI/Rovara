// DP-E1-R1/R2: exercise the real confirmation path and conditional binding writes.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAdminChangeBroker } from "../support/admin-change-broker.js";
import { bindChannel } from "../support/developer-task-broker.js";
import { SLACK_TEAM } from "../support/slack-broker.js";

const a = "C0LEDGER01", b = "C0OTHER001";
const key = (channel: string) => ({ pk: `SLACK_BINDING#${SLACK_TEAM}`, sk: `CHANNEL#${channel}` });
const idOf = (r: { body: Record<string, unknown> }) => (r.body.change as { changeId: string }).changeId;
type Harness = Awaited<ReturnType<typeof createAdminChangeBroker>>;
function project(h: Harness, name: string) {
  const revision = h.db.find(x => x.pk === "PROJECT#payments" && String(x.sk).startsWith("REV#"))[0]!;
  const member = h.db.find(x => x.entityType === "MEMBERSHIP" && x.role === "administrator")[0]!;
  h.db.set({ ...revision, pk: `PROJECT#${name}`, definition: { ...revision.definition as object, name } });
  h.db.set({ ...member, sk: `PROJECT#${name}`, projectName: name });
}
function bindingWrites(h: Harness) {
  const writes: unknown[] = [];
  h.db.onWrite(change => {
    if (String((change.after ?? change.before)?.pk).includes("SLACK_BINDING#")) writes.push(change);
  });
  return writes;
}

describe("DP-E1 reviewed channel and binding fences", () => {
  it.each(["bind_channel", "unbind_channel"] as const)("R1 refuses name swaps with equal binding snapshots: %s", async kind => {
    let renamed = false;
    const h = await createAdminChangeBroker({ channelInfo: async req => ({ ok: true, channels: req.channelIds.map(channelId => ({
      channelId, name: channelId === (renamed ? b : a) ? "ledger-dev" : "renamed-channel", isPrivate: false,
    })) }) });
    for (const channel of [a, b]) {
      await bindChannel(h.handler, channel);
      h.db.set({ ...h.db.get(key(channel).pk, key(channel).sk), updatedAt: "2026-11-20T12:00:00.000Z" });
    }
    project(h, "replacement");
    const proposed = await h.propose(kind === "bind_channel" ? { kind, channel: "#ledger-dev", project: "replacement" } : { kind, channel: "#ledger-dev" });
    expect(proposed.status).toBe(201);
    const id = idOf(proposed);
    expect(h.pending(id)?.details).toMatchObject({ channelId: a });
    const before = [h.db.get(key(a).pk, key(a).sk), h.db.get(key(b).pk, key(b).sk)];
    renamed = true;
    const writes = bindingWrites(h);
    const answer = await h.apply(id);
    expect(answer.body.error).toMatchObject({ code: "CHANGE_STALE" });
    expect(writes).toHaveLength(0);
    expect([h.db.get(key(a).pk, key(a).sk), h.db.get(key(b).pk, key(b).sk)]).toEqual(before);
    expect(h.pending(id)).toMatchObject({ status: "failed", error: { code: "CHANGE_STALE" } });
  });

  const cases = (["bind_channel", "unbind_channel", "first_bind"] as const).flatMap(action =>
    (["after_claim", "at_write"] as const).map(schedule => ({ action, schedule })));
  it.each(cases)("R2 preserves unreviewed binding: $action/$schedule", async ({ action, schedule }) => {
    const h = await createAdminChangeBroker();
    project(h, "replacement");
    project(h, "unreviewed");
    if (action !== "first_bind") await bindChannel(h.handler, a);
    const proposed = await h.propose(action === "unbind_channel" ? { kind: action, channel: a } : { kind: "bind_channel", channel: a, project: "replacement" });
    expect(proposed.status).toBe(201);
    const id = idOf(proposed);
    const writes = bindingWrites(h);
    const send = h.db.send;
    let injected = false;
    const interfere = () => {
      injected = true;
      h.db.set({ ...key(a), ...h.db.get(key(a).pk, key(a).sk), teamId: SLACK_TEAM, channelId: a,
        projectName: "unreviewed", updatedAt: "2026-11-20T13:00:00.000Z" });
    };
    h.db.send = async command => {
      const claim = command.constructor.name === "TransactWriteCommand" && JSON.stringify(command.input).includes(":applying");
      const write = ["PutCommand", "DeleteCommand"].includes(command.constructor.name) && JSON.stringify(command.input).includes("SLACK_BINDING#");
      if (!injected && schedule === "at_write" && write) interfere();
      const result = await send(command);
      if (!injected && schedule === "after_claim" && claim) interfere();
      return result;
    };
    const answer = await h.apply(id);
    expect(injected).toBe(true);
    expect(answer.body.error).toMatchObject({ code: "CHANGE_STALE" });
    expect(writes).toHaveLength(0);
    expect(h.db.get(key(a).pk, key(a).sk)).toMatchObject({ projectName: "unreviewed", updatedAt: "2026-11-20T13:00:00.000Z" });
    expect(h.pending(id)).toMatchObject({ status: "failed", error: { code: "CHANGE_STALE" } });
    expect(h.audit(id)).toMatchObject({ status: "failed", error: { code: "CHANGE_STALE" } });
    expect((await h.apply(id)).body.error).toMatchObject({ code: "CHANGE_STALE" });
    expect(writes).toHaveLength(0);
    // Only a newly reviewed intent can replace/remove the intervening binding.
    const reviewed = await h.propose(action === "unbind_channel" ? { kind: action, channel: a } : { kind: "bind_channel", channel: a, project: "replacement" });
    expect(reviewed.status).toBe(201);
    expect((reviewed.body.change as { effect: string }).effect).toContain("unreviewed");
    expect((await h.apply(idOf(reviewed))).body.change).toMatchObject({ status: "applied" });
    expect(writes).toHaveLength(1);
  });

  it.each(["bind_channel", "unbind_channel"] as const)("R2 fences generation even when project is unchanged: %s", async kind => {
    const h = await createAdminChangeBroker();
    project(h, "replacement");
    await bindChannel(h.handler, a);
    const proposed = await h.propose(kind === "bind_channel" ? { kind, channel: a, project: "replacement" } : { kind, channel: a });
    expect(proposed.status).toBe(201);
    const writes = bindingWrites(h);
    const send = h.db.send;
    h.db.send = async command => {
      if (["PutCommand", "DeleteCommand"].includes(command.constructor.name) && JSON.stringify(command.input).includes("SLACK_BINDING#")) {
        h.db.set({ ...h.db.get(key(a).pk, key(a).sk), updatedAt: "2026-11-20T14:00:00.000Z" });
      }
      return send(command);
    };
    expect((await h.apply(idOf(proposed))).body.error).toMatchObject({ code: "CHANGE_STALE" });
    expect(writes).toHaveLength(0);
    expect(h.db.get(key(a).pk, key(a).sk)).toMatchObject({ projectName: "payments", updatedAt: "2026-11-20T14:00:00.000Z" });
  });

  it.each(["bind_channel", "unbind_channel"] as const)("M1 reviews and applies the named-company binding: %s", async kind => {
    const h = await createAdminChangeBroker();
    project(h, "replacement");
    await bindChannel(h.handler, a);
    const company = `org_${"a".repeat(20)}`;
    const companyKey = { pk: `ORG#${company}#SLACK_BINDING#${SLACK_TEAM}`, sk: `CHANNEL#${a}` };
    const reviewed = { ...h.db.get(key(a).pk, key(a).sk), ...companyKey };
    h.db.set(reviewed);
    h.db.delete(key(a).pk, key(a).sk);
    // Real named-company revisions, and the pre-existing name-only administrator grants.
    // No own catalog entry: the separate name-collision refusal must remain intact.
    for (const name of ["payments", "replacement"]) {
      const revision = h.db.find(row => row.pk === `PROJECT#${name}` && String(row.sk).startsWith("REV#"))[0]!;
      h.db.set({ ...revision, pk: `ORG#${company}#PROJECT#${name}` });
    }
    h.db.set({ pk: `ORG#${company}#SLACK_WORKSPACES`, sk: `TEAM#${SLACK_TEAM}`,
      entityType: "COMPANY_SLACK_WORKSPACE_VIEW", teamId: SLACK_TEAM, companyId: company,
      boundAt: "2026-11-20T12:00:00.000Z", boundBy: "operator" });
    const ownershipReads: string[] = [];
    const { createAwsBrokerHandler } = await import("../../packages/broker/src/aws/broker.js");
    const handler = createAwsBrokerHandler({ ...h.brokerInput, companies: { companyOf: async () => company },
      workspaces: { requireCompany: async (team: string) => { ownershipReads.push(team); return company; } },
    } as unknown as Parameters<typeof createAwsBrokerHandler>[0]);
    const call = async (path: string, body: unknown) => {
      const response = await handler({ version: "2.0", rawPath: path, rawQueryString: "", headers: { authorization: "Bearer admin-token-for-tests", "x-agentx-slack-thread": `${SLACK_TEAM}/${a}/1700000000.000001` }, body: JSON.stringify(body),
        requestContext: { requestId: randomUUID(), http: { method: "POST" },
          authorizer: { jwt: { claims: { iss: "https://identity.example.test", sub: "admin-subject", groups: ["admins"] } } } },
      });
      return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
    };
    const input = kind === "bind_channel" ? { kind, channel: a, project: "replacement" } : { kind, channel: a };
    const writes = bindingWrites(h);
    const proposed = await call("/v1/admin/changes", { requestId: randomUUID(), change: input,
      client: { cliVersion: "0.0.7", mcpClient: { name: "test-client", version: "1.0.0" } }, methods: ["elicitation"] });
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(201);
    expect((proposed.body.change as { effect: string }).effect).toContain(kind === "bind_channel"
      ? "It is bound to payments today" : "from project payments.");
    const id = idOf(proposed);
    expect(h.pending(id)?.details).toMatchObject(kind === "bind_channel" ? { currentProject: "payments" } : { project: "payments" });
    expect(writes).toHaveLength(0);
    // A conflicting legacy row must neither change the re-plan nor be touched by execution.
    const legacy = { ...reviewed, ...key(a), projectName: "legacy-decoy" };
    h.db.set(legacy);
    const applied = await call(`/v1/admin/changes/${id}/apply`, { method: "elicitation" });
    expect(applied.status).toBe(200);
    expect(applied.body.change).toMatchObject({ status: "applied" });
    expect(writes).toHaveLength(1);
    expect(h.db.get(key(a).pk, key(a).sk)).toEqual(legacy);
    if (kind === "bind_channel") expect(h.db.get(companyKey.pk, companyKey.sk)).toMatchObject({ projectName: "replacement" });
    else expect(h.db.get(companyKey.pk, companyKey.sk)).toBeUndefined();
    expect(h.pending(id)).toMatchObject({ status: "applied" });
    expect(h.audit(id)).toMatchObject({ status: "applied" });
    expect(ownershipReads.length).toBeGreaterThan(0);
    expect(ownershipReads.every(team => team === SLACK_TEAM)).toBe(true);
  });

  it("L1 refuses unbind with CHANGE_STALE when the reviewed binding is deleted after claim", async () => {
    const h = await createAdminChangeBroker();
    await bindChannel(h.handler, a);
    const proposed = await h.propose({ kind: "unbind_channel", channel: a });
    expect(proposed.status).toBe(201);
    const id = idOf(proposed);
    const writes = bindingWrites(h);
    const send = h.db.send;
    let deleted = false;
    h.db.send = async command => {
      const claim = command.constructor.name === "TransactWriteCommand" && JSON.stringify(command.input).includes(":applying");
      const result = await send(command);
      if (!deleted && claim) { deleted = true; h.db.delete(key(a).pk, key(a).sk); }
      return result;
    };
    expect((await h.apply(id)).body.error).toMatchObject({ code: "CHANGE_STALE" });
    expect(deleted).toBe(true);
    expect(writes).toHaveLength(0);
    expect(h.db.get(key(a).pk, key(a).sk)).toBeUndefined();
    expect(h.pending(id)).toMatchObject({ status: "failed", error: { code: "CHANGE_STALE" } });
    expect(h.audit(id)).toMatchObject({ status: "failed", error: { code: "CHANGE_STALE" } });
    expect((await h.apply(id)).body.error).toMatchObject({ code: "CHANGE_STALE" });
    expect(writes).toHaveLength(0);
  });

});
