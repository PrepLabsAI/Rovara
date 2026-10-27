import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  E2E_EXECUTOR_COMPILED_ORIGIN, E2E_MODEL_SESSION_SYNC_MAX_VALUE_CHARS, E2E_MODEL_SESSION_SYNC_SLICE_CHARS, E2EModelChannelStepMarkerSchema, boundSessionValue, readE2EApplicationProjectContract,
  type E2EModelChannelClient,
} from "@agentx/contracts";
import { createGovernedE2EModelRoute, createInMemoryE2EDayBudget, type E2EInvoke } from "../../packages/model-runtime/src/e2e-route.js";
import { createExecutorSessionStore } from "../../packages/verifier/src/executor/accounts.js";
import { beginMarkerSessionValues } from "../../packages/verifier/src/executor/begin-marker-values.js";
import { createE2EAgentStepDriver } from "../../packages/verifier/src/executor/agent-step-driver.js";
import { generateE2EAgentValueKey } from "../../packages/contracts/src/e2e-model-channel.js";
import { createE2EModelChannelClient } from "../../packages/verifier/src/executor/model-channel.js";
import { createE2ESessionSyncSource } from "../../packages/verifier/src/executor/session-sync.js";
import type { FormLoginDriver, FormLoginStorageState, FormRequestContext } from "../../packages/verifier/src/executor/form-login.js";
import { createE2ESessionSyncLedger } from "../../packages/worker/src/e2e-model-session-sync.js";
import { startE2EModelProxy, type E2EModelEvidenceSink, type E2EModelProxy } from "../../packages/worker/src/e2e-model-proxy.js";
import { e2eSecretSpellings, e2eSecretSpellingsDetailed } from "../../packages/worker/src/e2e-secret-spellings.js";
import { createAccountsExecutorPlan } from "../support/e2e-accounts-fixture.js";
import { cleanRedirectingEnvironment } from "../support/e2e-clean-environment.js";
import { CASE_ID, RUN_ID, bedrockRoute, call, tapAnswer } from "../support/e2e-model-fixtures.js";

// MIDSTEPCOOKIE fix round 2: N-1 (a cut through a surrogate pair must not crash the worker) and R-1 (the values registered at sign-in follow the same classifier and bounds as the sync).

const POSITION = { caseId: CASE_ID, stepIndex: 0 };
const EMOJI = "\u{1F600}";
const wellFormed = (text: string) => !Array.from(text).some((character) => character.length === 1 && character.charCodeAt(0) >= 0xd800 && character.charCodeAt(0) <= 0xdfff);

let dir: string;
const closers: Array<() => Promise<unknown>> = [];
beforeEach(async () => { cleanRedirectingEnvironment(); dir = await mkdtemp(join(tmpdir(), "r2-")); });
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close().catch(() => undefined); await rm(dir, { recursive: true, force: true }); });

