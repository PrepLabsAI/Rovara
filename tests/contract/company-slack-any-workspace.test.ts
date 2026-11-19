// DEC 254e: with Code's company layer on, Slack is the shared sign-in method for every company: any Slack workspace may sign in, the company comes
// only from live membership (or an invite), never from the workspace. And (DEC 254b, the import lane) a merged sign-in is seated as its survivor.
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, SLACK_OIDC_ISSUER, companyScoped, newCompanyInviteCode } from "@agentx/contracts";
import { membershipKey } from "../../packages/broker/src/aws/company-check.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { slackSignInProvider } from "../../packages/broker/src/developer/providers.js";
import { fakeSlack, routeFetch, SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, TEAM, T0 } from "../support/developer-fakes.js";
import { B, OWN_SIGNIN, person, sharedSignInWorld, X } from "../support/company-shared-signin-world.js";

const OTHER = "T0OTHER9";
const slackId = (subject: string) => ownerKeyForSubject(SLACK_OIDC_ISSUER, subject);
const slackUsers = [
  { userId: "U0NEW0001", teamId: OTHER, name: "New Person", email: "new@other.test" },
  { userId: "U0SAME001", name: "Same Id", email: "same@example.test" },
  { userId: "U0INVITE1", teamId: OTHER, name: "Invited", email: "invited@other.test" },
  { userId: "U0INSTALL", name: "Install Person", email: "install@example.test" },
  { userId: "U0MERGED1", name: "Merged", email: "merged@example.test" },
];
const world = () => sharedSignInWorld({ slackUsers });

