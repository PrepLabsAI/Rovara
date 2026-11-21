import { describe, expect, it } from "vitest";
import { BUILT_IN_SIGN_IN_METHODS, SLACK_OIDC_ISSUER, companyInviteCodeHash, companyScoped } from "@agentx/contracts";
import { enabledMethods } from "../../packages/broker/src/developer/server.js";
import { DeveloperSignInMethodSchema } from "../../packages/contracts/src/developer-web.js";
import { GITHUB_ISSUER, githubSignInProvider } from "../../packages/broker/src/developer/providers.js";
import { GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, fakeGithub } from "../support/fake-github.js";
import { OIDC_ISSUER, authorizeQuery, httpEvent, type FakeOidcUser } from "../support/developer-fakes.js";
import { B, SECRET, WEB, X, sharedSignInWorld, type SharedSignInWorld } from "../support/company-shared-signin-world.js";
import { emailIndexKey } from "../../packages/broker/src/developer/store.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { inviteLinkKey } from "../../packages/broker/src/developer/company-membership.js";

const invitedEmail = "invite-matrix@example.test";
const inviteSecret = "invite-matrix-secret-00000000000000000000000000000000";
const badEmail = "different@example.test";

// This reviewed inventory is intentionally independent of enabledMethods and the provider setup.
// Each row selects a real HTTP-offered method/issuer path and carries four distinct provider results
// through the production callback and CompanySignInStore.joinByInvite guard.
const inviteProofCoverage = [
  { id: "slack", method: "slack", company: X, expectedOffers: ["slack", "oidc", "github"], logins: { match: "U0MATRIX1", mismatch: "U0MATRIX2", unverified: "U0MATRIX3", noEmail: "U0MATRIX4" } },
  { id: "github", method: "github", company: X, expectedOffers: ["slack", "oidc", "github"], logins: { match: "github-match", mismatch: "github-mismatch", unverified: "github-unverified", noEmail: "github-no-email" } },
  { id: "installOidc", method: "oidc", company: X, expectedOffers: ["slack", "oidc", "github"], logins: { match: "install-match", mismatch: "install-mismatch", unverified: "install-unverified", noEmail: "install-no-email" } },
  { id: "companyOidc", method: "oidc", company: B, expectedOffers: ["slack", "oidc"], logins: { match: "company-match", mismatch: "company-mismatch", unverified: "company-unverified", noEmail: "company-no-email" } },
] as const;
const reviewedBuiltIns = ["slack", "oidc", "cloud", "github", "saml"] as const;
const proofCases = [
  { proof: "mismatch", expected: "This invite is for another email" },
  { proof: "unverified", expected: "This sign-in has no verified email. Sign in with the invited email." },
  { proof: "noEmail", expected: "This sign-in has no verified email. Sign in with the invited email." },
  { proof: "match", expected: undefined },
] as const;

function world(): SharedSignInWorld & { gh: ReturnType<typeof fakeGithub> } {
  const providers: FakeOidcUser[] = inviteProofCoverage.flatMap((entry) => [
    { sub: entry.logins.match, email: invitedEmail, email_verified: true },
    { sub: entry.logins.mismatch, email: badEmail, email_verified: true },
    { sub: entry.logins.unverified, email: invitedEmail, email_verified: false },
    { sub: entry.logins.noEmail },
  ]);
  providers.push({ sub: "owner", email: "owner@example.test", email_verified: true });
  const slackUsers = inviteProofCoverage.slice(0, 1).flatMap((entry) => [
    { userId: entry.logins.match, name: entry.logins.match, email: invitedEmail },
    { userId: entry.logins.mismatch, name: entry.logins.mismatch, email: badEmail },
    { userId: entry.logins.unverified, name: entry.logins.unverified, email: invitedEmail, emailVerified: false },
    { userId: entry.logins.noEmail, name: entry.logins.noEmail },
  ]);
  const w = sharedSignInWorld({ oidcUsers: providers, slackUsers });
  const gh = fakeGithub([
    { id: 801, login: "github-match", emails: [{ email: invitedEmail, primary: true, verified: true }] },
    { id: 802, login: "github-mismatch", emails: [{ email: badEmail, primary: true, verified: true }] },
    { id: 803, login: "github-unverified", emails: [{ email: invitedEmail, primary: true, verified: false }] },
    { id: 804, login: "github-no-email", emails: "forbidden" },
  ]);
  w.deps.config.github = {};
  w.deps.providers.github = githubSignInProvider({ clientId: GITHUB_CLIENT_ID, clientSecret: async () => GITHUB_CLIENT_SECRET, fetch: gh.fetch, now: w.now });
  w.routes.developer.methods.github = true;
  return Object.assign(w, { gh });
}