class Sink implements E2EModelEvidenceSink { writeReceipt() { /* not needed */ } writeTranscript() { /* not needed */ } }
let socketCount = 0;
async function startRun() {
  const seen: unknown[] = [];
  const invoke: E2EInvoke = async (input) => { seen.push(input.call); return tapAnswer(); };
  const route = createGovernedE2EModelRoute(bedrockRoute(), { invoke, now: Date.now, dayBudget: createInMemoryE2EDayBudget() });
  const socketPath = join(dir, `m${++socketCount}.sock`);
  const proxy: E2EModelProxy = await startE2EModelProxy({ socketPath, runId: RUN_ID, route, credentialSet: { passwords: [], emails: [], cookieValues: [] }, evidence: new Sink(),
    deadlineAt: Date.now() + 60_000, environment: {}, allowedSteps: [POSITION] });
  closers.push(() => proxy.close());
  return { proxy, seen, socketPath };
}
describe("N-1: a value cut for the sync never splits a surrogate pair, and nothing here can end the worker", () => {
  // Hostile values: an astral character astride each cut, a lone surrogate at each cut, and an all-emoji value.
  const hostile: Array<[string, string]> = [
    ["a pair astride the head cut", `${"a".repeat(E2E_MODEL_SESSION_SYNC_SLICE_CHARS - 1)}${EMOJI}${"b".repeat(5_000)}`],
    ["a pair astride the tail cut", `${"b".repeat(5_000)}${EMOJI}${"a".repeat(E2E_MODEL_SESSION_SYNC_SLICE_CHARS - 1)}`],
    ["pairs astride both cuts", `${"a".repeat(E2E_MODEL_SESSION_SYNC_SLICE_CHARS - 1)}${EMOJI}${"m".repeat(3_000)}${EMOJI}${"a".repeat(E2E_MODEL_SESSION_SYNC_SLICE_CHARS - 1)}`],
    ["only emoji", EMOJI.repeat(3_000)],
    ["a lone high surrogate at the head cut", `${"a".repeat(E2E_MODEL_SESSION_SYNC_SLICE_CHARS - 1)}\ud83d${"b".repeat(5_000)}`],
    ["a lone low surrogate at the tail cut", `${"b".repeat(5_000)}\ude00${"a".repeat(E2E_MODEL_SESSION_SYNC_SLICE_CHARS - 1)}`],
    ["lone surrogates everywhere", "😀\ude00\ud83d".repeat(1_500)],
  ];

  it.each(hostile)("cuts %s on code point boundaries (the slices of a well-formed value are well-formed)", (name, value) => {
    expect(value.length).toBeGreaterThan(E2E_MODEL_SESSION_SYNC_MAX_VALUE_CHARS);
    const [head, tail] = boundSessionValue(value) as [string, string];
    expect(head.length).toBeLessThanOrEqual(E2E_MODEL_SESSION_SYNC_SLICE_CHARS);
    expect(tail.length).toBeLessThanOrEqual(E2E_MODEL_SESSION_SYNC_SLICE_CHARS);
    expect(value.startsWith(head)).toBe(true);
    expect(value.endsWith(tail)).toBe(true);
    if (wellFormed(value)) { expect(wellFormed(head), `${name} head`).toBe(true); expect(wellFormed(tail), `${name} tail`).toBe(true); }
    // Whatever the value holds, the slices can be spelled without throwing, and the raw form is always one of them.
    for (const slice of [head, tail]) { expect(() => e2eSecretSpellings(slice)).not.toThrow(); expect(e2eSecretSpellings(slice)).toContain(slice); }
  });

  it("keeps a value that is short enough whole, lone surrogates included", () => {
    expect(boundSessionValue("\ud83d-short")).toEqual(["\ud83d-short"]);
  });

  it("builds every other spelling of a value with a lone surrogate, never throws, and says which one it skipped", () => {
    const lone = `token-${"x".repeat(20)}\ud83d`;
    const result = e2eSecretSpellingsDetailed(lone);
    expect(result.skipped).toEqual(["percent-encoded"]);
    expect(result.forms).toContain(lone);
    expect(result.forms).toContain(Buffer.from(lone, "utf8").toString("hex"));
    expect(e2eSecretSpellingsDetailed("a-well-formed-session-token").skipped).toEqual([]);
  });

  it("the ledger accepts a value with a lone surrogate (its other spellings are scanned), records the gap, and a refused sync leaves no token", () => {
    const ledger = createE2ESessionSyncLedger();
    const outcome = ledger.accept({ schemaVersion: "rovara-e2e-model-channel/v1", runId: RUN_ID, values: [`token-${"x".repeat(20)}\ud83d`] }, RUN_ID);
    expect(outcome).toMatchObject({ ok: true });
    expect(ledger.spellingGaps).toBe(1);
    const token = (outcome as { syncToken: string }).syncToken;
    // A refused sync clears the token that was waiting: whoever sent it cannot call under it.
    expect(ledger.accept({ not: "a sync" }, RUN_ID)).toMatchObject({ ok: false, code: "invalid-sync" });
    ledger.beginCall();
    expect(ledger.useForCall(token)).toMatchObject({ ok: false });
  });

  it.each(hostile)("end to end through the real proxy: a hostile oversized value (%s) is accepted, calls go on, and a prompt showing the value is refused", async (name, value) => {
    const run = await startRun();
    const sessionSync = { read: async (): Promise<readonly string[]> => [value] };
    const client = createE2EModelChannelClient({ socketPath: run.socketPath, runId: RUN_ID, sessionSync });
    await client.beginStep(POSITION);
    expect((await client.generate({ ...POSITION, callIndex: 0, call: call() })).result.status, name).toBe("ok");
    const [head] = boundSessionValue(value) as [string, string];
    const shown = await client.generate({ ...POSITION, callIndex: 1, call: call(`#n1 text "${head}"`) });
    expect(shown.result, name).toMatchObject({ status: "error", code: "refused-credential-match" });
    expect(run.seen).toHaveLength(1);
  });
});

