import { expect, it, vi } from "vitest";
import * as identity from "../../packages/broker/src/aws/developer-identity.js";
import * as proof from "../../packages/broker/src/aws/task-person-proof-runtime.js";
import { identityHarness } from "../support/developer-fakes.js";
import { slackTokens } from "../../packages/testing/src/channel/slack-world.js";
const A = { companyId: "org_aaaaaaaaaaaaaaaaaaaa", teamId: "T0AAAAAAA" };
const B = { companyId: "org_bbbbbbbbbbbbbbbbbbbb", teamId: "T0BBBBBBB" };
const USER = "U0SHARED", CHANNEL = "C0SHARED";
function world() {
  const calls: string[] = [];
  const workspaces = { requireCompany: async (team: string) => team === A.teamId ? A.companyId : team === B.teamId ? B.companyId : "invalid",
    tokenForCompany: vi.fn(async (company: string) => slackTokens(company === A.companyId ? "a" : "b").bot) };
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const companyA = new Headers(init?.headers).get("authorization") === `Bearer ${slackTokens("a").bot}`;
    const team = companyA ? A.teamId : B.teamId; calls.push(team);
    const path = new URL((typeof url === "string" ? url : url instanceof URL ? url.href : url.url)).pathname;
    return new Response(JSON.stringify(path.endsWith("auth.test") ? { ok: true, team_id: team }
      : path.endsWith("users.info") ? { ok: true, user: { id: USER, team_id: team, deleted: false, is_bot: false, is_stranger: false, profile: { display_name: companyA ? "alpha" : "beta" } } }
      : { ok: true, members: companyA ? [USER] : [], response_metadata: { next_cursor: "" } }));
  };
  return { workspaces, fetch, calls };
}
it("identity invokes use a workspace directory and recheck cached bindings", async () => {
  const h = identityHarness({}); const w = world();
  expect(typeof identity.createWorkspaceSlackDirectory).toBe("function");
  h.deps.directoryForWorkspace = identity.createWorkspaceSlackDirectory({ legacy: h.deps.directory, ...w, now: Date.now });
  const request = { kind: "channel-members", slackUserId: USER, channelIds: [CHANNEL] };
  expect(await Promise.all([h.handler({ ...request, workspace: A } as never), h.handler({ ...request, workspace: B } as never)])).toEqual([{ ok: true, memberOf: [CHANNEL] }, { ok: true, memberOf: [] }]);
  expect(await h.handler({ ...request, workspace: { ...A, teamId: B.teamId } } as never)).toEqual({ ok: false, error: "slack_unavailable" });
  expect(await h.handler(request as never)).toEqual({ ok: false, error: "slack_unavailable" });
  w.workspaces.requireCompany = async () => B.companyId;
  expect(await h.handler({ ...request, workspace: A } as never)).toEqual({ ok: false, error: "slack_unavailable" });
  expect(w.calls).toHaveLength(2); expect(h.fetch.calls).toHaveLength(0);
});
it("dedicated proof uses the envelope's record-derived workspace and refuses absent/foreign scope", async () => {
  const w = world(); expect(typeof proof.createTaskPersonProofRuntime).toBe("function");
  const run = proof.createTaskPersonProofRuntime({ ...w, env: { AGENTX_ENV: "agentxlivetest123", AWS_REGION: "us-east-1" } });
  const event = (workspace?: typeof A) => ({ kind: "task-dispatch-person-proof", ...(workspace === undefined ? {} : { workspace }),
    request: { kind: "task-person-proof", slackUserId: USER, channelIds: [CHANNEL], ...(workspace === undefined ? {} : { workspace }) },
    admission: { version: 1, id: "11111111-1111-4111-8111-111111111111", deadlineAt: Date.now() + 6000, remainingMs: 6000, slackCallsLimit: 10 } });
  const context = { getRemainingTimeInMillis: () => 7000 };
  const [a, b] = await Promise.all([run(event(A), context), run(event(B), context)]);
  expect(a.result).toMatchObject({ ok: true, user: { teamId: A.teamId, name: "alpha" } });
  expect(b.result).toMatchObject({ ok: true, user: { teamId: B.teamId, name: "beta" } });
  for (const workspace of [undefined, { ...A, teamId: B.teamId }]) await expect(run(event(workspace), context)).rejects.toThrow("task person identity proof is unavailable");
  await expect(run({ ...event(A), request: event(B).request }, context)).rejects.toThrow("task person identity proof is unavailable");
  expect(w.calls).toHaveLength(4);
});

it("directory cache has one total bound across all companies and teams", async () => {
  const h = identityHarness({});
  const factory = identity.createWorkspaceSlackDirectory({ legacy: h.deps.directory,
    workspaces: { requireCompany: async () => A.companyId, tokenForCompany: async () => slackTokens("a").bot }, fetch: vi.fn(), now: Date.now });
  const first = await factory(A);
  for (let index = 0; index < 50; index++) await factory({ companyId: A.companyId, teamId: `T${index.toString().padStart(8, "0")}` });
  expect(await factory(A)).not.toBe(first);
});

it("company identity mode refuses internal directory calls when workspace dependencies are missing", async () => {
  const h = identityHarness({});
  h.deps.company = {} as NonNullable<typeof h.deps.company>;
  for (const workspace of [undefined, A]) {
    expect(await h.handler({ kind: "channel-members", slackUserId: USER, channelIds: [CHANNEL], ...(workspace === undefined ? {} : { workspace }) } as never))
      .toEqual({ ok: false, error: "slack_unavailable" });
  }
  expect(h.fetch.calls).toHaveLength(0);
});
