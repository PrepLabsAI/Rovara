// Evaluation fix RUN-3: the browser and API runtime registration expires after seven days and when an image changes, and only an operator's script renews it. agentx doctor and the TEST
// deploy check warn ahead of time, naming the expiry time and the exact renew command; the control plane tells an administrator state and times (and nothing else of a row).
import { describe, expect, it } from "vitest";
import {
  E2ERuntimeStatusSchema, E2E_RUNTIME_EXPIRY_ERROR_MS, E2E_RUNTIME_EXPIRY_WARNING_MS, E2E_RUNTIME_GENERIC_RENEW_COMMAND, e2eRuntimeExpiryNotice, e2eRuntimeRenewCommand,
} from "../../packages/contracts/src/index.js";
import { readRuntimeStatus, runtimeChecks, type RuntimeStatusRead } from "../../packages/cli/src/doctor/runtime.js";
import type { DoctorContext } from "../../packages/cli/src/doctor/checks.js";
import { e2eRegisteredRuntimeKey } from "../../packages/broker/src/aws/e2e-runtime-readiness.js";
import { createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { call } from "../support/slack-broker.js";
import { PROFILE, webApiRow } from "../support/e2e-application-plan-fixtures.js";

const NOW = Date.parse("2026-10-20T18:00:00.000Z");
const at = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();
const RENEW = "npx tsx scripts/test-qualify-runtime.ts --env agentxlivetest123 --profile agentx-test --apply";

describe("the renew command and the expiry notice", () => {
  it("is the one command that qualifies the runtime again, with the environment and the AWS profile", () => {
    expect(e2eRuntimeRenewCommand({ env: "agentxlivetest123", profile: "agentx-test" })).toBe(RENEW);
    expect(E2E_RUNTIME_GENERIC_RENEW_COMMAND).toBe("npx tsx scripts/test-qualify-runtime.ts --env <env> --profile <aws-profile> --apply");
  });

  it("says nothing for 48 hours or more, warns below 48 hours, and is an error below 24 hours, when expired and when unreadable", () => {
    const notice = (expiresAt: string) => e2eRuntimeExpiryNotice({ subject: "the web runtime", expiresAt, now: NOW, renewCommand: RENEW });
    expect(E2E_RUNTIME_EXPIRY_WARNING_MS).toBe(48 * 3_600_000);
    expect(E2E_RUNTIME_EXPIRY_ERROR_MS).toBe(24 * 3_600_000);
    expect(notice(at(48))).toBeUndefined();
    expect(notice(at(47.9))).toMatchObject({ severity: "warning" });
    expect(notice(at(24))).toMatchObject({ severity: "warning" });
    expect(notice(at(23.9))).toMatchObject({ severity: "error" });
    expect(notice(at(0))).toMatchObject({ severity: "error" });
    expect(notice(at(-5))).toMatchObject({ severity: "error", problem: `the web runtime expired at ${at(-5)}, so browser and API checks cannot run` });
    expect(notice("not a date")).toMatchObject({ severity: "error" });
    expect(notice(at(30))).toMatchObject({ problem: `the web runtime expires at ${at(30)}, in 30.0 hours, and browser and API checks stop then`, renewCommand: RENEW,
      message: `the web runtime expires at ${at(30)}, in 30.0 hours, and browser and API checks stop then; renew it with: ${RENEW}` });
  });
});

describe("GET /v1/admin/runtime-installation/status", () => {
  const admin = { subject: "admin-subject", admin: true };
  async function controlPlane(options: { catalog?: boolean } = {}) {
    const harness = await createDeveloperTaskBroker({ brokerExtra: options.catalog === false ? {} : { e2eFeatureRuntimeCatalogId: "catalog" } });
    const put = (kind: "web" | "api", overrides: Record<string, unknown> = {}) => harness.db.set({ ...e2eRegisteredRuntimeKey("catalog", PROFILE, kind), ...webApiRow(kind, overrides) });
    const status = (user: { subject: string; admin: boolean } = admin) => call(harness.handler, { method: "GET", path: "/v1/admin/runtime-installation/status", user });
    return { harness, put, status };
  }

  it("answers the state and the times of each kind that has a row, and nothing else of the row", async () => {
    const h = await controlPlane();
    h.put("web", { expiresAt: at(30), qualifiedAt: at(-100) });
    h.put("api", { state: "PARKED", expiresAt: at(200), qualifiedAt: at(-1) });
    const answer = await h.status();
    expect(answer.status).toBe(200);
    expect(E2ERuntimeStatusSchema.parse(answer.body)).toMatchObject({ rows: [
      { kind: "web", profileId: PROFILE, state: "READY", qualifiedAt: at(-100), expiresAt: at(30) },
      { kind: "api", profileId: PROFILE, state: "PARKED", qualifiedAt: at(-1), expiresAt: at(200) },
    ] });
    expect(JSON.stringify(answer.body)).not.toMatch(/endpoint|10\.0\.0\.8|Digest|binding|evidence|probe/i);
  });

  it("answers an empty list for a catalog with no row, is for administrators only, and says when the deployment has no catalog", async () => {
    const h = await controlPlane();
    expect(await h.status()).toMatchObject({ status: 200, body: { rows: [] } });
    expect(await h.status({ subject: "someone", admin: false })).toMatchObject({ status: 403 });
    const none = await controlPlane({ catalog: false });
    expect(await none.status()).toMatchObject({ status: 404, body: { error: { message: "browser and API runtimes are not set up in this deployment" } } });
  });

  it("leaves a row that does not read as state and times out of the answer, instead of guessing", async () => {
    const h = await controlPlane();
    h.put("web");
    h.harness.db.set({ ...e2eRegisteredRuntimeKey("catalog", PROFILE, "api"), entityType: "E2E_FEATURE_VERIFIER", state: 7 });
    expect((await h.status()).body).toMatchObject({ rows: [{ kind: "web" }] });
  });
});

describe("readRuntimeStatus", () => {
  const session = { controlPlaneUrl: "https://cp.example.test/", accessToken: "tok" };
  const answering = (response: Response) => (async () => response) as unknown as typeof fetch;
  it("is signed out without a session or with a refused one, not set up on a 404, and reads the rows otherwise", async () => {
    expect(await readRuntimeStatus(answering(Response.json({ rows: [] })), undefined)).toEqual({ kind: "signed-out" });
    expect(await readRuntimeStatus(answering(new Response("", { status: 401 })), session)).toEqual({ kind: "signed-out" });
    expect(await readRuntimeStatus(answering(new Response("", { status: 403 })), session)).toEqual({ kind: "signed-out" });
    expect(await readRuntimeStatus(answering(new Response("", { status: 404 })), session)).toEqual({ kind: "not-set-up" });
    expect(await readRuntimeStatus(answering(Response.json({ rows: [{ kind: "web", profileId: PROFILE, state: "READY", qualifiedAt: at(-1), expiresAt: at(100) }] })), session, "agentx-test"))
      .toMatchObject({ kind: "status", awsProfile: "agentx-test", status: { rows: [{ kind: "web" }] } });
  });
  it("throws, rather than reading as healthy, on a server error or an answer it does not understand", async () => {
    await expect(readRuntimeStatus(answering(new Response("", { status: 500 })), session)).rejects.toThrow(/HTTP 500/);
    await expect(readRuntimeStatus(answering(Response.json({ rows: [{ kind: "web" }] })), session)).rejects.toThrow(/unexpected/);
    await expect(readRuntimeStatus(answering(new Response("not json", { status: 200 })), session)).rejects.toThrow(/unexpected/);
  });
});

describe("agentx doctor's browser and API runtime checks", () => {
  const row = (kind: "web" | "api", overrides: Partial<{ state: string; expiresAt: string }> = {}) =>
    ({ kind, profileId: PROFILE, state: "READY", qualifiedAt: at(-24), expiresAt: at(24 * 6), ...overrides });
  const context = (read: (() => Promise<RuntimeStatusRead>) | undefined) => ({ env: "agentxlivetest123", services: { now: () => NOW, ...(read === undefined ? {} : { runtime: read }) } }) as unknown as DoctorContext;
  const lines = async (result: RuntimeStatusRead) => (await runtimeChecks(context(async () => result))).map(({ name, status, detail, fix }) => ({ name, status, detail, ...(fix === undefined ? {} : { fix }) }));
  const status = (rows: ReturnType<typeof row>[], awsProfile: string | null = "agentx-test"): RuntimeStatusRead => ({ kind: "status", status: { rows }, ...(awsProfile === null ? {} : { awsProfile }) });

  it("is ok for a registration good for 48 hours or more, and says until when", async () => {
    expect(await lines(status([row("web"), row("api")]))).toEqual([
      { name: "api runtime", status: "ok", detail: `qualified, good until ${at(24 * 6)}` },
      { name: "web runtime", status: "ok", detail: `qualified, good until ${at(24 * 6)}` },
    ]);
  });

  it("warns, naming the expiry time and the exact renew command, from 48 hours before, and when it has expired", async () => {
    expect(await lines(status([row("web", { expiresAt: at(40) }), row("api", { expiresAt: at(-3) })]))).toEqual([
      { name: "api runtime", status: "warn", detail: `the api runtime expired at ${at(-3)}, so browser and API checks cannot run`, fix: `renew it with: ${RENEW}` },
      { name: "web runtime", status: "warn", detail: `the web runtime expires at ${at(40)}, in 40.0 hours, and browser and API checks stop then`, fix: `renew it with: ${RENEW}` },
    ]);
  });

  it("warns for a registration that is not READY (an image change parks it), with the same command", async () => {
    const [web] = await lines(status([row("web", { state: "PARKED" })]));
    expect(web).toEqual({ name: "web runtime", status: "warn", detail: "the web runtime is PARKED, so browser and API checks cannot run", fix: `qualify the runtime again with: ${RENEW}` });
  });

  it("fills the environment in and leaves the AWS profile to the reader when this computer names none", async () => {
    const [web] = await lines(status([row("web", { expiresAt: at(30) })], null));
    expect(web!.fix).toBe("renew it with: npx tsx scripts/test-qualify-runtime.ts --env agentxlivetest123 --profile <aws-profile> --apply");
  });

  it("skips, saying why, with no sign-in, no deployment support, no rows, or an agentx that cannot check", async () => {
    expect((await lines({ kind: "signed-out" }))[0]!.fix).toContain("login --admin");
    expect((await lines({ kind: "signed-out" }))[0]!.status).toBe("skip");
    expect((await lines({ kind: "not-set-up" }))[0]).toMatchObject({ status: "skip" });
    expect((await lines(status([])))[0]).toMatchObject({ status: "skip" });
    expect((await lines(status([])))[0]!.detail).toContain("no browser and API runtime has been qualified");
    expect(await runtimeChecks(context(undefined))).toMatchObject([{ status: "skip", detail: "not checked by this agentx" }]);
  });
});