describe("R-1: the values registered at sign-in follow the sync's classifier and bounds", () => {
  const fixture = createAccountsExecutorPlan();
  const applicationId = fixture.compiled.originByApplicationId[0]!.applicationId;
  const contract = readE2EApplicationProjectContract(fixture.compiled.runtimeAdmissionContext.selectionInput.sourceSnapshot, applicationId)!;
  const sha = (value: string) => createHash("sha256").update(value).digest("hex");
  const signal = new AbortController().signal;
  const JWT = `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url")}.${Buffer.from('{"sub":"user-1234567890"}').toString("base64url")}.c2lnbmF0dXJlLWJ5dGVzLWhlcmU`;
  const OVERSIZED = `T${randomBytes(6_000).toString("base64url")}Z`;
  const DRAFT = "Quarterly report for ACME";
  const ROUTE = "https://app.example.com/settings?tab=billing&from=%2Fhome";

  /** A form login that leaves the given local storage behind, as an app does right after sign-in. */
  function storeWith(localStorage: Array<{ name: string; value: string }>) {
    const told: Array<{ value: string; evidenceOnly: boolean }> = [];
    const driver: FormLoginDriver = {
      async signIn(input) {
        const account = fixture.plan.accounts.find((item) => item.email === input.email && item.password === input.password)!;
        const state: FormLoginStorageState = { cookies: [{ name: "sid", value: `tok-${sha(account.profileId).slice(0, 24)}`, domain: "127.0.0.1", path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Strict" }],
          origins: [{ origin: input.origin, localStorage }] };
        return { state, status: 200 };
      },
      async requestContext(): Promise<FormRequestContext> {
        return { async request({ path }) {
          const profile = contract.accountProfiles.find((item) => item.roleRef === "owner") ?? contract.accountProfiles[0]!;
          const body = new TextEncoder().encode(JSON.stringify(path === "/api/me" ? { subjectId: "s-1", tenantId: profile.tenantRef, role: profile.roleRef } : {}));
          return { status: 200, body, contentType: "application/json", setCookies: [] as string[] };
        }, async dispose() { /* nothing */ } };
      },
    };
    const store = createExecutorSessionStore({ plan: fixture.plan, formLogin: driver, registerSecret: (value, options) => told.push({ value, evidenceOnly: options?.evidenceOnly === true }) });
    const profileId = contract.accountProfiles.find((item) => item.roleRef === "owner")?.profileId ?? contract.accountProfiles[0]!.profileId;
    const ref = { applicationId, profileId, revision: 1, definitionDigest: "8".repeat(64) };
    const open = () => store.open({ binding: {}, applicationId, profileId, approvedAccountRef: ref, origin: E2E_EXECUTOR_COMPILED_ORIGIN }, signal);
    return { open, told };
  }

  it("tells the worker only a credential found in sign-in storage; a draft, a route and other app data are scrubbed from evidence only", async () => {
    const t = storeWith([{ name: "draft", value: DRAFT }, { name: "returnTo", value: ROUTE }, { name: "auth_state", value: "opaque-keyed-session-value-1234" }, { name: "jwt", value: JWT }, { name: "theme", value: "dark" },
      { name: "recentSearches", value: "orders,invoices,customers-with-open-balances,refunds-pending" }]);
    await t.open();
    const worker = t.told.filter((item) => !item.evidenceOnly).map((item) => item.value);
    expect(worker).toContain("opaque-keyed-session-value-1234");
    expect(worker).toContain(JWT);
    for (const appData of [DRAFT, ROUTE, "orders,invoices,customers-with-open-balances,refunds-pending"]) expect(worker, appData).not.toContain(appData);
    // They are still scrubbed from what the executor writes.
    expect(t.told.filter((item) => item.evidenceOnly).map((item) => item.value)).toEqual(expect.arrayContaining([ROUTE]));
    expect(t.told.map((item) => item.value)).not.toContain("dark");
  });

  it("a sign-in draft that the page shows does not refuse the call; a sign-in credential that it shows does (end to end)", async () => {
    const t = storeWith([{ name: "draft", value: DRAFT }, { name: "returnTo", value: ROUTE }, { name: "jwt", value: JWT }]);
    await t.open();
    // The host's rule: what is not evidence-only is what the worker is told.
    const sessionSecrets: string[] = [];
    for (const item of t.told) if (!item.evidenceOnly && !sessionSecrets.includes(item.value)) sessionSecrets.push(item.value);
    const run = await startRun();
    const source = createE2ESessionSyncSource({ register: () => undefined, known: () => sessionSecrets });
    const client = createE2EModelChannelClient({ socketPath: run.socketPath, runId: RUN_ID, sessionSync: source });
    await client.beginStep({ ...POSITION, cookieValues: beginMarkerSessionValues(sessionSecrets) });
    expect((await client.generate({ ...POSITION, callIndex: 0, call: call(`#n1 textbox "Title" value="${DRAFT}"\n#n2 link "Back" href="${ROUTE}"`) })).result.status).toBe("ok");
    expect((await client.generate({ ...POSITION, callIndex: 1, call: call(`#n3 text "${JWT}"`) })).result).toMatchObject({ status: "error", code: "refused-credential-match" });
  });

  it("an oversized value at sign-in is bounded in the begin marker and does not fail beginStep or the steps after it (end to end)", async () => {
    const t = storeWith([{ name: "persist", value: OVERSIZED }, { name: "jwt", value: JWT }]);
    await t.open();
    const sessionSecrets = t.told.filter((item) => !item.evidenceOnly).map((item) => item.value);
    expect(sessionSecrets).toContain(OVERSIZED);
    const values = beginMarkerSessionValues(sessionSecrets);
    expect(values.every((value) => value.length <= E2E_MODEL_SESSION_SYNC_MAX_VALUE_CHARS)).toBe(true);
    expect(values).toEqual(expect.arrayContaining([...boundSessionValue(OVERSIZED), JWT]));
    expect(E2EModelChannelStepMarkerSchema.safeParse({ schemaVersion: "rovara-e2e-model-channel/v1", runId: RUN_ID, marker: "begin", caseId: CASE_ID, stepIndex: 0, cookieValues: values }).success).toBe(true);
    const run = await startRun();
    const source = createE2ESessionSyncSource({ register: () => undefined, known: () => sessionSecrets });
    const client = createE2EModelChannelClient({ socketPath: run.socketPath, runId: RUN_ID, sessionSync: source });
    await client.beginStep({ ...POSITION, cookieValues: values });
    expect((await client.generate({ ...POSITION, callIndex: 0, call: call() })).result.status).toBe("ok");
    // The whole value, shown by the page, is refused.
    expect((await client.generate({ ...POSITION, callIndex: 1, call: call(`#n1 text "${OVERSIZED}"`) })).result).toMatchObject({ status: "error", code: "refused-credential-match" });
  });

  it("the step driver sends a begin marker that the schema accepts when a session value is oversized, and keeps the newest values within the marker's count and bytes", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "r2-driver-"));
    closers.push(async () => rmSync(outDir, { recursive: true, force: true }));
    const markers: Array<readonly string[] | undefined> = [];
    const client: E2EModelChannelClient = {
      async beginStep(position) { markers.push(position.cookieValues); },
      async endStep() { /* nothing */ },
      async generate() { throw new Error("no model call"); },
    };
    const run = async (secrets: string[]) => {
      const driver = createE2EAgentStepDriver({ client, adapter: { takeReceiptIds: () => [] }, current: { position: null, ledger: null }, runId: RUN_ID, valueKey: generateE2EAgentValueKey(), outDir, sessionSecrets: () => secrets });
      await driver({ caseId: CASE_ID, stepIndex: 0, goal: "g", maxActions: 2, timeoutMs: 10_000, signal: new AbortController().signal, act: async () => undefined });
      return markers.at(-1)!;
    };
    const marker = (cookieValues: readonly string[]) => ({ schemaVersion: "rovara-e2e-model-channel/v1", runId: RUN_ID, marker: "begin", caseId: CASE_ID, stepIndex: 0, cookieValues });
    // An oversized value among the newest: bounded, not rejected by the marker schema (4096 characters a value).
    const withOversized = await run([...Array.from({ length: 5 }, (_, index) => `session-value-${String(index).padStart(3, "0")}`), OVERSIZED]);
    expect(withOversized.every((value) => value.length <= E2E_MODEL_SESSION_SYNC_MAX_VALUE_CHARS)).toBe(true);
    expect(withOversized.slice(-2)).toEqual(boundSessionValue(OVERSIZED));
    expect(E2EModelChannelStepMarkerSchema.safeParse(marker(withOversized)).success).toBe(true);
    // Many large multi-byte values: the marker stays within its byte limit (the proxy refuses a marker over 262 144 bytes), keeping the newest.
    const wide = Array.from({ length: 31 }, (_, index) => `${String(index).padStart(3, "0")}${"\u65e5".repeat(4_090)}`);
    const withWide = await run(wide);
    expect(Buffer.byteLength(JSON.stringify(marker(withWide)))).toBeLessThan(262_144);
    expect(withWide.at(-1)).toBe(wide.at(-1));
    expect(withWide.length).toBeLessThan(wide.length);
    expect(E2EModelChannelStepMarkerSchema.safeParse(marker(withWide)).success).toBe(true);
    // Few small values are all sent, in order.
    expect(await run(["session-value-a-1234", "session-value-b-1234"])).toEqual(["session-value-a-1234", "session-value-b-1234"]);
  });
});

