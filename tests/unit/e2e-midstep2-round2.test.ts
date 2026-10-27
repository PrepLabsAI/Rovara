import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { E2E_EXECUTOR_COMPILED_ORIGIN, readE2EApplicationProjectContract } from "@agentx/contracts";
import { createExecutorSessionStore } from "../../packages/verifier/src/executor/accounts.js";
import { agentTraceFilePath, createE2EAgentCaptureStore, persistE2EAgentTrace } from "../../packages/verifier/src/executor/agent-capture-store.js";
import { readBrowserState, type BrowserContextLike, type BrowserFrameLike } from "../../packages/verifier/src/executor/browser-state-reader.js";
import { BROWSER_STATE_MEMO_MAX, tellBrowserState } from "../../packages/verifier/src/executor/browser-state-secrets.js";
import { classifyStorageEntry } from "../../packages/verifier/src/executor/storage-entry-classifier.js";
import { classifyString } from "../../packages/verifier/src/executor/credential-classifier.js";
import type { FormLoginDriver, FormLoginStorageState, FormRequestContext } from "../../packages/verifier/src/executor/form-login.js";
import { createCredentialRedactor } from "../../packages/verifier/src/executor/redact.js";
import { createSessionSecretRegistry } from "../../packages/verifier/src/executor/session-secret-registry.js";
import { createHostAgentCaptureStore } from "../../packages/verifier/src/executor/host-capture-store.js";
import { readSessionSecretFile, scanOutputFile, sessionSecretLine } from "../../packages/verifier/src/executor/session-secrets-file.js";
import { E2E_SESSION_SYNC_MAX_WEAK_VALUES } from "../../packages/verifier/src/executor/session-sync.js";
import { createAccountsExecutorPlan } from "../support/e2e-accounts-fixture.js";
import { cleanRedirectingEnvironment } from "../support/e2e-clean-environment.js";
import { createMidstep2Harness } from "../support/e2e-midstep2-harness.js";

// MIDSTEP-2 fix round 2: N-1 (numeric and hex id paths), N-2 (a weak value learned after a trace is on disk), N-3 (the main frame is never skipped), N-6 (survivors).

const JWT = `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from('{"sub":"user-1234567890"}').toString("base64url")}.c2lnbmF0dXJlLWJ5dGVzLWhlcmU`;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

let dir: string;
const closers: Array<() => Promise<unknown>> = [];
beforeEach(async () => { cleanRedirectingEnvironment(); dir = await mkdtemp(join(tmpdir(), "m2r2-")); });
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close().catch(() => undefined); await rm(dir, { recursive: true, force: true }); });
const harness = createMidstep2Harness({ dir: () => dir, closers });

describe("N-1: REST paths with numeric or hex ids are not credentials", () => {
  const PATHS = ["/users/8423/orders/12345/items/99882211", "/orders/1234567890abcdef/items/9876543210fedcba", "/files/9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a", "users/8423/orders/12345/items/99882211"];
  it.each(PATHS)("%s: not strong at the top level, as a JSON leaf, as an IndexedDB-style structure, or as a stored JSON string", (path) => {
    expect(path.length).toBeGreaterThanOrEqual(32);
    for (const name of ["lastRoute", "anything", "href"]) expect(classifyString(name, path).filter((item) => item.tier === "strong"), `${name} ${path}`).toEqual([]);
    expect(classifyStorageEntry({ name: "cache", value: JSON.stringify({ href: path }) }).filter((item) => item.tier === "strong")).toEqual([]);
    expect(classifyStorageEntry({ name: "lastRoute", value: JSON.stringify(path) }).filter((item) => item.tier === "strong")).toEqual([]);
  });

  it("a random standard-base64 token with slashes (both cases) is still strong, with or without a leading slash", () => {
    for (const token of ["/k3JqZ8vR2mT9wXyB4nL7pQ1sD6fH0gA5eC8uV3iO2Y=", "k3JqZ8vR2mT9/wXyB4nL7pQ1sD6fH0gA5eC8uV3iO2Yb"]) {
      expect(classifyString("anything", token).map((item) => item.tier), token).toContain("strong");
    }
  });

  it("end to end: a page that shows such a path is not refused when the cache holds it", async () => {
    const e = await harness.executor();
    e.state.current = { cookies: [], origins: [{ localStorage: [{ name: "lastRoute", value: PATHS[0]! }, { name: "cache", value: JSON.stringify({ href: PATHS[2] }) }] }] };
    expect((await e.workerSays("Nothing secret here")).status).toBe("ok");
    expect((await e.workerSays(`Open ${PATHS[0]} and ${PATHS[2]}`)).status).toBe("ok");
    expect(await e.executorSays(`Open ${PATHS[0]}`)).toBe("ok");
  });
});

