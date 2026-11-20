import { afterEach, describe, expect, it, vi } from "vitest";
import { INDEX_EXPIRY_ATTRIBUTE, orgChannelLinkKey, type DocumentStore } from "@agentx/contracts";
import { createSlackPersonResolver } from "../../packages/broker/src/aws/slack-person.js";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { issueChannelLinkCode, redeemChannelLinkCode } from "../../packages/broker/src/core/channel/links.js";
import { dynamoWorld } from "../support/ports/dynamodb-harness.js";
const A = "org_aaaaaaaaaaaaaaaaaaaa";
const B = "org_bbbbbbbbbbbbbbbbbbbb";
const TEAM = "T0AAAAAAA";
const OTHER = "T0BBBBBBB";
const USER = "U0SHARED00";
const PERSON = "web-person";
const native = developerIdForSlackUser(USER);
const NOW = Date.parse("2026-11-15T12:00:00.000Z");
const actor = { channel: "slack", tenant: TEAM, userId: USER };
afterEach(() => vi.restoreAllMocks());
function world() {
  const { store } = dynamoWorld();
  const members = new Map<string, string>();
  const bindings = { requireCompany: async (team: string) => { if (team === TEAM) return A; if (team === OTHER) return B; throw new Error("unavailable"); } };
  const companies = { companyOf: async (person: string) => members.get(person) };
  const deps = { workspaces: bindings, companies, store, now: () => NOW };
  const resolve = createSlackPersonResolver(deps);
  const link = async () => { const code = await issueChannelLinkCode({ store, orgId: A, now: () => NOW }, actor); await redeemChannelLinkCode({ store, orgId: A, now: () => NOW }, PERSON, code.code); };
  return { store, members, deps, resolve, link };
}
describe("one Slack person resolver", () => {
  it("accepts native sign-in only through workspace company membership", async () => {
    const h = world(); h.members.set(native, A);
    expect(await h.resolve({ teamId: TEAM, userId: USER })).toEqual({ kind: "linked", companyId: A, personId: native, via: "signin" });
    expect(await h.resolve({ teamId: OTHER, userId: USER })).toEqual({ kind: "unlinked", companyId: B });
  });
  it("requires membership on the link path and refuses conflicting native and linked people", async () => {
    const h = world(); await h.link();
    expect(await h.resolve({ teamId: TEAM, userId: USER })).toEqual({ kind: "unlinked", companyId: A });
    h.members.set(PERSON, B);
    expect(await h.resolve({ teamId: TEAM, userId: USER })).toEqual({ kind: "unlinked", companyId: A });
    h.members.set(PERSON, A); h.members.set(native, A);
    expect(await h.resolve({ teamId: TEAM, userId: USER })).toEqual({ kind: "unlinked", companyId: A });
  });
  it("treats absent companies, thrown membership and thrown links as unlinked", async () => {
    const h = world();
    expect(await createSlackPersonResolver({ ...h.deps, companies: undefined })({ teamId: TEAM, userId: USER })).toEqual({ kind: "unlinked", companyId: A });
    h.deps.companies.companyOf = async () => { throw new Error("private membership cause"); };
    expect(await h.resolve({ teamId: TEAM, userId: USER })).toEqual({ kind: "unlinked", companyId: A });
    const broken = { ...h.deps, store: { get: async () => { throw new Error("private link cause"); } } as unknown as DocumentStore };
    expect(await createSlackPersonResolver(broken)({ teamId: TEAM, userId: USER })).toEqual({ kind: "unlinked", companyId: A });
  });
});

// Changing a class to member must fail the corresponding policy assertion; adding an action must fail completeness.
describe("Slack action classification", () => {
  it("explicitly classifies every routed press and form, with web-only settings and admin actions", async () => {
    const { SLACK_ACTION_CLASSES, slackActionClass } = await import("../../packages/broker/src/aws/slack-action-classes.js");
    const { ADMIN_CHANGE_PRESSES, ROUTED_SLACK_PRESSES, FORM_SLACK_PRESSES, SLACK_FORM_SUBMISSIONS } = await import("../../packages/broker/src/aws/slack-press-routing.js");
    for (const action of new Set([...ADMIN_CHANGE_PRESSES, ...ROUTED_SLACK_PRESSES, ...FORM_SLACK_PRESSES, ...SLACK_FORM_SUBMISSIONS, "use <model>"])) {
      expect(Object.hasOwn(SLACK_ACTION_CLASSES, action)).toBe(true);
      expect(["member", "admin", "settings"]).toContain(slackActionClass(action));
    }
    for (const action of ADMIN_CHANGE_PRESSES) expect(slackActionClass(action)).toBe("admin");
    for (const action of ["use <model>", "rovara_chatgpt_paste", "rovara_chatgpt_paste_submission", "agentx_task_people", "agentx_task_people_submission", "agentx_task_take_ownership"]) expect(slackActionClass(action)).toBe("settings");
    expect(slackActionClass("agentx_workflow_approve")).toBe("member");
  });
});

