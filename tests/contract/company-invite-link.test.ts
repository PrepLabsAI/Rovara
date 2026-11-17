// DEC 254h: an invite link carries a single-use secret that Code checks at sign-in. The real broker route makes it with a company pre-approval;
// the real sign-in server spends it, whatever the sign-in method, in the transaction that writes the membership.
import { describe, expect, it } from "vitest";
import { COMPANY_INVITE_LINK_PREFIX, SLACK_OIDC_ISSUER, companyInviteCodeHash, companyScoped } from "@agentx/contracts";
import { membershipKey } from "../../packages/broker/src/aws/company-check.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { inviteLinkKey } from "../../packages/broker/src/developer/company-membership.js";
import { emailIndexKey } from "../../packages/broker/src/developer/store.js";
import { authorizeQuery, httpEvent } from "../support/developer-fakes.js";
import { B, person, sharedSignInWorld, X, type SharedSignInWorld } from "../support/company-shared-signin-world.js";

const OTHER = "T0OTHER9";
const slackId = (subject: string) => ownerKeyForSubject(SLACK_OIDC_ISSUER, subject);
const slackUsers = [
  { userId: "U0INVITE1", teamId: OTHER, name: "Invited", email: "invited@other.test" },
  { userId: "U0INVITE2", teamId: OTHER, name: "Second", email: "second@other.test" },
];
const PATH = "/v1/dev/company/preapprovals";
const NOT_INVITED = "not invited";

/** X made by its owner (self-serve, no issuer); B an operator's company with no issuer of its own here (so only the secret decides). */
async function ready(): Promise<{ w: SharedSignInWorld; owner: string }> {
  const w = sharedSignInWorld({ slackUsers });
  await w.setup();
  w.db.delete(w.issuerRow.pk, w.issuerRow.sk);
  const owner = await w.signIn("owner");
  expect((await w.access(owner.access)).body).toMatchObject({ companyId: X, companyRole: "owner" });
  return { w, owner: owner.access! };
}
async function mint(w: SharedSignInWorld, token: string, email: string, hours = 24): Promise<{ secret: string; expiresAt: string }> {
  const answer = await w.call("POST", PATH, token, { email, role: "member", expiresInHours: hours });
  expect(answer.status).toBe(200);
  return (answer.body as { invite: { secret: string; expiresAt: string } }).invite;
}
const linkRow = (w: SharedSignInWorld, company: string, secret: string) => { const key = inviteLinkKey(company, companyInviteCodeHash(secret)); return w.db.get(key.pk, key.sk); };
const memberOf = (w: SharedSignInWorld, id: string) => w.db.get(membershipKey(id).pk, membershipKey(id).sk);