describe("N-2: an evidence-only value learned after a trace is on disk scrubs or drops, and never fails the run", () => {
  const GOAL_TRACE = (id: string) => ({ actions: [{ name: "navigate", summary: "open", url: `/documents/${id}` }],
    executor: { name: "rovara-e2e-agent", version: "1" }, summary: "Done.", recordedFor: { testId: ".agentx/e2e/generated-application.test.ts::case-orders-export", targetId: "account-target-1", instructionDigest: sha("export the orders"), callIndex: 0 } });
  const DOC_ID = "Xk3pQ9xW2mV7cL4nR8tY";

  it("the trace written before the value was known is removed by the final scan without a credential-leak verdict; a credential in the same place still is one", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "m2r2-out-"));
    closers.push(async () => rmSync(outDir, { recursive: true, force: true }));
    const redactor = createCredentialRedactor([]);
    const registry = createSessionSecretRegistry({ redactor });
    const store = createE2EAgentCaptureStore({ scan: registry.evidenceScan, persist: (keyHash, bytes) => persistE2EAgentTrace(outDir, keyHash, bytes), goals: () => ["export the orders"], origin: E2E_EXECUTOR_COMPILED_ORIGIN });
    const keyHash = "a".repeat(64);
    expect(await store.write(keyHash, GOAL_TRACE(DOC_ID))).toBeDefined();
    const tracePath = agentTraceFilePath(outDir, keyHash);
    expect(existsSync(tracePath)).toBe(true);
    // The next sync learns the document id (evidence-only); the child leaves it for the parent in the session-secrets file, and the parent registers it as the run does.
    const secretsFile = join(outDir, "secrets.jsonl");
    writeFileSync(secretsFile, sessionSecretLine(DOC_ID, true));
    const parent = createCredentialRedactor([]);
    for (const secret of await readSessionSecretFile(secretsFile)) parent.addSessionSecret(secret.value, { evidenceOnly: secret.evidenceOnly });
    const logged: string[] = [];
    const verdict = await scanOutputFile({ file: tracePath, outDir, redactor: parent, log: async (line) => { logged.push(line); } });
    expect(verdict).toBe("evidence-only");
    expect(existsSync(tracePath)).toBe(false);
    expect(logged.join("\n")).toContain("not a credential");
    // The same trace with a CREDENTIAL learned afterwards is a leak, as before.
    expect(await store.write(keyHash, GOAL_TRACE(DOC_ID))).toBeDefined();
    writeFileSync(secretsFile, sessionSecretLine(DOC_ID, false));
    const strict = createCredentialRedactor([]);
    for (const secret of await readSessionSecretFile(secretsFile)) strict.addSessionSecret(secret.value, { evidenceOnly: secret.evidenceOnly });
    expect(await scanOutputFile({ file: tracePath, outDir, redactor: strict, log: async () => undefined })).toBe("credential");
    expect(existsSync(tracePath)).toBe(false);
  });

  it("the session-secrets file: a credential is a plain JSON string (as the old code wrote it), an evidence-only value is tagged, junk is skipped", async () => {
    const file = join(dir, "s.jsonl");
    writeFileSync(file, `${JSON.stringify("cookie-value-0123456789")}\n${sessionSecretLine("draft-text-0123456789", true)}not json\n{"v":5}\n\n`);
    expect(await readSessionSecretFile(file)).toEqual([{ value: "cookie-value-0123456789", evidenceOnly: false }, { value: "draft-text-0123456789", evidenceOnly: true }]);
    expect(await readSessionSecretFile(join(dir, "missing"))).toEqual([]);
  });

  it("the registry tells the child's file writer which values are evidence-only, and the host and the parent use the tagged file", () => {
    const told: Array<{ value: string; evidenceOnly: boolean }> = [];
    const registry = createSessionSecretRegistry({ redactor: createCredentialRedactor([]), onRegister: (value, options) => { told.push({ value, evidenceOnly: options?.evidenceOnly === true }); } });
    registry.register("credential-value-0123456789");
    registry.register("evidence-value-0123456789", { evidenceOnly: true });
    expect(told).toEqual([{ value: "credential-value-0123456789", evidenceOnly: false }, { value: "evidence-value-0123456789", evidenceOnly: true }]);
    const executor = new URL("../../packages/verifier/src/executor/", import.meta.url);
    expect(readFileSync(new URL("host.ts", executor), "utf8")).toContain("sessionSecretLine(value, options?.evidenceOnly === true)");
    const run = readFileSync(new URL("run.ts", executor), "utf8");
    expect(run).toContain("input.redactor.addSessionSecret(secret.value, { evidenceOnly: secret.evidenceOnly })");
    expect(run).toContain("await scanOutputFile(");
  });

  it("the capture store, wired with the registry's evidence scan, drops a trace that shows an evidence-only value known at write time (and the model scan would have kept it)", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "m2r2-out-"));
    closers.push(async () => rmSync(outDir, { recursive: true, force: true }));
    const redactor = createCredentialRedactor([]);
    const registry = createSessionSecretRegistry({ redactor });
    registry.register(DOC_ID, { evidenceOnly: true });
    const make = (scan: (bytes: Uint8Array) => boolean) => createE2EAgentCaptureStore({ scan, persist: (keyHash, bytes) => persistE2EAgentTrace(outDir, keyHash, bytes), goals: () => ["export the orders"], origin: E2E_EXECUTOR_COMPILED_ORIGIN });
    expect(await make(registry.evidenceScan).write("b".repeat(64), GOAL_TRACE(DOC_ID))).toBeUndefined();
    expect(existsSync(agentTraceFilePath(outDir, "b".repeat(64)))).toBe(false);
    expect(await make(registry.modelScan).write("c".repeat(64), GOAL_TRACE(DOC_ID))).toBeDefined();
    expect(readFileSync(agentTraceFilePath(outDir, "c".repeat(64)), "utf8")).toContain(DOC_ID);
  });
});

