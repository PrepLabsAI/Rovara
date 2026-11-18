// Guided onboarding PR 5: a project's Slack channel, from the web and from `/rovara`. Through the real developer dispatcher, the real binding/link rows, the real sign-in
// Lambda side (slack-install-identity.ts) over a fake Secrets Manager holding each company's own token, a fake slack.com behind the fetch seam, the real interactivity
// handler's signature check and the real front/broker halves of /rovara. Two companies throughout, each with its own workspace.
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { companyRouteHarness, TIME } from "../support/company-route-harness.js";
import { companyMembershipFromDynamo, membershipKey } from "../../packages/broker/src/aws/company-check.js";
import { companyInstallKey } from "../../packages/broker/src/aws/slack-company-install.js";
import { handleSlackInstallRequest, slackInstallSecretsFromSecretsManager, slackInstallThroughLambda } from "../../packages/broker/src/aws/slack-install-identity.js";
import {
  CHANNEL_ARCHIVED, CHANNEL_INVITE, CHANNEL_LINK_NOT_ALLOWED, CHANNEL_NO_TOKEN, CHANNEL_NOT_CONNECTED, CHANNEL_SHARED, CHANNEL_TAKEN, type SlackChannelWiring,
} from "../../packages/broker/src/aws/slack-channel-link.js";
import {
  handleSlackRovara, ROVARA_CHANGED, ROVARA_EXPIRED, ROVARA_INVITE, ROVARA_NO_PROJECTS, ROVARA_NOT_ALLOWED, ROVARA_PROJECT_NOT_FOUND, ROVARA_SIGN_IN_FIRST, rovaraActionKey,
  slackSignInPerson, slackSignInUrlOf, SlackRovaraEventSchema, type SlackRovaraContext,
} from "../../packages/broker/src/aws/slack-rovara-command.js";
import { createRovaraFront, isSlackResponseUrl, ROVARA_LINK_ACTION, ROVARA_UNLINK_ACTION, rovaraRequestOf, runRovaraHandOff, type RovaraHandOff } from "../../packages/broker/src/aws/slack-rovara-front.js";
import { createSlackInteractivityHandler } from "../../packages/broker/src/aws/slack-interactivity.js";
import { COMPANY_A_ID as A, COMPANY_B_ID as B } from "../../packages/testing/src/isolation/two-company.js";

const C = "org_cccccccccccccccccccc";
const projectDefinition = (name: string) => ({
  name, revision: 1, orchestratorInstructions: "x",
  setup: [{ executable: "npm", args: ["ci"], cwd: "repo/r", timeoutSeconds: 900 }], readiness: [{ executable: "npm", args: ["test"], cwd: "repo/r", timeoutSeconds: 900 }],
  repositories: [{ name: "r", url: "https://github.com/acme/r", defaultBranch: "main", path: "repo/r", credentialRef: "github-agentx-sdlc" }],
});
const ACME = "T0ACME"; const BETA = "T0BETA";
const tokenOf = (name: string) => ["xoxb", "200", name].join("-");
const SIGNING = ["sign", "ing", "secret", "for", "tests", "only"].join("-");
const RESPONSE = "https://hooks.slack.com/commands/T0ACME/1/abc";

type Button = { action_id: string; value: string };
type Answer = Record<string, unknown> & { error: { code: string; message: string }; channels: Array<Record<string, unknown>>; text: string; blocks?: Array<{ accessory?: Button; elements?: Button[] }> };
type Channel = { id: string; name: string; is_channel?: boolean; is_group?: boolean; is_private?: boolean; is_member?: boolean; is_archived?: boolean; is_ext_shared?: boolean; context_team_id?: string };

/** slack.com for two workspaces: each token sees only its own workspace's channels, and a private channel only while its bot is in it. */
function fakeSlack() {
  const workspaces: Record<string, Channel[]> = {
    [tokenOf("acme")]: [
      { id: "C0GENERAL", name: "general", is_channel: true, is_member: false },
      { id: "C0BOTIN", name: "builds", is_channel: true, is_member: true },
      { id: "G0PRIV", name: "secret-plans", is_group: true, is_private: true, is_member: false },
      { id: "G0BOTPRIV", name: "core-team", is_group: true, is_private: true, is_member: true },
      { id: "C0SHARED", name: "with-partner", is_channel: true, is_member: true, is_ext_shared: true },
      { id: "C0OLD", name: "old", is_channel: true, is_member: true, is_archived: true },
      { id: "C0CTX", name: "partner-context", is_channel: true, is_member: true, context_team_id: "T0OTHER" },
    ],
    [tokenOf("beta")]: [{ id: "C0BETA", name: "beta-general", is_channel: true, is_member: true }],
  };
  const calls: string[] = [];
  const control = { joinOk: true, listCursor: undefined as string | undefined, fail: false };
  const visible = (token: string) => (workspaces[token] ?? []).filter((channel) => !channel.is_private || channel.is_member);
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const token = (new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /, "");
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    calls.push(`${url.pathname.slice(5)} ${token.slice(9)}${url.searchParams.get("channel") ? ` ${url.searchParams.get("channel")}` : ""}${url.searchParams.get("cursor") ? ` cursor=${url.searchParams.get("cursor")}` : ""}`);
    if (control.fail) return new Response("no", { status: 500 });
    if (workspaces[token] === undefined) return json({ ok: false, error: "invalid_auth" });
    if (url.pathname === "/api/conversations.list") {
      return json({ ok: true, channels: visible(token).filter((channel) => !channel.is_archived), response_metadata: { next_cursor: control.listCursor ?? "" } });
    }
    if (url.pathname === "/api/conversations.info") {
      const channel = visible(token).find((candidate) => candidate.id === url.searchParams.get("channel"));
      return channel === undefined ? json({ ok: false, error: "channel_not_found" }) : json({ ok: true, channel });
    }
    if (url.pathname === "/api/conversations.join") {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { channel: string };
      const channel = visible(token).find((candidate) => candidate.id === body.channel);
      if (channel === undefined || channel.is_private || !control.joinOk) return json({ ok: false, error: "method_not_supported_for_channel_type" });
      channel.is_member = true;
      return json({ ok: true, channel });
    }
    return json({ ok: false, error: "unknown_method" });
  });
  const invite = (channelId: string) => { for (const channel of workspaces[tokenOf("acme")]!) if (channel.id === channelId) channel.is_member = true; };
  return { fetch, calls, control, invite };
}

function fakeSecrets(initial: Record<string, string>) {
  const store = new Map(Object.entries(initial));
  const named = (name: string) => Object.assign(new Error(name), { name });
  return { store, client: { send: async (command: unknown) => {
    const { constructor: { name: kind }, input } = command as { constructor: { name: string }; input: Record<string, unknown> };
    if (kind === "GetSecretValueCommand") { const value = store.get(String(input.SecretId)); if (value === undefined) throw named("ResourceNotFoundException"); return { SecretString: value }; }
    throw new Error(`unexpected ${kind}`);
  } } };
}

