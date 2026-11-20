// DEC 254b (a): sign-in by live membership, and the install's own sign-in as the shared method for a company with no issuer of its own.
// Two companies over one wire-level table and the real sign-in server and broker checks: X made by self-serve (no issuer), B with its own issuer
// (the same IdP URL as the install's, the hardest no-downgrade case: the same person id either way).
import { describe, expect, it } from "vitest";
import { companyScoped } from "@agentx/contracts";
import { authenticateDeveloperSessionId } from "../../packages/broker/src/aws/developer-routes.js";
import { httpEvent, OIDC_ISSUER } from "../support/developer-fakes.js";
import { B, person, sharedSignInWorld as world, X } from "../support/company-shared-signin-world.js";

describe("sign-in by live membership (DEC 254b a)", () => {

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