describe("invite link secret (DEC 254h)", () => {
  it("the pre-approval route answers a secret once; a person from another Slack workspace joins with it and spends it and its pre-approval", async () => {
    const { w, owner } = await ready();
    const invite = await mint(w, owner, "someone@example.test");
    expect(invite.secret.startsWith(COMPANY_INVITE_LINK_PREFIX)).toBe(true);
    expect(invite.secret.length).toBeGreaterThanOrEqual(COMPANY_INVITE_LINK_PREFIX.length + 32);
    const approval = w.db.get(companyScoped(X, "PREAPPROVAL"), emailIndexKey("someone@example.test").pk)!;
    expect(new Date(invite.expiresAt).getTime()).toBe((approval.expiresAt as number) * 1000);
    expect(linkRow(w, X, invite.secret)).toMatchObject({ entityType: "COMPANY_INVITE_LINK", companyId: X, status: "live", expiresAt: approval.expiresAt, createdAt: approval.createdAt, createdBy: person("owner") });
    expect(approval.inviteHash).toBe(companyInviteCodeHash(invite.secret));
    // Another invitation answers another secret.
    expect((await mint(w, owner, "other@example.test")).secret).not.toBe(invite.secret);

    const joined = await w.signIn("U0INVITE1", { slackTeam: OTHER, company: X, invite: invite.secret });
    expect(joined.refused).toBeUndefined();
    const id = slackId(`${OTHER}:U0INVITE1`);
    expect((await w.access(joined.access)).body).toMatchObject({ developerId: id, companyId: X, companyRole: "member", joinedByInvite: true });
    expect(memberOf(w, id)).toMatchObject({ companyId: X, role: "member", joinedVia: "preapproval" });
    expect(linkRow(w, X, invite.secret)).toMatchObject({ status: "used", usedBy: id, usedAt: expect.any(String) as unknown });
    expect(w.db.get(companyScoped(X, "PREAPPROVAL"), emailIndexKey("someone@example.test").pk)).toMatchObject({ status: "used", usedBy: id });
    // Used: nobody else gets in with it, and the answer is the same as for a secret that never existed.
    const again = await w.signIn("U0INVITE2", { slackTeam: OTHER, company: X, invite: invite.secret });
    const unknown = await w.signIn("U0INVITE2", { slackTeam: OTHER, company: X, invite: `${COMPANY_INVITE_LINK_PREFIX}${"A".repeat(32)}` });
    expect(again.refused).toBe(NOT_INVITED);
    expect(unknown.refused).toBe(NOT_INVITED);
    expect(memberOf(w, slackId(`${OTHER}:U0INVITE2`))).toBeUndefined();
  });

  it("an identity with no email joins with a secret (and not without one)", async () => {
    const { w, owner } = await ready();
    expect((await w.signIn("noemail", { company: X })).refused).toBe(NOT_INVITED);
    const invite = await mint(w, owner, "anyone@example.test");
    const joined = await w.signIn("noemail", { company: X, invite: invite.secret });
    expect((await w.access(joined.access)).body).toMatchObject({ companyId: X, companyRole: "member", joinedByInvite: true });
    expect((await w.refresh(joined.refresh!)).status).toBe(200);
  });

  it("two companies: a secret for X never admits into B, even with company=B, and B's never into X", async () => {
    const { w, owner } = await ready();
    const forX = await mint(w, owner, "carol@example.test");
    // bob is B's first admin (email pre-approval); he mints B's own secret.
    const bob = await w.signIn("bob", { company: B });
    expect((await w.access(bob.access)).body).toMatchObject({ companyId: B, companyRole: "admin" });
    const forB = await mint(w, bob.access!, "dana@example.test");
    expect((await w.signIn("noemail", { company: B, invite: forX.secret })).refused).toBe(NOT_INVITED);
    expect((await w.signIn("U0INVITE1", { slackTeam: OTHER, company: X, invite: forB.secret })).refused).toBe(NOT_INVITED);
    expect(memberOf(w, person("noemail"))).toBeUndefined();
    expect(linkRow(w, X, forX.secret)).toMatchObject({ status: "live" });
    expect(linkRow(w, B, forB.secret)).toMatchObject({ status: "live" });
    // The store itself looks a secret up only under the company asked for.
    expect(await w.company.joinByInvite({ personId: person("noemail"), companyId: B, inviteHash: companyInviteCodeHash(forX.secret) })).toEqual({ ok: false, reason: "not_invited" });
    // Each still works for its own company.
    expect((await w.access((await w.signIn("noemail", { company: X, invite: forX.secret })).access)).body).toMatchObject({ companyId: X });
    expect((await w.access((await w.signIn("U0INVITE1", { slackTeam: OTHER, company: B, invite: forB.secret })).access)).body).toMatchObject({ companyId: B });
  });

  it("a double spend race: exactly one of two people joins", async () => {
    const { w, owner } = await ready();
    const invite = await mint(w, owner, "race@example.test");
    const results = await Promise.all([
      w.signIn("U0INVITE1", { slackTeam: OTHER, company: X, invite: invite.secret }),
      w.signIn("noemail", { company: X, invite: invite.secret }),
    ]);
    expect(results.filter((result) => result.refused === undefined)).toHaveLength(1);
    expect(results.filter((result) => result.refused === NOT_INVITED)).toHaveLength(1);
    const members = [memberOf(w, slackId(`${OTHER}:U0INVITE1`)), memberOf(w, person("noemail"))].filter((row) => row !== undefined);
    expect(members).toHaveLength(1);
    expect(linkRow(w, X, invite.secret)).toMatchObject({ status: "used", usedBy: members[0]!.personId });
  });

  it("the store's own race: a second spend after the first commits writes nothing", async () => {
    const { w, owner } = await ready();
    const invite = await mint(w, owner, "race@example.test");
    const hash = companyInviteCodeHash(invite.secret);
    const both = await Promise.all([person("erin"), person("frank")].map((personId) => w.company.joinByInvite({ personId, companyId: X, inviteHash: hash })));
    expect(both.filter((result) => result.ok)).toHaveLength(1);
    expect(both.filter((result) => result.ok && result.viaPreapproval === true)).toHaveLength(1);
    expect([memberOf(w, person("erin")), memberOf(w, person("frank"))].filter((row) => row !== undefined)).toHaveLength(1);
  });

  it("expired, withdrawn and replaced: each is the same refusal and admits nobody", async () => {
    const { w, owner } = await ready();
    const short = await mint(w, owner, "short@example.test", 1);
    const withdrawn = await mint(w, owner, "gone@example.test");
    expect((await w.call("DELETE", `${PATH}/${emailIndexKey("gone@example.test").pk.slice(6)}`, owner)).status).toBe(200);
    expect(linkRow(w, X, withdrawn.secret)).toMatchObject({ status: "withdrawn" });
    // Withdrawn, then the same email invited again: the old secret stays dead, the new one works.
    const replaced = await mint(w, owner, "gone@example.test");
    expect((await w.signIn("noemail", { company: X, invite: withdrawn.secret })).refused).toBe(NOT_INVITED);
    w.tick(3_600_001);
    expect((await w.signIn("U0INVITE1", { slackTeam: OTHER, company: X, invite: short.secret })).refused).toBe(NOT_INVITED);
    expect(memberOf(w, person("noemail"))).toBeUndefined();
    expect(memberOf(w, slackId(`${OTHER}:U0INVITE1`))).toBeUndefined();
    expect((await w.access((await w.signIn("noemail", { company: X, invite: replaced.secret })).access)).body).toMatchObject({ companyId: X, joinedByInvite: true });
  });

  it("a person already in another company, or removed from this one, is refused with the same answer and the secret stays unspent", async () => {
    const { w, owner } = await ready();
    const invite = await mint(w, owner, "carol@example.test");
    // bob is in B.
    await w.signIn("bob", { company: B });
    expect((await w.signIn("bob", { company: X, invite: invite.secret })).refused).toBe(NOT_INVITED);
    // dana joins X by email, is removed, then tries a secret.
    await w.call("POST", PATH, owner, { email: "dana@example.test", role: "member", expiresInHours: 24 });
    await w.signIn("dana", { company: X });
    expect(memberOf(w, person("dana"))).toMatchObject({ companyId: X });
    await w.company.setRevoked(X, person("dana"), true);
    expect((await w.signIn("dana", { company: X, invite: invite.secret })).refused).toBe(NOT_INVITED);
    expect(linkRow(w, X, invite.secret)).toMatchObject({ status: "live" });
    expect(w.db.get(companyScoped(X, "PREAPPROVAL"), emailIndexKey("carol@example.test").pk)).toMatchObject({ status: "live" });
    expect(memberOf(w, person("bob"))).toMatchObject({ companyId: B });
    // An existing member of X with a secret: signed in as before, nothing spent, and not "joined by invite".
    const again = await w.signIn("owner", { company: X, invite: invite.secret });
    expect((await w.access(again.access)).body).not.toHaveProperty("joinedByInvite");
    expect(linkRow(w, X, invite.secret)).toMatchObject({ status: "live" });
  });

  it("the secret is never stored, logged or sent anywhere in plain text", async () => {
    const { w, owner } = await ready();
    const invite = await mint(w, owner, "leak@example.test");
    await w.signIn("noemail", { company: X, invite: invite.secret });
    await w.signIn("U0INVITE1", { slackTeam: OTHER, company: X, invite: invite.secret });
    const body = invite.secret.slice(COMPANY_INVITE_LINK_PREFIX.length);
    expect(JSON.stringify(w.db.find(() => true))).not.toContain(body);
    expect(JSON.stringify(w.logs)).not.toContain(body);
    expect(JSON.stringify(w.fetch.calls)).not.toContain(body);
    // The list shows neither the secret nor its hash.
    const listed = JSON.stringify(await w.operator({ kind: "company-preapprovals-list", companyId: X }));
    expect(listed).toContain(emailIndexKey("leak@example.test").pk.slice(6));
    expect(listed).not.toContain(companyInviteCodeHash(invite.secret));
    // The sign-in request keeps only the hash.
    expect(w.db.find((row) => row.entityType === "AUTH_REQUEST" && row.inviteHash === companyInviteCodeHash(invite.secret))).toHaveLength(2);
  });

  it("authorize refuses a secret with no company, too long, from a company-bound client or on a step-up, before anything is stored", async () => {
    const { w, owner } = await ready();
    const invite = await mint(w, owner, "x@example.test");
    const before = w.db.find((row) => row.entityType === "AUTH_REQUEST").length;
    const refused = async (query: Record<string, string>) => `unexpected-${(await w.http(httpEvent("GET", authorizeQuery(query)))).statusCode}`;
    expect(await refused({ client_id: "web-app", redirect_uri: "https://cloud.example.test/callback", invite: invite.secret })).toContain("unexpected-400");
    expect(await refused({ client_id: "web-app", redirect_uri: "https://cloud.example.test/callback", company: X, invite: "x".repeat(257) })).toContain("unexpected-400");
    expect(await refused({ client_id: "web-app", redirect_uri: "https://cloud.example.test/callback", company: X, invite: "" })).toContain("unexpected-400");
    expect(await refused({ client_id: "web-app", redirect_uri: "https://cloud.example.test/callback", company: X, invite: invite.secret, acr_values: "step-up" })).toContain("unexpected-400");
    // A client bound to company X (not install-level): it signs people in to X, but never with a secret.
    const bound: Record<string, unknown> = { ...w.db.get("SIGNIN_CLIENTS", "CLIENT#web-app")!, sk: "CLIENT#x-app", clientId: "x-app", companyId: X };
    delete bound.installLevel; delete bound.webApp;
    w.db.set(bound);
    expect(await refused({ client_id: "x-app", redirect_uri: "https://cloud.example.test/callback", invite: invite.secret })).toContain("unexpected-400");
    expect(w.db.find((row) => row.entityType === "AUTH_REQUEST")).toHaveLength(before);
    expect(await refused({ client_id: "x-app", redirect_uri: "https://cloud.example.test/callback" })).toContain("unexpected-200");
    expect(memberOf(w, person("noemail"))).toBeUndefined();
    expect(linkRow(w, X, invite.secret)).toMatchObject({ status: "live" });
  });

  it("an email join without a secret keeps working", async () => {
    const { w, owner } = await ready();
    await mint(w, owner, "carol@example.test");
    const carol = await w.signIn("carol", { company: X });
    expect((await w.access(carol.access)).body).toMatchObject({ companyId: X, joinedByInvite: true });
  });

  it("a refused secret attempts no write at all: used, expired, withdrawn, replaced, or a row naming another company", async () => {
    const { w, owner } = await ready();
    const used = await mint(w, owner, "used@example.test");
    await w.signIn("erin", { company: X, invite: used.secret });
    const withdrawn = await mint(w, owner, "gone@example.test");
    await w.call("DELETE", `${PATH}/${emailIndexKey("gone@example.test").pk.slice(6)}`, owner);
    const replaced = await mint(w, owner, "again@example.test");
    // The pre-approval is replaced by an operator's (expired first) with another secret: the old one is no longer the one it names.
    const approvalKey = { pk: companyScoped(X, "PREAPPROVAL"), sk: emailIndexKey("again@example.test").pk };
    w.db.set({ ...w.db.get(approvalKey.pk, approvalKey.sk)!, inviteHash: "e".repeat(64) });
    const expired = await mint(w, owner, "short@example.test", 1);
    // A row in B's partition that names X (as a corrupt or copied row would): never admits into B.
    const copied = await mint(w, owner, "copied@example.test");
    const xRow = linkRow(w, X, copied.secret)!;
    const bKey = inviteLinkKey(B, companyInviteCodeHash(copied.secret));
    w.db.set({ ...xRow, ...bKey });
    w.db.set({ ...w.db.get(companyScoped(X, "PREAPPROVAL"), emailIndexKey("copied@example.test").pk)!, pk: companyScoped(B, "PREAPPROVAL") });
    // A secret marked spent, or past its own expiry, while its pre-approval is still live (as a partial or hand-made row would be).
    const spent = await mint(w, owner, "spent@example.test");
    const spentKey = inviteLinkKey(X, companyInviteCodeHash(spent.secret));
    w.db.set({ ...w.db.get(spentKey.pk, spentKey.sk)!, status: "used" });
    const lapsed = await mint(w, owner, "lapsed@example.test");
    const lapsedKey = inviteLinkKey(X, companyInviteCodeHash(lapsed.secret));
    w.db.set({ ...w.db.get(lapsedKey.pk, lapsedKey.sk)!, expiresAt: Math.floor(w.now() / 1000) + 60 });
    // A live secret, for a person who is already a member of another company.
    const live = await mint(w, owner, "live@example.test");
    w.db.set({ ...membershipKey(person("bob")), entityType: "COMPANY_MEMBERSHIP", personId: person("bob"), companyId: B, role: "member", joinedAt: "2026-01-01T00:00:00.000Z" });
    w.tick(3_600_001);
    const cases = [[used.secret, X, "frank"], [withdrawn.secret, X, "frank"], [replaced.secret, X, "frank"], [expired.secret, X, "frank"], [copied.secret, B, "frank"], [spent.secret, X, "frank"], [lapsed.secret, X, "frank"], [live.secret, X, "bob"]] as const;
    for (const [secret, company, who] of cases) {
      const sent = w.db.commandNames().length;
      const answer = await w.company.joinByInvite({ personId: person(who), companyId: company, inviteHash: companyInviteCodeHash(secret) });
      expect(answer).toEqual(who === "bob" ? { ok: false, reason: "member_elsewhere" } : { ok: false, reason: "not_invited" });
      expect(w.db.commandNames().slice(sent)).not.toContain("TransactWriteCommand");
    }
    expect(memberOf(w, person("frank"))).toBeUndefined();
    expect(linkRow(w, X, live.secret)).toMatchObject({ status: "live" });
  });

  it.each([
    ["the secret is spent", (w: SharedSignInWorld, link: { pk: string; sk: string }) => w.db.set({ ...w.db.get(link.pk, link.sk)!, status: "used" })],
    ["the secret's row is rewritten", (w: SharedSignInWorld, link: { pk: string; sk: string }) => w.db.set({ ...w.db.get(link.pk, link.sk)!, createdAt: "2020-01-01T00:00:00.000Z" })],
    ["the pre-approval is withdrawn", (w: SharedSignInWorld) => { const key = { pk: companyScoped(X, "PREAPPROVAL"), sk: emailIndexKey("mid@example.test").pk }; w.db.set({ ...w.db.get(key.pk, key.sk)!, status: "withdrawn" }); }],
    ["the pre-approval names another secret", (w: SharedSignInWorld) => { const key = { pk: companyScoped(X, "PREAPPROVAL"), sk: emailIndexKey("mid@example.test").pk }; w.db.set({ ...w.db.get(key.pk, key.sk)!, inviteHash: "e".repeat(64) }); }],
    ["the person joined elsewhere", (w: SharedSignInWorld) => w.db.set({ ...membershipKey(person("frank")), entityType: "COMPANY_MEMBERSHIP", personId: person("frank"), companyId: B, role: "member", joinedAt: "2026-01-01T00:00:00.000Z" })],
  ])("a change between the check and the write refuses (%s)", async (_name, change) => {
    const { w, owner } = await ready();
    const invite = await mint(w, owner, "mid@example.test");
    const link = inviteLinkKey(X, companyInviteCodeHash(invite.secret));
    const send = w.db.send;
    let changed = false;
    w.db.send = async (command) => {
      if (!changed && command.constructor.name === "TransactWriteCommand") { changed = true; change(w, link); }
      return send(command);
    };
    const answer = await w.company.joinByInvite({ personId: person("frank"), companyId: X, inviteHash: companyInviteCodeHash(invite.secret) });
    expect(changed).toBe(true);
    expect(answer.ok && answer.viaPreapproval === true).toBe(false);
    expect(memberOf(w, person("frank"))?.companyId).not.toBe(X);
  });

  it("an operator pre-approval with a hash already stored is refused, never overwritten", async () => {
    const { w } = await ready();
    const hash = "d".repeat(64);
    expect(await w.operator({ kind: "company-preapprove", companyId: X, email: "one@example.test", role: "member", expiresInHours: 24, inviteHash: hash })).toMatchObject({ ok: true, expiresAt: expect.any(Number) as unknown });
    expect(await w.operator({ kind: "company-preapprove", companyId: X, email: "two@example.test", role: "member", expiresInHours: 24, inviteHash: hash })).toEqual({ ok: false, error: "unavailable" });
    expect(w.db.get(inviteLinkKey(X, hash).pk, inviteLinkKey(X, hash).sk)).toMatchObject({ emailHash: emailIndexKey("one@example.test").pk.slice(6) });
    expect(w.db.get(companyScoped(X, "PREAPPROVAL"), emailIndexKey("two@example.test").pk)).toBeUndefined();
    // Without a hash, the operator's answer is as before.
    expect(await w.operator({ kind: "company-preapprove", companyId: X, email: "three@example.test", role: "member", expiresInHours: 24 })).toEqual({ ok: true });
  });

  it("withdrawing an expired invitation whose link row has aged out (TTL) still works", async () => {
    const { w, owner } = await ready();
    const invite = await mint(w, owner, "old@example.test", 1);
    const key = inviteLinkKey(X, companyInviteCodeHash(invite.secret));
    w.db.delete(key.pk, key.sk);
    w.tick(3_600_001);
    expect((await w.call("DELETE", `${PATH}/${emailIndexKey("old@example.test").pk.slice(6)}`, owner)).status).toBe(200);
    expect(w.db.get(key.pk, key.sk)).toBeUndefined();
  });
});