function world(options: { installTeam?: string; tokens?: boolean } = {}) {
  const h = companyRouteHarness();
  let now = Date.parse(TIME);
  h.deps.now = () => now;
  const slack = fakeSlack();
  const sm = fakeSecrets(options.tokens === false ? {} : {
    [`agentx/test/slack-workspaces/${A}/${ACME}`]: JSON.stringify({ botToken: tokenOf("acme") }),
    [`agentx/test/slack-workspaces/${B}/${BETA}`]: JSON.stringify({ botToken: tokenOf("beta") }),
  });
  const invoke = async (payload: Uint8Array) => ({ Payload: Buffer.from(JSON.stringify(await handleSlackInstallRequest({ appClient: async () => ({}), secrets: slackInstallSecretsFromSecretsManager(sm.client, "test"), fetch: slack.fetch }, JSON.parse(Buffer.from(payload).toString("utf8"))))) });
  const logs: Array<Record<string, unknown>> = [];
  let seed = 0;
  const wiring: SlackChannelWiring = { slack: slackInstallThroughLambda(invoke), log: (entry) => logs.push(entry), random: (size) => Buffer.alloc(size, ++seed) };
  h.deps.companies = companyMembershipFromDynamo(h.db, "SignIn");
  h.deps.developer.slackChannels = wiring;
  h.db.set({ pk: "SIGNIN_CLIENTS", sk: "CLIENT#web-app", entityType: "SIGN_IN_CLIENT", clientId: "web-app", name: "Web App", audience: "web-app", redirectUris: ["https://app.rovara.test/callback"],
    loopback: false, installLevel: true, secretHash: "f".repeat(64), fullAccess: true, webApp: true, createdAt: TIME, updatedAt: TIME, updatedBy: "admin" });
  h.deps.developer.verifyAccessToken = async (authorization) => JSON.parse(Buffer.from((authorization ?? "").split(".")[1] ?? "", "base64url").toString()) as Record<string, unknown>;
  const installTeam = options.installTeam ?? ACME;
  // Workspaces: A has Acme, B has Beta, C has none.
  const connect = (company: string, team: string, by: string) => {
    h.db.set({ pk: `SLACK_TEAM#${team}`, sk: "BINDING", entityType: "SLACK_WORKSPACE_BINDING", teamId: team, companyId: company, boundAt: TIME, boundBy: by });
    h.db.set({ ...companyInstallKey(company), entityType: "SLACK_COMPANY_WORKSPACE", companyId: company, teamId: team, status: "connected", connectedAt: TIME, connectedBy: by });
  };
  // Projects (names are install-wide; each belongs to one company): A has web and api, B has beta-app.
  const project = (name: string, company: string) => {
    h.db.set({ pk: `PROJECT#${name}`, sk: "REV#000000000001", entityType: "PROJECT", definition: { name, revision: 1 }, companyId: company });
    // DEC 254zzz80 (R2-F1): a NAMED company's project lives in its own partition (the staging layout); that is the one its channel links are checked against.
    h.db.set({ pk: `ORG#${company}#PROJECT#${name}`, sk: "REV#000000000001", entityType: "PROJECT", definition: projectDefinition(name), companyId: company });
    h.db.set({ pk: `ORG#${company}#PROJECT_CATALOG`, sk: `PROJECT#${name}`, entityType: "PROJECT_CATALOG", name, latestRevision: 1, companyId: company });
  };
  project("web", A); project("api", A); project("beta-app", B); project("cee-app", C);
  let sid = 0;
  const people = new Map<string, Record<string, unknown>>();
  /** A person who signed in with Slack as `user` of `team` (#827's subject rule), a live member of `company`. */
  const person = (team: string, user: string, company: string, role: "owner" | "admin" | "member") => {
    const personId = slackSignInPerson(team, user, installTeam);
    const session = `session-${++sid}`;
    h.db.set({ ...membershipKey(personId), entityType: "COMPANY_MEMBERSHIP", personId, companyId: company, role, joinedAt: TIME });
    h.db.set({ pk: `SESSION#${session}`, sk: "META", sessionId: session, developerId: personId, amr: "slack", clientId: "web-app", startedAt: TIME, endsAt: Date.parse(TIME) / 1000 + 86_400 });
    h.db.set({ pk: `DEVELOPER#${personId}`, sk: "META", developerId: personId, provider: "slack", displayName: user, revoked: false });
    people.set(personId, { ...h.claims, azp: "web-app", sub: personId, sid: session });
    return { personId, team, user, company };
  };
  connect(A, ACME, "a".repeat(64)); connect(B, BETA, "b".repeat(64));
  const adminA = person(ACME, "U0ADA", A, "admin");
  const ownerB = person(BETA, "U0BEA", B, "owner");
  const memberA = person(ACME, "U0MEM", A, "member");
  const apiAdminA = person(ACME, "U0API", A, "member");
  h.db.set({ pk: `ORG#${A}#MEMBER#${apiAdminA.personId}`, sk: "PROJECT#api", projectName: "api", role: "administrator" });
  const adminC = person("T0CEE", "U0CEE", C, "admin");
  const jwtOf = (claims: Record<string, unknown>) => { const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url"); return `Bearer ${part({ alg: "none" })}.${part(claims)}.sig`; };
  const call = async (who: { personId: string }, method: string, path: string, body?: unknown) => {
    const answer = await h.read(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }), headers: { authorization: jwtOf(people.get(who.personId)!) } });
    return { status: answer.statusCode, body: JSON.parse(answer.body) as Answer, raw: answer.body };
  };
  const link = (who: { personId: string }, project: string, channelId: string) => call(who, "PUT", `/v1/dev/company/slack/projects/${project}/channel`, { channelId });
  // DEC 254zzz80 (R2-F1): a NAMED company's channel links live in its own partition (Acme is A's workspace, Beta is B's).
  const linkRow = (team: string, channel: string) => h.db.get(`ORG#${team === BETA ? B : A}#SLACK_BINDING#${team}`, `CHANNEL#${channel}`);
  const audits = (company: string) => h.db.find((item) => item.pk === `ORG#${company}#SLACK_CHANNEL_AUDIT`);
  const context = (): SlackRovaraContext => ({ documentClient: h.db, tableName: "State", signInTableName: "SignIn", now: () => now, wiring, installTeamId: installTeam });
  // The Slack side: the real interactivity handler (signature) -> the real front -> (asynchronous half) the real broker half -> the response URL.
  const handOffs: RovaraHandOff[] = [];
  const posted: Array<{ url: string; body: Answer }> = [];
  const interactivity = createSlackInteractivityHandler({ secrets: async () => ({ signingSecret: SIGNING, botToken: tokenOf("install") }), handlers: [], now: () => now,
    rovara: createRovaraFront({ handOff: async (handOff) => { handOffs.push(handOff); } }) });
  const signed = (body: string, at = Math.floor(now / 1000), secret = SIGNING) => ({ rawPath: "/v1/slack/interactions", body, isBase64Encoded: false,
    headers: { "x-slack-request-timestamp": String(at), "x-slack-signature": `v0=${createHmac("sha256", secret).update(`v0:${at}:${body}`).digest("hex")}` } });
  const runHandOffs = async () => {
    for (const handOff of handOffs.splice(0)) {
      await runRovaraHandOff({ invokeBroker: async (event) => ({ statusCode: 200, body: JSON.stringify({ ...await handleSlackRovara(context(), SlackRovaraEventSchema.parse(event)), requestId: "x" }) }),
        post: async (url, body) => { posted.push({ url, body: body as Answer }); } }, handOff);
    }
    return posted.splice(0);
  };
  const slash = async (who: { team: string; user: string }, text: string, channel = "C0GENERAL") => {
    const body = new URLSearchParams({ command: "/rovara", text, team_id: who.team, user_id: who.user, channel_id: channel, response_url: RESPONSE, trigger_id: "1.2.3" }).toString();
    const answer = await interactivity(signed(body));
    expect(answer).toMatchObject({ statusCode: 200, body: "" });
    const [reply] = await runHandOffs();
    return reply!.body;
  };
  const press = async (who: { team: string; user: string; userTeam?: string }, actionId: string, token: string, channel = "C0GENERAL") => {
    const payload = { type: "block_actions", team: { id: who.team }, user: { id: who.user, team_id: who.userTeam ?? who.team }, channel: { id: channel }, response_url: RESPONSE,
      actions: [{ action_id: actionId, value: token, type: "button" }] };
    const answer = await interactivity(signed(new URLSearchParams({ payload: JSON.stringify(payload) }).toString()));
    expect(answer.statusCode).toBe(200);
    const [reply] = await runHandOffs();
    return reply?.body;
  };
  const buttons = (body: Answer): Button[] => (body.blocks ?? []).flatMap((block) => [...(block.accessory ? [block.accessory] : []), ...(block.elements ?? [])]);
  return { ...h, slack, sm, wiring, logs, adminA, ownerB, memberA, apiAdminA, adminC, call, link, linkRow, audits, context, interactivity, signed, handOffs, runHandOffs, slash, press, buttons, person,
    tick: (ms: number) => { now += ms; } };
}