it("refuses a TTL on a durable link without falling back to native membership", async () => {
  const h = world(); h.members.set(native, A);
  const core = { store: h.store, orgId: A, now: () => NOW };
  const code = await issueChannelLinkCode(core, actor);
  await redeemChannelLinkCode(core, native, code.code);
  const row = await h.store.get(orgChannelLinkKey(A, actor));
  if (row === undefined) throw new Error("missing durable link fixture");
  expect(Object.hasOwn(row, INDEX_EXPIRY_ATTRIBUTE)).toBe(false);
  expect((await h.resolve({ teamId: TEAM, userId: USER })).kind).toBe("linked");
  await h.store.put({ item: { ...row, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(NOW / 1000) + 3600 } });
  expect((await h.resolve({ teamId: TEAM, userId: USER })).kind).toBe("unlinked");
});

it("redeems a Slack code only for a member of the bound company, once and before expiry", async () => {
  const { createSlackLinkCodes } = await import("../../packages/broker/src/aws/slack-person.js");
  const h = world(); h.members.set(PERSON, A); h.members.set("other-person", B);
  const codes = createSlackLinkCodes(h.deps);
  const issued = await codes.issue({ teamId: TEAM, userId: USER });
  const unknown = "x".repeat(32);
  const errorOf = async (person: string, code: string) => { try { await codes.redeem(person, code); return "accepted"; } catch (e) { return e instanceof Error ? e.message : "error"; } };
  const missing = await errorOf("other-person", unknown);
  expect(await errorOf("other-person", issued.code)).toBe(missing);
  expect(await codes.preview("other-person", issued.code)).toBeUndefined();
  expect(await codes.preview(PERSON, issued.code)).toMatchObject({ channel: "slack", userId: USER });
  expect(await codes.redeem(PERSON, issued.code)).toMatchObject({ developerId: PERSON, actor });
  expect(await errorOf(PERSON, issued.code)).toBe(missing);
  const expired = await codes.issue({ teamId: TEAM, userId: USER });
  const later = createSlackLinkCodes({ ...h.deps, now: () => NOW + 600_000 });
  expect(await later.preview(PERSON, expired.code)).toBeUndefined();
  await expect(later.redeem(PERSON, expired.code)).rejects.toThrow(missing);
});

it("refuses Slack code redemption when the workspace or member reader cannot establish company", async () => {
  const { createSlackLinkCodes } = await import("../../packages/broker/src/aws/slack-person.js");
  const h = world(); h.members.set(PERSON, A);
  const codes = createSlackLinkCodes(h.deps);
  const issued = await codes.issue({ teamId: TEAM, userId: USER });
  const broken = createSlackLinkCodes({ ...h.deps, workspaces: { requireCompany: async () => B } });
  await expect(broken.redeem(PERSON, issued.code)).rejects.toThrow("This link has expired or was already used.");
  h.deps.companies.companyOf = async () => { throw new Error("private membership cause"); };
  expect(await codes.preview(PERSON, issued.code)).toBeUndefined();
  await expect(codes.redeem(PERSON, issued.code)).rejects.toThrow("This link has expired or was already used.");
});


it("refuses a link-code issue whose storage response exceeds the total time budget", async () => {
  const { createSlackLinkCodes } = await import("../../packages/broker/src/aws/slack-person.js");
  const h = world(); let time = NOW;
  const put = h.store.put.bind(h.store);
  vi.spyOn(h.store, "put").mockImplementation(async (request) => {
    const result = await put(request); time += 10_001; return result;
  });
  const codes = createSlackLinkCodes({ ...h.deps, now: () => time });
  let outcome = "accepted";
  try { await codes.issue({ teamId: TEAM, userId: USER }); }
  catch (error) { outcome = error instanceof Error ? error.message : "invalid refusal"; }
  expect(outcome).toBe("This Slack workspace is not available.");
});


it("applies one byte budget across preview and the redemption reread", async () => {
  const { createSlackLinkCodes } = await import("../../packages/broker/src/aws/slack-person.js");
  const h = world(); h.members.set(PERSON, A);
  const issued = await createSlackLinkCodes(h.deps).issue({ teamId: TEAM, userId: USER });
  const get = h.store.get.bind(h.store);
  vi.spyOn(h.store, "get").mockImplementation(async (key) => {
    const row = await get(key); return row === undefined ? undefined : { ...row, [INDEX_EXPIRY_ATTRIBUTE]: "a".repeat(40_000) };
  });
  const writes = vi.spyOn(h.store, "transact");
  const codes = createSlackLinkCodes(h.deps);
  let outcome = "accepted";
  try { await codes.redeem(PERSON, issued.code); }
  catch (error) { outcome = error instanceof Error ? error.message : "invalid refusal"; }
  expect(outcome).toContain("This link has expired or was already used.");
  expect(writes).not.toHaveBeenCalled();
});
