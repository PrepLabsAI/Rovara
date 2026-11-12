// Spec 063 phase 063a (FR-001): an administrator registers and removes the services that sign Rovara users in, as
// admin changes applied through DeveloperIdentity, which owns the registry. Only a secret's hash is ever sent or kept.
import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SIGN_IN_CLIENTS_PK, SignInClientRegistrationSchema, type AdminChangeInput } from "@agentx/contracts";
import { signInClientsThroughLambda } from "../../packages/broker/src/aws/developer-routes.js";
import { newClientSecret, signInClientId, signInClientRegistration } from "../../packages/cli/src/admin/sign-in-clients.js";
import { tokenStoreKey } from "../../packages/cli/src/auth.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";
import { createAdminChangeBroker } from "../support/admin-change-broker.js";
import { identityHarness } from "../support/developer-fakes.js";

const registration = { name: "Scheduler", audience: "scheduler", redirectUris: ["https://scheduler.example.com/callback"], loopback: true };

/** The broker's registry, reaching a real DeveloperIdentity handler as the Lambda invoke does. */
function registryOverIdentity() {
  const identity = identityHarness();
  const registry = signInClientsThroughLambda(async (payload) => {
    const answer = await identity.handler(JSON.parse(new TextDecoder().decode(payload)) as never);
    return { Payload: new TextEncoder().encode(JSON.stringify(answer)) };
  });
  return { identity, registry, rows: () => identity.db.find((item) => item.pk === SIGN_IN_CLIENTS_PK) };
}

async function setUp() {
  const { identity, registry, rows } = registryOverIdentity();
  const harness = await createAdminChangeBroker({ signInClients: registry });
  const change = async (input: AdminChangeInput) => {
    const planned = await harness.propose(input, ["cli"]);
    return { planned, apply: () => harness.apply((planned.body.change as { changeId: string }).changeId, "cli") };
  };
  return { identity, harness, rows, change };
}

describe("a sign-in client's registration (FR-001)", () => {
  it("refuses Rovara's own client and audience, a plain-http or private redirect, and a client with nowhere to return", () => {
    expect(() => signInClientId("agentx-cli")).toThrow("not agentx-cli");
    expect(() => signInClientId("Scheduler")).toThrow("lower-case");
    expect(() => signInClientRegistration("scheduler", { audience: "agentx-developer", loopback: true })).toThrow("--audience");
    expect(() => signInClientRegistration("scheduler", { audience: "scheduler", redirect: ["http://scheduler.example.com/cb"] })).toThrow("--redirect");
    expect(() => signInClientRegistration("scheduler", { audience: "scheduler", redirect: ["https://10.0.0.5/cb"] })).toThrow("--redirect");
    expect(() => signInClientRegistration("scheduler", { audience: "scheduler" })).toThrow("a redirect URL, a loopback redirect, or both");
    expect(SignInClientRegistrationSchema.safeParse({ ...registration, secret: "plain" }).success).toBe(false);
  });

  it("makes a secret whose SHA-256 is the only part that leaves the CLI", () => {
    const { secret, secretHash } = newClientSecret();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(secretHash).toBe(createHash("sha256").update(secret).digest("hex"));
    const made = signInClientRegistration("scheduler", { audience: "scheduler", loopback: true, confidential: true }, secretHash);
    expect(JSON.stringify(made)).not.toContain(secret);
    expect(made).toEqual({ name: "scheduler", audience: "scheduler", redirectUris: [], loopback: true, secretHash });
  });
});

describe("registering and removing, as admin changes (FR-001)", () => {
  it("shows the effect first, and keeps the client in the sign-in table only once applied", async () => {
    const { harness, rows, change } = await setUp();
    const { secretHash } = newClientSecret();
    const { planned, apply } = await change({ kind: "register_sign_in_client", clientId: "scheduler", registration: { ...registration, secretHash } });
    expect(planned.status).toBe(201);
    const view = planned.body.change as { effect: string; details: Record<string, unknown> };
    expect(view.effect).toContain("Register sign-in client scheduler (Scheduler)");
    expect(view.effect).toContain("tokens addressed to scheduler, which AgentX's own API never accepts");
    expect(view.effect).toContain("It is confidential");
    expect(JSON.stringify(view)).not.toContain(secretHash);
    expect(rows()).toEqual([]);

    expect((await apply()).body.change).toMatchObject({ status: "applied" });
    expect(rows()).toEqual([expect.objectContaining({ sk: "CLIENT#scheduler", audience: "scheduler", secretHash, loopback: true })]);
    // The list never carries the hash, only whether there is one.
    const listed = await harness.admin("GET", "/v1/admin/sign-in-clients");
    expect(listed.body.clients).toEqual([expect.objectContaining({ clientId: "scheduler", confidential: true })]);
    expect(JSON.stringify(listed.body)).not.toContain(secretHash);
  });

  it("replaces a client keeping when it was made, and refuses another client's audience", async () => {
    const { rows, change } = await setUp();
    await (await change({ kind: "register_sign_in_client", clientId: "scheduler", registration })).apply();
    const createdAt = rows()[0]?.createdAt;
    const replaced = await change({ kind: "register_sign_in_client", clientId: "scheduler", registration: { ...registration, loopback: false } });
    expect((replaced.planned.body.change as { effect: string }).effect).toContain("Replace sign-in client scheduler");
    await replaced.apply();
    expect(rows()).toEqual([expect.objectContaining({ loopback: false, createdAt })]);

    const clash = await change({ kind: "register_sign_in_client", clientId: "dashboard", registration: { ...registration, name: "Dashboard" } });
    expect(clash.planned.status).toBe(400);
    expect(JSON.stringify(clash.planned.body)).toContain("sign-in client scheduler already uses the audience scheduler");
  });

  it("removes a client, and refuses to plan removing one that is not there", async () => {
    const { rows, change } = await setUp();
    await (await change({ kind: "register_sign_in_client", clientId: "scheduler", registration })).apply();
    const removal = await change({ kind: "remove_sign_in_client", clientId: "scheduler" });
    expect((removal.planned.body.change as { effect: string }).effect).toContain("Remove sign-in client scheduler (Scheduler): nobody can sign in to it");
    expect((await removal.apply()).body.change).toMatchObject({ status: "applied" });
    expect(rows()).toEqual([]);
    expect((await change({ kind: "remove_sign_in_client", clientId: "scheduler" })).planned.status).toBe(404);
  });

  it("is for administrators only, and not found where developer sign-in is not set up", async () => {
    const { harness } = await setUp();
    expect((await harness.admin("GET", "/v1/admin/sign-in-clients", { admin: false })).status).toBe(403);
    const without = await createAdminChangeBroker();
    expect((await without.propose({ kind: "register_sign_in_client", clientId: "scheduler", registration }, ["cli"])).status).toBe(404);
    expect((await without.admin("GET", "/v1/admin/sign-in-clients")).status).toBe(404);
  });
});