describe("web: link a project's channel", () => {
  it("joins a public channel and writes exactly the CLI's link row, with an audit row naming the person", async () => {
    const w = world();
    const answer = await w.link(w.adminA, "web", "C0GENERAL");
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ status: "linked", workspace: { teamId: ACME }, channel: { id: "C0GENERAL", name: "general", isPrivate: false }, alreadyLinked: false, replaced: [] });
    expect(w.slack.calls).toEqual(["conversations.info acme C0GENERAL", "conversations.join acme"]);
    // Golden: the row the CLI's `agentx admin slack bind` writes (broker.ts putSlackBinding), with the person as updatedBy.
    expect(w.linkRow(ACME, "C0GENERAL")).toEqual({ pk: `ORG#${A}#SLACK_BINDING#${ACME}`, sk: "CHANNEL#C0GENERAL", entityType: "SLACK_BINDING", teamId: ACME, channelId: "C0GENERAL", projectName: "web", updatedAt: TIME, updatedBy: w.adminA.personId });
    expect(w.audits(A)).toEqual([expect.objectContaining({ entityType: "SLACK_CHANNEL_AUDIT", action: "link", actor: w.adminA.personId, via: "web", projectName: "web", channelId: "C0GENERAL", teamId: ACME, companyId: A })]);
    expect(w.audits(B)).toEqual([]);
    expect(w.logs).toEqual([expect.objectContaining({ event: "slack.channel_linked", companyId: A, channelId: "C0GENERAL", actor: w.adminA.personId })]);
    expect(JSON.stringify(w.logs) + answer.raw).not.toContain("xoxb");
  });

  it("DEC 254zzz80: a NAMED company's project is its own partition's: a project only in the legacy layout (even stamped with A) is not A's", async () => {
    const w = world();
    w.db.delete(`ORG#${A}#PROJECT#web`, "REV#000000000001");
    const answer = await w.link(w.adminA, "web", "C0GENERAL");
    expect(answer.status).toBe(404);
    expect(w.db.find((item) => String(item.pk).includes("SLACK_BINDING#"))).toEqual([]);
    expect(w.slack.calls).toEqual([]);
  });

  it("DEC 254zzz80: a link row in A's partition that names another company is unreadable, never A's link", async () => {
    const w = world();
    w.db.set({ pk: `ORG#${A}#SLACK_BINDING#${ACME}`, sk: "CHANNEL#C0GENERAL", entityType: "SLACK_BINDING", teamId: ACME, channelId: "C0GENERAL", projectName: "web", updatedAt: TIME, companyId: B });
    const answer = await w.link(w.adminA, "web", "C0GENERAL");
    expect(answer.status).not.toBe(200);
    expect(answer.body.error.code).toBe("RUNTIME_UNAVAILABLE");
  });

  it("two companies: A's admin can't link a channel of B's workspace, and the body can't name a workspace", async () => {
    const w = world();
    const answer = await w.link(w.adminA, "web", "C0BETA");
    // A's own token is asked (never B's), and Slack doesn't show it the channel: nothing is linked, and the answer names nothing of B.
    expect(answer.body).toMatchObject({ status: "invite_needed", workspace: { teamId: ACME }, channel: { id: "C0BETA" }, message: CHANNEL_INVITE });
    expect(w.slack.calls).toEqual(["conversations.info acme C0BETA"]);
    expect(w.db.find((item) => String(item.pk).includes("SLACK_BINDING#"))).toEqual([]);
    expect(answer.raw).not.toContain("beta-general");
    const named = await w.call(w.adminA, "PUT", "/v1/dev/company/slack/projects/web/channel", { channelId: "C0BETA", teamId: BETA });
    expect(named.status).toBe(400);
    // B's admin can't link A's project, which answers exactly as a missing one.
    const foreign = await w.link(w.ownerB, "web", "C0BETA");
    const missing = await w.link(w.ownerB, "nope", "C0BETA");
    expect(foreign.status).toBe(404);
    expect(foreign.body.error).toEqual(missing.body.error);
    expect(w.db.find((item) => String(item.pk).includes("SLACK_BINDING#"))).toEqual([]);
    // B links its own channel, through its own token only.
    expect((await w.link(w.ownerB, "beta-app", "C0BETA")).body).toMatchObject({ status: "linked", workspace: { teamId: BETA } });
    expect(w.slack.calls.filter((line) => line.includes(" beta"))).toEqual(["conversations.info beta C0BETA"]);
  });

  it("a member is refused; a project admin may link only their own project", async () => {
    const w = world();
    expect(await w.link(w.memberA, "web", "C0GENERAL")).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN", message: CHANNEL_LINK_NOT_ALLOWED } } });
    expect(await w.link(w.apiAdminA, "web", "C0GENERAL")).toMatchObject({ status: 403 });
    expect((await w.link(w.apiAdminA, "api", "C0GENERAL")).body).toMatchObject({ status: "linked" });
    expect(w.slack.calls).toEqual(["conversations.info acme C0GENERAL", "conversations.join acme"]);
  });

  it("a project admin's grant must be in the caller's company", async () => {
    const w = world();
    // DEC 254zzz80: a row in A's own partition that names company B, one in B's partition, and a legacy row: none is A's grant.
    w.db.set({ pk: `ORG#${A}#MEMBER#${w.memberA.personId}`, sk: "PROJECT#web", projectName: "web", role: "administrator", companyId: B });
    expect((await w.link(w.memberA, "web", "C0GENERAL")).status).toBe(403);
    w.db.delete(`ORG#${A}#MEMBER#${w.memberA.personId}`, "PROJECT#web");
    w.db.set({ pk: `ORG#${B}#MEMBER#${w.memberA.personId}`, sk: "PROJECT#web", projectName: "web", role: "administrator" });
    expect((await w.link(w.memberA, "web", "C0GENERAL")).status).toBe(403);
    w.db.set({ pk: `MEMBER#${w.memberA.personId}`, sk: "PROJECT#web", projectName: "web", role: "administrator", companyId: A });
    expect((await w.link(w.memberA, "web", "C0GENERAL")).status).toBe(403);
  });

  it("a project grant that is not administrator does not let a member link", async () => {
    const w = world();
    w.db.set({ pk: `ORG#${A}#MEMBER#${w.memberA.personId}`, sk: "PROJECT#web", projectName: "web", role: "developer" });
    expect((await w.link(w.memberA, "web", "C0GENERAL")).status).toBe(403);
    expect(w.slack.calls).toEqual([]);
  });

  it("a channel Slack shows as private without the bot is never joined: invite_needed", async () => {
    const w = world();
    const join = vi.fn(async () => true);
    w.wiring.slack = { ...w.wiring.slack, channel: async () => ({ id: "G0PRIV", name: "secret-plans", isPrivate: true, isMember: false, isArchived: false, isShared: false }), join };
    expect((await w.link(w.adminA, "web", "G0PRIV")).body).toMatchObject({ status: "invite_needed" });
    expect(join).not.toHaveBeenCalled();
    expect(w.linkRow(ACME, "G0PRIV")).toBeUndefined();
  });

  it("a channel seen from another workspace's context counts as shared", async () => {
    const w = world();
    expect(await w.link(w.adminA, "web", "C0CTX")).toMatchObject({ status: 409, body: { error: { message: CHANNEL_SHARED } } });
  });

  it("the role is read live: a demoted admin is refused at once", async () => {
    const w = world();
    w.db.set({ ...membershipKey(w.adminA.personId), entityType: "COMPANY_MEMBERSHIP", personId: w.adminA.personId, companyId: A, role: "member", joinedAt: TIME });
    expect((await w.link(w.adminA, "web", "C0GENERAL")).status).toBe(403);
  });

  it("a private channel the bot isn't in answers invite_needed; after /invite, Check links it", async () => {
    const w = world();
    expect((await w.link(w.adminA, "web", "G0PRIV")).body).toMatchObject({ status: "invite_needed", channel: { id: "G0PRIV" }, message: CHANNEL_INVITE });
    expect(w.linkRow(ACME, "G0PRIV")).toBeUndefined();
    w.slack.invite("G0PRIV");
    const checked = await w.call(w.adminA, "POST", "/v1/dev/company/slack/projects/web/channel/check", { channelId: "G0PRIV" });
    expect(checked.body).toMatchObject({ status: "linked", channel: { id: "G0PRIV", name: "secret-plans", isPrivate: true } });
    expect(w.slack.calls.filter((line) => line.startsWith("conversations.join"))).toEqual([]);
  });

  it("first wins: a channel linked to another project is refused and never overwritten", async () => {
    const w = world();
    await w.link(w.adminA, "web", "C0BOTIN");
    const before = w.linkRow(ACME, "C0BOTIN");
    const calls = w.slack.calls.length;
    expect(await w.link(w.adminA, "api", "C0BOTIN")).toMatchObject({ status: 409, body: { error: { code: "SLACK_CHANNEL_TAKEN", message: CHANNEL_TAKEN } } });
    expect(w.linkRow(ACME, "C0BOTIN")).toEqual(before);
    // Refused before Slack is asked anything.
    expect(w.slack.calls).toHaveLength(calls);
    // Linking it again to its own project changes nothing.
    expect((await w.link(w.adminA, "web", "C0BOTIN")).body).toMatchObject({ status: "linked", alreadyLinked: true });
    expect(w.audits(A)).toHaveLength(1);
  });

  it("first wins under a race: another project's link landing before the write is refused (conditional write)", async () => {
    const w = world();
    const send = w.db.send.bind(w.db);
    w.db.send = (async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === "TransactWriteCommand") w.db.set({ pk: `ORG#${A}#SLACK_BINDING#${ACME}`, sk: "CHANNEL#C0BOTIN", entityType: "SLACK_BINDING", teamId: ACME, channelId: "C0BOTIN", projectName: "api", updatedAt: TIME });
      return send(command as never);
    });
    expect(await w.link(w.adminA, "web", "C0BOTIN")).toMatchObject({ status: 409, body: { error: { code: "SLACK_CHANNEL_TAKEN" } } });
    expect(w.linkRow(ACME, "C0BOTIN")?.projectName).toBe("api");
    expect(w.audits(A)).toEqual([]);
  });

  it("a disconnect landing before the write links nothing (the team binding is checked in the same transaction)", async () => {
    const w = world();
    const send = w.db.send.bind(w.db);
    w.db.send = (async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === "TransactWriteCommand") w.db.delete(`SLACK_TEAM#${ACME}`, "BINDING");
      return send(command as never);
    });
    expect((await w.link(w.adminA, "web", "C0BOTIN")).status).toBe(503);
    expect(w.linkRow(ACME, "C0BOTIN")).toBeUndefined();
  });

  it("refuses shared and archived channels, and a company with no connected workspace or no token", async () => {
    const w = world();
    expect(await w.link(w.adminA, "web", "C0SHARED")).toMatchObject({ status: 409, body: { error: { code: "SLACK_CHANNEL_REFUSED", message: CHANNEL_SHARED } } });
    expect(await w.link(w.adminA, "web", "C0OLD")).toMatchObject({ status: 409, body: { error: { message: CHANNEL_ARCHIVED } } });
    expect(await w.link(w.adminC, "cee-app", "C0GENERAL")).toMatchObject({ status: 409, body: { error: { code: "SLACK_NOT_CONNECTED", message: CHANNEL_NOT_CONNECTED } } });
    w.db.set({ ...companyInstallKey(A), entityType: "SLACK_COMPANY_WORKSPACE", companyId: A, teamId: ACME, status: "disconnected", connectedAt: TIME, connectedBy: "a".repeat(64) });
    expect(await w.link(w.adminA, "web", "C0GENERAL")).toMatchObject({ status: 409, body: { error: { code: "SLACK_NOT_CONNECTED" } } });
    const none = world({ tokens: false });
    expect(await none.link(none.adminA, "web", "C0GENERAL")).toMatchObject({ status: 409, body: { error: { message: CHANNEL_NO_TOKEN } } });
    // A binding naming another company is not this company's workspace, whatever its own record says.
    const crossed = world();
    crossed.db.set({ pk: `SLACK_TEAM#${ACME}`, sk: "BINDING", entityType: "SLACK_WORKSPACE_BINDING", teamId: ACME, companyId: B, boundAt: TIME, boundBy: "b".repeat(64) });
    expect(await crossed.link(crossed.adminA, "web", "C0GENERAL")).toMatchObject({ status: 409, body: { error: { code: "SLACK_NOT_CONNECTED" } } });
    expect(crossed.slack.calls).toEqual([]);
  });

  it("Slack failing is a 503 and writes nothing", async () => {
    const w = world();
    w.slack.control.fail = true;
    expect((await w.link(w.adminA, "web", "C0GENERAL")).status).toBe(503);
    w.slack.control.fail = false; w.slack.control.joinOk = false;
    expect((await w.link(w.adminA, "web", "C0GENERAL")).status).toBe(503);
    expect(w.linkRow(ACME, "C0GENERAL")).toBeUndefined();
  });

  it("changing the channel unlinks the project's old one in the same transaction", async () => {
    const w = world();
    await w.link(w.adminA, "web", "C0GENERAL");
    expect((await w.link(w.adminA, "web", "C0BOTIN")).body).toMatchObject({ status: "linked", replaced: ["C0GENERAL"] });
    expect(w.linkRow(ACME, "C0GENERAL")).toBeUndefined();
    expect(w.linkRow(ACME, "C0BOTIN")?.projectName).toBe("web");
  });
});