async function callback(w: ReturnType<typeof world>, entry: (typeof inviteProofCoverage)[number], login: string, secret: string) {
  const query = { client_id: "web-app", redirect_uri: WEB, company: entry.company, invite: secret };
  if (entry.method !== "github") {
    const back = await w.providerSignIn(entry.method, login, { query });
    const code = back.searchParams.get("code");
    if (code === null) return { refused: back.searchParams.get("error_description") };
    const tokens = await w.exchange(code, { client_id: "web-app", client_secret: SECRET, redirect_uri: WEB });
    return tokens.status === 200 ? { access: tokens.body.access_token as string } : { refused: `exchange ${tokens.status}` };
  }
  let start = await w.http(httpEvent("GET", authorizeQuery(query)));
  const offer = /href="([^"]*method=github[^"]*)"/.exec(start.body)?.[1];
  if (offer === undefined) return { refused: "GitHub missing from offered methods" };
  start = await w.http(httpEvent("GET", offer.replaceAll("&amp;", "&")));
  const back = await w.http(httpEvent("GET", w.gh.approve(start.headers.location!, login)));
  const code = new URL(back.headers.location!).searchParams.get("code");
  if (code === null) return { refused: new URL(back.headers.location!).searchParams.get("error_description") };
  const tokens = await w.exchange(code, { client_id: "web-app", client_secret: SECRET, redirect_uri: WEB });
  return tokens.status === 200 ? { access: tokens.body.access_token as string } : { refused: `exchange ${tokens.status}` };
}

