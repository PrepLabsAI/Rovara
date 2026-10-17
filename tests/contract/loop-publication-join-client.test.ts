import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { developerTokenKey, saveDeveloperEnvironment } from "../../packages/cli/src/developer/config.js";
import { createDeveloperPublicationJoinTransport } from "../../packages/cli/src/loop/enrollment-cli.js";
import { RegisteredEnrollmentSchema, resolveRegisteredPublication, type RegisteredEnrollment } from "../../packages/cli/src/loop/enrollment.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";

const dirs: string[] = [];
const servers: Server[] = [];
const makeEnrollment = (baseUrl: string): RegisteredEnrollment => ({
  schemaVersion: 1, kind: "registered", enrollmentId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", namespace: `${baseUrl}/env/dev/project/payments`,
  hostId: "host-a", uid: 501, account: "maya", project: "payments", projectRevision: 3,
  repository: "acme/payments", repositoryId: 1234, checkoutPath: "/work/payments", commonGitDir: "/work/payments/.git",
  sourceBindingRef: `cli-source:v1:${"a".repeat(64)}`, taskRef: "11111111-2222-4333-8444-555555555555", enrolledAt: "2026-10-14T10:00:00.000Z",
});
const subject = { projectName: "payments", projectRevision: 3, repositoryId: 1234, commitSha: "a".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "c".repeat(40) };

async function fixture(baseUrl: string) {
  const home = await mkdtemp(join(tmpdir(), "rovara-join-client-"));
  dirs.push(home);
  const tokenStore = new InMemoryTokenStore();
  const issuer = "https://identity.control.example/";
  await saveDeveloperEnvironment(home, "dev", { url: baseUrl, issuer, tokenEndpoint: "https://identity.control.example/token", revocationEndpoint: "https://identity.control.example/revoke" });
  await tokenStore.set(developerTokenKey(issuer), { accessToken: "synthetic-cli-session", expiresAt: Date.now() + 600_000 });
  return { home, tokenStore };
}

async function serve(handler: (request: Request) => Response | Promise<Response>): Promise<string> {
  const server = createServer((request, response) => {
    void (async () => {
      request.setEncoding("utf8");
      const body = await new Promise<string>((resolve, reject) => {
        let text = "";
        request.on("data", (chunk: string) => { text += chunk; });
        request.on("end", () => resolve(text));
        request.on("error", reject);
      });
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      const webRequest = new Request(`http://127.0.0.1${request.url ?? "/"}`, {
        method: request.method ?? "GET", headers, ...(body.length === 0 ? {} : { body }),
      });
      const result = await handler(webRequest);
      response.writeHead(result.status, Object.fromEntries(result.headers.entries()));
      response.end(await result.text());
    })().catch((error: unknown) => {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : "fixture handler failed");
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server did not bind a TCP port");
  return `http://127.0.0.1:${address.port}`;
}

describe("the authenticated registered publication join client", () => {
  it("sends the frozen subject and opaque host binding through the CLI developer session", async () => {
    let received: { path?: string; authorization?: string; body?: unknown } = {};
    const baseUrl = await serve(async (request) => {
      const authorization = request.headers.get("authorization");
      received = { path: new URL(request.url).pathname, ...(authorization === null ? {} : { authorization }), body: await request.json() };
      await new Promise((resolve) => setTimeout(resolve, 55));
      return Response.json({ schemaVersion: 1, status: "READY", requestId: "response-1", subject, candidateDigest: "d".repeat(64), contractDigest: "e".repeat(64), policyDigest: "f".repeat(64), planDigest: "1".repeat(64), roundId: "round-current", evidenceSetDigest: "2".repeat(64), checkedAt: new Date().toISOString() });
    });
    const h = await fixture(baseUrl);
    const enrollment = makeEnrollment(baseUrl);
    expect(RegisteredEnrollmentSchema.safeParse(enrollment)).toMatchObject({ success: true });
    const transport = createDeveloperPublicationJoinTransport({ home: h.home, env: "dev", tokenStore: h.tokenStore, fetch: fetch.bind(globalThis) });
    const result = await resolveRegisteredPublication({ enrollment, subject, taskRef: enrollment.taskRef, transport, now: Date.now });
    if (result.kind !== "ready") throw new Error(JSON.stringify(result));
    expect(result).toMatchObject({ kind: "ready", response: { roundId: "round-current", requestId: "response-1" } });
    expect(received).toEqual({
      path: `/v1/dev/tasks/${enrollment.taskRef}/e2e-publication-context`, authorization: "Bearer synthetic-cli-session",
      body: { taskRef: enrollment.taskRef, subject, sourceBindingRef: enrollment.sourceBindingRef },
    });
  });

  it("holds refused requests and rejects a non-UUID task selector before sending it", async () => {
    let requests = 0;
    const baseUrl = await serve(async () => { requests += 1; return Response.json({ error: "denied" }, { status: 403 }); });
    const h = await fixture(baseUrl);
    const enrollment = makeEnrollment(baseUrl);
    const transport = createDeveloperPublicationJoinTransport({ home: h.home, env: "dev", tokenStore: h.tokenStore, fetch: fetch.bind(globalThis) });
    expect(RegisteredEnrollmentSchema.safeParse(enrollment)).toMatchObject({ success: true });
    const refusal = await resolveRegisteredPublication({ enrollment, subject, taskRef: enrollment.taskRef, transport, now: Date.now });
    expect(refusal).toEqual({ kind: "hold", reasonCode: "native_join_unavailable" });
    await expect(resolveRegisteredPublication({ enrollment, subject, taskRef: "not-a-uuid", transport, now: Date.now }))
      .resolves.toEqual({ kind: "hold", reasonCode: "task_binding_invalid" });
    expect(requests).toBe(1);
  });

  it("holds a registered namespace from another selected environment before sending any request", async () => {
    let requests = 0;
    const ready = { schemaVersion: 1, status: "READY", subject, candidateDigest: "d".repeat(64), contractDigest: "e".repeat(64), policyDigest: "f".repeat(64), planDigest: "1".repeat(64), roundId: "same-round", evidenceSetDigest: "2".repeat(64), checkedAt: new Date().toISOString() };
    const authorityA = await serve(async () => Response.json(ready));
    const selectedB = await serve(async () => { requests += 1; return Response.json(ready); });
    const h = await fixture(selectedB);
    const enrollment = makeEnrollment(authorityA);
    const transport = createDeveloperPublicationJoinTransport({ home: h.home, env: "dev", tokenStore: h.tokenStore, fetch: fetch.bind(globalThis) });
    const result = await resolveRegisteredPublication({ enrollment, subject, taskRef: enrollment.taskRef, transport, now: Date.now });
    expect(result).toEqual({ kind: "hold", reasonCode: "native_join_unavailable" });
    expect(requests).toBe(0);
  });
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
