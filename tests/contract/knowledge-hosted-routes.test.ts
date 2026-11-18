// L4-AK1H at the broker's developer router: `POST /v1/dev/projects/{p}/lessons`, `.../knowledge/areas` and `.../knowledge/propose` on a hosted install. The CLI's own sign-in (a real sign-in, real broker checks) reaches the knowledge API as the signed-in
// person; a script token (`Bearer rvst_...`) reaches it with no sign-in and is checked by the API itself; a registered client that is not the CLI or a full-access client is refused by the route table; without the wiring a person
// gets the fixed "off" answer and a token is refused. The route table's rows are additive: no existing row changed.
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AgentXError } from "@agentx/contracts";
import { DEV_ROUTES } from "../../packages/broker/src/aws/dev-route-scopes.js";
import { routeDeveloperRequest, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import type { KnowledgeApi } from "../../packages/broker/src/core-host/knowledge-api.js";
import { WEB, person, sharedSignInWorld as world } from "../support/company-shared-signin-world.js";

type Answer = { status: number; body: Record<string, unknown> };
const P = "/v1/dev/projects/payments";
const TOKEN = `rvst_${"a".repeat(20)}_${"b".repeat(20)}_${"c".repeat(43)}`;

async function callOn(deps: DeveloperRouteDependencies, method: string, path: string, authorization: string | undefined, body: unknown = {}): Promise<Answer> {
  const request = { method, path, headers: authorization === undefined ? {} : { authorization }, requestId: "r", body: JSON.stringify(body) };
  try { return { status: 200, body: await routeDeveloperRequest(deps, request, new URL(path, "https://broker.example.test")) as Record<string, unknown> }; }
  catch (error) {
    // The test world's own verifier throws jose's error for a token that is not a JWT; the deployed verifier answers 401.
    if (error instanceof Error && error.name === "JWTInvalid") return { status: 401, body: { error: { code: "AUTH_REQUIRED", message: "Sign in again." } } };
    if (!(error instanceof AgentXError)) throw error;
    return { status: error.statusCode, body: { error: { code: error.code, message: error.message.slice(error.code.length + 2) } } };
  }
}

describe("the knowledge routes at the developer router", () => {
  it("a signed-in person (the CLI's own sign-in) reaches the API as that person; the company is never read from the request", async () => {
    const w = world();
    await w.setup();
    const cli = await w.signIn("owner", { cli: true });
    expect(cli.refused).toBeUndefined();
    const answer = vi.fn(async () => ({ status: "ok", project: "payments", lessons: [], markdown: "", complete: true }));
    const deps = { ...w.routes, knowledge: { answer } satisfies KnowledgeApi } as DeveloperRouteDependencies;
    for (const tool of ["lessons", "knowledge/areas"]) {
      expect((await callOn(deps, "POST", `${P}/${tool}`, `Bearer ${cli.access!}`, { repo: "git@github.com:acme/api.git" })).status).toBe(200);
    }
    expect(answer).toHaveBeenCalledTimes(2);
    expect(answer.mock.calls[0]).toEqual([{ method: "POST", path: `${P}/lessons`, authorization: `Bearer ${cli.access!}`, body: JSON.stringify({ repo: "git@github.com:acme/api.git" }) }, { kind: "person", personId: person("owner") }]);
    expect((answer.mock.calls[1] as unknown[] | undefined)?.[1]).toEqual({ kind: "person", personId: person("owner") });
    // No sign-in, a bad sign-in: refused before the API is asked.
    expect((await callOn(deps, "POST", `${P}/lessons`, undefined)).status).toBe(401);
    expect((await callOn(deps, "POST", `${P}/lessons`, "Bearer not.a.jwt")).status).toBe(401);
    expect(answer).toHaveBeenCalledTimes(2);
  });

  it("the suggestion route (team_propose) is answered by the same door: a person as that person, a script token as a token, and a GET or another path is not it (L4-AK3H)", async () => {
    const w = world();
    await w.setup();
    const cli = await w.signIn("owner", { cli: true });
    const answer = vi.fn(async () => ({ status: "received", message: "ok" }));
    const deps = { ...w.routes, knowledge: { answer } satisfies KnowledgeApi } as DeveloperRouteDependencies;
    const body = { advice: "Wrap network calls in withRetry" };
    expect((await callOn(deps, "POST", `${P}/knowledge/propose`, `Bearer ${cli.access!}`, body)).status).toBe(200);
    expect(answer).toHaveBeenLastCalledWith({ method: "POST", path: `${P}/knowledge/propose`, authorization: `Bearer ${cli.access!}`, body: JSON.stringify(body) }, { kind: "person", personId: person("owner") });
    expect((await callOn(deps, "POST", `${P}/knowledge/propose`, `Bearer ${TOKEN}`, body)).status).toBe(200);
    expect(answer).toHaveBeenLastCalledWith({ method: "POST", path: `${P}/knowledge/propose`, authorization: `Bearer ${TOKEN}`, body: JSON.stringify(body) }, { kind: "token" });
    // No sign-in and a bad sign-in are refused before the API is asked; a GET, and a path next to it, are not this door (a token is refused there).
    expect((await callOn(deps, "POST", `${P}/knowledge/propose`, undefined, body)).status).toBe(401);
    expect((await callOn(deps, "POST", `${P}/knowledge/propose`, "Bearer not.a.jwt", body)).status).toBe(401);
    expect((await callOn(deps, "GET", `${P}/knowledge/propose`, `Bearer ${TOKEN}`)).status).toBe(404);
    expect((await callOn(deps, "POST", `${P}/knowledge/proposals`, `Bearer ${TOKEN}`, body)).status).toBe(404);
    expect(answer).toHaveBeenCalledTimes(2);
    // Without the wiring: a person is told the fixed off sentence, a token is refused.
    const bare: DeveloperRouteDependencies = { ...w.routes };
    expect(await callOn(bare, "POST", `${P}/knowledge/propose`, `Bearer ${cli.access!}`, body)).toMatchObject({ status: 200, body: { status: "off" } });
    expect(await callOn(bare, "POST", `${P}/knowledge/propose`, `Bearer ${TOKEN}`, body)).toMatchObject({ status: 401, body: { error: { code: "AUTH_REQUIRED", message: "Script tokens are turned off here." } } });
  });

  it("a script token needs no sign-in: the API is asked with the token's header, as a token; a made-up sign-in is not mistaken for one", async () => {
    const w = world();
    await w.setup();
    const answer = vi.fn(async () => ({ status: "ok", project: "payments", lessons: [], markdown: "", complete: true }));
    const deps = { ...w.routes, knowledge: { answer } satisfies KnowledgeApi } as DeveloperRouteDependencies;
    expect((await callOn(deps, "POST", `${P}/lessons`, `Bearer ${TOKEN}`, { files: ["a.ts"] })).status).toBe(200);
    expect(answer).toHaveBeenCalledWith({ method: "POST", path: `${P}/lessons`, authorization: `Bearer ${TOKEN}`, body: JSON.stringify({ files: ["a.ts"] }) }, { kind: "token" });
    // The token reaches no other route through this door: any other developer route still wants a real sign-in.
    expect((await callOn(deps, "GET", "/v1/dev/projects", `Bearer ${TOKEN}`)).status).toBe(401);
    expect((await callOn(deps, "PUT", `${P}/lessons/mode`, `Bearer ${TOKEN}`, { mode: "auto" })).status).toBe(401);
    expect((await callOn(deps, "GET", `${P}/lessons`, `Bearer ${TOKEN}`)).status).toBe(401);
    expect(answer).toHaveBeenCalledTimes(1);
  });

  it("without the wiring a person is given the fixed off answer after signing in, and a script token is refused; nothing is read", async () => {
    const w = world();
    await w.setup();
    const cli = await w.signIn("owner", { cli: true });
    const deps: DeveloperRouteDependencies = { ...w.routes };
    for (const [tool, shape] of [["lessons", { lessons: [] }], ["knowledge/areas", { repos: [], more: 0 }]] as const) {
      expect(await callOn(deps, "POST", `${P}/${tool}`, `Bearer ${cli.access!}`)).toMatchObject({ status: 200, body: { status: "off", reason: "install_switch", project: "payments", ...shape } });
      expect(await callOn(deps, "POST", `${P}/${tool}`, `Bearer ${TOKEN}`)).toMatchObject({ status: 401, body: { error: { code: "AUTH_REQUIRED", message: "Script tokens are turned off here." } } });
      expect((await callOn(deps, "POST", `${P}/${tool}`, undefined)).status).toBe(401);
    }
    expect((await callOn(deps, "POST", "/v1/dev/projects/%E0%A4%A/lessons", `Bearer ${cli.access!}`)).status).toBe(404);
  });

  it("a registered client that is not full access is refused by the route table, and the web app (full access) is not", async () => {
    const w = world();
    await w.setup();
    const answer = vi.fn(async () => ({ status: "ok", project: "payments", lessons: [], markdown: "", complete: true }));
    const deps = { ...w.routes, knowledge: { answer } satisfies KnowledgeApi } as DeveloperRouteDependencies;
    const web = await w.signIn("owner");
    expect((await callOn(deps, "POST", `${P}/lessons`, `Bearer ${web.access!}`)).status).toBe(200);
    // A registered client with a named scope but no full access (not the CLI, not the web app).
    const secret = "scoped-app-secret-for-tests";
    const before = new Date(w.now() - 86_400_000).toISOString();
    w.db.set({ pk: "SIGNIN_CLIENTS", sk: "CLIENT#scoped-app", entityType: "SIGN_IN_CLIENT", clientId: "scoped-app", name: "Scoped app", audience: "scoped-app", redirectUris: [WEB], loopback: false,
      installLevel: true, scopes: ["tasks:read"], secretHash: createHash("sha256").update(secret).digest("hex"), createdAt: before, updatedAt: before, updatedBy: "operator" });
    const back = await w.oidcSignIn("owner", { client_id: "scoped-app", redirect_uri: WEB });
    const grant = back.searchParams.get("code");
    expect(grant, back.toString()).not.toBeNull();
    const tokens = await w.exchange(grant!, { client_id: "scoped-app", client_secret: secret, redirect_uri: WEB });
    const limited = { access: tokens.body.access_token as string | undefined };
    expect(limited.access).toBeDefined();
    const refused = await callOn(deps, "POST", `${P}/lessons`, `Bearer ${limited.access!}`);
    expect(refused, JSON.stringify(refused)).toMatchObject({ status: 403 });
    expect(JSON.stringify(refused.body)).toContain("full access");
    expect(answer).toHaveBeenCalledTimes(1);
  });

  it("the route table's rows are additive: exactly these three rows are the knowledge rows, and each existing row keeps its method, path and scope", () => {
    const keyOf = (route: { method: string; path: string; requires: string }) => `${route.method} ${route.path} ${route.requires}`;
    const all = DEV_ROUTES.map(keyOf);
    expect(new Set(all).size).toBe(all.length);
    const added = all.filter((row) => row.includes("/knowledge/areas") || row.includes("/knowledge/propose") || row === "POST /v1/dev/projects/{project}/lessons full");
    expect(added).toEqual(["POST /v1/dev/projects/{project}/lessons full", "POST /v1/dev/projects/{project}/knowledge/areas full", "POST /v1/dev/projects/{project}/knowledge/propose full"]);
    // The digest of every other row (the order is the table's own).
    const others = all.filter((row) => !added.includes(row));
    expect(others).toHaveLength(DEV_ROUTES.length - 3);
    expect(createHash("sha256").update(others.join("\n")).digest("hex")).toBe(OTHER_ROWS_DIGEST);
  });
});

/** The digest of every DEV_ROUTES row except the two knowledge rows, as of the base this lane stacked on (code/next with #976): a changed, removed or loosened existing row changes it. */
// Batch 17 (rule D): re-pinned on batch 16's table plus the batch's other 13 new /v1/dev rows (#992 lessons areas/learning-sources x3, #1003's 9 phase-4 rows, #994's company/egress-addresses). All added, none
// changed: removing exactly those 13 rows gives 24c5e84b..., the digest of batch 16's whole DEV_ROUTES table.
// Batch 18 (rule D): with batch 16+17's table and the batch's new /v1/dev rows (#1017 GET lessons/tuning; #1029 POST lessons/{lessonId}/keep; #1034's five Rovara skills rows (GET skills, POST lessons/{lessonId}/skill,
// PUT skills/{skill}, POST skills/{skill}/approve and /retire); #1020's POST knowledge/propose; #1036's GET and PUT me/lessons-slack; #1051's GET lessons/replay). All added, none changed, the order of every earlier row kept:
// removing exactly those 11 rows gives back the batch 16+17 pin bb57d437e545367e483433b83f4d5de6048d8aab93a43882bc21316f82e73599 (the knowledge rows are left out of both).
// DEC 254zzz101 (rule D): #1100 stacks on #1086, whose own table (step-up removed) gives ff498627c2c192b3cb3ea56aa4fb04369cb6b6f2957598952f4b96d7ea4c128a here (the earlier pin was
// 94b5a951d82e3018901238dc6fdb2967296519a1554f994e650414e97b4ccbe0); #1100 adds two rows (GET company/members/handovers, POST company/members/{personId}/handover), none changed: removing
// exactly those 2 rows gives back ff498627....
const OTHER_ROWS_DIGEST = "ffcecbb6818e65c59557e3895af7f8aefa9c91e6482068e47be79ea678160801";