describe("agentx admin sign-in-client (FR-001)", () => {
  const CHANGE = "55555555-5555-4555-8555-555555555555";
  const view = (status: string) => ({ changeId: CHANGE, kind: "register_sign_in_client", status, effect: "Register sign-in client scheduler (Scheduler).", methodsOffered: ["cli"], createdAt: "2026-11-12T09:00:00.000Z", expiresAt: "2026-11-12T09:10:00.000Z", ...(status === "applied" ? { methodUsed: "cli" } : {}) });
  const deployment = { controlPlaneUrl: "http://127.0.0.1:8787", auth: { issuer: "https://identity.example.test", clientId: "agentx-client", audience: "agentx-api" } };

  async function cli(outcome: "applied" | "declined") {
    const directory = await mkdtemp(join(tmpdir(), "agentx-cli-sign-in-clients-"));
    const deploymentFile = join(directory, "deployment.yaml");
    await writeFile(deploymentFile, JSON.stringify(deployment), "utf8");
    const tokens = new InMemoryTokenStore();
    await tokens.set(tokenStoreKey(deployment.auth), { accessToken: "access-secret-9d2e", expiresAt: Date.now() + 60_000 });
    const bodies: unknown[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname;
      if (init?.body !== undefined) bodies.push(JSON.parse(init.body as string));
      if (path === "/v1/admin/changes") return Response.json({ change: view("pending") });
      return Response.json({ change: view(path.endsWith("/apply") ? "applied" : "declined") });
    }) as unknown as typeof globalThis.fetch;
    let stdout = "";
    let stderr = "";
    const io = { fetchImplementation: fetch, tokenStore: tokens, confirm: async () => outcome === "applied", stdout: { write: (text: string) => { stdout += text; return true; } }, stderr: { write: (text: string) => { stderr += text; return true; } } };
    const run = (args: string[]) => executeCli(["--config-dir", directory, "--deployment-file", deploymentFile, "--allow-loopback", "admin", "sign-in-client", ...args], io);
    return { run, bodies, directory, out: () => stdout, err: () => stderr };
  }

  it("sends only the secret's hash, and shows the secret once the change applied", async () => {
    const session = await cli("applied");
    expect(await session.run(["add", "scheduler", "--name", "Scheduler", "--audience", "scheduler", "--loopback", "--confidential"])).toBe(0);
    const secret = /Client secret \(shown once[^\n]*\n([A-Za-z0-9_-]{43})\n/.exec(session.err())?.[1];
    expect(secret).toBeDefined();
    const sent = (session.bodies[0] as { change: { registration: { secretHash: string } } }).change;
    expect(sent).toEqual({ kind: "register_sign_in_client", clientId: "scheduler", registration: { name: "Scheduler", audience: "scheduler", redirectUris: [], loopback: true, secretHash: createHash("sha256").update(secret!).digest("hex") } });
    expect(JSON.stringify(session.bodies)).not.toContain(secret);
  });

  it("writes the secret to --secret-file before applying, and removes it when the change is declined", async () => {
    const applied = await cli("applied");
    const file = join(applied.directory, "scheduler.secret");
    expect(await applied.run(["add", "scheduler", "--audience", "scheduler", "--loopback", "--confidential", "--secret-file", file])).toBe(0);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const secret = (await readFile(file, "utf8")).trim();
    expect(`${applied.out()}${applied.err()}`).not.toContain(secret);

    const declined = await cli("declined");
    const other = join(declined.directory, "scheduler.secret");
    expect(await declined.run(["add", "scheduler", "--audience", "scheduler", "--loopback", "--confidential", "--secret-file", other])).toBe(0);
    await expect(stat(other)).rejects.toThrow();
    expect(declined.err()).not.toContain("Client secret");
  });

  it("refuses a bad client before calling AgentX", async () => {
    const session = await cli("applied");
    expect(await session.run(["add", "agentx-cli", "--audience", "scheduler", "--loopback"])).toBe(2);
    expect(await session.run(["add", "scheduler", "--audience", "scheduler", "--loopback", "--secret-file", "x"])).toBe(2);
    expect(session.err()).toContain("--secret-file only goes with --confidential");
    expect(session.bodies).toEqual([]);
  });
});
