// Spec 064: the legacy deployment (production), whose sign-in is for account linking only, takes the sign-in client
// admin changes, confirmed in the CLI, so a service such as the Rovara Cloud web app can be registered there. Every other
// kind of change is refused before it is planned.
import { describe, expect, it } from "vitest";
import { SIGN_IN_CLIENTS_PK } from "@agentx/contracts";
import { signInClientsThroughLambda } from "../../packages/broker/src/aws/developer-routes.js";
import { createAdminChangeBroker } from "../support/admin-change-broker.js";
import { identityHarness } from "../support/developer-fakes.js";
import { OMAR } from "../support/developer-task-broker.js";

const registration = { name: "Rovara Cloud", audience: "rovara-cloud", redirectUris: ["https://cloud.example.com/auth/callback"], loopback: true };

async function production() {
  const identity = identityHarness();
  const registry = signInClientsThroughLambda(async (payload) => {
    const answer = await identity.handler(JSON.parse(new TextDecoder().decode(payload)) as never);
    return { Payload: new TextEncoder().encode(JSON.stringify(answer)) };
  });
  const harness = await createAdminChangeBroker({ signInClients: registry, linkingOnly: true });
  return { harness, rows: () => identity.db.find((item) => item.pk === SIGN_IN_CLIENTS_PK) };
}

describe("admin changes in the legacy deployment (spec 064)", () => {
  it("registers a sign-in client, confirmed in the CLI, and removes it", async () => {
    const { harness, rows } = await production();
    const planned = await harness.propose({ kind: "register_sign_in_client", clientId: "rovara-cloud", registration }, ["cli"]);
    expect(planned.status).toBe(201);
    expect(planned.body.change).toMatchObject({ kind: "register_sign_in_client", status: "pending", methodsOffered: ["cli"] });
    expect(rows()).toEqual([]);
    const applied = await harness.apply((planned.body.change as { changeId: string }).changeId, "cli");
    expect(applied.status).toBe(200);
    expect(rows()).toEqual([expect.objectContaining({ sk: "CLIENT#rovara-cloud", audience: "rovara-cloud" })]);
    // The list `update` reads first, served by the linking-only sign-in too.
    const listed = await harness.admin("GET", "/v1/admin/sign-in-clients");
    expect(listed.status).toBe(200);
    expect(listed.body.clients).toEqual([expect.objectContaining({ clientId: "rovara-cloud", audience: "rovara-cloud" })]);

    const removal = await harness.propose({ kind: "remove_sign_in_client", clientId: "rovara-cloud" }, ["cli"]);
    await harness.apply((removal.body.change as { changeId: string }).changeId, "cli");
    expect(rows()).toEqual([]);
  });

  it("grants and revokes a signed-in person's access to a project, so the access check lists it", async () => {
    const { harness } = await production();
    const grant = await harness.propose({ kind: "grant_project_access", project: "payments", developer: OMAR.developerId }, ["cli"]);
    expect(grant.status).toBe(201);
    expect((await harness.apply((grant.body.change as { changeId: string }).changeId, "cli")).status).toBe(200);
    expect(harness.db.get(`MEMBER#${OMAR.developerId}`, "PROJECT#payments")).toMatchObject({ role: "developer" });
    const revoke = await harness.propose({ kind: "revoke_project_access", project: "payments", developer: OMAR.developerId }, ["cli"]);
    await harness.apply((revoke.body.change as { changeId: string }).changeId, "cli");
    expect(harness.db.get(`MEMBER#${OMAR.developerId}`, "PROJECT#payments")).toBeUndefined();
  });

  it("refuses every other kind of change before planning it, and stores nothing", async () => {
    const { harness } = await production();
    const refused = await harness.propose({ kind: "bind_channel", channel: "#ledger-dev", project: "payments" }, ["cli"]);
    expect(refused.status).toBe(404);
    expect(refused.body.error).toMatchObject({ code: "NOT_FOUND", message: "bind_channel changes are not available in this deployment" });
    expect(harness.db.find((item) => item.entityType === "ADMIN_CHANGE" || item.entityType === "ADMIN_CHANGE_AUDIT")).toEqual([]);
  });
});