describe("Slack from any workspace (DEC 254e)", () => {
  it("a person from a new workspace with no invite gets the company-less session, with their workspace recorded and the team in their id", async () => {
    const w = world();
    const signed = await w.signIn("U0NEW0001", { slackTeam: OTHER });
    expect(signed.refused).toBeUndefined();
    const id = slackId(`${OTHER}:U0NEW0001`);
    expect(w.db.get(`DEVELOPER#${id}`, "META")).toMatchObject({ provider: "slack", subject: `${OTHER}:U0NEW0001`, slackTeamId: OTHER, companyless: true });
    expect(w.db.get(`DEVELOPER#${id}`, "META")).not.toHaveProperty("slackUserId");
    expect(w.db.find((row) => row.entityType === "SESSION" && row.developerId === id)).toEqual([expect.not.objectContaining({ companyId: expect.anything() as unknown, slackUserId: expect.anything() as unknown })]);
    expect((await w.access(signed.access)).body).toEqual({ developerId: id, displayName: "New Person", nameChosen: false, administrator: false, projects: [], notices: [], slackTeamId: OTHER });
    // Nobody looked them up in the install's Slack directory.
    expect(w.fetch.calls.filter((call) => call.includes("lookupByEmail"))).toEqual([]);
    // They make their own company with an operator's code, then sign in again through Slack and get it.
    const made = newCompanyInviteCode();
    await w.operator({ kind: "company-invite-create", codeHash: made.codeHash, expiresInHours: 24 });
    expect((await w.call("POST", "/v1/dev/company", signed.access, { name: "Other Co", inviteCode: made.code })).status).toBe(200);
    const again = await w.signIn("U0NEW0001", { slackTeam: OTHER });
    expect((await w.access(again.access)).body).toMatchObject({ developerId: id, companyId: X, companyRole: "owner" });
    expect(w.db.find((row) => row.entityType === "SESSION" && row.developerId === id && row.companyId === X)).toEqual([expect.objectContaining({ installMethod: true, amr: "slack" })]);
    expect((await w.refresh(again.refresh!)).status).toBe(200);
  });

  it("the same Slack user id in two workspaces is two people", async () => {
    const w = world();
    await w.signIn("U0SAME001", { slackTeam: TEAM });
    await w.signIn("U0SAME001", { slackTeam: OTHER });
    const ids = w.db.find((row) => row.entityType === "DEVELOPER").map((row) => String(row.pk).slice("DEVELOPER#".length)).sort();
    expect(ids).toEqual([slackId("U0SAME001"), slackId(`${OTHER}:U0SAME001`)].sort());
    expect(new Set(ids).size).toBe(2);
    // The install-workspace person keeps exactly the id they always had, with their Slack user id.
    expect(w.db.get(`DEVELOPER#${slackId("U0SAME001")}`, "META")).toMatchObject({ subject: "U0SAME001", slackUserId: "U0SAME001", slackTeamId: TEAM });
  });

  it("a workspace binding never puts anyone in a company: a new install-workspace person bound to B gets no company", async () => {
    const w = world();
    await w.setup();
    w.deps.slackTeamCompany = () => B;
    const signed = await w.signIn("U0INSTALL", { slackTeam: TEAM });
    expect((await w.access(signed.access)).body).not.toHaveProperty("companyId");
    expect(w.db.get(membershipKey(slackId("U0INSTALL")).pk, "COMPANY")).toBeUndefined();
    // The CLI (no company-less sessions) refuses them.
    expect((await w.signIn("U0INSTALL", { slackTeam: TEAM, cli: true })).refused).toBe("not invited");
  });

  it("an email from another workspace spends no invite: only the install workspace's (or an invite code) admits", async () => {
    const w = world();
    await w.setup();
    await w.operator({ kind: "company-preapprove", companyId: X, email: "invited@other.test", role: "member", expiresInHours: 24 });
    await w.operator({ kind: "company-preapprove", companyId: IMPLICIT_COMPANY_ID, email: "invited@other.test", role: "member", expiresInHours: 24 });
    // The invite link (company=X) and a plain sign-in: neither spends the invite for the foreign workspace's asserted email.
    expect((await w.signIn("U0INVITE1", { slackTeam: OTHER, company: X })).refused).toBe("not invited");
    const plain = await w.signIn("U0INVITE1", { slackTeam: OTHER });
    expect((await w.access(plain.access)).body).not.toHaveProperty("companyId");
    expect(w.db.find((row) => row.entityType === "COMPANY_PREAPPROVAL" && row.status === "live" && !String(row.pk).includes(B))).toHaveLength(2);
    expect(w.db.get(membershipKey(slackId(`${OTHER}:U0INVITE1`)).pk, "COMPANY")).toBeUndefined();
    // No email is kept for them: no email index row, no factor email.
    const record = w.db.get(`DEVELOPER#${slackId(`${OTHER}:U0INVITE1`)}`, "META")!;
    expect(record).not.toHaveProperty("email");
    expect(record).not.toHaveProperty("factorEmail");
    expect(w.db.find((row) => row.entityType === "DEVELOPER_EMAIL" && row.developerId === slackId(`${OTHER}:U0INVITE1`))).toEqual([]);
    // The install workspace's own people still join by invite link, through Slack, and only that company.
    await w.operator({ kind: "company-preapprove", companyId: X, email: "install@example.test", role: "member", expiresInHours: 24 });
    const own = await w.signIn("U0INSTALL", { slackTeam: TEAM, company: X });
    expect((await w.access(own.access)).body).toMatchObject({ companyId: X, companyRole: "member", joinedByInvite: true });
    expect(w.sessionOf(slackId("U0INSTALL"))).toEqual([expect.objectContaining({ companyId: X, installMethod: true, amr: "slack" })]);
    expect((await w.signIn("U0INSTALL", { slackTeam: TEAM, company: B })).refused).toBe(OWN_SIGNIN);
  });

  it("a company with its own issuer keeps it: Slack from another workspace is refused before the invite is spent", async () => {
    const w = world();
    await w.setup();
    await w.operator({ kind: "company-preapprove", companyId: B, email: "invited@other.test", role: "member", expiresInHours: 24 });
    expect((await w.signIn("U0INVITE1", { slackTeam: OTHER, company: B })).refused).toBe(OWN_SIGNIN);
    expect(w.db.find((row) => row.entityType === "COMPANY_PREAPPROVAL" && String(row.pk).includes(B) && row.status === "live").length).toBeGreaterThan(0);
    expect(w.db.get(membershipKey(slackId(`${OTHER}:U0INVITE1`)).pk, "COMPANY")).toBeUndefined();
    // As before: B's own install workspace, bound to B, still signs B's members in through Slack (unmarked).
    w.deps.slackTeamCompany = () => B;
    await w.operator({ kind: "company-preapprove", companyId: B, email: "install@example.test", role: "member", expiresInHours: 24 });
    const own = await w.signIn("U0INSTALL", { slackTeam: TEAM, company: B });
    expect(own.refused).toBeUndefined();
    expect(w.sessionOf(slackId("U0INSTALL"))).toEqual([expect.objectContaining({ companyId: B })]);
    expect(w.sessionOf(slackId("U0INSTALL"))[0]).not.toHaveProperty("installMethod");
    // Unbound again: that session ends at refresh.
    w.deps.slackTeamCompany = () => undefined;
    expect((await w.refresh(own.refresh!)).status).toBe(400);
  });

  it("the bound-workspace exception is for the install workspace only: a member of B from another workspace is refused through Slack", async () => {
    const w = world();
    await w.setup();
    w.deps.slackTeamCompany = () => B;
    const id = slackId(`${OTHER}:U0NEW0001`);
    // A membership in B written by an operator (an import), for a person from another workspace.
    w.db.set({ ...membershipKey(id), entityType: "COMPANY_MEMBERSHIP", personId: id, companyId: B, role: "member", joinedAt: new Date(w.now()).toISOString() });
    expect((await w.signIn("U0NEW0001", { slackTeam: OTHER })).refused).toBe(OWN_SIGNIN);
    expect((await w.signIn("U0NEW0001", { slackTeam: OTHER, company: B })).refused).toBe(OWN_SIGNIN);
    expect(w.db.find((row) => row.entityType === "SESSION" && row.developerId === id)).toEqual([]);
  });

  it("a shared Slack session ends once its company gets an issuer: at once at the broker, and at refresh", async () => {
    const w = world();
    await w.setup();
    await w.operator({ kind: "company-preapprove", companyId: X, email: "install@example.test", role: "member", expiresInHours: 24 });
    const signed = await w.signIn("U0INSTALL", { slackTeam: TEAM, company: X });
    const cli = await w.signIn("U0INSTALL", { slackTeam: TEAM, cli: true });
    expect(await w.cliCheck(cli.access!)).toBe(200);
    w.db.set({ ...w.issuerRow, pk: companyScoped(X, "SIGNIN_ISSUER") });
    expect((await w.access(signed.access)).status).toBe(401);
    expect(await w.cliCheck(cli.access!)).toBe(401);
    expect((await w.refresh(signed.refresh!)).status).toBe(400);
  });

  it("a removed member from another workspace (self-serve owner) is refused at once and at refresh", async () => {
    const w = world();
    const first = await w.signIn("U0NEW0001", { slackTeam: OTHER });
    const made = newCompanyInviteCode();
    await w.operator({ kind: "company-invite-create", codeHash: made.codeHash, expiresInHours: 24 });
    expect((await w.call("POST", "/v1/dev/company", first.access, { name: "Other Co", inviteCode: made.code })).status).toBe(200);
    const signed = await w.signIn("U0NEW0001", { slackTeam: OTHER });
    expect((await w.access(signed.access)).body).toMatchObject({ companyId: X });
    w.db.set({ ...w.db.get(membershipKey(slackId(`${OTHER}:U0NEW0001`)).pk, "COMPANY")!, revokedAt: new Date(w.now()).toISOString(), revokedBy: "operator" });
    expect((await w.access(signed.access)).status).toBe(401);
    expect((await w.refresh(signed.refresh!)).status).toBe(400);
    expect((await w.signIn("U0NEW0001", { slackTeam: OTHER })).refused).toBe("access ended by a company admin");
  });

  it("the provider takes any workspace only when asked: off, the link names the install team and another workspace is refused", async () => {
    const slack = fakeSlack({ users: slackUsers, now: () => T0 });
    const make = (anyWorkspace: boolean) => slackSignInProvider({ ...(anyWorkspace ? { anyWorkspace: true } : {}), teamId: TEAM, credentials: async () => ({ clientId: SLACK_CLIENT_ID, clientSecret: SLACK_CLIENT_SECRET }), fetch: routeFetch(slack.handler), jwks: slack.jwks, now: () => T0 });
    const redirectUri = "https://signin.example.test/v1/auth/callback/slack";
    for (const anyWorkspace of [false, true]) {
      const provider = make(anyWorkspace);
      const url = await provider.authorizeUrl({ state: "s", nonce: "n", redirectUri });
      expect(new URL(url).searchParams.get("team"), String(anyWorkspace)).toBe(anyWorkspace ? null : TEAM);
      const code = new URL(slack.approve(url, "U0NEW0001", { teamId: OTHER })).searchParams.get("code")!;
      const result = await provider.complete({ code, nonce: "n", redirectUri });
      if (anyWorkspace) expect(result).toMatchObject({ ok: true, identity: { subject: `${OTHER}:U0NEW0001`, slackTeam: { id: OTHER } } });
      else expect(result).toMatchObject({ ok: false, wrongAccount: true });
      if (result.ok) expect(result.identity).not.toHaveProperty("slackUserId");
    }
  });
});