class FakePage extends EventEmitter { constructor(readonly framesList: BrowserFrameLike[]) { super(); } }
function contextOf(pages: BrowserFrameLike[][]): BrowserContextLike {
  const list = pages.map((frames) => new FakePage(frames));
  return { storageState: async () => ({ cookies: [], origins: [] }), pages: () => list.map((page) => ({ frames: () => page.framesList, mainFrame: () => page.framesList[0]! })) };
}
const okFrame = (entries: Array<{ name: string; value: string }> = []): BrowserFrameLike => ({ url: () => `${E2E_EXECUTOR_COMPILED_ORIGIN}/`, evaluate: async () => ({ over: false, origin: E2E_EXECUTOR_COMPILED_ORIGIN, entries }) });
const brokenFrame = (url = `${E2E_EXECUTOR_COMPILED_ORIGIN}/child`, wait?: (timeout: number) => Promise<unknown>): BrowserFrameLike => ({ url: () => url, evaluate: async () => { throw new Error("Execution context was destroyed"); },
  ...(wait === undefined ? {} : { waitForLoadState: (_state: "domcontentloaded", options: { timeout: number }) => wait(options.timeout) }) });

describe("N-3: the main frame is never skipped", () => {
  it("a main frame that cannot be read fails the read even though it never held state; the same frame as a child is skipped", async () => {
    await expect(readBrowserState(contextOf([[brokenFrame(`${E2E_EXECUTOR_COMPILED_ORIGIN}/`)]]))).rejects.toMatchObject({ code: "sessionstorage-unreadable" });
    await expect(readBrowserState(contextOf([[okFrame(), brokenFrame()]]))).resolves.toMatchObject({ urls: expect.any(Array) as unknown });
  });

  it("a child frame that held state and then cannot be read still fails the read", async () => {
    let fail = false;
    const child: BrowserFrameLike = { url: () => `${E2E_EXECUTOR_COMPILED_ORIGIN}/child`, evaluate: async () => { if (fail) throw new Error("gone"); return { over: false, origin: E2E_EXECUTOR_COMPILED_ORIGIN, entries: [{ name: "k", value: "v" }] }; } };
    const context = contextOf([[okFrame(), child]]);
    await readBrowserState(context);
    fail = true;
    await expect(readBrowserState(context)).rejects.toMatchObject({ code: "sessionstorage-unreadable" });
  });

  it("the time spent waiting for navigating frames is bounded per read, not per frame", { timeout: 30_000 }, async () => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const frames = [okFrame(), ...Array.from({ length: 6 }, () => brokenFrame(undefined, sleep))];
    const started = Date.now();
    await readBrowserState(contextOf([frames]));
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("N-6: survivors", () => {
  const fixture = createAccountsExecutorPlan();
  const applicationId = fixture.compiled.originByApplicationId[0]!.applicationId;
  const contract = readE2EApplicationProjectContract(fixture.compiled.runtimeAdmissionContext.selectionInput.sourceSnapshot, applicationId)!;

  it("the sign-in registers at most the weak cap of evidence-only values, and never holds back a credential", async () => {
    const told: Array<{ value: string; evidenceOnly: boolean }> = [];
    const weak = Array.from({ length: E2E_SESSION_SYNC_MAX_WEAK_VALUES + 300 }, (_unused, index) => ({ name: `k${index}`, value: `Abcdef0123456789x${String(index).padStart(6, "0")}` }));
    const driver: FormLoginDriver = {
      async signIn(input) {
        const state: FormLoginStorageState = { cookies: [], origins: [{ origin: input.origin, localStorage: [...weak, { name: "accessToken", value: JWT }] }] };
        return { state, status: 200 };
      },
      async requestContext(): Promise<FormRequestContext> {
        return { async request({ path }) {
          const profile = contract.accountProfiles.find((item) => item.roleRef === "owner") ?? contract.accountProfiles[0]!;
          return { status: 200, body: new TextEncoder().encode(JSON.stringify(path === "/api/me" ? { subjectId: "s-1", tenantId: profile.tenantRef, role: profile.roleRef } : {})), contentType: "application/json", setCookies: [] as string[] };
        }, async dispose() { /* nothing */ } };
      },
    };
    const store = createExecutorSessionStore({ plan: fixture.plan, formLogin: driver, registerSecret: (value, options) => { told.push({ value, evidenceOnly: options?.evidenceOnly === true }); } });
    const profileId = contract.accountProfiles.find((item) => item.roleRef === "owner")?.profileId ?? contract.accountProfiles[0]!.profileId;
    const ref = { applicationId, profileId, revision: 1, definitionDigest: "8".repeat(64) };
    await store.open({ binding: {}, applicationId, profileId, approvedAccountRef: ref, origin: E2E_EXECUTOR_COMPILED_ORIGIN }, new AbortController().signal);
    expect(told.filter((item) => item.evidenceOnly)).toHaveLength(E2E_SESSION_SYNC_MAX_WEAK_VALUES);
    expect(told.filter((item) => !item.evidenceOnly).map((item) => item.value)).toContain(JWT);
  });

  it("the classify memo is cleared when it would pass its bound, and the new entries are remembered", () => {
    const memo = new Set<string>(Array.from({ length: BROWSER_STATE_MEMO_MAX - 1 }, (_unused, index) => `old-${index}`));
    tellBrowserState({ cookies: [], origins: [{ localStorage: [{ name: "a", value: "1" }, { name: "b", value: "2" }, { name: "c", value: "3" }] }] }, () => undefined, memo);
    expect(memo.size).toBe(3);
    expect(memo.has("old-0")).toBe(false);
    // The remembered entries are not classified again.
    const told: string[] = [];
    tellBrowserState({ cookies: [], origins: [{ localStorage: [{ name: "a", value: "A".repeat(20) }] }] }, (item) => told.push(item.value), memo);
    tellBrowserState({ cookies: [], origins: [{ localStorage: [{ name: "a", value: "A".repeat(20) }] }] }, (item) => told.push(item.value), memo);
    expect(told).toHaveLength(1);
  });
});

describe("fix round 3 (re-check 2)", () => {
  const MIXED_CASE_PATHS = ["/api/userProfiles/8423/orderItems/12345/lineItems/99882211", "/Users/8423/Orders/12345/Items/99882211", "/v2/Projects/8423/Tasks/9921/Comments/771122334455",
    "/ProjectData/8423/TaskList/9921/CommentItems/771122334455", "/files/9F8A7B6C5D4E3F2A1B0C9D8E7F6A5B4C3D2E1F0A", "api/userProfiles/8423/orderItems/12345/lineItems/99882211"];
  it.each(MIXED_CASE_PATHS)("N-7: %s is a path: not strong at the top level, as a JSON leaf, or as a stored JSON string", (path) => {
    for (const name of ["lastRoute", "anything", "href"]) expect(classifyString(name, path).filter((item) => item.tier === "strong"), `${name} ${path}`).toEqual([]);
    expect(classifyStorageEntry({ name: "cache", value: JSON.stringify({ href: path }) }).filter((item) => item.tier === "strong")).toEqual([]);
    expect(classifyStorageEntry({ name: "lastRoute", value: JSON.stringify(path) }).filter((item) => item.tier === "strong")).toEqual([]);
  });

  it("N-7: random standard-base64 tokens with slashes stay strong (10 000 seeded tokens, with and without a leading slash; any miss must be a token without a digit)", () => {
    let seed = 20_261_027;
    const next = (): number => { seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0; return seed; };
    let checked = 0;
    const misses: string[] = [];
    for (let index = 0; checked < 10_000 && index < 100_000; index += 1) {
      const token = Buffer.from(Array.from({ length: 24 + (next() % 24) }, () => next() & 255)).toString("base64").replace(/=+$/, "");
      if (!token.includes("/")) continue;
      for (const value of [token, `/${token}`]) {
        checked += 1;
        if (!classifyString("anything", value).some((item) => item.tier === "strong" && item.value === value)) misses.push(value);
      }
    }
    expect(checked).toBeGreaterThanOrEqual(10_000);
    expect(misses.filter((value) => /[0-9]/.test(value))).toEqual([]);
    expect(misses.length / checked).toBeLessThan(0.01);
  });

  it("N-12: a page object without mainFrame still has its first frame treated as the main frame (fail closed)", async () => {
    const mainFrames = [brokenFrame(`${E2E_EXECUTOR_COMPILED_ORIGIN}/`), okFrame()];
    const context: BrowserContextLike = { storageState: async () => ({ cookies: [], origins: [] }), pages: () => [{ frames: () => mainFrames }] };
    await expect(readBrowserState(context)).rejects.toMatchObject({ code: "sessionstorage-unreadable" });
    const childFrames = [okFrame(), brokenFrame()];
    const child: BrowserContextLike = { storageState: async () => ({ cookies: [], origins: [] }), pages: () => [{ frames: () => childFrames }] };
    await expect(readBrowserState(child)).resolves.toBeDefined();
  });

  it("N-9: the host's capture store drops a trace that shows an evidence-only value and keeps one that does not", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "m2r3-out-"));
    closers.push(async () => rmSync(outDir, { recursive: true, force: true }));
    const registry = createSessionSecretRegistry({ redactor: createCredentialRedactor([]) });
    registry.register("Xk3pQ9xW2mV7cL4nR8tY", { evidenceOnly: true });
    const store = createHostAgentCaptureStore({ registry, outDir, valueKey: "k".repeat(32), goals: () => ["export the orders"], origin: E2E_EXECUTOR_COMPILED_ORIGIN });
    const trace = (id: string) => ({ actions: [{ name: "navigate", summary: "open", url: `/documents/${id}` }], executor: { name: "rovara-e2e-agent", version: "1" }, summary: "Done.",
      recordedFor: { testId: ".agentx/e2e/generated-application.test.ts::case-orders-export", targetId: "account-target-1", instructionDigest: sha("export the orders"), callIndex: 0 } });
    expect(await store.write("d".repeat(64), trace("Xk3pQ9xW2mV7cL4nR8tY"))).toBeUndefined();
    expect(existsSync(agentTraceFilePath(outDir, "d".repeat(64)))).toBe(false);
    expect(await store.write("e".repeat(64), trace("ordinary-id"))).toBeDefined();
    expect(existsSync(agentTraceFilePath(outDir, "e".repeat(64)))).toBe(true);
  });
});
