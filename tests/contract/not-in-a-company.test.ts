// #1612: a signed-in person with no company membership on the install is told so (403 FORBIDDEN, fixed words), never "sign in again" or "your sign-in has ended":
// signing in again cannot change it. A revoked or malformed membership is still the sign-in refusal, and a read that fails is still the retryable 503.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NOT_IN_A_COMPANY_MESSAGE, type DocumentStore } from "@agentx/contracts";
import { companyMembershipFromStore, resolveCompany } from "../../packages/broker/src/aws/company-check.js";
import { CORE_APP_SIGN_IN_AGAIN, coreAppEntryFrom } from "../../packages/broker/src/aws/core-app-routes.js";
import type { CoreEntryCaller } from "../../packages/broker/src/aws/engine-boundary.js";
import type { BrokerRequest, BrokerResponse } from "../../packages/broker/src/handler.js";
import { developerTokenKey, saveDeveloperEnvironment } from "../../packages/cli/src/developer/config.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";

const PERSON = "a".repeat(64);
const COMPANY = "org_0123456789abcdefghij";
const TIME = "2026-11-27T12:00:00.000Z";
const row = (patch: Record<string, unknown> = {}) => ({ entityType: "COMPANY_MEMBERSHIP", personId: PERSON, companyId: COMPANY, role: "member", joinedAt: TIME, ...patch });
const storeWith = (item: unknown): Pick<DocumentStore, "get"> & { reads: ReturnType<typeof vi.fn> } => {
  const reads = vi.fn();
  return { reads, get: (async (key: unknown) => { reads(key); return item; }) as DocumentStore["get"] };
};

describe("the membership reader tells a person who never joined from a removed one", () => {
  it("is absent only when there is no membership row at all", async () => {
    expect(await companyMembershipFromStore(storeWith(undefined)).absent!(PERSON)).toBe(true);
    expect(await companyMembershipFromStore(storeWith(row())).absent!(PERSON)).toBe(false);
    expect(await companyMembershipFromStore(storeWith(row({ revokedAt: TIME }))).absent!(PERSON)).toBe(false);
    expect(await companyMembershipFromStore(storeWith(row({ role: "root" }))).absent!(PERSON)).toBe(false);
  });

  it("reads nothing for a malformed person id, and a read that fails is the retryable error", async () => {
    const store = storeWith(undefined);
    for (const person of ["", "x#y", "x y", "x".repeat(257)]) expect(await companyMembershipFromStore(store).absent!(person)).toBe(false);
    expect(store.reads).not.toHaveBeenCalled();
    const failing = companyMembershipFromStore({ get: (async () => { throw new Error("private-canary"); }) });
    await expect(failing.absent!(PERSON)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("refuses a person with no membership row as not in a company, and a revoked one with the sign-in refusal", async () => {
    await expect(resolveCompany(companyMembershipFromStore(storeWith(undefined)), PERSON)).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403, message: `FORBIDDEN: ${NOT_IN_A_COMPANY_MESSAGE}` });
    await expect(resolveCompany(companyMembershipFromStore(storeWith(row({ revokedAt: TIME }))), PERSON)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    await expect(resolveCompany(companyMembershipFromStore(storeWith(row())), PERSON)).resolves.toBe(COMPANY);
    // A reader without the absence check (a host's own) keeps the sign-in refusal.
    await expect(resolveCompany({ companyOf: async () => undefined }, PERSON)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    // The absence check failing is the retryable error, never a refusal.
    await expect(resolveCompany({ companyOf: async () => undefined, absent: async () => { throw new Error("private-canary"); } }, PERSON)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });
});

describe("the core's /v1/app entry", () => {
  const caller: CoreEntryCaller = { developerId: PERSON, sessionId: "s", name: "Ada" };
  const request: BrokerRequest = { method: "GET", path: "/v1/app/sessions", headers: {} };
  const routes = { route: async (): Promise<BrokerResponse | undefined> => ({ statusCode: 200, headers: {}, body: "{}" }) };
  const entry = (notInACompany?: () => Promise<boolean>) => coreAppEntryFrom({ routes, personErase: routes, deployedCallerOf: async () => undefined, log: () => undefined, ...(notInACompany === undefined ? {} : { notInACompany }) });
  const errorOf = (answer: BrokerResponse | undefined) => ({ status: answer?.statusCode, error: (JSON.parse(answer!.body) as { error: unknown }).error });

  it("tells a person with no membership row they are in no company", async () => {
    expect(errorOf(await entry(async () => true).route(request, caller))).toEqual({ status: 403, error: { code: "FORBIDDEN", message: NOT_IN_A_COMPANY_MESSAGE } });
  });

  it("keeps the sign-in refusal for a revoked membership, or where the deployment gives no absence check", async () => {
    for (const answer of [await entry(async () => false).route(request, caller), await entry().route(request, caller)]) {
      expect(errorOf(answer)).toEqual({ status: 401, error: { code: "UNAUTHENTICATED", message: CORE_APP_SIGN_IN_AGAIN } });
    }
  });

  it("answers the retryable 503 when the absence check fails", async () => {
    expect(errorOf(await entry(async () => { throw new Error("private-canary"); }).route(request, caller)).status).toBe(503);
  });
});

describe("the command line", () => {
  const ORIGIN = "http://127.0.0.1:4411";
  const ISSUER = `${ORIGIN}/v1/auth`;
  const dirs: string[] = [];
  afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

  async function run(argv: string[]) {
    const home = await mkdtemp(join(tmpdir(), "rovara-no-company-"));
    dirs.push(home);
    await saveDeveloperEnvironment(home, "laptop", { url: ORIGIN, issuer: ISSUER, tokenEndpoint: `${ISSUER}/token`, revocationEndpoint: `${ISSUER}/revoke` });
    const tokenStore = new InMemoryTokenStore();
    await tokenStore.set(developerTokenKey(ISSUER), { accessToken: "token", refreshToken: `agxr_${"a".repeat(43)}`, expiresAt: Date.now() + 3_600_000 });
    const out: string[] = [];
    const fetchImplementation: typeof fetch = async () => new Response(JSON.stringify({ error: { code: "FORBIDDEN", message: NOT_IN_A_COMPANY_MESSAGE } }), { status: 403, headers: { "content-type": "application/json" } });
    const write = { write: (text: string) => out.push(text) };
    const code = await executeCli(["--env", "laptop", ...argv], { fetchImplementation, tokenStore, environments: { home }, stdout: write, stderr: write });
    return { code, text: out.join("") };
  }

  it.each([["sessions"], ["whoami"]])("`%s` prints that the person is in no company, not that the sign-in ended", async (command) => {
    const { code, text } = await run([command]);
    expect(code).not.toBe(0);
    expect(text).toContain(NOT_IN_A_COMPANY_MESSAGE);
    expect(text).not.toMatch(/sign-in .*has ended/u);
  });
});