describe("web: read, unlink and the picker", () => {
  it("unlink removes only the link row, as the CLI's unbind: existing threads keep working", async () => {
    const w = world();
    await w.link(w.adminA, "web", "C0BOTIN");
    // A thread already running in the channel: its workspace and thread records are not the link's.
    const thread = { pk: "WORKSPACE#3f0c", sk: "META", entityType: "WORKSPACE", teamId: ACME, channelId: "C0BOTIN", threadTs: "1.2", project: "web" };
    w.db.set(thread);
    const before = new Map(w.db.items);
    const answer = await w.call(w.adminA, "DELETE", "/v1/dev/company/slack/projects/web/channel");
    expect(answer.body).toMatchObject({ status: "unlinked", teamId: ACME, channels: ["C0BOTIN"] });
    const removed = [...before.keys()].filter((key) => !w.db.items.has(key));
    const added = [...w.db.items.keys()].filter((key) => !before.has(key));
    expect(removed).toEqual([[...before.keys()].find((key) => key.includes("CHANNEL#C0BOTIN"))]);
    expect(added.every((key) => key.includes("SLACK_CHANNEL_AUDIT"))).toBe(true);
    expect(w.db.get("WORKSPACE#3f0c", "META")).toEqual(thread);
    expect(w.audits(A).map((row) => row.action).sort()).toEqual(["link", "unlink"]);
    expect(await w.call(w.adminA, "DELETE", "/v1/dev/company/slack/projects/web/channel")).toMatchObject({ status: 404 });
    expect((await w.call(w.memberA, "DELETE", "/v1/dev/company/slack/projects/web/channel")).status).toBe(403);
  });

  it("any member reads their own company's project channel; another company gets 404", async () => {
    const w = world();
    await w.link(w.adminA, "web", "C0BOTIN");
    expect((await w.call(w.memberA, "GET", "/v1/dev/company/slack/projects/web/channel")).body).toMatchObject({ workspace: { teamId: ACME }, channels: [{ channelId: "C0BOTIN" }] });
    expect((await w.call(w.ownerB, "GET", "/v1/dev/company/slack/projects/web/channel")).status).toBe(404);
    expect((await w.call(w.adminC, "GET", "/v1/dev/company/slack/projects/cee-app/channel")).body).toMatchObject({ workspace: null, channels: [] });
  });

  it("the picker lists only the company's own workspace, public plus private-the-bot-is-in, and marks links", async () => {
    const w = world();
    await w.link(w.adminA, "api", "C0BOTIN");
    w.slack.calls.length = 0;
    w.slack.control.listCursor = "dGVhbTpDMEJPVElO";
    const answer = await w.call(w.adminA, "GET", "/v1/dev/company/slack/channels?project=web");
    expect(answer.body).toEqual({ workspace: { teamId: ACME }, nextCursor: "dGVhbTpDMEJPVElO", requestId: "company-test", channels: [
      { id: "C0GENERAL", name: "general", isPrivate: false },
      { id: "C0BOTIN", name: "builds", isPrivate: false, linked: true, linkedProject: "api" },
      { id: "G0BOTPRIV", name: "core-team", isPrivate: true },
    ] });
    expect(w.slack.calls).toEqual(["conversations.list acme"]);
    await w.call(w.adminA, "GET", "/v1/dev/company/slack/channels?project=web&cursor=dGVhbTpDMEJPVElO");
    expect(w.slack.calls.at(-1)).toBe("conversations.list acme cursor=dGVhbTpDMEJPVElO");
    expect((await w.call(w.adminA, "GET", "/v1/dev/company/slack/channels?project=web&cursor=%3Cx%3E")).status).toBe(400);
    expect((await w.call(w.memberA, "GET", "/v1/dev/company/slack/channels?project=web")).status).toBe(403);
    expect((await w.call(w.ownerB, "GET", "/v1/dev/company/slack/channels?project=web")).status).toBe(404);
    const b = await w.call(w.ownerB, "GET", "/v1/dev/company/slack/channels?project=beta-app");
    expect(b.body.channels).toEqual([{ id: "C0BETA", name: "beta-general", isPrivate: false }]);
  });

  it("names a linked project only when it is this company's", async () => {
    const w = world();
    w.db.set({ pk: `ORG#${A}#SLACK_BINDING#${ACME}`, sk: "CHANNEL#C0GENERAL", entityType: "SLACK_BINDING", teamId: ACME, channelId: "C0GENERAL", projectName: "beta-app", updatedAt: TIME });
    const answer = await w.call(w.adminA, "GET", "/v1/dev/company/slack/channels?project=web");
    expect(answer.body.channels[0]).toEqual({ id: "C0GENERAL", name: "general", isPrivate: false, linked: true });
    expect(answer.raw).not.toContain("beta-app");
  });
});

