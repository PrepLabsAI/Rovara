// #634: a person sets their own name (PUT /v1/dev/me/name), ported from Rovara Cloud's release 0.4.16 (abd4a061d). The sign-in
// Lambda owns the sign-in table, so it stores the name; a later sign-in leaves a chosen name alone.
import { describe, expect, it, vi } from "vitest";
import { setDisplayNameThroughLambda } from "../../packages/broker/src/aws/developer-routes.js";
import { TEAM, identityHarness } from "../support/developer-fakes.js";

/** upsertDeveloper keeps the developer ID in the key only, so it is read from there. */
const developerIdOf = (db: { find(predicate: (item: Record<string, unknown>) => boolean): Array<Record<string, unknown>> }) =>
  String(db.find((item) => item.entityType === "DEVELOPER")[0]?.pk).replace(/^DEVELOPER#/, "");
const reply = (value: unknown) => ({ Payload: Buffer.from(JSON.stringify(value)) });

describe("the sign-in Lambda's set-display-name request", () => {
  it("stores the chosen name, marks it chosen, logs no name, and a later sign-in keeps it", async () => {
    const harness = identityHarness({ slackUsers: [{ userId: "U0ADA00001", teamId: TEAM, name: "Ada" }] });
    await harness.signIn("slack", "U0ADA00001");
    const developerId = developerIdOf(harness.db);
    expect(await harness.handler({ kind: "set-display-name", developerId, name: "Ada Lovelace" } as never)).toEqual({ ok: true, name: "Ada Lovelace" });
    expect(harness.db.get(`DEVELOPER#${developerId}`, "META")).toMatchObject({ displayName: "Ada Lovelace", displayNameChosen: true });
    expect(harness.logs).toContainEqual({ event: "signin.display_name_chosen", developerId });
    expect(JSON.stringify(harness.logs)).not.toContain("Lovelace");

    harness.tick(1_000);
    await harness.signIn("slack", "U0ADA00001");
    expect(harness.db.get(`DEVELOPER#${developerId}`, "META")).toMatchObject({ displayName: "Ada Lovelace", displayNameChosen: true });
  });

  it("keeps refreshing the provider's name at sign-in while none was chosen", async () => {
    const harness = identityHarness({ slackUsers: [{ userId: "U0ADA00001", teamId: TEAM, name: "Ada" }] });
    await harness.signIn("slack", "U0ADA00001");
    const developerId = developerIdOf(harness.db);
    harness.db.set({ ...harness.db.get(`DEVELOPER#${developerId}`, "META")!, displayName: "Old name" });
    harness.tick(1_000);
    await harness.signIn("slack", "U0ADA00001");
    expect(harness.db.get(`DEVELOPER#${developerId}`, "META")).toMatchObject({ displayName: "Ada" });
    expect(harness.db.get(`DEVELOPER#${developerId}`, "META")?.displayNameChosen).toBeUndefined();
  });

  it("refuses a name the route would refuse, and answers not_found for an unknown or revoked person", async () => {
    const harness = identityHarness({ slackUsers: [{ userId: "U0ADA00001", teamId: TEAM, name: "Ada" }] });
    await harness.signIn("slack", "U0ADA00001");
    const developerId = developerIdOf(harness.db);
    for (const name of ["ada@example.com", "  Ada  ", "Member 3fa9c1d2", "‮Ada"]) {
      expect(await harness.handler({ kind: "set-display-name", developerId, name } as never)).toEqual({ ok: false, error: "invalid_request" });
    }
    expect(await harness.handler({ kind: "set-display-name", developerId: "e".repeat(64), name: "Eve" } as never)).toEqual({ ok: false, error: "not_found" });
    harness.db.set({ ...harness.db.get(`DEVELOPER#${developerId}`, "META")!, revoked: true });
    expect(await harness.handler({ kind: "set-display-name", developerId, name: "Ada L" } as never)).toEqual({ ok: false, error: "not_found" });
    expect(harness.db.get(`DEVELOPER#${developerId}`, "META")).toMatchObject({ displayName: "Ada" });
  });
});

describe("setDisplayNameThroughLambda", () => {
  it("passes ok, not_found and invalid_request through, and turns anything else into unavailable", async () => {
    const request = { kind: "set-display-name" as const, developerId: "a".repeat(64), name: "Ada" };
    const answers = [{ ok: true, name: "Ada" }, { ok: false, error: "not_found" }, { ok: false, error: "invalid_request" }, { ok: false, error: "boom" }, { ok: true }];
    const invoke = vi.fn();
    for (const answer of answers) invoke.mockResolvedValueOnce(reply(answer));
    const set = setDisplayNameThroughLambda(invoke);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await set(request)).toEqual({ ok: true, name: "Ada" });
    expect(await set(request)).toEqual({ ok: false, error: "not_found" });
    expect(await set(request)).toEqual({ ok: false, error: "invalid_request" });
    expect(await set(request)).toEqual({ ok: false, error: "unavailable" });
    expect(await set(request)).toEqual({ ok: false, error: "unavailable" });
    expect(JSON.parse(Buffer.from(invoke.mock.calls[0]![0] as Uint8Array).toString())).toEqual(request);
  });
});