describe("a merged sign-in is seated as its survivor (company layer on)", () => {
  const merge = (w: ReturnType<typeof world>, from: string, into: string, extra: Record<string, unknown> = {}) =>
    w.db.set({ pk: `DEVELOPER#${from}`, sk: "META", entityType: "DEVELOPER", developerId: from, provider: "slack", issuer: SLACK_OIDC_ISSUER, subject: "U0MERGED1", displayName: "Merged",
      revoked: false, firstSignInAt: "2026-10-01T00:00:00.000Z", lastSignInAt: "2026-10-01T00:00:00.000Z", mergedInto: into, ...extra });

  it("a merged Slack id signs in as the survivor, in the survivor's company, and neither record is rewritten", async () => {
    const w = world();
    await w.setup();
    const merged = slackId("U0MERGED1");
    merge(w, merged, person("owner"));
    const before = JSON.stringify([w.db.get(`DEVELOPER#${merged}`, "META"), w.db.get(`DEVELOPER#${person("owner")}`, "META")]);
    const signed = await w.signIn("U0MERGED1", { slackTeam: TEAM });
    expect(signed.refused).toBeUndefined();
    expect((await w.access(signed.access)).body).toMatchObject({ developerId: person("owner"), companyId: X, companyRole: "owner" });
    expect(JSON.stringify([w.db.get(`DEVELOPER#${merged}`, "META"), w.db.get(`DEVELOPER#${person("owner")}`, "META")])).toBe(before);
    expect(w.db.find((row) => row.entityType === "SESSION" && row.developerId === merged)).toEqual([]);
    expect((await w.refresh(signed.refresh!)).status).toBe(200);
  });

  it.each(["revoked hop", "revoked survivor", "loop", "too long", "missing survivor", "malformed"] as const)("a bad merge walk refuses (%s), and nothing is minted", async (cause) => {
    const w = world();
    await w.setup();
    const merged = slackId("U0MERGED1");
    const hop = "1".repeat(64);
    if (cause === "revoked hop") { merge(w, merged, hop); w.db.set({ pk: `DEVELOPER#${hop}`, sk: "META", developerId: hop, revoked: true, mergedInto: person("owner") }); }
    if (cause === "revoked survivor") { merge(w, merged, person("owner")); w.db.set({ ...w.db.get(`DEVELOPER#${person("owner")}`, "META")!, revoked: true }); }
    if (cause === "loop") { merge(w, merged, hop); w.db.set({ pk: `DEVELOPER#${hop}`, sk: "META", developerId: hop, revoked: false, mergedInto: merged }); }
    if (cause === "too long") {
      const chain = Array.from({ length: 10 }, (_, i) => String(i + 1).repeat(64).slice(0, 64));
      merge(w, merged, chain[0]!);
      chain.forEach((id, i) => w.db.set({ pk: `DEVELOPER#${id}`, sk: "META", developerId: id, revoked: false, ...(i + 1 < chain.length ? { mergedInto: chain[i + 1] } : {}) }));
    }
    if (cause === "missing survivor") merge(w, merged, hop);
    if (cause === "malformed") merge(w, merged, "not-an-id");
    const sessions = w.db.find((row) => row.entityType === "SESSION").length;
    expect((await w.signIn("U0MERGED1", { slackTeam: TEAM })).refused).toBe("your Rovara sign-in was turned off by an administrator; contact an administrator");
    expect(w.db.find((row) => row.entityType === "SESSION")).toHaveLength(sessions);
    expect(w.db.find((row) => row.entityType === "AUTH_CODE" && row.developerId !== person("owner"))).toEqual([]);
  });

  it("with the company layer off a merged record is not followed (the old sign-in, as before)", async () => {
    const w = world();
    const merged = slackId("U0MERGED1");
    merge(w, merged, person("owner"));
    delete w.deps.company; delete w.deps.companyInvites;
    w.deps.providers.slack = slackSignInProvider({ teamId: TEAM, credentials: async () => ({ clientId: SLACK_CLIENT_ID, clientSecret: SLACK_CLIENT_SECRET }), fetch: w.fetch, jwks: w.slack.jwks, now: w.now });
    const signed = await w.signIn("U0MERGED1", { slackTeam: TEAM, cli: true });
    expect(signed.refused).toBeUndefined();
    expect(w.db.find((row) => row.entityType === "SESSION")).toEqual([expect.objectContaining({ developerId: merged })]);
    expect(IMPLICIT_COMPANY_ID).toBeDefined();
  });
});