describe("invite verified-email method coverage", () => {
  it("keeps the independently reviewed built-in schema inventory explicit", () => {
    expect([...BUILT_IN_SIGN_IN_METHODS]).toEqual(reviewedBuiltIns);
    expect(DeveloperSignInMethodSchema.options).toEqual(reviewedBuiltIns);
  });

  it.each(inviteProofCoverage)("runs the $id offered sign-in and its invite proof matrix through the real guard", async (entry) => {
    const w = world();
    const company = entry.company;
    await w.setup();
    expect(enabledMethods(w.deps)).toEqual(["slack", "oidc", "github"]);
    const page = await w.http(httpEvent("GET", authorizeQuery({ client_id: "web-app", redirect_uri: WEB, company, invite: inviteSecret })));
    const offered = [...page.body.matchAll(/method=(slack|oidc|github)/g)].map((match) => match[1]);
    expect([...new Set(offered)].sort()).toEqual([...entry.expectedOffers].sort());
    expect(offered).toContain(entry.method);

    await w.company.preapprove(company, invitedEmail, "member", 24, "operator", companyInviteCodeHash(inviteSecret));
    const link = inviteLinkKey(company, companyInviteCodeHash(inviteSecret));
    for (const row of proofCases) {
      const membersBefore = w.db.find((item) => item.entityType === "COMPANY_MEMBERSHIP");
      const result = await callback(w, entry, entry.logins[row.proof], inviteSecret);
      if (row.proof === "match") {
        expect(result.refused).toBeUndefined();
        expect(result.access).toBeDefined();
        expect((await w.access(result.access)).body).toMatchObject({ companyId: company, joinedByInvite: true });
        expect(w.db.get(link.pk, link.sk)).toMatchObject({ status: "used" });
      } else {
        expect(result.refused).toBe(row.expected);
        expect(result.access).toBeUndefined();
        expect(w.db.find((item) => item.entityType === "COMPANY_MEMBERSHIP")).toEqual(membersBefore);
        expect(w.db.get(companyScoped(company, "PREAPPROVAL"), emailIndexKey(invitedEmail).pk)).toMatchObject({ status: "live" });
        expect(w.db.get(link.pk, link.sk)).toMatchObject({ status: "live" });
      }
    }
  });

  describe.each(inviteProofCoverage)("$id current provider proof overrides stored email", (entry) => {
    it.each(["profile", "merge-survivor"] as const)("never substitutes the %s email for the current proof", async (storedIdentity) => {
      // A fresh world per proof keeps the matching control independent of every refusal.
      for (const row of proofCases) {
        const w = world();
        await w.setup();
        const login = entry.logins[row.proof];
        const issuer = entry.method === "github" ? GITHUB_ISSUER : entry.method === "slack" ? SLACK_OIDC_ISSUER : OIDC_ISSUER;
        const githubSubjects = { match: "801", mismatch: "802", unverified: "803", noEmail: "804" };
        const subject = entry.method === "github" ? githubSubjects[row.proof] : login;
        const signedInId = ownerKeyForSubject(issuer, subject);
        const survivorId = ownerKeyForSubject(OIDC_ISSUER, "invite-matrix-survivor");
        const personId = storedIdentity === "profile" ? signedInId : survivorId;
        const at = new Date(w.now()).toISOString();
        const profile = { pk: `DEVELOPER#${signedInId}`, sk: "META", entityType: "DEVELOPER", developerId: signedInId,
          provider: entry.method, issuer, subject, displayName: "Saved identity", email: invitedEmail,
          firstSignInAt: at, lastSignInAt: at, revoked: false };
        w.db.set(storedIdentity === "profile" ? profile : { ...profile, email: badEmail, mergedInto: survivorId });
        if (storedIdentity === "merge-survivor") {
          w.db.set({ ...profile, pk: `DEVELOPER#${survivorId}`, developerId: survivorId, provider: "oidc", issuer: OIDC_ISSUER, subject: "invite-matrix-survivor" });
        }
        expect(w.db.get(`DEVELOPER#${personId}`, "META")).toMatchObject({ email: invitedEmail });
        await w.company.preapprove(entry.company, invitedEmail, "member", 24, "operator", companyInviteCodeHash(inviteSecret));
        const link = inviteLinkKey(entry.company, companyInviteCodeHash(inviteSecret));
        const approvalPk = companyScoped(entry.company, "PREAPPROVAL");
        const approvalSk = emailIndexKey(invitedEmail).pk;
        const membersBefore = w.db.find((item) => item.entityType === "COMPANY_MEMBERSHIP");
        const result = await callback(w, entry, login, inviteSecret);
        expect(result.refused, row.proof).toBe(row.expected);
        if (row.proof === "match") {
          expect(result.access).toBeDefined();
          expect((await w.access(result.access)).body).toMatchObject({ developerId: personId, companyId: entry.company, joinedByInvite: true });
          expect(w.db.get(link.pk, link.sk)).toMatchObject({ status: "used", usedBy: personId });
          expect(w.db.get(approvalPk, approvalSk)).toMatchObject({ status: "used", usedBy: personId });
        } else {
          expect(result.access, row.proof).toBeUndefined();
          expect(w.db.find((item) => item.entityType === "COMPANY_MEMBERSHIP"), row.proof).toEqual(membersBefore);
          expect(w.db.get(link.pk, link.sk), row.proof).toMatchObject({ status: "live" });
          expect(w.db.get(approvalPk, approvalSk), row.proof).toMatchObject({ status: "live" });
        }
        if (storedIdentity === "merge-survivor") {
          expect(w.db.get(`DEVELOPER#${signedInId}`, "META")).toMatchObject({ email: badEmail, mergedInto: survivorId });
          expect(w.db.get(`DEVELOPER#${survivorId}`, "META")).toMatchObject({ email: invitedEmail });
        }
      }
    });
  });

  it("does not let unsupported built-ins or an unknown adapter start an invite sign-in", async () => {
    const w = world();
    await w.setup();
    const query = { client_id: "web-app", redirect_uri: WEB, company: X, invite: inviteSecret };
    for (const method of ["cloud", "saml", "unknown-adapter"]) {
      const selected = await w.http(httpEvent("GET", authorizeQuery({ ...query, method })));
      expect(selected.statusCode).toBe(400);
      expect(selected.body).toContain("Sign-in method not available");
    }
  });
});
