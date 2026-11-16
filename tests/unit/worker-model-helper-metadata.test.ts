// TE-F2 part B: the GCE metadata server beside the loop (Vertex's Application Default Credentials; te-f1 design 4.5, redirect check 1b). F0a's pure route table answers; the loop wraps it: every answer carries
// `Metadata-Flavor: Google`, a request without that header is refused, anything else is 404, the token is a fixed dummy and a bearer token that arrives is never echoed.
import { afterEach, describe, expect, it } from "vitest";
import { cleanupWorlds, fakeKey, request, startWorld, type World } from "../support/model-helper-world.js";

afterEach(cleanupWorlds);
const open: World[] = [];
afterEach(async () => {
  for (const w of open.splice(0)) await w.close();
});
const flavor = { "metadata-flavor": "Google" };

describe("metadata server", () => {
  it("serves the routes Python and JS google-auth ask for, each with Metadata-Flavor: Google", async () => {
    const w = await startWorld();
    open.push(w);
    const meta = w.meta as string;
    const ping = await request(`${meta}/`, { headers: flavor });
    expect(ping.status).toBe(200);
    expect(ping.headers["metadata-flavor"]).toBe("Google");
    const project = await request(`${meta}/computeMetadata/v1/project/project-id`, { headers: flavor });
    expect(project.body).toBe("rovara-test-project");
    const account = await request(`${meta}/computeMetadata/v1/instance/service-accounts/default/?recursive=true`, { headers: flavor });
    expect(JSON.parse(account.body)).toMatchObject({ aliases: ["default"] });
    const token = await request(`${meta}/computeMetadata/v1/instance/service-accounts/default/token?scopes=https://www.googleapis.com/auth/cloud-platform`, { headers: flavor });
    const parsed = JSON.parse(token.body) as { access_token: string; expires_in: number; token_type: string };
    expect(parsed).toMatchObject({ expires_in: 3600, token_type: "Bearer" });
    expect(parsed.access_token).toBe(["rovara", "dummy", "token"].join("-"));
    expect(token.headers["metadata-flavor"]).toBe("Google");
  });
  it("refuses a request without the Metadata-Flavor request header, a method other than GET, and anything else with 404", async () => {
    const w = await startWorld();
    open.push(w);
    const meta = w.meta as string;
    expect((await request(`${meta}/computeMetadata/v1/instance/service-accounts/default/token`)).status).toBe(403);
    expect((await request(`${meta}/computeMetadata/v1/instance/service-accounts/default/token`, { method: "POST", headers: flavor })).status).toBe(405);
    expect((await request(`${meta}/computeMetadata/v1/instance/hostname`, { headers: flavor })).status).toBe(404);
    expect((await request(`${meta}/x`, { method: "GET", headers: { ...flavor }, path: "//evil" })).status).toBe(404);
  });
  it("never echoes or forwards a bearer token that arrives", async () => {
    const w = await startWorld();
    open.push(w);
    const key = fakeKey();
    const reply = await request(`${w.meta as string}/computeMetadata/v1/instance/service-accounts/default/token`, { headers: { ...flavor, authorization: `Bearer ${key}` } });
    expect(reply.body).not.toContain(key);
    expect(JSON.stringify(reply.headers)).not.toContain(key);
    expect(w.ledgerText()).not.toContain(key);
  });
  it("without a project id the project route answers 500, not a made-up id", async () => {
    const w = await startWorld({ projectId: undefined });
    open.push(w);
    expect((await request(`${w.meta as string}/computeMetadata/v1/project/project-id`, { headers: flavor })).status).toBe(500);
  });
});