describe("/rovara in Slack", () => {
  it("refuses a forged, wrong-secret or old signature before anything is read or handed on", async () => {
    const w = world();
    const body = new URLSearchParams({ command: "/rovara", text: "link", team_id: ACME, user_id: "U0ADA", channel_id: "C0GENERAL", response_url: RESPONSE }).toString();
    const now = Math.floor(Date.parse(TIME) / 1000);
    for (const event of [w.signed(body, now, "wrong-secret-wrong-secret"), w.signed(body, now - 301), w.signed(body, now + 301), { ...w.signed(body), body: body.replace("link", "unlink") },
      { ...w.signed(body), headers: { "x-slack-request-timestamp": String(now) } }]) {
      expect((await w.interactivity(event as never)).statusCode).toBe(401);
    }
    expect(w.handOffs).toEqual([]);
    expect((await w.interactivity(w.signed(body, now - 299) as never)).statusCode).toBe(200);
    expect(w.handOffs).toHaveLength(1);
  });

  it("acks at once with an empty answer and hands on only the verified fields", async () => {
    const w = world();
    const body = new URLSearchParams({ command: "/rovara", text: "status", team_id: ACME, user_id: "U0ADA", channel_id: "C0BOTIN", response_url: RESPONSE, enterprise_id: "E0X", api_app_id: "A0" }).toString();
    expect(await w.interactivity(w.signed(body) as never)).toEqual({ statusCode: 200, headers: {}, body: "" });
    expect(w.handOffs).toEqual([{ source: "agentx.slack-rovara-handoff", responseUrl: RESPONSE, event: { source: "agentx.slack-rovara", kind: "command", teamId: ACME, userId: "U0ADA", channelId: "C0BOTIN", text: "status" } }]);
    // Only Slack's own response URLs.
    const evil = new URLSearchParams({ command: "/rovara", text: "status", team_id: ACME, user_id: "U0ADA", channel_id: "C0BOTIN", response_url: "https://evil.test/x" }).toString();
    expect(JSON.parse((await w.interactivity(w.signed(evil) as never)).body)).toMatchObject({ response_type: "ephemeral" });
    expect(w.handOffs).toHaveLength(1);
    expect(isSlackResponseUrl("https://hooks.slack.com.evil.test/x")).toBe(false);
    expect(isSlackResponseUrl("http://hooks.slack.com/x")).toBe(false);
  });

  it("with no name, A's admin gets a menu of A's projects only, each with its own single-use Link", async () => {
    const w = world();
    const menu = await w.slash(w.adminA, "link");
    expect(menu).toMatchObject({ response_type: "ephemeral", replace_original: false });
    const text = JSON.stringify(menu);
    expect(text).toContain("*api*"); expect(text).toContain("*web*");
    expect(text).not.toContain("beta-app"); expect(text).not.toContain("cee-app");
    const links = w.buttons(menu);
    expect(links.map((b) => b.action_id)).toEqual([ROVARA_LINK_ACTION, ROVARA_LINK_ACTION]);
    expect(new Set(links.map((b) => b.value)).size).toBe(2);
    // Only the hash is stored, bound to company, team, channel, Slack user, person, project and action.
    const row = w.db.get(rovaraActionKey(links[1]!.value).pk, "META")!;
    expect(row).toMatchObject({ entityType: "SLACK_ROVARA_ACTION", status: "live", action: "link", companyId: A, teamId: ACME, channelId: "C0GENERAL", userId: "U0ADA", personId: w.adminA.personId, projectName: "web" });
    expect(JSON.stringify(w.db.find((item) => item.entityType === "SLACK_ROVARA_ACTION"))).not.toContain(links[1]!.value);
  });

  it("/rovara from B's team never lists A's projects, and A's project name resolves only inside A", async () => {
    const w = world();
    const menu = await w.slash({ team: BETA, user: "U0BEA" }, "link", "C0BETA");
    expect(JSON.stringify(menu)).toContain("*beta-app*");
    expect(JSON.stringify(menu)).not.toMatch(/\*web\*|\*api\*/);
    const foreign = await w.slash({ team: BETA, user: "U0BEA" }, "link web", "C0BETA");
    const missing = await w.slash({ team: BETA, user: "U0BEA" }, "link nope", "C0BETA");
    expect(foreign).toEqual(missing);
    expect(foreign.text).toBe(ROVARA_PROJECT_NOT_FOUND);
    expect(w.db.find((item) => item.entityType === "SLACK_ROVARA_ACTION" && item.projectName === "web")).toEqual([]);
  });

  it("no Rovara account, an unbound team, or a person outside the team's company: Sign in first, no project names", async () => {
    const w = world();
    const outsider = await w.slash({ team: ACME, user: "U0NOBODY" }, "link");
    const unbound = await w.slash({ team: "T0NOWHERE", user: "U0ADA" }, "link web");
    // B's owner, from A's workspace with B's own Slack user id: a different subject, and not A's member.
    const other = await w.slash({ team: ACME, user: "U0BEA" }, "link");
    // A's admin's Slack user id in B's workspace is another person (`<team>:<user>`, #827).
    const sameIdOtherTeam = await w.slash({ team: BETA, user: "U0ADA" }, "link", "C0BETA");
    for (const answer of [outsider, unbound, other, sameIdOtherTeam]) {
      expect(answer).toEqual({ response_type: "ephemeral", replace_original: false, text: ROVARA_SIGN_IN_FIRST });
    }
    expect(w.db.find((item) => item.entityType === "SLACK_ROVARA_ACTION")).toEqual([]);
    // A removed member is outside too.
    w.db.set({ ...membershipKey(w.memberA.personId), entityType: "COMPANY_MEMBERSHIP", personId: w.memberA.personId, companyId: A, role: "member", joinedAt: TIME, revokedAt: TIME });
    expect((await w.slash(w.memberA, "status")).text).toBe(ROVARA_SIGN_IN_FIRST);
    const linked = { ...w.context(), signInUrl: "https://app.rovara.test/" };
    expect((await handleSlackRovara(linked, { source: "agentx.slack-rovara", kind: "command", teamId: ACME, userId: "U0NOBODY", channelId: "C0GENERAL", text: "link" })).text)
      .toBe(`${ROVARA_SIGN_IN_FIRST} <https://app.rovara.test/|Open Rovara>`);
    expect(slackSignInUrlOf("https://app.rovara.test/|x")).toBeUndefined();
    expect(slackSignInUrlOf("http://app.rovara.test/")).toBeUndefined();
  });

  it("a foreign workspace's user with the same id as a member's install-workspace id is not that member", async () => {
    const w = world();
    // B's member signed in from the install's workspace (Acme) as U0TWIN; someone in Beta also has the id U0TWIN.
    const twin = w.person(ACME, "U0TWIN", B, "owner");
    expect(twin.personId).toBe(slackSignInPerson(ACME, "U0TWIN", ACME));
    expect((await w.slash({ team: BETA, user: "U0TWIN" }, "link", "C0BETA")).text).toBe(ROVARA_SIGN_IN_FIRST);
  });

  it("an install-workspace Slack user who is another company's member is outside this team's company", async () => {
    const w = world();
    w.person(ACME, "U0TWIN", B, "owner");
    expect((await w.slash({ team: ACME, user: "U0TWIN" }, "link")).text).toBe(ROVARA_SIGN_IN_FIRST);
    expect(w.db.find((item) => item.entityType === "SLACK_ROVARA_ACTION")).toEqual([]);
  });

  it("a press after the workspace moved to another company (with the same person moved too) changes nothing", async () => {
    const w = world();
    const value = w.buttons(await w.slash(w.adminA, "link web"))[0]!.value;
    w.db.set({ pk: `SLACK_TEAM#${ACME}`, sk: "BINDING", entityType: "SLACK_WORKSPACE_BINDING", teamId: ACME, companyId: B, boundAt: TIME, boundBy: "b".repeat(64) });
    w.db.set({ ...membershipKey(w.adminA.personId), entityType: "COMPANY_MEMBERSHIP", personId: w.adminA.personId, companyId: B, role: "admin", joinedAt: TIME });
    expect((await w.press(w.adminA, ROVARA_LINK_ACTION, value))!.text).toBe(ROVARA_EXPIRED);
  });

  it("the menu never offers a project of another company, even with a stray grant stamped with this company", async () => {
    const w = world();
    w.db.set({ pk: `ORG#${A}#MEMBER#${w.apiAdminA.personId}`, sk: "PROJECT#beta-app", projectName: "beta-app", role: "administrator" });
    const menu = await w.slash(w.apiAdminA, "link");
    expect(JSON.stringify(menu)).toContain("*api*");
    expect(JSON.stringify(menu)).not.toContain("beta-app");
  });

  it("a removed person (their record revoked) is outside", async () => {
    const w = world();
    w.db.set({ pk: `DEVELOPER#${w.adminA.personId}`, sk: "META", developerId: w.adminA.personId, provider: "slack", displayName: "x", revoked: true });
    expect((await w.slash(w.adminA, "link")).text).toBe(ROVARA_SIGN_IN_FIRST);
    w.db.delete(`DEVELOPER#${w.adminA.personId}`, "META");
    expect((await w.slash(w.adminA, "link")).text).toBe(ROVARA_SIGN_IN_FIRST);
  });

  it("the install's own workspace signs in as <user>, any other as <team>:<user>", () => {
    expect(slackSignInPerson(ACME, "U0ADA", ACME)).not.toBe(slackSignInPerson(BETA, "U0ADA", ACME));
    expect(slackSignInPerson(BETA, "U0ADA", ACME)).toBe(slackSignInPerson(BETA, "U0ADA", undefined));
    expect(slackSignInPerson(ACME, "U0ADA", undefined)).not.toBe(slackSignInPerson(ACME, "U0ADA", ACME));
  });

  it("Link press links; a replayed press is refused and changes nothing", async () => {
    const w = world();
    const confirm = await w.slash(w.adminA, "link web");
    expect(confirm.text).toBe("Link <#C0GENERAL> to *web*?");
    const [button] = w.buttons(confirm);
    const done = await w.press(w.adminA, ROVARA_LINK_ACTION, button!.value);
    expect(done).toMatchObject({ response_type: "ephemeral", replace_original: true, text: "Linked <#C0GENERAL> to *web*. Mention @Rovara here to start work." });
    expect(w.linkRow(ACME, "C0GENERAL")).toMatchObject({ projectName: "web", updatedBy: w.adminA.personId });
    expect(w.audits(A)).toEqual([expect.objectContaining({ action: "link", via: "slack", actor: w.adminA.personId })]);
    w.db.delete(`ORG#${A}#SLACK_BINDING#${ACME}`, "CHANNEL#C0GENERAL");
    expect((await w.press(w.adminA, ROVARA_LINK_ACTION, button!.value))!.text).toBe(ROVARA_EXPIRED);
    expect(w.linkRow(ACME, "C0GENERAL")).toBeUndefined();
    expect(w.audits(A)).toHaveLength(1);
  });

  it("a press is bound to its team, channel, Slack user, action and 10 minutes", async () => {
    const w = world();
    const fresh = async () => w.buttons(await w.slash(w.adminA, "link web"))[0]!.value;
    const other = w.person(ACME, "U0ADB", A, "admin");
    expect((await w.press(other, ROVARA_LINK_ACTION, await fresh()))!.text).toBe(ROVARA_EXPIRED);
    expect((await w.press(w.adminA, ROVARA_LINK_ACTION, await fresh(), "C0BOTIN"))!.text).toBe(ROVARA_EXPIRED);
    expect((await w.press(w.adminA, ROVARA_UNLINK_ACTION, await fresh()))!.text).toBe(ROVARA_EXPIRED);
    expect((await w.press({ ...w.adminA, userTeam: BETA }, ROVARA_LINK_ACTION, await fresh()))).toBeUndefined();
    const late = await fresh();
    w.tick(600_001);
    expect((await w.press(w.adminA, ROVARA_LINK_ACTION, late))!.text).toBe(ROVARA_EXPIRED);
    expect((await w.press(w.adminA, ROVARA_LINK_ACTION, "A".repeat(43)))!.text).toBe(ROVARA_EXPIRED);
    expect(w.linkRow(ACME, "C0GENERAL")).toBeUndefined();
  });

  it("a press from another team leaves the token unspent; tokens carry no TTL attribute and are deleted when spent", async () => {
    const w = world();
    const value = w.buttons(await w.slash(w.adminA, "link web"))[0]!.value;
    expect(w.db.get(rovaraActionKey(value).pk, "META")).toMatchObject({ expiresAt: Math.floor(Date.parse(TIME) / 1000) + 600 });
    expect(w.db.get(rovaraActionKey(value).pk, "META")).not.toHaveProperty("indexExpiresAt");
    expect((await w.press({ team: BETA, user: "U0ADA" }, ROVARA_LINK_ACTION, value))!.text).toBe(ROVARA_EXPIRED);
    expect(w.db.get(rovaraActionKey(value).pk, "META")).toMatchObject({ status: "live" });
    expect((await w.press(w.adminA, ROVARA_LINK_ACTION, value))!.text).toContain("Linked <#C0GENERAL> to *web*");
    // Spent: the row is gone.
    expect(w.db.get(rovaraActionKey(value).pk, "META")).toBeUndefined();
  });

  it("two presses of one token at once: exactly one links", async () => {
    const w = world();
    const token = w.buttons(await w.slash(w.adminA, "link web"))[0]!.value;
    const press = { source: "agentx.slack-rovara" as const, kind: "press" as const, teamId: ACME, userId: "U0ADA", channelId: "C0GENERAL", action: "link" as const, token };
    const answers = await Promise.all([handleSlackRovara(w.context(), press), handleSlackRovara(w.context(), press)]);
    expect(answers.map((answer) => answer.text).sort()).toEqual([ROVARA_EXPIRED, "Linked <#C0GENERAL> to *web*. Mention @Rovara here to start work."].sort());
    expect(w.audits(A)).toHaveLength(1);
  });

  it("a token is refused one second after its 10 minutes, and accepted just before", async () => {
    const w = world();
    const early = w.buttons(await w.slash(w.adminA, "link web"))[0]!.value;
    w.tick(599_000);
    expect((await w.press(w.adminA, ROVARA_LINK_ACTION, early))!.text).toContain("Linked");
    const w2 = world();
    const late = w2.buttons(await w2.slash(w2.adminA, "link web"))[0]!.value;
    w2.tick(600_000);
    expect((await w2.press(w2.adminA, ROVARA_LINK_ACTION, late))!.text).toBe(ROVARA_EXPIRED);
    expect(w2.db.get(rovaraActionKey(late).pk, "META")).toMatchObject({ status: "live" });
  });

  it("a press from a workspace that isn't the company's connected one links nothing", async () => {
    const w = world();
    // An older, operator-bound workspace of the same company.
    w.db.set({ pk: "SLACK_TEAM#T0LEGACY", sk: "BINDING", entityType: "SLACK_WORKSPACE_BINDING", teamId: "T0LEGACY", companyId: A, boundAt: TIME, boundBy: "operator" });
    const legacy = w.person("T0LEGACY", "U0LEG", A, "admin");
    const value = w.buttons(await w.slash(legacy, "link web"))[0]!.value;
    expect((await w.press(legacy, ROVARA_LINK_ACTION, value))!.text).toBe(CHANNEL_NOT_CONNECTED);
    expect(w.db.find((item) => String(item.pk).includes("SLACK_BINDING#"))).toEqual([]);
  });

  it("a legacy link naming another company's project reads as unlinked", async () => {
    const w = world();
    w.db.set({ pk: `ORG#${A}#SLACK_BINDING#${ACME}`, sk: "CHANNEL#C0BOTIN", entityType: "SLACK_BINDING", teamId: ACME, channelId: "C0BOTIN", projectName: "beta-app", updatedAt: TIME });
    const status = await w.slash(w.adminA, "status", "C0BOTIN");
    expect(status.text).toBe("<#C0BOTIN> isn't linked to a Rovara project.");
  });

  it("a press re-checks the person live: removed or demoted since the menu, nothing changes", async () => {
    const w = world();
    const value = w.buttons(await w.slash(w.adminA, "link web"))[0]!.value;
    w.db.set({ ...membershipKey(w.adminA.personId), entityType: "COMPANY_MEMBERSHIP", personId: w.adminA.personId, companyId: A, role: "member", joinedAt: TIME });
    expect((await w.press(w.adminA, ROVARA_LINK_ACTION, value))!.text).toBe(ROVARA_NOT_ALLOWED);
    const again = world();
    const second = again.buttons(await again.slash(again.adminA, "link web"))[0]!.value;
    again.db.set({ ...membershipKey(again.adminA.personId), entityType: "COMPANY_MEMBERSHIP", personId: again.adminA.personId, companyId: A, role: "admin", joinedAt: TIME, revokedAt: TIME });
    expect((await again.press(again.adminA, ROVARA_LINK_ACTION, second))!.text).toBe(ROVARA_SIGN_IN_FIRST);
    expect(w.linkRow(ACME, "C0GENERAL")).toBeUndefined();
    expect(again.linkRow(ACME, "C0GENERAL")).toBeUndefined();
  });

  it("a member is refused; a project admin may link only their own project", async () => {
    const w = world();
    expect((await w.slash(w.memberA, "link web")).text).toBe(ROVARA_NOT_ALLOWED);
    expect((await w.slash(w.memberA, "link")).text).toBe(ROVARA_NO_PROJECTS);
    expect((await w.slash(w.apiAdminA, "link web")).text).toBe(ROVARA_NOT_ALLOWED);
    const menu = await w.slash(w.apiAdminA, "link");
    expect(JSON.stringify(menu)).toContain("*api*");
    expect(JSON.stringify(menu)).not.toContain("*web*");
    expect((await w.press(w.apiAdminA, ROVARA_LINK_ACTION, w.buttons(menu)[0]!.value))!.text).toContain("Linked <#C0GENERAL> to *api*");
  });

  it("a private channel the bot isn't in: invite, then a fresh Link press links", async () => {
    const w = world();
    const value = w.buttons(await w.slash(w.adminA, "link web", "G0PRIV"))[0]!.value;
    const invite = await w.press(w.adminA, ROVARA_LINK_ACTION, value, "G0PRIV");
    expect(invite).toMatchObject({ text: ROVARA_INVITE, replace_original: true });
    expect(w.linkRow(ACME, "G0PRIV")).toBeUndefined();
    const next = w.buttons(invite!)[0]!.value;
    expect(next).not.toBe(value);
    w.slack.invite("G0PRIV");
    expect((await w.press(w.adminA, ROVARA_LINK_ACTION, next, "G0PRIV"))!.text).toContain("Linked <#G0PRIV> to *web*");
  });

  it("a channel already linked to another project: the command says so, a stale press is refused", async () => {
    const w = world();
    const stale = w.buttons(await w.slash(w.adminA, "link api", "C0BOTIN"))[0]!.value;
    await w.link(w.adminA, "web", "C0BOTIN");
    expect((await w.slash(w.adminA, "link api", "C0BOTIN")).text).toBe("<#C0BOTIN> is already linked to *web*. Type `/rovara unlink` first.");
    expect((await w.press(w.adminA, ROVARA_LINK_ACTION, stale, "C0BOTIN"))!.text).toContain("already linked to another project");
    expect(w.linkRow(ACME, "C0BOTIN")?.projectName).toBe("web");
  });

  it("status, then unlink by press; a press for a link that changed since changes nothing", async () => {
    const w = world();
    await w.link(w.adminA, "web", "C0BOTIN");
    expect((await w.slash(w.memberA, "status", "C0BOTIN")).text).toBe("<#C0BOTIN> is linked to *web*.");
    expect((await w.slash(w.memberA, "unlink", "C0BOTIN")).text).toBe(ROVARA_NOT_ALLOWED);
    const confirm = await w.slash(w.adminA, "unlink", "C0BOTIN");
    const [button] = w.buttons(confirm);
    expect(button!.action_id).toBe(ROVARA_UNLINK_ACTION);
    expect((await w.press(w.adminA, ROVARA_UNLINK_ACTION, button!.value, "C0BOTIN"))!.text).toBe("Unlinked <#C0BOTIN> from *web*. Threads already started keep working.");
    expect(w.linkRow(ACME, "C0BOTIN")).toBeUndefined();
    expect((await w.slash(w.adminA, "status", "C0BOTIN")).text).toBe("<#C0BOTIN> isn't linked to a Rovara project.");
    await w.link(w.adminA, "web", "C0BOTIN");
    const changed = w.buttons(await w.slash(w.adminA, "unlink", "C0BOTIN"))[0]!.value;
    await w.call(w.adminA, "DELETE", "/v1/dev/company/slack/projects/web/channel");
    await w.link(w.adminA, "api", "C0BOTIN");
    expect((await w.press(w.adminA, ROVARA_UNLINK_ACTION, changed, "C0BOTIN"))!.text).toBe(ROVARA_CHANGED);
    expect(w.linkRow(ACME, "C0BOTIN")?.projectName).toBe("api");
  });

  it("other interactions stay with the interactivity handler; malformed presses of ours are dropped", () => {
    expect(rovaraRequestOf(new URLSearchParams({ payload: JSON.stringify({ type: "block_actions", actions: [{ action_id: "agentx_details" }] }) }).toString())).toBeUndefined();
    expect(rovaraRequestOf(new URLSearchParams({ command: "/other", text: "x" }).toString())).toBeUndefined();
    const two = { type: "block_actions", team: { id: ACME }, user: { id: "U0ADA", team_id: ACME }, channel: { id: "C0GENERAL" }, response_url: RESPONSE,
      actions: [{ action_id: ROVARA_LINK_ACTION, value: "A".repeat(43) }, { action_id: ROVARA_LINK_ACTION, value: "B".repeat(43) }] };
    expect(rovaraRequestOf(new URLSearchParams({ payload: JSON.stringify(two) }).toString())).toEqual({ answer: { statusCode: 200, headers: {}, body: "" } });
  });

  it("a broker that fails is answered with the fixed try-again, never its cause", async () => {
    const posted: Array<Record<string, unknown>> = [];
    await runRovaraHandOff({ invokeBroker: async () => { throw new Error("secret cause xoxb-1"); }, post: async (_url, body) => { posted.push(body); } },
      { source: "agentx.slack-rovara-handoff", responseUrl: RESPONSE, event: { source: "agentx.slack-rovara", kind: "command", teamId: ACME, userId: "U0ADA", channelId: "C0GENERAL", text: "link" } });
    expect(posted).toEqual([{ response_type: "ephemeral", replace_original: false, text: "Rovara couldn't take that just now; try again." }]);
    await runRovaraHandOff({ invokeBroker: async () => ({ statusCode: 200, body: "{}" }), post: async () => { throw new Error("x"); } },
      { source: "agentx.slack-rovara-handoff", responseUrl: "https://evil.test/", event: { source: "agentx.slack-rovara", kind: "command", teamId: ACME, userId: "U0ADA", channelId: "C0GENERAL", text: "link" } });
  });
});
