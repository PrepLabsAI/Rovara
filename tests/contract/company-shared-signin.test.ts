// DEC 254b (a): sign-in by live membership, and the install's own sign-in as the shared method for a company with no issuer of its own.
// Two companies over one wire-level table and the real sign-in server and broker checks: X made by self-serve (no issuer), B with its own issuer
// (the same IdP URL as the install's, the hardest no-downgrade case: the same person id either way).
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, companyScoped } from "@agentx/contracts";
import { membershipKey } from "../../packages/broker/src/aws/company-check.js";
import { authenticateDeveloperSessionId } from "../../packages/broker/src/aws/developer-routes.js";
import { httpEvent, OIDC_ISSUER } from "../support/developer-fakes.js";
import { B, OWN_SIGNIN, person, SECRET, sharedSignInWorld as world, WEB, X } from "../support/company-shared-signin-world.js";

describe("sign-in by live membership (DEC 254b a)", () => {
  it("the self-serve owner signs in to the web app with no company named and gets their company, through the shared method", async () => {
    const w = world();
    await w.setup();
    const signed = await w.signIn("owner");
    expect(signed.refused).toBeUndefined();
    expect(w.sessionOf(person("owner"))).toEqual([expect.objectContaining({ companyId: X, installMethod: true, clientId: "web-app" })]);
    expect((await w.access(signed.access)).body).toMatchObject({ developerId: person("owner"), companyId: X, companyRole: "owner", companyName: "Acme" });
    const rotated = await w.refresh(signed.refresh!);
    expect(rotated.status).toBe(200);
    expect((await w.access(rotated.body.access_token as string)).body).toMatchObject({ companyId: X });
  });

  it("the CLI and the browser review page sign the owner in to their company too, and the broker's CLI and cookie checks accept it", async () => {
    const w = world();
    await w.setup();
    const cli = await w.signIn("owner", { cli: true });
    expect(cli.refused).toBeUndefined();
    expect(w.sessionOf(person("owner")).filter((row) => row.clientId === undefined)).toEqual([expect.objectContaining({ companyId: X, installMethod: true })]);
    expect(await w.cliCheck(cli.access!)).toBe(200);
    expect((await w.refresh(cli.refresh!, true)).status).toBe(200);
    // The browser review page: no client, no company named.
    const sessionId = await w.browserSession("owner");
    expect(w.db.get(`SESSION#${sessionId}`, "META")).toMatchObject({ companyId: X, installMethod: true });
    await expect(authenticateDeveloperSessionId(w.routes, sessionId)).resolves.toMatchObject({ developerId: person("owner") });
  });

  it("a member of the built-in company still gets the legacy grant: no company on the session, no mark", async () => {
    const w = world();
    await w.deps.store.upsertDeveloper({ developerId: person("legacy"), provider: "oidc", issuer: OIDC_ISSUER, subject: "legacy", displayName: "Legacy" });
    const signed = await w.signIn("legacy", { cli: true });
    expect(signed.refused).toBeUndefined();
    expect(w.sessionOf(person("legacy"))).toEqual([expect.not.objectContaining({ companyId: expect.anything() as unknown })]);
    expect(w.sessionOf(person("legacy"))[0]).not.toHaveProperty("installMethod");
    expect(await w.cliCheck(signed.access!)).toBe(200);
  });

  it("an invited person joins the no-issuer company through the shared method when Cloud names it (company=X), and only that company", async () => {
    const w = world();
    await w.setup();
    await w.operator({ kind: "company-preapprove", companyId: X, email: "carol@example.test", role: "member", expiresInHours: 24 });
    // The method page offers only what the shared method allows: the install's OIDC (the install's Slack is bound to the built-in company, not X).
    const page = await w.http(httpEvent("GET", `/v1/auth/authorize?${new URLSearchParams({ response_type: "code", client_id: "web-app", redirect_uri: WEB, state: "s", code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", code_challenge_method: "S256", company: X }).toString()}`));
    expect(page.statusCode).toBe(302);
    expect(page.headers.location).toContain(OIDC_ISSUER);
    const signed = await w.signIn("carol", { company: X });
    expect(signed.refused).toBeUndefined();
    expect(w.sessionOf(person("carol"))).toEqual([expect.objectContaining({ companyId: X, installMethod: true })]);
    expect((await w.access(signed.access)).body).toMatchObject({ companyId: X, companyRole: "member" });
    // The same person later, naming no company: their membership's company.
    const again = await w.signIn("carol");
    expect((await w.access(again.access)).body).toMatchObject({ companyId: X });
  });

  it("a company with its own issuer keeps requiring it: its member is refused through the install's sign-in before anything is minted", async () => {
    const w = world();
    await w.setup();
    const bob = await w.signIn("bob", { company: B });
    expect(bob.refused).toBeUndefined();
    expect(w.sessionOf(person("bob"))).toEqual([expect.objectContaining({ companyId: B })]);
    expect(w.sessionOf(person("bob"))[0]).not.toHaveProperty("installMethod");
    expect((await w.access(bob.access)).body).toMatchObject({ companyId: B, companyRole: "admin" });
    const codesBefore = w.db.find((row) => row.entityType === "AUTH_CODE").length;
    for (const cli of [false, true]) {
      const shared = await w.signIn("bob", { cli });
      expect(shared.refused).toBe(OWN_SIGNIN);
    }
    expect(w.db.find((row) => row.entityType === "AUTH_CODE")).toHaveLength(codesBefore);
    expect(w.sessionOf(person("bob"))).toHaveLength(1);
    expect(JSON.stringify(w.logs.filter((entry) => entry.event === "signin.refused"))).not.toContain(B);
  });

  it("a removed member of a company with its own issuer is told their access ended, through either sign-in", async () => {
    const w = world();
    await w.setup();
    await w.signIn("bob", { company: B });
    await w.company.setRevoked(B, person("bob"), true);
    expect((await w.signIn("bob")).refused).toBe("access ended by a company admin");
    expect((await w.signIn("bob", { company: B })).refused).toBe("access ended by a company admin");
  });

  it("an issuer added after the callback but before the code is redeemed: the code is refused", async () => {
    const w = world();
    await w.setup();
    const back = await w.oidcSignIn("owner", { client_id: "web-app", redirect_uri: WEB });
    w.db.set({ ...w.issuerRow, pk: companyScoped(X, "SIGNIN_ISSUER") });
    const tokens = await w.exchange(back.searchParams.get("code")!, { client_id: "web-app", client_secret: SECRET, redirect_uri: WEB });
    expect(tokens.status).toBe(400);
    expect(w.sessionOf(person("owner"))).toEqual([]);
  });

  it("an unreadable issuer row fails closed at the callback and at refresh", async () => {
    const w = world();
    await w.setup();
    const signed = await w.signIn("owner");
    const read = w.company.read.bind(w.company);
    w.company.read = async (key) => { if (key.pk === companyScoped(X, "SIGNIN_ISSUER")) throw new Error("read-canary"); return read(key); };
    expect((await w.refresh(signed.refresh!)).status).toBe(400);
    expect((await w.signIn("owner")).refused).toBe("not invited");
    expect(JSON.stringify(w.logs)).not.toContain("read-canary");
  });

  it("the install's Slack admits a member of a self-serve company only when its team is bound to that company", async () => {
    const w = world();
    await w.setup();
    w.deps.slackTeamCompany = () => X;
    await w.operator({ kind: "company-preapprove", companyId: X, email: "dana@example.test", role: "member", expiresInHours: 24 });
    const page = await w.http(httpEvent("GET", `/v1/auth/authorize?${new URLSearchParams({ response_type: "code", client_id: "web-app", redirect_uri: WEB, state: "s", code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", code_challenge_method: "S256", company: X }).toString()}`));
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("method=slack");
    expect(page.body).toContain("method=oidc");
  });

  it("each person gets only their own company and cannot use the other's method or name the other company", async () => {
    const w = world();
    await w.setup();
    await w.signIn("bob", { company: B });
    // A member of B naming X, and a member of X naming B: refused, nothing minted, nobody moved.
    expect((await w.signIn("bob", { company: X })).refused).toBe("already a member of another company");
    expect((await w.signIn("owner", { company: B })).refused).toBe("already a member of another company");
    expect(w.db.get(membershipKey(person("bob")).pk, "COMPANY")).toMatchObject({ companyId: B });
    expect(w.db.get(membershipKey(person("owner")).pk, "COMPANY")).toMatchObject({ companyId: X });
    // A preapproval for X does not let B's member in through the shared method either.
    await w.operator({ kind: "company-preapprove", companyId: X, email: "bob@example.test", role: "member", expiresInHours: 24 });
    expect((await w.signIn("bob", { company: X })).refused).toBe("already a member of another company");
    // The CLI too.
    expect((await w.signIn("owner", { cli: true, company: B })).refused).toBe("already a member of another company");
  });

  it("removal mid-session ends access at once at the broker and at the next refresh", async () => {
    const w = world();
    await w.setup();
    await w.operator({ kind: "company-preapprove", companyId: X, email: "carol@example.test", role: "member", expiresInHours: 24 });
    const web = await w.signIn("carol", { company: X });
    const cli = await w.signIn("carol", { cli: true });
    expect((await w.access(web.access)).status).toBe(200);
    await w.company.setRevoked(X, person("carol"), true);
    expect((await w.access(web.access)).status).toBe(401);
    expect(await w.cliCheck(cli.access!)).toBe(401);
    expect((await w.refresh(web.refresh!)).status).toBe(400);
    expect((await w.refresh(cli.refresh!, true)).status).toBe(400);
    expect(w.sessionOf(person("carol"))).toEqual([]);
    expect((await w.signIn("carol")).refused).toBe("access ended by a company admin");
  });

  it("a session's company never changes in place: a membership that moves ends it, and the session record keeps its company", async () => {
    const w = world();
    await w.setup();
    const signed = await w.signIn("owner");
    const row = w.db.get(membershipKey(person("owner")).pk, "COMPANY")!;
    w.db.set({ ...row, companyId: IMPLICIT_COMPANY_ID });
    expect((await w.access(signed.access)).status).toBe(401);
    expect((await w.refresh(signed.refresh!)).status).toBe(400);
    expect(w.db.find((item) => item.entityType === "SESSION" && item.developerId === person("owner")).every((item) => item.companyId === X || item.companyId === undefined)).toBe(true);
  });

  it("no downgrade later: once the company has any issuer row (even a disabled one), its shared-method sessions end", async () => {
    for (const enabled of [true, false]) {
      const w = world();
      await w.setup();
      const web = await w.signIn("owner");
      const cli = await w.signIn("owner", { cli: true });
      w.db.set({ ...w.issuerRow, pk: companyScoped(X, "SIGNIN_ISSUER"), enabled });
      expect((await w.access(web.access)).status, `enabled=${enabled}`).toBe(401);
      expect(await w.cliCheck(cli.access!)).toBe(401);
      expect((await w.refresh(web.refresh!)).status).toBe(400);
      expect((await w.refresh(cli.refresh!, true)).status).toBe(400);
      expect(w.db.find((row) => row.entityType === "SESSION" && row.developerId === person("owner") && row.companyId === X).every((row) => row.revokedReason === "company_changed")).toBe(true);
    }
  });

  it("the mark is checked both ways, and only for a company other than the built-in one", async () => {
    const w = world();
    await w.setup();
    const owner = await w.signIn("owner");
    const bob = await w.signIn("bob", { company: B });
    const ownerSession = w.sessionOf(person("owner"))[0]!;
    const bobSession = w.sessionOf(person("bob"))[0]!;
    // X's session with the mark removed; B's with a mark added.
    w.db.set({ ...ownerSession, installMethod: undefined });
    expect((await w.access(owner.access)).status).toBe(401);
    w.db.set({ ...ownerSession, installMethod: "yes" });
    expect((await w.access(owner.access)).status).toBe(401);
    w.db.set(ownerSession);
    expect((await w.access(owner.access)).status).toBe(200);
    w.db.set({ ...bobSession, installMethod: true });
    expect((await w.access(bob.access)).status).toBe(401);
    expect((await w.refresh(bob.refresh!)).status).toBe(400);
    // A built-in company session carrying the mark.
    await w.deps.store.upsertDeveloper({ developerId: person("legacy"), provider: "oidc", issuer: OIDC_ISSUER, subject: "legacy", displayName: "Legacy" });
    const legacy = await w.signIn("legacy", { cli: true });
    const legacySession = w.sessionOf(person("legacy"))[0]!;
    w.db.set({ ...legacySession, installMethod: true });
    expect(await w.cliCheck(legacy.access!)).toBe(401);
    expect((await w.refresh(legacy.refresh!, true)).status).toBe(400);
  });

  it("the shared method follows the install's own OIDC switch", async () => {
    const w = world();
    await w.setup();
    const web = await w.signIn("owner");
    const cli = await w.signIn("owner", { cli: true });
    const review = await w.browserSession("owner");
    await expect(authenticateDeveloperSessionId(w.routes, review)).resolves.toBeDefined();
    w.routes.developer.methods = { slack: true, oidc: false };
    expect((await w.access(web.access)).status).toBe(401);
    expect(await w.cliCheck(cli.access!)).toBe(401);
    await expect(authenticateDeveloperSessionId(w.routes, review)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    delete w.deps.providers.oidc; delete w.deps.config.oidc;
    expect((await w.refresh(web.refresh!)).status).toBe(400);
  });

  it("an install administrator claim never makes an administrator of a session bound to another company", async () => {
    const w = world({ administrator: true });
    await w.setup();
    await w.signIn("owner");
    expect(w.sessionOf(person("owner")).filter((row) => row.companyId === X)).toEqual([expect.not.objectContaining({ administrator: true })]);
    // As before, a built-in company member with the claim is one.
    await w.deps.store.upsertDeveloper({ developerId: person("legacy"), provider: "oidc", issuer: OIDC_ISSUER, subject: "legacy", displayName: "Legacy" });
    await w.signIn("legacy", { cli: true });
    expect(w.sessionOf(person("legacy"))).toEqual([expect.objectContaining({ administrator: true })]);
  });

  it("a company-bound client still signs in only to its own company, never the person's membership", async () => {
    const w = world();
    await w.setup();
    const at = new Date(w.now() - 1000).toISOString();
    await w.deps.store.putClient({ clientId: "legacy-web", name: "Legacy", audience: "legacy-web", redirectUris: [], loopback: true, createdAt: at, updatedAt: at, updatedBy: "operator" });
    const back = await w.http(httpEvent("GET", "/v1/auth/authorize?request=none&method=unknown")).then(async () => w.oidcSignIn("owner", { client_id: "legacy-web" }));
    expect(back.searchParams.get("error_description")).toBe("already a member of another company");
    expect(w.sessionOf(person("owner")).filter((row) => row.clientId === "legacy-web")).toEqual([]);
  });
});
