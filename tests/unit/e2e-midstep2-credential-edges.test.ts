import { createHash, randomBytes, randomInt } from "node:crypto";
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
import { BROWSER_STATE_MEMO_MAX, tellBrowserState, type BrowserSecretState } from "../../packages/verifier/src/executor/browser-state-secrets.js";
import { classifyStorageEntry } from "../../packages/verifier/src/executor/storage-entry-classifier.js";
import { headerSecrets, urlSecrets, oversizedTokens } from "../../packages/verifier/src/executor/request-secrets.js";
import { classifyString, isPathLike, isTokenShape, type ClassifiedValue } from "../../packages/verifier/src/executor/credential-classifier.js";
import { cookieTier, visitorCookieSecret, analyticsCookieName } from "../../packages/verifier/src/executor/visitor-cookie.js";
import type { FormLoginDriver, FormLoginStorageState, FormRequestContext } from "../../packages/verifier/src/executor/form-login.js";
import { createCredentialRedactor, MASK_BUCKET_CAP, MASK_ONLY_LIMIT } from "../../packages/verifier/src/executor/redact.js";
import { createSessionSecretRegistry } from "../../packages/verifier/src/executor/session-secret-registry.js";
import { createHostAgentCaptureStore } from "../../packages/verifier/src/executor/host-capture-store.js";
import { readSessionSecretFile, scanOutputFile, sessionSecretLine } from "../../packages/verifier/src/executor/session-secrets-file.js";
import { E2E_SESSION_SYNC_MAX_WEAK_VALUES, type E2ESessionSyncSource, createE2ESessionSyncSource } from "../../packages/verifier/src/executor/session-sync.js";
import { createAccountsExecutorPlan } from "../support/e2e-accounts-fixture.js";
import { cleanRedirectingEnvironment } from "../support/e2e-clean-environment.js";
import { createMidstep2Harness, MIDSTEP2_POSITION as POSITION } from "../support/e2e-midstep2-harness.js";
import { createServer, type Server } from "node:http";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { createHostModelStack } from "../../packages/verifier/src/executor/host-model-stack.js";
import { readSessionContextAtClose, wireSessionContext, readCaseContextAtClose, wireCaseContext, adoptCaseContext, closeCaseContext } from "../../packages/verifier/src/executor/session-context-wiring.js";
import { RUN_ID, TOOLS } from "../support/e2e-model-fixtures.js";
import { expectLinearScaling } from "../support/scaling.js";
import ts from "typescript";

// MIDSTEP-2 edge cases of the credential classifier and the mask: paths and ids versus tokens, top-level and oversized values, visitor and analytics cookies, one-time sign-in
// parameters, the mask's time and size bounds, and the session-context wiring through a real Chromium. The pure classifier tests are in e2e-midstep2-classifier.test.ts.


const USER_JWT = `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from('{"sub":"user-1234567890"}').toString("base64url")}.c2lnbmF0dXJlLWJ5dGVzLWhlcmU`;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
/** Deterministic bytes (SHA-256 of seed and counter): the same tokens on every run, so CI cannot flake on a rare random token. */
function seededBytes(seed: string): (length: number) => Buffer {
  let counter = 0;
  return (length) => {
    const chunks: Buffer[] = [];
    for (let size = 0; size < length; size += 32) chunks.push(createHash("sha256").update(`${seed}:${counter++}`).digest());
    return Buffer.concat(chunks).subarray(0, length);
  };
}
/** An ordinary random token (no slash) for comparing the tier a neutral position gives. */
const RANDOM_CONTROL = "k3JqZ8vR2mT9wXyB4nL7pQ1sD6fH0gA5eC8uV3iO2Yb";

let dir: string;
const closers: Array<() => Promise<unknown>> = [];
beforeEach(async () => { cleanRedirectingEnvironment(); dir = await mkdtemp(join(tmpdir(), "m2-")); });
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close().catch(() => undefined); await rm(dir, { recursive: true, force: true }); });
const harness = createMidstep2Harness({ dir: () => dir, closers });

describe("REST paths with numeric or hex ids are not credentials", () => {
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

describe("an evidence-only value learned after a trace is on disk scrubs or drops, and never fails the run", () => {
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

describe("the main frame is never skipped", () => {
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

describe("survivors", () => {
  const fixture = createAccountsExecutorPlan();
  const applicationId = fixture.compiled.originByApplicationId[0]!.applicationId;
  const contract = readE2EApplicationProjectContract(fixture.compiled.runtimeAdmissionContext.selectionInput.sourceSnapshot, applicationId)!;

  it("the sign-in registers at most the weak cap of evidence-only values (the rest go to the mask), and never holds back a credential", async () => {
    const told: Array<{ value: string; evidenceOnly: boolean; maskOnly: boolean }> = [];
    const weak = Array.from({ length: E2E_SESSION_SYNC_MAX_WEAK_VALUES + 300 }, (_unused, index) => ({ name: `k${index}`, value: `Abcdef0123456789x${String(index).padStart(6, "0")}` }));
    const driver: FormLoginDriver = {
      async signIn(input) {
        const state: FormLoginStorageState = { cookies: [], origins: [{ origin: input.origin, localStorage: [...weak, { name: "accessToken", value: USER_JWT }] }] };
        return { state, status: 200 };
      },
      async requestContext(): Promise<FormRequestContext> {
        return { async request({ path }) {
          const profile = contract.accountProfiles.find((item) => item.roleRef === "owner") ?? contract.accountProfiles[0]!;
          return { status: 200, body: new TextEncoder().encode(JSON.stringify(path === "/api/me" ? { subjectId: "s-1", tenantId: profile.tenantRef, role: profile.roleRef } : {})), contentType: "application/json", setCookies: [] as string[] };
        }, async dispose() { /* nothing */ } };
      },
    };
    const store = createExecutorSessionStore({ plan: fixture.plan, formLogin: driver, registerSecret: (value, options) => { told.push({ value, evidenceOnly: options?.evidenceOnly === true, maskOnly: options?.maskOnly === true }); } });
    const profileId = contract.accountProfiles.find((item) => item.roleRef === "owner")?.profileId ?? contract.accountProfiles[0]!.profileId;
    const ref = { applicationId, profileId, revision: 1, definitionDigest: "8".repeat(64) };
    await store.open({ binding: {}, applicationId, profileId, approvedAccountRef: ref, origin: E2E_EXECUTOR_COMPILED_ORIGIN }, new AbortController().signal);
    expect(told.filter((item) => item.evidenceOnly)).toHaveLength(E2E_SESSION_SYNC_MAX_WEAK_VALUES);
    // The 300 after the cap are held for the model's mask (MASKMAYBE F-2), not dropped.
    expect(told.filter((item) => item.maskOnly)).toHaveLength(300);
    expect(told.filter((item) => !item.evidenceOnly && !item.maskOnly).map((item) => item.value)).toEqual([USER_JWT]);
  });

  it("the sign-in tells the store once that a weak value could not be registered at all (a value over 64 KiB), and the store passes it on as an overflow note", async () => {
    const told: Array<{ value: string; overflow: boolean }> = [];
    const driver: FormLoginDriver = {
      async signIn(input) {
        const state: FormLoginStorageState = { cookies: [], origins: [{ origin: input.origin, localStorage: [{ name: "session", value: "word ".repeat(20_000) }, { name: "session2", value: "word ".repeat(20_001) }] }] };
        return { state, status: 200 };
      },
      async requestContext(): Promise<FormRequestContext> {
        return { async request({ path }) {
          const profile = contract.accountProfiles.find((item) => item.roleRef === "owner") ?? contract.accountProfiles[0]!;
          return { status: 200, body: new TextEncoder().encode(JSON.stringify(path === "/api/me" ? { subjectId: "s-1", tenantId: profile.tenantRef, role: profile.roleRef } : {})), contentType: "application/json", setCookies: [] as string[] };
        }, async dispose() { /* nothing */ } };
      },
    };
    const store = createExecutorSessionStore({ plan: fixture.plan, formLogin: driver, registerSecret: (value, options) => { told.push({ value, overflow: options?.overflow === true }); } });
    const profileId = contract.accountProfiles.find((item) => item.roleRef === "owner")?.profileId ?? contract.accountProfiles[0]!.profileId;
    const ref = { applicationId, profileId, revision: 1, definitionDigest: "8".repeat(64) };
    await store.open({ binding: {}, applicationId, profileId, approvedAccountRef: ref, origin: E2E_EXECUTOR_COMPILED_ORIGIN }, new AbortController().signal);
    expect(told.filter((item) => item.overflow)).toEqual([{ value: "", overflow: true }]);
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

describe("paths and tokens, the main frame and evidence-only values", () => {
  const MIXED_CASE_PATHS = ["/api/userProfiles/8423/orderItems/12345/lineItems/99882211", "/Users/8423/Orders/12345/Items/99882211", "/v2/Projects/8423/Tasks/9921/Comments/771122334455",
    "/ProjectData/8423/TaskList/9921/CommentItems/771122334455", "/files/9F8A7B6C5D4E3F2A1B0C9D8E7F6A5B4C3D2E1F0A", "api/userProfiles/8423/orderItems/12345/lineItems/99882211"];
  it.each(MIXED_CASE_PATHS)("%s is a path: not strong at the top level, as a JSON leaf, or as a stored JSON string", (path) => {
    for (const name of ["lastRoute", "anything", "href"]) expect(classifyString(name, path).filter((item) => item.tier === "strong"), `${name} ${path}`).toEqual([]);
    expect(classifyStorageEntry({ name: "cache", value: JSON.stringify({ href: path }) }).filter((item) => item.tier === "strong")).toEqual([]);
    expect(classifyStorageEntry({ name: "lastRoute", value: JSON.stringify(path) }).filter((item) => item.tier === "strong")).toEqual([]);
  });

  it("the path rule counts digit ids and hex ids as well as words, and needs half of the segments, not one", () => {
    for (const path of ["/Api/8423/12345/6789/4321/Items/55", "/Files/9F8A7B6C5D4E3F2A/1B0C9D8E7F6A5B4C/3D2E1F0A9B8C7D6E"]) {
      expect(classifyString("anything", path).filter((item) => item.tier === "strong"), path).toEqual([]);
    }
    // One digits-only piece between random base64 segments does not make a token a path.
    const token = "k3JqZ8vR2mT9wXyB4nL7/12/pQ1sD6fH0gA5eC8uV3iO2Yb";
    expect(classifyString("anything", token).map((item) => item.tier)).toContain("strong");
  });

  it("random standard-base64 tokens with slashes stay strong (seeded: 200 000 distinct tokens at each of 24, 32 and 40 bytes, with and without a leading slash)", () => {
    for (const bytes of [24, 32, 40]) {
      const next = seededBytes(`n7-m3-1-${bytes}`);
      const seen = new Set<string>();
      const misses: string[] = [];
      let checked = 0;
      while (seen.size < 200_000) {
        const token = next(bytes).toString("base64").replace(/=+$/, "");
        if (!token.includes("/") || seen.has(token)) continue;
        seen.add(token);
        for (const value of [token, `/${token}`]) {
          checked += 1;
          if (!classifyString("anything", value).some((item) => item.tier === "strong" && item.value === value)) misses.push(value);
        }
      }
      // The only tokens that are not strong are the ones without a digit (an opaque run needs a letter and a digit, as it always did): measured 0.5% at 24 bytes, 0.1% at 32, 0.02% at 40.
      expect(misses.filter((value) => /[0-9]/.test(value)), `${bytes} bytes`).toEqual([]);
      expect(misses.length / checked, `${bytes} bytes`).toBeLessThan(0.02);
    }
  }, 120_000);

  // CRED-CLASSIFIER-DIGIT-PATH: a random token whose pieces between the slashes read as a digit id and 3-letter words was called a path (and so was not registered at all as a leaf, a URL parameter or a cookie).
  const DIGIT_PATH_TOKENS = ["939/Qoy/vkv7zesoatRb5eCCFKuVPauoWV74ODe/fyk", "qwi/Ipt/ampea74/4e7m/iVGWf5hIwlr"];
  describe.each(DIGIT_PATH_TOKENS.flatMap((token) => [token, `/${token}`]))("%s", (value) => {
    it("is not a path", () => { expect(isPathLike(value)).toBe(false); });
    it("is strong at the top level under a neutral key", () => {
      expect(classifyString("anything", value).some((item) => item.tier === "strong" && item.value === value)).toBe(true);
    });
    it("is strong as a JSON leaf under a neutral key (and as a stored JSON string)", () => {
      expect(classifyStorageEntry({ name: "cache", value: JSON.stringify({ href: value }) }).some((item) => item.tier === "strong" && item.value === value)).toBe(true);
      expect(classifyStorageEntry({ name: "cache", value: JSON.stringify({ nested: { list: [value] } }) }).some((item) => item.tier === "strong" && item.value === value)).toBe(true);
      expect(classifyStorageEntry({ name: "cache", value: JSON.stringify(value) }).some((item) => item.tier === "strong" && item.value === value)).toBe(true);
    });
    it("is registered in a neutral URL parameter exactly as any other random token is (masked: weak)", () => {
      const control = urlSecrets(`https://app.test/x?ref=${encodeURIComponent(RANDOM_CONTROL)}`).find((item) => item.value === RANDOM_CONTROL)?.tier;
      expect(control).toBe("weak");
      expect(urlSecrets(`https://app.test/x?ref=${encodeURIComponent(value)}`).find((item) => item.value === value)?.tier).toBe(control);
    });
    it("is registered as a neutral visitor cookie exactly as any other random token is (an HttpOnly one is strong)", () => {
      const control = cookieTier({ name: "appstate", value: RANDOM_CONTROL, httpOnly: false }, true);
      expect(control).toBe("weak");
      expect(cookieTier({ name: "appstate", value, httpOnly: false }, true)).toBe(control);
      expect(cookieTier({ name: "appstate", value, httpOnly: true }, true)).toBe("strong");
    });
  });

  it("real paths with ids, dates, files and 3-letter words are still paths: nothing strong or weak at the top level, as a leaf, a URL parameter or a visitor cookie", () => {
    const REAL_PATHS = ["/api/v2/Users/8423/Orders/12345/Items/99882211", "/Api/Orders/2024/11/08/InvoiceItems/99882211", "/Users/8423/Documents/Reports/2024Q4/Summary", "/Api/Orders/12345/Items/Kx9mQ2vL7nR4tYbc",
      "/Users/dev/Projects/App/src/Runner/path-rules.ts", "/api/orders/12345", "/api/get/all/orders/2024/Items/list", "/Users/8423/Orders/12345/Items/Kx9mQ2vL7nR4tYbc/Lines/99",
      "/v1/app/org/mcp-servers/mcpone000001", "SampleApp/docs/guides/specs/2026-10-12-example-spec-e2e/", "/Users/8423/Orgs/Kx9mQ2vL7nR/Projects/Zp3mQ8vL1nR/Tasks/8423",
      "/api/users/aB3dE5fG7hI9jK1lM2nO/posts", "/api/Orders/Kx9mQ2vL7nR4tYbc/Items", "/app/projects/V1StGXR8Z5jdHi6bmyT/settings", "/api/orgs/aB3dE5fG7hI9jK1lM2nO/members", "/api/docs/aB3dE5fG7hI9jK1lM2nO/edit",
      "/users/V1StGXR8Z5jdHi6bmyT/posts/V1StGXR8Z5jdHi6bmyT/comments/list"];
    for (const path of REAL_PATHS) {
      expect(isPathLike(path), path).toBe(true);
      expect(classifyString("lastRoute", path).filter((item) => item.tier === "strong" || item.tier === "weak"), path).toEqual([]);
      expect(classifyStorageEntry({ name: "cache", value: JSON.stringify({ href: path }) }), path).toEqual([]);
      expect(urlSecrets(`https://app.test/x?ref=${encodeURIComponent(path)}`), path).toEqual([]);
      expect(cookieTier({ name: "appstate", value: path, httpOnly: false }, true), path).toBeNull();
    }
  });

  it("one short or random-looking piece never makes a token a path (the examples an earlier rule called paths)", () => {
    for (const token of ["keuKworc/72N1kIkJ5mQjGuvL9k3e8RRxCORrdK7NZs", "4/f9EDeEMdOdCrluy3cor3zIui5R6gz9K1cB8DnegrU", "levZOQeFlMUeSw5bnSgCr4zKCjog2b/8", "/Ko/Xk3pQ9xW2mV7cL4nR8tYabcdEFGHijk12LM",
      "caxso3/SCS1tjURjp5uz4keV0SldtQ4V5RrYQQzM/ac", "ve/Zbzio5/Z4ZGLOGCp24cHJf26hMPW7",
      // Short words and short numbers between slashes say nothing, even three of them.
      "Xk3pQ9xW2mV7cL4nR8tYabcdEFGHij/ab/xy/ok", "Xk3pQ9xW2mV7cL4nR8tYabcdEFGHij/12/34/56"]) {
      expect(classifyString("anything", token).map((item) => item.tier), token).toContain("strong");
    }
  });

  describe("a credential context wins over every path or shape heuristic", () => {
    const TOKEN_LIKE = ["/Ko/Xk3pQ9xW2mV7cL4nR8tYabcdEFGHijk12LM", "/Tokens/Xk3pQ9xW2mV7cL4nR8tYabcdEFGHijk12LM", ...MIXED_CASE_PATHS, "/users/8423/orders/12345/items/99882211"];
    it.each(TOKEN_LIKE)("%s is strong under a credential key (top level, JSON leaf, parent-key inheritance), a credential URL parameter and a credential header", (value) => {
      for (const name of ["token", "access_token", "auth", "session", "sid", "refresh_token", "apiKey", "password"]) {
        expect(classifyString(name, value).map((item) => item.tier), `${name} ${value}`).toContain("strong");
      }
      expect(classifyStorageEntry({ name: "state", value: JSON.stringify({ access_token: value }) }).filter((item) => item.value === value && item.tier === "strong"), "leaf").toHaveLength(1);
      expect(classifyStorageEntry({ name: "state", value: JSON.stringify({ session: { value } }) }).filter((item) => item.value === value && item.tier === "strong"), "generic leaf").toHaveLength(1);
      expect(classifyStorageEntry({ name: "accessToken", value: JSON.stringify(value) }).filter((item) => item.value === value && item.tier === "strong"), "stored string").toHaveLength(1);
      expect(urlSecrets(`https://app.test/cb?token=${encodeURIComponent(value)}`).filter((item) => item.value === value && item.tier === "strong"), "?token=").toHaveLength(1);
      expect(urlSecrets(`https://app.test/cb#access_token=${encodeURIComponent(value)}&token_type=bearer`).filter((item) => item.value === value && item.tier === "strong"), "#access_token=").toHaveLength(1);
      for (const header of ["X-Auth-Token", "X-API-Key", "Authorization", "X-Access-Token"]) {
        expect(headerSecrets([{ name: header, value }]).filter((item) => item.value === value && item.tier === "strong"), header).toHaveLength(1);
      }
    });

    it("a short value under a credential key is scrubbed even when it is a route (leaf mode)", () => {
      expect(classifyStorageEntry({ name: "state", value: JSON.stringify({ session: "/orders/12" }) }).map((item) => item.tier)).toEqual(["weak"]);
    });

    it("under a neutral key and a neutral parameter or header the same values stay what they were: paths are nothing or weak, tokens strong", () => {
      expect(classifyString("anything", MIXED_CASE_PATHS[0]!).filter((item) => item.tier === "strong")).toEqual([]);
      expect(urlSecrets(`https://app.test/cb?next=${encodeURIComponent(MIXED_CASE_PATHS[0]!)}`)).toEqual([]);
      expect(headerSecrets([{ name: "X-Request-Path", value: MIXED_CASE_PATHS[0]! }])).toEqual([]);
    });
  });

  it("a page object without mainFrame still has its first frame treated as the main frame (fail closed)", async () => {
    const mainFrames = [brokenFrame(`${E2E_EXECUTOR_COMPILED_ORIGIN}/`), okFrame()];
    const context: BrowserContextLike = { storageState: async () => ({ cookies: [], origins: [] }), pages: () => [{ frames: () => mainFrames }] };
    await expect(readBrowserState(context)).rejects.toMatchObject({ code: "sessionstorage-unreadable" });
    const childFrames = [okFrame(), brokenFrame()];
    const child: BrowserContextLike = { storageState: async () => ({ cookies: [], origins: [] }), pages: () => [{ frames: () => childFrames }] };
    await expect(readBrowserState(child)).resolves.toBeDefined();
  });

  it("the host's capture store drops a trace that shows an evidence-only value and keeps one that does not", async () => {
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


const b64 = (text: string) => Buffer.from(text).toString("base64url");

const JWT = `${b64('{"alg":"HS256","typ":"JWT"}')}.${b64('{"sub":"visitor-1234567890"}')}.c2lnbmF0dXJlLWJ5dGVzLWhlcmU`;

const tierOf = (items: readonly ClassifiedValue[], value: string) => items.find((item) => item.value === value)?.tier ?? null;

const TOOLS_V4 = TOOLS.map((tool) => ({ type: "function", name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));

type Part = { type: "text"; text: string };

async function stackFor(storage: Array<{ name: string; value: string }>, redactorOptions?: { maskOnlyLimit?: number }) {
  const e = await harness.executor(undefined, redactorOptions);
  e.state.current = { cookies: [], origins: [{ localStorage: storage }] };
  const stack = createHostModelStack({ socketPath: e.run.socketPath, runId: RUN_ID, routeId: "rovara-e2e-default", registry: e.registry, sessionSync: e.source, position: () => POSITION });
  /** What the model was shown for one user text. */
  const shown = async (text: string): Promise<string> => {
    await stack.adapter.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text }] }], tools: TOOLS_V4 });
    const last = e.run.seen[e.run.seen.length - 1] as { prompt: Array<{ content: Part[] }> };
    return last.prompt[0]!.content[0]!.text;
  };
  return { e, stack, shown };
}

describe("a random-looking run of 16+ characters at the top level is weak (masked), whatever its alphabet", () => {
  const A64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
  const make: Record<string, (n: number) => string> = {
    hex: (n) => randomBytes(Math.ceil(n / 2)).toString("hex").slice(0, n),
    lower: (n) => Array.from({ length: n }, () => "abcdefghijklmnopqrstuvwxyz"[randomInt(26)]).join(""),
    upper: (n) => Array.from({ length: n }, () => "ABCDEFGHIJKLMNOPQRSTUVWXYZ"[randomInt(26)]).join(""),
    base64: (n) => randomBytes(n).toString("base64").slice(0, n),
    base64url: (n) => randomBytes(n).toString("base64url").slice(0, n),
    nanoid: (n) => Array.from({ length: n }, () => A64[randomInt(64)]).join(""),
    "payload.signature": (n) => `${randomBytes(n).toString("base64url").slice(0, n >> 1)}.${randomBytes(n).toString("base64url").slice(0, n >> 1)}`,
  };
  it.each(Object.keys(make))("%s of 16 to 31 characters under a neutral key: weak in at least 85 percent, never unregistered, never strong", (kind) => {
    for (const size of [16, 21, 24, 31]) {
      let weak = 0;
      const total = 200;
      for (let index = 0; index < total; index += 1) {
        const value = make[kind]!(size);
        const tier = tierOf(classifyStorageEntry({ name: "lastDocument", value }), value);
        expect(["weak", "scrub"], `${kind} ${value}`).toContain(tier);
        if (tier === "weak") weak += 1;
      }
      expect(weak / total, `${kind} ${size}`).toBeGreaterThanOrEqual(0.85);
    }
  });
  it.each([["s:abc123DEF456ghi789.Zm9vYmFyYmF6cXV4MTIz"], ["Zm9vYmFyYmF6.cXV4MTIzNDU2Nzg5"], ["12|abcDEF123ghiJKL456mno"], ["ya29.a0AfH6SMBx9QzLmN2pRtVw8YcK3"], ["sessionid=a1b2c3d4e5f6a7b8"], ["oauth_state=Xk3_9aB-q7LmZp2RtVw8"],
    ["V1StGXR8_Z5jdHi6B-myT"], ["Ck3x-Qw9_ZLm2vB7nRtYhA"], ["9f86d081884c7d65"], ["a1b2c3d4e5f60718293a4b5c"]])("the random-looking shape %s is weak", (value) => {
    expect(tierOf(classifyStorageEntry({ name: "lastDocument", value }), value)).toBe("weak");
  });
  it("the model does not read a nanoid, a token_urlsafe(16) or a short hex id kept under a neutral top-level key; it still reads the base URL beside them", async () => {
    const { shown } = await stackFor([{ name: "uid", value: "V1StGXR8_Z5jdHi6B-myT" }, { name: "anonId", value: "Ck3x-Qw9_ZLm2vB7nRtYhA" }, { name: "build", value: "9f86d081884c7d65" }, { name: "apiBase", value: "https://app.example.com" }]);
    expect(await shown("user V1StGXR8_Z5jdHi6B-myT anon Ck3x-Qw9_ZLm2vB7nRtYhA build 9f86d081884c7d65 at https://app.example.com/orders")).toBe("user <session> anon <session> build <session> at https://app.example.com/orders");
  });
  it("a leaf of JSON is unchanged by this rule (a cache of ordinary ids is not masked)", () => {
    const value = "V1StGXR8_Z5jdHi6B-myT";
    expect(tierOf(classifyStorageEntry({ name: "settings", value: JSON.stringify({ uid: value }) }), value)).toBeNull();
  });
});

describe("an oversized ordinary parameter or header does not fail the view closed", () => {
  it("a 20 KB query value, a 20 KB fragment value, 250 parameters and a 17 KB Referer leave the view open; the credential in the 250th parameter is still found", async () => {
    const { e, shown } = await stackFor([]);
    const fresh = "ORD2026102712345678";
    e.source.learn(urlSecrets(`https://app.test/?q=${"x".repeat(20_000)}`));
    e.source.learn(urlSecrets(`https://app.test/#json=${"A".repeat(20_000)}`));
    e.source.learn(headerSecrets([{ name: "referer", value: `https://app.test/${"y".repeat(17_000)}` }]));
    const many = `${Array.from({ length: 249 }, (_unused, index) => `f${index}=v${index}`).join("&")}&token=Ab3dEf9hJk`;
    const items = urlSecrets(`https://app.test/?${many}`);
    expect(tierOf(items, "Ab3dEf9hJk")).toBe("strong");
    e.source.learn(items);
    expect(e.registry.maskOverflowed()).toBe(false);
    expect(await shown(`order ${fresh} /orders/12345/items/99882211 https://app.example.com/orders/12345`)).toBe(`order ${fresh} /orders/12345/items/99882211 https://app.example.com/orders/12345`);
  });
  it("a header list of 300 ordinary headers leaves the view open, and a credential header at the end of it is still found", () => {
    const headers = [...Array.from({ length: 299 }, (_unused, index) => ({ name: `x-h${index}`, value: "short-value-here" })), { name: "x-api-key", value: "Ab3dEf9hJk" }];
    const items = headerSecrets(headers);
    expect(items.some((item) => item.tier === "overflow")).toBe(false);
    expect(tierOf(items, "Ab3dEf9hJk")).toBe("strong");
  });
  it("a credential-named parameter or header that is too large still fails the view closed (the one case that must)", () => {
    expect(urlSecrets(`https://app.test/?access_token=${"x".repeat(20_000)}`).some((item) => item.tier === "overflow")).toBe(true);
    expect(headerSecrets([{ name: "cookie", value: `a=${"y".repeat(20_000)}` }]).some((item) => item.tier === "overflow")).toBe(true);
  });
});

describe("the fail-closed mask and the matcher", () => {
  it("once the view has failed closed, a run of 16+ of one case, a run over 4,096 characters and a digit-less lower-case run are masked; slugs and paths are not", async () => {
    const { e, shown } = await stackFor([]);
    e.source.learn([{ value: "", tier: "overflow" }]);
    const long = "Qk".repeat(2_600);
    const out = await shown(`a kjhsdfqwpoiuzxcmvbnq b ABCDEFGHIJKLMNOPQRSTUVWXYZ c ${long} d /projects/alpha/settings e my-quarterly-report-final f Quarterly Report g /Api/userProfiles/orderItems`);
    expect(out).toBe("a <session> b <session> c <session> d /projects/alpha/settings e my-quarterly-report-final f Quarterly Report g /Api/userProfiles/orderItems");
  });
  it("no recursion: 40 values that share 60,000 characters register and are masked without a stack overflow, and are never thrown out of addSessionSecret", () => {
    const redactor = createCredentialRedactor([]);
    const common = "Zq".repeat(30_000);
    const values = Array.from({ length: 40 }, (_unused, index) => `${common}${String(index).padStart(4, "0")}`);
    for (const value of values) { expect(() => redactor.addSessionSecret(value, { evidenceOnly: true })).not.toThrow(); }
    for (const value of values.slice(0, 3)) expect(() => redactor.addMaskOnly(`${value}x`)).not.toThrow();
    expect(redactor.maskEvidenceOnly(`a ${values[7]!} b`)).toBe("a <session> b");
  });
});

describe("a signed-out visitor's session cookie is registered by its name and value; its id and cart are not", () => {
  const SUPABASE = `base64-${b64(JSON.stringify({ access_token: JWT, refresh_token: "r3fr3sh0pq9", user: { id: "u1" } }))}`;
  it("token shapes include a `base64-` session", () => {
    expect(isTokenShape(SUPABASE)).toBe(true);
    expect(isTokenShape("base64-short")).toBe(false);
  });
  it.each([
    ["sb-abcdefgh-auth-token", SUPABASE, true], ["sb-abcdefgh-auth-token", "plainvalueplainvalue", true], ["sid", "a1b2c3d4e5f6a7b8", true], ["session", "Qx7Lm2Vb9Tz4Wk8P", true], ["connect.sid", "s%3AQx7Lm2Vb9Tz4Wk8P.abc", true],
    ["visitor", "visitor-3f2504e0-4f89-11d3-9a0c-0305e82c3301", false], ["visitor_id", "Qx7Lm2Vb9Tz4Wk8PzN3", false], ["cart", "3-items-blue-shirt-red-hat", false],
    ["anon_id", "Qx7Lm2Vb9Tz4Wk8PzN3", false], ["_ga", "GA1.2.123456789.1730000000", false], ["theme", "dark", false], ["lang", "en-US", false], ["foo", "short", false], ["token", "Ab3dEf9hJk", true], ["secret", "Ab3dEf9hJk", true], ["auth", "Ab3dEf9hJk", false], ["foo", "Ab3dEf9hJk12", false],
  ])("cookie %s=%s: %s", (name, value, secret) => {
    expect(visitorCookieSecret({ name, value, httpOnly: false })).toBe(secret);
  });
  it("an opaque value under an unknown name is weak (masked, never refused); under a session or login name it is strong", () => {
    expect(cookieTier({ name: "appstate", value: "Qx7Lm2Vb9Tz4Wk8PzN3", httpOnly: false }, true)).toBe("weak");
    for (const name of ["PHPSESSID", "JSESSIONID", ".ASPXAUTH", "SESS1a2b3c4d5e", "login_state"]) expect(cookieTier({ name, value: "Qx7Lm2Vb9Tz4Wk8PzN3", httpOnly: false }, true), name).toBe("strong");
  });
  it("an HttpOnly cookie and a JWT count under any name; with no name the old rule stands", () => {
    expect(visitorCookieSecret({ name: "foo", value: "Qx7Lm2Vb9Tz4", httpOnly: true })).toBe(true);
    expect(visitorCookieSecret({ name: "visitor", value: JWT, httpOnly: false })).toBe(true);
    expect(visitorCookieSecret({ value: "a1b2c3d4e5f6a7b8c9d0", httpOnly: false })).toBe(false);
  });
  it("through the state read and the Cookie header", () => {
    const state: BrowserSecretState = { cookies: [{ name: "sb-abcdefgh-auth-token", value: SUPABASE, httpOnly: false }, { name: "visitor", value: "visitor-3f2504e0-4f89-11d3-9a0c-0305e82c3301", httpOnly: false }], origins: [] };
    const told: ClassifiedValue[] = [];
    tellBrowserState(state, (item) => told.push(item), undefined, { visitor: true });
    expect(told).toEqual([{ value: SUPABASE, tier: "strong" }]);
    const header = [{ name: "cookie", value: `visitor=visitor-3f2504e0-4f89-11d3-9a0c-0305e82c3301; sb-abcdefgh-auth-token=${SUPABASE}` }];
    expect(headerSecrets(header, { visitor: true }).map((item) => item.value)).toEqual([SUPABASE]);
    expect(headerSecrets([{ name: "cookie", value: "visitor=visitor-1234567890123; session=Qx7Lm2Vb9Tz4Wk8P" }], { visitor: true }).map((item) => item.value)).toEqual(["Qx7Lm2Vb9Tz4Wk8P"]);
  });
});

describe("a one-time parameter needs a token-like value", () => {
  it.each([["otp", "required"], ["invite", "accepted"], ["magic_link", "sent-already"], ["inviteCode", "accepted"], ["oobCode", "expired-link"], ["verificationCode", "pending-review"]])("?%s=%s is not registered", (name, value) => {
    expect(urlSecrets(`https://app.test/auth?${name}=${value}`)).toEqual([]);
  });
  it("the status word is not refused when the page shows it", async () => {
    const e = await harness.executor();
    e.source.learn(urlSecrets("https://app.test/auth?otp=required&invite=accepted"));
    expect(await e.executorSays("Two-factor required to continue; invite accepted")).toBe("ok");
    expect(e.registry.sessionSecrets).toEqual([]);
  });
  it.each([["otc"], ["magic_code"], ["invite"], ["verify_code"], ["signin_code"], ["login_code"], ["login_link"], ["signin_link"], ["onetime_code"], ["email_code"], ["magic_token"], ["passwordless_token"]])("?%s= with a token-like value is strong", (name) => {
    expect(tierOf(urlSecrets(`https://app.test/auth?${name}=Qx7Lm2Vb9Tz4`), "Qx7Lm2Vb9Tz4")).toBe("strong");
  });
  it("a digit-less random value and a hex value are token-like too", () => {
    for (const value of ["kQwErTyUiOpAsDfGhJkLzXcVbNmQwErT", "9f86d081884c7d659f86d081884c7d65"]) expect(tierOf(urlSecrets(`https://app.test/auth?oobCode=${value}`), value), value).toBe("strong");
  });
  it("a magic link URL counts when a piece of it is opaque", () => {
    const link = "https://app.test/magic/b9Gk2Lx7Qw4Zp1Vm6Rt3";
    expect(tierOf(urlSecrets(`https://app.test/?magicLink=${encodeURIComponent(link)}`), link)).toBe("strong");
  });
  it("a neutral value classified as before: an opaque token under another name is weak", () => {
    expect(tierOf(classifyString("lastDocument", "Dk3pQ9xW2mV7cL4nR8tY"), "Dk3pQ9xW2mV7cL4nR8tY")).toBe("weak");
  });
});

describe("the context wiring, through a real Chromium, for a signed-out visitor", () => {
  const haveChromium = existsSync(chromium.executablePath());
  const VISITOR = "visitor-3f2504e0-4f89-11d3-9a0c-0305e82c3301";
  const SB_VALUE = `base64-${b64(JSON.stringify({ access_token: JWT, refresh_token: "r3fr3sh0pq9" }))}`;
  const API_KEY = "Qx7Lm2Vb9Tz4Wk8PzN3";

  /** A session sync that only records what the wiring tells it, so each path is seen on its own. */
  function recorder() {
    const learned: ClassifiedValue[] = [];
    const attached: Array<{ sessionRef: string; anonymous: boolean | undefined; reader: { storageState(): Promise<BrowserSecretState> } }> = [];
    const pending: Array<Promise<unknown>> = [];
    const source: E2ESessionSyncSource = {
      read: async () => [],
      track: (promise) => { pending.push(promise); },
      learn: (items) => { learned.push(...items); },
      attach: (sessionRef, reader, options) => { attached.push({ sessionRef, anonymous: options?.anonymous, reader }); },
      detach: () => undefined,
    };
    return { source, learned, attached, settle: async () => { await Promise.allSettled(pending); } };
  }
  async function visitorPage(routes: (url: string) => { headers?: Record<string, string>; body?: string }) {
    const server: Server = createServer((request, response) => {
      const route = routes(request.url ?? "/");
      response.writeHead(200, { "content-type": "text/html", ...(route.headers ?? {}) });
      response.end(route.body ?? "<html><body>ok</body></html>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)); }));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const browser: Browser = await chromium.launch();
    closers.push(() => browser.close());
    const context = await browser.newContext();
    return { origin, context };
  }

  it.skipIf(!haveChromium)("Set-Cookie: a Supabase session cookie issued to a visitor is registered; a plain visitor id cookie is not", async () => {
    const { origin, context } = await visitorPage((url) => url === "/signup"
      ? { headers: { "set-cookie": [`sb-abcdefgh-auth-token=${SB_VALUE}; Path=/`, `visitor=${VISITOR}; Path=/`] as unknown as string } } : { headers: { "set-cookie": `visitor=${VISITOR}; Path=/` } });
    const r = recorder();
    const registered: string[] = [];
    wireSessionContext({ browserContext: context, sessionRef: "visitor-1", anonymous: true, sessionSync: r.source, registerSecret: (value) => registered.push(value) });
    const page = await context.newPage();
    await page.goto(`${origin}/`);
    await r.settle();
    expect(registered).toEqual([]);
    await page.goto(`${origin}/signup`);
    await r.settle();
    expect(registered).toEqual([SB_VALUE]);
    expect(r.attached.map((item) => [item.sessionRef, item.anonymous])).toEqual([["visitor-1", true]]);
  }, 60_000);

  it.skipIf(!haveChromium)("request watch: a visitor's Authorization header and its #access_token= fragment are learned; its Cookie header with an id and a cart is not", async () => {
    const { origin, context } = await visitorPage(() => ({ headers: { "set-cookie": `visitor=${VISITOR}; Path=/` },
      body: `<html><body><script>fetch("/api/me", { headers: { Authorization: "Bearer ${API_KEY}" } });</script></body></html>` }));
    const r = recorder();
    wireSessionContext({ browserContext: context, sessionRef: "visitor-1", anonymous: true, sessionSync: r.source, registerSecret: () => undefined });
    const page = await context.newPage();
    await page.goto(`${origin}/`);
    await page.goto(`${origin}/again`);
    await page.waitForLoadState("networkidle");
    await page.goto(`${origin}/welcome#access_token=${JWT}&token_type=bearer`);
    await r.settle();
    const values = r.learned.map((item) => item.value);
    expect(values).toContain(API_KEY);
    expect(values).toContain(JWT);
    // The second page load sent `Cookie: visitor=...`: the visitor bar leaves it out (it is registered if the watch ignores the bar).
    expect(values).not.toContain(VISITOR);
  }, 60_000);

  it.skipIf(!haveChromium)("case close: what a visitor's browser holds at the end (a token the app stored mid-step) is learned; the visitor id beside it is not", async () => {
    const { origin, context } = await visitorPage(() => ({ headers: { "set-cookie": `visitor=${VISITOR}; Path=/` },
      body: `<html><body><script>localStorage.setItem("visitor_id", "${VISITOR}"); localStorage.setItem("sb-abcdefgh-auth-token", JSON.stringify({ access_token: "${JWT}", refresh_token: "r3fr3sh0pq9" }));</script></body></html>` }));
    const page = await context.newPage();
    await page.goto(`${origin}/`);
    const r = recorder();
    await readSessionContextAtClose({ browserContext: context, anonymous: true, sessionSync: r.source });
    const values = r.learned.map((item) => item.value);
    expect(values).toContain(JWT);
    expect(values).toContain("r3fr3sh0pq9");
    expect(values).not.toContain(VISITOR);
    // The same read for a signed-in context takes the id as well (the visitor bar is the only difference).
    const owned = recorder();
    await readSessionContextAtClose({ browserContext: context, anonymous: false, sessionSync: owned.source });
    expect(owned.learned.map((item) => item.value)).toContain(VISITOR);
  }, 60_000);
});

describe("ordinary values at the top level of storage are scrub-only, never masked for the model", () => {
  const ORDINARY: Array<[string, string]> = [["apiBase", "https://app.example.com"], ["lastProject", "Quarterly Report"], ["lastRoute", "/projects/alpha/settings"], ["returnUrl", "https://app.example.com/orders/12345"],
    ["userEmail", "maya.rodriguez@example.com"], ["selectedWorkspace", "acme-engineering-team"], ["draft:42", "Meeting notes for Monday standup"], ["lastSeen", "2026-10-27T09:15:00.000Z"],
    ["workspaceId", "3f2504e0-4f89-11d3-9a0c-0305e82c3301"], ["tz", "America/Los_Angeles"], ["apiHost", "login.example.com"], ["searchQuery", "internationalization settings"], ["lastSlug", "my-quarterly-report-2024-final"], ["lastPath", "projects/alpha/settings2"], ["lastPath2", "Pqe/Rta/Xwo/Zyl/Mnu/Cvb/Dfe/Ghi"], ["cdnHost", "cdn-static.xyz-sprl.zrkq.tech"], ["word", "internationalization"]];
  it.each(ORDINARY)("%s=%s is scrub at the top level and not registered as a JSON leaf", (name, value) => {
    expect(tierOf(classifyStorageEntry({ name, value }), value)).toBe("scrub");
    expect(tierOf(classifyStorageEntry({ name: "settings", value: JSON.stringify({ [name]: value }) }), value)).toBeNull();
  });
  it("a token-shaped value at the top level is still weak (masked), and a sentence under a credential-sounding name is weak too", () => {
    expect(tierOf(classifyStorageEntry({ name: "lastDocument", value: "Dk3pQ9xW2mV7cL4nR8tY" }), "Dk3pQ9xW2mV7cL4nR8tY")).toBe("weak");
    expect(tierOf(classifyString("tokenEndpoint", "https://login.example.com/oauth2/token"), "https://login.example.com/oauth2/token")).toBe("weak");
  });
  it("the model reads an app's base URL, a project name that is part of a longer word, a route and a draft; the same values are still scrubbed from evidence; a token beside them is masked", async () => {
    const { e, shown } = await stackFor([{ name: "apiBase", value: "https://app.example.com" }, { name: "lastProject", value: "Quarterly Report" }, { name: "lastRoute", value: "/projects/alpha/settings" },
      { name: "selectedWorkspace", value: "acme-engineering-team" }, { name: "draft:42", value: "Meeting notes for Monday standup" }, { name: "lastDocument", value: "Dk3pQ9xW2mV7cL4nR8tY" }]);
    const text = "URL: https://app.example.com/orders/12345 | Quarterly Reports overview | /acme-engineering-team/settings | Meeting notes for Monday standup | /projects/alpha/settings | doc Dk3pQ9xW2mV7cL4nR8tY";
    expect(await shown(text)).toBe(text.replace("Dk3pQ9xW2mV7cL4nR8tY", "<session>"));
    // Positive control: the sync registered them (evidence scrub and scan know them) and the call was not refused.
    for (const value of ["https://app.example.com", "Quarterly Report", "acme-engineering-team", "Meeting notes for Monday standup"]) expect(e.redactor.contains(Buffer.from(value), "all"), value).toBe(true);
    expect(e.redactor.text("see Quarterly Report")).toBe("see <session>");
    expect(e.registry.modelScan(Buffer.from(text))).toBe(false);
  });
  it("the redactor masks a scrub-only value for nobody, and a scrub-only value later registered weak becomes maskable (the other way round it stays maskable)", () => {
    const redactor = createCredentialRedactor([]);
    redactor.addSessionSecret("Quarterly Report", { evidenceOnly: true, scrubOnly: true });
    expect(redactor.maskEvidenceOnly("a Quarterly Report b")).toBe("a Quarterly Report b");
    expect(redactor.text("a Quarterly Report b")).toBe("a <session> b");
    redactor.addSessionSecret("Quarterly Report", { evidenceOnly: true });
    expect(redactor.maskEvidenceOnly("a Quarterly Report b")).toBe("a <session> b");
    redactor.addSessionSecret("Quarterly Report", { evidenceOnly: true, scrubOnly: true });
    expect(redactor.maskEvidenceOnly("a Quarterly Report b")).toBe("a <session> b");
  });
});

describe("the caps do not stop the mask", () => {
  const weakItem = (index: number): ClassifiedValue => ({ value: `Zq${String(index).padStart(6, "0")}LmWp3Rt6YvB2nXc`, tier: "weak" });
  it("the 2,001st weak value (past the evidence cap) and the 2,500th are still masked, and the call is not refused", async () => {
    const { e, shown } = await stackFor([]);
    e.source.learn(Array.from({ length: 2_500 }, (_unused, index) => weakItem(index)));
    expect(await shown(`first ${weakItem(0).value} 2000th ${weakItem(1_999).value} 2001st ${weakItem(2_000).value} 2500th ${weakItem(2_499).value} ordinary text`)).toBe("first <session> 2000th <session> 2001st <session> 2500th <session> ordinary text");
    // Only the first 2,000 are scrubbed from evidence (the cap is the evidence scrub's); the rest are held for the mask alone.
    expect(e.redactor.contains(Buffer.from(weakItem(1_999).value), "all")).toBe(true);
    expect(e.redactor.contains(Buffer.from(weakItem(2_000).value), "all")).toBe(false);
    expect(e.registry.sessionSecrets).toEqual([]);
  });
  it("the 201st opaque leaf of one storage entry and the 250th are still masked", async () => {
    const leaves = Object.fromEntries(Array.from({ length: 250 }, (_unused, index) => [`k${index}`, `Lf${String(index).padStart(5, "0")}Xc7Yb2Nm5Qr8Tw`]));
    const { shown } = await stackFor([{ name: "cache", value: JSON.stringify(leaves) }]);
    expect(await shown(`a ${leaves.k0 as string} b ${leaves.k199 as string} c ${leaves.k200 as string} d ${leaves.k249 as string}`)).toBe("a <session> b <session> c <session> d <session>");
  });
  it("past even the mask bound the model's view fails closed: every opaque run of 16+ characters is masked, ordinary text is not, and the call is not refused", async () => {
    const { e, shown } = await stackFor([], { maskOnlyLimit: 5 });
    const fresh = "Zq8LmWp3Rt6YvB2nXc5K";
    // Before the bound is passed, an unregistered run is shown (the control).
    expect(await shown(`doc ${fresh}`)).toBe(`doc ${fresh}`);
    e.source.learn(Array.from({ length: 8 }, (_unused, index) => ({ value: `Mk${String(index).padStart(6, "0")}LmWp3Rt6YvB2nXc`, tier: "mask" as const })));
    expect(e.registry.maskOverflowed()).toBe(true);
    expect(await shown(`doc ${fresh} path /projects/alpha/settings words Quarterly Report short Ab3dEf9h`)).toBe("doc <session> path /projects/alpha/settings words Quarterly Report short Ab3dEf9h");
  });
  it("an overflow note from the classifier (a weak value over 64 KiB) fails the view closed; a scrub-only value that large does not", () => {
    expect(classifyStorageEntry({ name: "session", value: "word ".repeat(20_000) }).some((item) => item.tier === "overflow")).toBe(true);
    expect(classifyStorageEntry({ name: "blob", value: "plain words ".repeat(8_000) }).some((item) => item.tier === "overflow")).toBe(false);
  });
  it("one combined matcher: 20,000 values that share a start (JWT-like) and a 200 KB text full of that start are masked in bounded time (cost scales with the input), the view failing closed past the bucket bound", () => {
    const head = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.";
    const secretAt = (index: number) => `${head}${String(index).padStart(8, "0")}.sig${String(index * 7).padStart(8, "0")}`;
    const target = secretAt(12_345);
    // Register `values` values that share a start, then mask a text of `repeats` runs of that start. Returns the registry and the masked text.
    const registerAndMask = (values: number, repeats: number, text: string = `${`${head}unregistered `.repeat(repeats)}${target} end`) => {
      const registry = createSessionSecretRegistry({ redactor: createCredentialRedactor([]) });
      for (let index = 0; index < values; index += 1) registry.register(secretAt(index), { maskOnly: true });
      return { registry, out: registry.maskForModel(text) };
    };
    const { registry, out } = registerAndMask(20_000, 1_500);
    expect(out.endsWith(" end")).toBe(true);
    expect(out).not.toContain(target);
    expect(registry.maskOverflowed()).toBe(true);
    // The cost must not grow faster than the number of values and the text length together (500 values and 37 runs -> 4,000 and 300; the 8N input stays at or under 256 KiB so it stays in CPU cache; the full 20,000 and 1,500 ran once above).
    expectLinearScaling((values) => { const text = `${`${head}unregistered `.repeat(Math.round(values * 0.075))}${target} end`; return () => { registerAndMask(values, 0, text); }; }, { n: 500, unitBytes: 64, label: "mask registration and lookup by value count" });
  }, 60_000);
});

describe("a credential too large to register fails the view closed; an oversized ordinary parameter or header does not", () => {
  it("a credential-named URL value or header over 16 KiB gives an overflow note; below the bounds there is none", () => {
    expect(urlSecrets(`https://app.test/?token=${"x".repeat(20_000)}`).some((item) => item.tier === "overflow")).toBe(true);
    expect(urlSecrets("https://app.test/?a=b&token=Ab3dEf9hJk").some((item) => item.tier === "overflow")).toBe(false);
    expect(headerSecrets([{ name: "x-api-key", value: "y".repeat(20_000) }]).some((item) => item.tier === "overflow")).toBe(true);
    expect(headerSecrets([{ name: "authorization", value: `Bearer ${"y".repeat(20_000)}` }]).some((item) => item.tier === "overflow")).toBe(true);
    expect(headerSecrets([{ name: "x-api-key", value: "Ab3dEf9hJk" }]).some((item) => item.tier === "overflow")).toBe(false);
  });
  it("more weak leaves in one entry than the mask bound (5,000) give an overflow note; fewer do not", () => {
    const leaves = (count: number) => JSON.stringify(Object.fromEntries(Array.from({ length: count }, (_unused, index) => [`k${index}`, `Lf${String(index).padStart(6, "0")}Xc7Yb2Nm5Qr8Tw`])));
    expect(classifyStorageEntry({ name: "cache", value: leaves(5_300) }).some((item) => item.tier === "overflow")).toBe(true);
    expect(classifyStorageEntry({ name: "cache", value: leaves(300) }).some((item) => item.tier === "overflow")).toBe(false);
  });
  it("an overflow note is registered once, however often it is learned", () => {
    const registered: Array<{ value: string; overflow: boolean }> = [];
    const source = createE2ESessionSyncSource({ register: (value, options) => { registered.push({ value, overflow: options?.overflow === true }); }, known: () => [] });
    source.learn([{ value: "", tier: "overflow" }, { value: "", tier: "overflow" }]);
    source.learn([{ value: "", tier: "overflow" }]);
    expect(registered).toEqual([{ value: "", overflow: true }]);
  });
  it("an overflow note learned by the session source fails the model's view closed, once", async () => {
    const { e, shown } = await stackFor([]);
    const fresh = "Zq8LmWp3Rt6YvB2nXc5K";
    expect(await shown(`doc ${fresh}`)).toBe(`doc ${fresh}`);
    e.source.learn([{ value: "", tier: "overflow" }, { value: "", tier: "overflow" }]);
    expect(e.registry.maskOverflowed()).toBe(true);
    expect(await shown(`doc ${fresh}`)).toBe("doc <session>");
  });
});

describe("a signed-out visitor's context is read", () => {
  it("a token the visitor gains mid-step (a fragment, a Supabase-style cache) is registered and refused if shown; a visitor id and a cart are not registered", async () => {
    const e = await harness.executor();
    e.state.current = { cookies: [{ value: "visitor-3f2504e0-4f89-11d3-9a0c-0305e82c3301", httpOnly: false }], origins: [{ localStorage: [{ name: "visitor_id", value: "visitor-3f2504e0-4f89-11d3-9a0c-0305e82c3301" }, { name: "cart", value: "3 items: blue shirt, red hat" }] }] };
    e.source.detach("s1");
    e.source.attach("visitor", { storageState: async () => e.state.current }, { anonymous: true });
    expect((await e.executorSays("visitor visitor-3f2504e0-4f89-11d3-9a0c-0305e82c3301 cart 3 items: blue shirt, red hat")), "before").toBe("ok");
    e.state.current = { ...e.state.current, urls: [`https://app.test/welcome#access_token=${JWT}&token_type=bearer`], origins: [{ localStorage: [...e.state.current.origins[0]!.localStorage, { name: "sb-xyz-auth-token", value: JSON.stringify({ access_token: JWT, refresh_token: "r3fr3sh0pq9" }) }] }] };
    expect(await e.executorSays(`landed on https://app.test/welcome#access_token=${JWT}`)).toBe("credential-in-prompt");
    // The worker is told it too (the sync), so its own scan would refuse it.
    expect(e.registry.sessionSecrets).toContain(JWT);
    expect(e.registry.sessionSecrets).toContain("r3fr3sh0pq9");
    expect(e.registry.sessionSecrets).not.toContain("visitor-3f2504e0-4f89-11d3-9a0c-0305e82c3301");
  });
  const haveChromium = existsSync(chromium.executablePath());
  it.skipIf(!haveChromium)("real Chromium: an anonymous context that gains #access_token= after the first page is protected from the next model call; its visitor id is not registered", async () => {
    const server: Server = createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/html", "set-cookie": "visitor=visitor-3f2504e0-4f89-11d3-9a0c-0305e82c3301; Path=/" });
      response.end(`<!doctype html><html><body><p>Welcome visitor-3f2504e0-4f89-11d3-9a0c-0305e82c3301</p><script>localStorage.setItem("visitor_id", "visitor-3f2504e0-4f89-11d3-9a0c-0305e82c3301");</script></body></html>`);
      void request;
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)); }));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const browser: Browser = await chromium.launch();
    closers.push(() => browser.close());
    const context = await browser.newContext();
    const e = await harness.executor();
    e.source.detach("s1");
    // As the host attaches a signed-out visitor: with the visitor bar. Nothing else watches this context, so the fragment is found only because the visitor's browser state is read.
    e.source.attach("visitor", { storageState: () => readBrowserState(context) }, { anonymous: true });
    const page = await context.newPage();
    await page.goto(`${origin}/`);
    expect(await e.executorSays("Welcome visitor-3f2504e0-4f89-11d3-9a0c-0305e82c3301"), "the visitor id is no secret").toBe("ok");
    await page.goto(`${origin}/welcome#access_token=${JWT}&token_type=bearer`);
    expect(await e.executorSays(`You are at ${page.url()}`)).toBe("credential-in-prompt");
    expect(e.registry.sessionSecrets).toContain(JWT);
  }, 60_000);
});

describe("the visitor bar of the request watch", () => {
  it("a visitor's Cookie header (its id and cart) registers nothing, a JWT in it does; a signed-in context's cookie header is unchanged", () => {
    const header = [{ name: "cookie", value: `visitor=visitor-3f2504e0-4f89-11d3-9a0c-0305e82c3301; cart=3-items-blue-shirt-red-hat; sid=${JWT}` }];
    expect(headerSecrets(header, { visitor: true }).map((item) => item.value)).toEqual([JWT]);
    expect(headerSecrets(header).map((item) => item.value)).toEqual(expect.arrayContaining(["visitor-3f2504e0-4f89-11d3-9a0c-0305e82c3301", JWT]));
  });
});

describe("one-time sign-in URL parameters are credentials", () => {
  const SAML = "AAQAAMFbLinlmzYhpL8Tq7Wx0v3Cn2D5Rk9sE1uJ4gB6hN8mA";
  const OOB = "b9Gk2Lx7Qw4Zp1Vm6Rt3Hc8Dn5Fs0JyAeUo";
  it.each([["oobCode", OOB], ["otp", "Ab3dEf9hJk"], ["magic_link", "https://app.test/magic/b9Gk2Lx7Qw4Zp1Vm6Rt3"], ["magicLink", "https://app.test/magic/b9Gk2Lx7Qw4Zp1Vm6Rt3"], ["inviteCode", "Tm9x2Kq8Lw"],
    ["SAMLart", SAML], ["SAMLResponse", `${SAML}${SAML}`], ["verificationCode", "Qx7Lm2Vb9Tz"], ["resetCode", "Rn4Kp8Wd1Yc"], ["t", OOB], ["t", "Qx7Lm2Vb9Tz4Wk8P"]])("?%s= is strong", (name, value) => {
    expect(tierOf(urlSecrets(`https://app.test/auth?${name}=${encodeURIComponent(value)}&lang=en-US`), value)).toBe("strong");
  });
  it("SAMLart is one word (not sam and lart), and a parameter named t counts only when its value is a token; other *code names are masked, not refused", () => {
    expect(tierOf(urlSecrets("https://app.test/?t=1730000000"), "1730000000")).toBeNull();
    expect(tierOf(urlSecrets("https://app.test/?t=pending-review-status"), "pending-review-status")).toBeNull();
    expect(tierOf(urlSecrets("https://app.test/?promoCode=SUMMER2026SALE"), "SUMMER2026SALE")).toBe("weak");
    expect(urlSecrets("https://app.test/?lang=en-US&page=2&q=blue+shirts+for+summer")).toEqual([]);
  });
  it("a page URL that carries a live oobCode is refused when the model would be shown it; the same URL without it is not", async () => {
    const e = await harness.executor();
    e.source.learn(urlSecrets(`https://app.test/__/auth/action?mode=signIn&oobCode=${OOB}&apiKey=AIzaSyfake`));
    expect(await e.executorSays("at https://app.test/__/auth/action?mode=signIn")).toBe("ok");
    expect(await e.executorSays(`at https://app.test/__/auth/action?mode=signIn&oobCode=${OOB}`)).toBe("credential-in-prompt");
    expect(e.registry.sessionSecrets).toContain(OOB);
  });
  // A seeded generator (mulberry32), so the tokens of one run are the tokens of every run: the old test drew 50 tokens from `randomBytes` and failed about 1 run in 200, when one token's `-`/`_` cut it
  // into pieces that read as a slug (`dfakcoe9_do-eLOSC0ZGdO48bORcH9QZ`). A failure now names its token and repeats.
  const seededBytes = (seed: number, length: number): Buffer => {
    let state = seed >>> 0;
    const out = Buffer.alloc(length);
    for (let index = 0; index < length; index += 1) {
      state = (state + 0x6d2b79f5) >>> 0;
      let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
      mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
      out[index] = ((mixed ^ (mixed >>> 14)) >>> 0) & 0xff;
    }
    return out;
  };
  // The seed 11,300,000 is one the code before the fix failed on (4 of the 10,000 tokens below), found by scanning 300 seeds; the mean was 0.6.
  const masked = (token: string): boolean => tierOf(urlSecrets(`https://app.test/x?ref=${token}`), token) !== null;
  it("random tokens under a neutral parameter name are masked (weak); hex ids and UUIDs are not registered", () => {
    for (let index = 0; index < 50; index += 1) {
      const token = seededBytes(1000 + index, 24).toString("base64url");
      if (!/[0-9]/.test(token) || !/[A-Za-z]/.test(token)) continue;
      expect(tierOf(urlSecrets(`https://app.test/x?ref=${token}`), token), token).not.toBeNull();
    }
    expect(urlSecrets(`https://app.test/x?ref=${"a1".repeat(16)}&id=3f2504e0-4f89-11d3-9a0c-0305e82c3301`)).toEqual([]);
  });
  it("random tokens whose - and _ cut them into word-like pieces are still masked (the CI flake: a slug is made of words, not of a long mixed-case and digit run)", () => {
    for (const token of ["dfakcoe9_do-eLOSC0ZGdO48bORcH9QZ", "AxMGcuG16Qzv1umqOSlA9dIcra-eb-ug", "sni-azy_8rcF9mm0NjTo7m19tclN4XoO", "qy-613rGz5ikXquVMiqO06NSS3V_ip90"]) expect(masked(token), token).toBe(true);
  });
  it("slugs stay unregistered, even with a long camel-case word or a long number in them (the fix reads only a piece of both cases AND a digit as random)", () => {
    for (const slug of ["my-quarterly-report-NotificationsServiceHandler-2024", "my-quarterly-report-2024-final-version-notes", "projects_alpha_settings_notifications2_page", "release-notes-for-november-20241113123456"]) expect(masked(slug), slug).toBe(false);
  });
  it("10,000 seeded random base64url tokens of 24, 32 and 48 bytes are all masked, and 10,000 hex ids and UUIDs are none of them", () => {
    const missed: string[] = [];
    const overMasked: string[] = [];
    for (let index = 0; index < 10_000; index += 1) {
      const bytes = [24, 32, 48][index % 3]!;
      const token = seededBytes(11_300_000 + index, bytes).toString("base64url");
      if (/[0-9]/.test(token) && /[A-Za-z]/.test(token) && !masked(token)) missed.push(token);
      const hex = seededBytes(0xface + index, bytes).toString("hex");
      const uuid = [hex.slice(0, 8), hex.slice(8, 12), `4${hex.slice(13, 16)}`, `a${hex.slice(17, 20)}`, hex.slice(20, 32)].join("-");
      for (const id of [hex, uuid]) if (urlSecrets(`https://app.test/x?ref=${id}`).length > 0) overMasked.push(id);
    }
    expect(missed.slice(0, 5), `${missed.length} random tokens were not masked`).toEqual([]);
    expect(overMasked.slice(0, 5), `${overMasked.length} hex ids or UUIDs were registered`).toEqual([]);
  });
});

describe("analytics and anti-bot cookies are not credentials", () => {
  const OPAQUE = "oeu1698765432123r0.1234567890123";
  const COOKIES: Array<[string, string]> = [["optimizelyEndUserId", OPAQUE], ["_hjSessionUser_123456", "eyJpZCI6ImFiY2RlZmdoLWlqa2wiLCJjcmVhdGVkIjoxNjk4NzY1NDMyfQ=="], ["_hjSession_123456", "eyJpZCI6ImFiY2RlZiIsImMiOjE2OTg3NjU0MzJ9"],
    ["_uetsid", "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"], ["_uetvid", "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"], ["hubspotutk", "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"], ["__hstc", "123456789.a1b2c3d4e5f6a7b8.1698765432.1698765432.1"],
    ["_clck", "1abcdef|2|fgh|0|1234"], ["_clsk", "abcdef1234567890|1698765432123|1|0|x.clarity.ms/collect"], ["__stripe_mid", "3f2504e0-4f89-11d3-9a0c-0305e82c3301abcdef"], ["__stripe_sid", "3f2504e0-4f89-11d3-9a0c-0305e82c3301abcdef"],
    ["__cf_bm", "Qx7Lm2Vb9Tz4Wk8PzN3Qx7Lm2Vb9Tz4Wk8PzN3-1698765432-0-Abc"], ["cf_clearance", "Qx7Lm2Vb9Tz4Wk8PzN3Qx7Lm2Vb9Tz4Wk8PzN3-1698765432-1-Abc"], ["_gcl_au", "1.1.123456789.1698765432"], ["_fbc", "fb.1.1698765432123.IwAR0abcdefghijklmnop"],
    ["ajs_user_id", "a1b2c3d4e5f6a7b8c9d0"], ["mp_abc123_mixpanel", "%7B%22distinct_id%22%3A%20%22abcdef123456%22%7D"], ["amplitude_id_abc123", "eyJkZXZpY2VJZCI6ImFiY2RlZmdoaWprbCJ9"], ["intercom-session-abc123", "Qx7Lm2Vb9Tz4Wk8PzN3Qx7L"], ["utm_source_cookie", "Qx7Lm2Vb9Tz4Wk8PzN3"], ["datadome", "Qx7Lm2Vb9Tz4Wk8PzN3Qx7Lm2Vb9Tz4Wk8PzN3"]];
  it.each(COOKIES)("%s is never strong, in a signed-out or a signed-in browser, from the state, the Cookie header and cookieTier (an opaque value is weak)", (name, value) => {
    expect(analyticsCookieName(name), name).toBe(true);
    for (const visitor of [true, false]) {
      expect(["weak", null], `${name} visitor=${String(visitor)}`).toContain(cookieTier({ name, value, httpOnly: false }, visitor));
      expect(["weak", null], `${name} httpOnly visitor=${String(visitor)}`).toContain(cookieTier({ name, value, httpOnly: true }, visitor));
      const told: ClassifiedValue[] = [];
      tellBrowserState({ cookies: [{ name, value, httpOnly: true }], origins: [] }, (item) => told.push(item), undefined, { visitor });
      expect(told.filter((item) => item.tier === "strong"), `${name} state`).toEqual([]);
      expect(headerSecrets([{ name: "cookie", value: `${name}=${value}` }], { visitor }).filter((item) => item.tier === "strong"), `${name} header`).toEqual([]);
    }
  });
  it("a JWT is still a credential under an analytics name, and a real session cookie beside the analytics ones still is", () => {
    expect(cookieTier({ name: "ajs_user_id", value: JWT, httpOnly: false }, true)).toBe("strong");
    expect(cookieTier({ name: "session", value: "Qx7Lm2Vb9Tz4Wk8PzN3", httpOnly: false }, true)).toBe("strong");
    expect(cookieTier({ name: "connect.sid", value: "s%3AQx7Lm2Vb9Tz4Wk8P.abc", httpOnly: true }, false)).toBe("strong");
    const told: ClassifiedValue[] = [];
    tellBrowserState({ cookies: [{ name: "_ga", value: "GA1.2.123456789.1730000000", httpOnly: false }, { name: "sid", value: "a1b2c3d4e5f6a7b8c9d0", httpOnly: false }], origins: [] }, (item) => told.push(item));
    expect(told.filter((item) => item.tier === "strong")).toEqual([{ value: "a1b2c3d4e5f6a7b8c9d0", tier: "strong" }]);
  });
});

describe("dotted words and hyphenated phrases are not tokens", () => {
  const DOTTED = ["navigation.breadcrumbs.dashboard", "checkout.payment_method.label", "validation.messages.required", "components.dashboard.header", "notifications.preferences.email", "dashboard.mycompany.com", "analytics.amplitude.com",
    "myorganization.atlassian.net", "container.registry.local", "application.properties.server", "settings.profile.changePassword"];
  it.each(DOTTED)("%s is not strong or weak at the top level or as a JSON leaf, in a URL parameter or in a header", (value) => {
    expect(isTokenShape(value), value).toBe(false);
    expect(["scrub", null], value).toContain(tierOf(classifyStorageEntry({ name: "lastKey", value }), value));
    expect(tierOf(classifyStorageEntry({ name: "settings", value: JSON.stringify({ lastKey: value }) }), value)).toBeNull();
    expect(urlSecrets(`https://app.test/?label=${value}`).filter((item) => item.value === value)).toEqual([]);
    expect(headerSecrets([{ name: "x-label", value }]).filter((item) => item.value === value)).toEqual([]);
  });
  it("only a header that starts eyJ is a JWS or a JWE", () => {
    expect(isTokenShape(JWT)).toBe(true);
    expect(isTokenShape(`${b64('{"alg":"dir","enc":"A128GCM"}')}..${"a".repeat(16)}.${"b".repeat(16)}.${"c".repeat(16)}`)).toBe(true);
    expect(isTokenShape(`navigation.${b64('{"sub":"visitor-1234567890"}')}.c2lnbmF0dXJlLWJ5dGVzLWhlcmU`)).toBe(false);
    expect(tierOf(classifyString("anything", JWT), JWT)).toBe("strong");
  });
  it.each([["base64-encoded-image-data"], ["base64-thumbnail-preview"], ["base64-image-attachment-1"]])("%s is not a token shape: not strong at the top level, as a leaf, in a URL parameter or in a header", (value) => {
    expect(isTokenShape(value)).toBe(false);
    expect(["scrub", null]).toContain(tierOf(classifyStorageEntry({ name: "lastFormat", value }), value));
    expect(tierOf(classifyStorageEntry({ name: "settings", value: JSON.stringify({ lastFormat: value }) }), value)).toBeNull();
    expect(urlSecrets(`https://app.test/?format=${value}`).filter((item) => item.value === value)).toEqual([]);
    expect(headerSecrets([{ name: "x-format", value }]).filter((item) => item.value === value)).toEqual([]);
  });
  it("Supabase's `base64-` plus a JSON session stays strong", () => {
    const supabase = `base64-${b64(JSON.stringify({ access_token: JWT, refresh_token: "r3fr3sh0pq9" }))}`;
    expect(isTokenShape(supabase)).toBe(true);
    expect(cookieTier({ name: "sb-abcdefgh-auth-token", value: supabase, httpOnly: false }, true)).toBe("strong");
  });
});

describe("a JWT inside an oversized neutral value is found", () => {
  const padded = JSON.stringify({ pad: "x".repeat(12_000), session: { token: JWT }, tail: "y".repeat(12_000) });
  it("in a URL query value, a fragment value and a header value over 16 KiB", () => {
    expect(padded.length).toBeGreaterThan(16_384);
    expect(tierOf(urlSecrets(`https://app.test/?state=${encodeURIComponent(padded)}`), JWT)).toBe("strong");
    expect(tierOf(urlSecrets(`https://app.test/#state=${encodeURIComponent(padded)}`), JWT)).toBe("strong");
    expect(tierOf(headerSecrets([{ name: "x-state", value: padded }]), JWT)).toBe("strong");
  });
  it("ordinary text of that size registers nothing, and nothing is refused for it", () => {
    expect(urlSecrets(`https://app.test/?q=${"x".repeat(20_000)}`)).toEqual([]);
    expect(headerSecrets([{ name: "referer", value: `https://app.test/${"y".repeat(20_000)}` }])).toEqual([]);
  });
  it("the scan is bounded and linear: a megabyte of separators and dotted pieces takes well under a second, a JWT past the first MiB is not looked for, at most 100 are kept", () => {
    // Scaling checks: each shape is timed at a size and at eight times it (the 8N input stays at or under 256 KiB so it stays in CPU cache; the full 1.2 MB, 1.35 MB and 1.2 MB inputs are checked once, un-timed, below); the cost must grow no faster than the text.
    const shapes: Array<[string, number, number, (size: number) => string]> = [
      ["separators", 16_000, 2, (size) => ".-".repeat(size)],
      ["dotted pieces", 3_500, 9, (size) => "aaaaaaaa.".repeat(size)],
      ["spaces then a JWT", 16_000, 2, (size) => `${"z ".repeat(size)}${JWT}`],
    ];
    for (const [label, n, unitBytes, build] of shapes) {
      expectLinearScaling((size) => {
        const text = build(size);
        return () => oversizedTokens(text);
      }, { n, unitBytes, label: `oversizedTokens on ${label}` });
    }
    expect(oversizedTokens(".-".repeat(600_000))).toEqual([]);
    expect(oversizedTokens("aaaaaaaa.".repeat(150_000))).toEqual([]);
    expect(oversizedTokens(`${"z ".repeat(600_000)}${JWT}`)).toEqual([]);
    // A run longer than 64 KiB is not tested, whatever its shape.
    const huge = `${JWT.split(".")[0]!}.${"A".repeat(70_000)}.${"B".repeat(20)}`;
    expect(isTokenShape(huge)).toBe(true);
    expect(oversizedTokens(` ${huge} `)).toEqual([]);
    expect(oversizedTokens(Array.from({ length: 300 }, (_unused, index) => `${JWT}${index.toString(36)} `).join("")).length).toBe(100);
  });
});

describe("the mask has a hard time and size bound; past it the view fails closed and the run goes on", () => {
  it("20,000 nine-character values that share a 6-character start, and a 200 KB text made of it: registered and masked in under a second, nothing of the start left readable", () => {
    // Scaling check: registering the values and masking a text made of them must cost no more than linear in their number (200 values and a 2 KB text, then 1,600 and 16 KB; the 8N input, about 19 bytes a value, stays at or under 256 KiB so it stays in CPU cache). The full 20,000 values and 200 KB text run once, un-timed, below.
    const registerAndMask = (count: number) => {
      const text = "Zq8LmWxxx ".repeat(count);
      const registry = createSessionSecretRegistry({ redactor: createCredentialRedactor([]) });
      for (let index = 0; index < count; index += 1) registry.register(`Zq8LmW${String(index).padStart(3, "0")}`, { maskOnly: true });
      return { out: registry.maskForModel(text), overflowed: registry.maskOverflowed() };
    };
    expectLinearScaling((count) => () => { registerAndMask(count); }, { n: 200, unitBytes: 20, label: "registering values with a shared start and masking a text of them" });
    const { out, overflowed } = registerAndMask(20_000);
    expect(out).not.toContain("Zq8LmW");
    expect(overflowed).toBe(true);
  });
  // The values are held in memory the whole run, so they count toward the 256 KiB cache limit with the 8N text (`fixedBytes`): the timed scaling checks use values of 4 KB sharing their first 4,000 characters and a text of 8,000 then 64,000
  // characters (8 x 4 KB + 20 x 4.1 KB = under the limit); the full size (values of 32 KB sharing their first 32,000 characters, a 200 KB text) runs once, un-timed, with a generous bound on the time.
  const COMMON_SMALL = "ab".repeat(2_000);
  const COMMON_FULL = "ab".repeat(16_000);
  const valuesOf = (common: string, count: number): string[] => Array.from({ length: count }, (_unused, index) => `${common}${String(index).padStart(4, "0")}${"z".repeat(100)}`);
  const heldBytes = (values: readonly string[]): number => values.reduce((total, value) => total + value.length, 0);
  const periodic = (length: number): string => "ab".repeat(length / 2);
  const GENEROUS_MS = 5_000;
  it("20 values that share their first characters, and a periodic text: the cost grows with the text, not faster; at full size (32 KB values, 200 KB text) it is masked in good time", () => {
    const small = valuesOf(COMMON_SMALL, 20);
    const registry = createSessionSecretRegistry({ redactor: createCredentialRedactor([]) });
    for (const value of small) registry.register(value, { maskOnly: true });
    let out = "";
    expectLinearScaling((length) => {
      const text = periodic(length);
      return () => { out = registry.maskForModel(text); };
    }, { n: 8_000, fixedBytes: heldBytes(small), label: "masking a periodic text against 20 long values" });
    expect(out).not.toContain("ababab");
    const full = createSessionSecretRegistry({ redactor: createCredentialRedactor([]) });
    for (const value of valuesOf(COMMON_FULL, 20)) full.register(value, { maskOnly: true });
    const started = performance.now();
    const masked = full.maskForModel(periodic(200_000));
    expect(performance.now() - started).toBeLessThan(GENEROUS_MS);
    expect(masked).not.toContain("ababab");
  });
  it("5 values (too few to split the tree) and a periodic text: cut short by the work bound, the cost grows with the text, not faster; at full size (32 KB values, 200 KB text) it is cut short in good time", () => {
    const small = valuesOf(COMMON_SMALL, 5);
    const registry = createSessionSecretRegistry({ redactor: createCredentialRedactor([]) });
    for (const value of small) registry.register(value, { maskOnly: true });
    let out = "";
    expectLinearScaling((length) => {
      const text = periodic(length);
      return () => { out = registry.maskForModel(text); };
    }, { n: 8_000, fixedBytes: heldBytes(small), label: "masking a periodic text against 5 long values" });
    expect(out).not.toContain("ababab");
    const full = createSessionSecretRegistry({ redactor: createCredentialRedactor([]) });
    for (const value of valuesOf(COMMON_FULL, 5)) full.register(value, { maskOnly: true });
    const started = performance.now();
    const masked = full.maskForModel(periodic(200_000));
    expect(performance.now() - started).toBeLessThan(GENEROUS_MS);
    expect(masked).not.toContain("ababab");
  });
  it("a bucket that fills through weak evidence values degrades the mask too, and the registry reports it", () => {
    const registry = createSessionSecretRegistry({ redactor: createCredentialRedactor([]) });
    for (let index = 0; index < 5_000; index += 1) registry.register(`Zq8LmW${String(index).padStart(4, "0")}`, { evidenceOnly: true });
    expect(registry.maskOverflowed()).toBe(true);
    expect(registry.maskForModel("order Zq8LmW4999 and Zq8LmW0003")).toBe("order <session> and <session>");
  });
  it("the work bound: a text that costs more than the budget is cut short and reported, a normal text is not", () => {
    const redactor = createCredentialRedactor([]);
    const small = valuesOf(COMMON_SMALL, 20);
    for (const value of small) redactor.addMaskOnly(value);
    let exceeded = false;
    expectLinearScaling((length) => {
      const text = periodic(length);
      return () => { exceeded = redactor.maskEvidenceOnlyBounded(text).exceeded; };
    }, { n: 8_000, fixedBytes: heldBytes(small), label: "the work bound on a periodic text against 20 long values" });
    expect(exceeded).toBe(true);
    expect(redactor.maskEvidenceOnlyBounded("an ordinary page with no registered value").exceeded).toBe(false);
    const normal = createCredentialRedactor([]);
    normal.addMaskOnly("Dk3pQ9xW2mV7cL4nR8tY");
    expect(normal.maskEvidenceOnlyBounded("doc Dk3pQ9xW2mV7cL4nR8tY here")).toEqual({ text: "doc <session> here", exceeded: false });
  });
  // SCALING-CAP-BLIND: the scaling checks above stay under the caps (a bucket of 4,096 forms; 20,000 mask-only values). These pin each cap exactly: the last value that fits is taken, the first one past it is refused, and a refused
  // value costs the same however long the refusals go on (they do not grow with the number of values already refused).
  it("the value-count bound is exact: the 20,000th value is taken, the 20,001st and every one after it is refused without being stored, and a refusal costs no more as refusals pile up", () => {
    expect(MASK_ONLY_LIMIT).toBe(20_000);
    const redactor = createCredentialRedactor([]);
    // A distinct value per index, whose first 6 characters vary fastest so no bucket fills (the bucket bound is the next test).
    const valueOf = (index: number): string => `${index.toString(36).split("").reverse().join("").padEnd(6, "-")}Zk8mWx`;
    let taken = 0;
    for (let index = 0; index < MASK_ONLY_LIMIT; index += 1) if (redactor.addMaskOnly(valueOf(index))) taken += 1;
    expect(taken).toBe(MASK_ONLY_LIMIT);
    expect(redactor.maskDegraded()).toBe(false);
    expect(redactor.addMaskOnly(valueOf(MASK_ONLY_LIMIT))).toBe(false);
    expect(redactor.addMaskOnly(valueOf(MASK_ONLY_LIMIT + 1))).toBe(false);
    // Control: a value already taken is still accepted (it is not a new one), so the refusal is about new values only.
    expect(redactor.addMaskOnly(valueOf(0))).toBe(true);
    expect(redactor.maskEvidenceOnlyBounded(`see ${valueOf(5)} and ${valueOf(MASK_ONLY_LIMIT)}`).text).toBe(`see <session> and ${valueOf(MASK_ONLY_LIMIT)}`);
    // Refusals: n of them, then 8n, cost about 8 times, not 64. The 20,000 held values count toward the working set.
    const heldValueBytes = MASK_ONLY_LIMIT * valueOf(0).length;
    expectLinearScaling((count) => {
      const refusedValues = Array.from({ length: count }, (_unused, index) => valueOf(MASK_ONLY_LIMIT + 10 + index));
      return () => { for (const value of refusedValues) redactor.addMaskOnly(value); };
    }, { n: 100, unitBytes: 12, fixedBytes: heldValueBytes, label: "refusing mask-only values past the count bound" });
  });
  it("the bucket bound holds: values are taken until the bucket of forms that share a start is full, then each one is refused and degrades the mask, and a refusal costs no more as refusals pile up", () => {
    const redactor = createCredentialRedactor([]);
    const valueOf = (index: number): string => `Zq8LmW${String(index).padStart(5, "0")}`;
    // The bucket counts FORMS (each value brings several spellings, and the base64 ones of values like these share a start), so the point where it fills is found, not assumed: every value before it is taken and leaves the
    // mask whole, the first one that does not fit is refused and degrades the mask, and so is every one after it.
    let firstRefused = -1;
    for (let index = 0; index < 2 * MASK_BUCKET_CAP && firstRefused < 0; index += 1) {
      const degradedBefore = redactor.maskDegraded();
      if (!redactor.addMaskOnly(valueOf(index))) firstRefused = index;
      else expect(degradedBefore || redactor.maskDegraded(), `value ${String(index)}`).toBe(false);
    }
    expect(firstRefused).toBeGreaterThan(0);
    expect(firstRefused).toBeLessThanOrEqual(MASK_BUCKET_CAP);
    expect(redactor.maskDegraded()).toBe(true);
    expect(redactor.addMaskOnly(valueOf(firstRefused + 1))).toBe(false);
    expect(redactor.addMaskOnly(valueOf(firstRefused + 2))).toBe(false);
    // Control: a value with another start still fits.
    expect(redactor.addMaskOnly("Dk3pQ9xW2mV7cL4nR8tY")).toBe(true);
    expectLinearScaling((count) => {
      const refusedValues = Array.from({ length: count }, (_unused, index) => valueOf(MASK_BUCKET_CAP + 10 + index));
      return () => { for (const value of refusedValues) redactor.addMaskOnly(value); };
    }, { n: 100, unitBytes: 11, fixedBytes: MASK_BUCKET_CAP * 40, label: "refusing forms past the bucket bound" });
  });
  it("the size bound: a bucket of forms that share their first 6 characters is full at MASK_BUCKET_CAP; the value that does not fit is refused and the mask is degraded", () => {
    const redactor = createCredentialRedactor([]);
    let refused = 0;
    for (let index = 0; index < 5_000; index += 1) if (!redactor.addMaskOnly(`Zq8LmW${String(index).padStart(4, "0")}`)) refused += 1;
    expect(refused).toBeGreaterThan(0);
    expect(redactor.maskDegraded()).toBe(true);
    expect(MASK_BUCKET_CAP).toBe(4_096);
    const fresh = createCredentialRedactor([]);
    expect(fresh.addMaskOnly("Dk3pQ9xW2mV7cL4nR8tY")).toBe(true);
    expect(fresh.maskDegraded()).toBe(false);
  });
});

describe("the context wiring, for a signed-in context as well as a visitor's (real Chromium)", () => {
  const haveChromium = existsSync(chromium.executablePath());
  const VISITOR = "visitor-3f2504e0-4f89-11d3-9a0c-0305e82c3301";
  const SESSION = "Qx7Lm2Vb9Tz4Wk8PzN3";

  function recorder() {
    const learned: ClassifiedValue[] = [];
    const attached: Array<{ sessionRef: string; anonymous: boolean | undefined }> = [];
    const tracked: Array<Promise<unknown>> = [];
    const source: E2ESessionSyncSource = {
      read: async () => [], track: (promise) => { tracked.push(promise); }, learn: (items) => { learned.push(...items); },
      attach: (sessionRef, _reader, options) => { attached.push({ sessionRef, anonymous: options?.anonymous }); }, detach: () => undefined,
    };
    return { source, learned, attached, tracked, settle: async () => { await Promise.allSettled(tracked); } };
  }
  async function page(routes: (url: string) => { headers?: Record<string, string | string[]>; body?: string }) {
    const server: Server = createServer((request, response) => {
      const route = routes(request.url ?? "/");
      response.writeHead(200, { "content-type": "text/html", ...(route.headers ?? {}) });
      response.end(route.body ?? "<html><body>ok</body></html>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)); }));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const browser: Browser = await chromium.launch();
    closers.push(() => browser.close());
    return { origin, context: await browser.newContext() };
  }

  it.skipIf(!haveChromium)("the choice of bar is the caller's callback, and every context is attached whichever answer it gives", async () => {
    for (const anonymous of [true, false]) {
      const { context } = await page(() => ({}));
      const r = recorder();
      wireCaseContext({ browserContext: context, sessionRef: `s-${String(anonymous)}`, isAnonymous: (ref) => ref === `s-${String(anonymous)}` ? anonymous : !anonymous, sessionSync: r.source, registerSecret: () => undefined });
      expect(r.attached).toEqual([{ sessionRef: `s-${String(anonymous)}`, anonymous }]);
    }
  }, 60_000);

  it.skipIf(!haveChromium)("a signed-in context: its plain `visitor=<uuid>` Set-Cookie and Cookie header ARE registered (the visitor bar is not applied), analytics cookies are not, and every Set-Cookie answer is tracked", async () => {
    const { origin, context } = await page(() => ({ headers: { "set-cookie": [`visitor=${VISITOR}; Path=/`, `_hjSessionUser_1=Qx7Lm2Vb9Tz4Wk8PzN3Qx7Lm; Path=/`] } }));
    const r = recorder();
    const registered: string[] = [];
    wireCaseContext({ browserContext: context, sessionRef: "owned-1", isAnonymous: () => false, sessionSync: r.source, registerSecret: (value) => registered.push(value) });
    let requests = 0;
    let responses = 0;
    context.on("request", () => { requests += 1; });
    context.on("response", () => { responses += 1; });
    const p = await context.newPage();
    await p.goto(`${origin}/`);
    await p.goto(`${origin}/again`);
    await r.settle();
    expect(r.attached).toEqual([{ sessionRef: "owned-1", anonymous: false }]);
    expect(registered).toContain(VISITOR);
    expect(registered.some((value) => value.startsWith("Qx7Lm2Vb9Tz4Wk8PzN3Qx7Lm"))).toBe(false);
    expect(r.learned.map((item) => item.value)).toContain(VISITOR);
    // One tracked read per request (the header read) and one per response (the Set-Cookie read): the sync waits for the Set-Cookie read before the next model call.
    expect(r.tracked.length).toBe(requests + responses);
  }, 60_000);

  it.skipIf(!haveChromium)("a signed-in context's request watch uses the signed-in bar for the Authorization header, and its case-close read takes the visitor-style id too", async () => {
    const { origin, context } = await page(() => ({ headers: { "set-cookie": `visitor=${VISITOR}; Path=/` }, body: `<html><body><script>localStorage.setItem("visitor_id", "${VISITOR}"); localStorage.setItem("sb-abcdefgh-auth-token", JSON.stringify({ access_token: "${JWT}" })); fetch("/api/me", { headers: { Authorization: "Bearer ${SESSION}" } });</script></body></html>` }));
    const r = recorder();
    wireCaseContext({ browserContext: context, sessionRef: "owned-2", isAnonymous: () => false, sessionSync: r.source, registerSecret: () => undefined });
    const p = await context.newPage();
    await p.goto(`${origin}/`);
    await p.waitForLoadState("networkidle");
    await r.settle();
    expect(r.learned.map((item) => item.value)).toContain(SESSION);
    const closing = recorder();
    await readCaseContextAtClose({ browserContext: context, sessionRef: "owned-2", isAnonymous: () => false, sessionSync: closing.source });
    expect(closing.learned.map((item) => item.value)).toContain(VISITOR);
    const visitorClose = recorder();
    await readCaseContextAtClose({ browserContext: context, sessionRef: "visitor-2", isAnonymous: (ref) => ref === "visitor-2", sessionSync: visitorClose.source });
    expect(visitorClose.learned.map((item) => item.value)).not.toContain(VISITOR);
    expect(visitorClose.learned.map((item) => item.value)).toContain(JWT);
    await readCaseContextAtClose({ browserContext: undefined, sessionRef: "none", isAnonymous: () => true, sessionSync: closing.source });
  }, 60_000);

  it.skipIf(!haveChromium)("a visitor's `__cf_bm` and a plain unknown opaque cookie: neither is a credential (nothing is registered strong), and the unknown one is learned weak (masked, not refused)", async () => {
    const { origin, context } = await page(() => ({ headers: { "set-cookie": [`__cf_bm=Qx7Lm2Vb9Tz4Wk8PzN3Qx7Lm2Vb9Tz4Wk8PzN3-1698765432-0-Abc; HttpOnly; Path=/`, `appstate=Qx7Lm2Vb9Tz4Wk8PzN3; Path=/`] } }));
    const r = recorder();
    const registered: string[] = [];
    wireCaseContext({ browserContext: context, sessionRef: "visitor-3", isAnonymous: () => true, sessionSync: r.source, registerSecret: (value) => registered.push(value) });
    const p = await context.newPage();
    await p.goto(`${origin}/`);
    await r.settle();
    expect(registered).toEqual([]);
    expect(r.learned).toContainEqual({ value: "Qx7Lm2Vb9Tz4Wk8PzN3", tier: "weak" });
  }, 60_000);
});


const OPAQUE = "Qx7Lm2Vb9Tz4Wk8PzN3Qx7Lm2Vb9Tz4";

describe("the analytics names are whole names or delimited stems; an opaque value under one is weak", () => {
  it.each([["_gateway_session"], ["_gallery_session"], ["_game_session"], ["_gamma_session"], ["_garage_auth"], ["_galaxy_token"], ["_gidget_session"], ["optimizely_login"], ["mp_session"], ["utm_session"], ["ajs_session"], ["amplitude_session"], ["_pk_sess"], ["_hj_session_token"]])(
    "%s is not an analytics name: a signed-in browser registers it strong, a visitor's too (it names a session or a token)", (name) => {
      expect(analyticsCookieName(name), name).toBe(false);
      for (const httpOnly of [true, false]) {
        expect(cookieTier({ name, value: OPAQUE, httpOnly }, false), `owner ${name}`).toBe("strong");
        expect(cookieTier({ name, value: OPAQUE, httpOnly }, true), `visitor ${name}`).toBe("strong");
      }
      const told: ClassifiedValue[] = [];
      tellBrowserState({ cookies: [{ name, value: OPAQUE, httpOnly: true }], origins: [] }, (item) => told.push(item));
      expect(told).toEqual([{ value: OPAQUE, tier: "strong" }]);
      expect(headerSecrets([{ name: "cookie", value: `${name}=${OPAQUE}` }]).map((item) => item.tier)).toEqual(["strong"]);
    });

  it.each([["_ga"], ["_ga_ABC123XYZ"], ["_gid"], ["_gat"], ["_gat_UA123"], ["_gac_UA123"], ["_gcl_au"]])("%s is an analytics name", (name) => {
    expect(analyticsCookieName(name)).toBe(true);
  });

  // The names that had no test of their own, plus the ones of the list: each with an opaque value (weak) and a plain one (not registered), for an owner and a visitor.
  const NAMES: Array<[string, string]> = [["_fbp", "fb.1.1730000000000.1234567890"], ["_fbc", "fb.1.1730000000000.IwAR0abcdefghijklmnop"], ["_gid", "GA1.2.987654321.1730000000"], ["_pk_id.1.abcd", "a1b2c3d4e5f6a7b8.1730000000.1"],
    ["_pk_ses.1.abcd", "a1b2c3d4e5f6a7b8"], ["_cs_id", "a1b2c3d4-e5f6.1730000000.1"], ["_ttp", OPAQUE], ["_scid", OPAQUE], ["_dd_s", "rum=0&id=abc123def456&created=1&expire=2"], ["_shopify_y", OPAQUE], ["_ga", "GA1.2.123456789.1730000000"],
    ["_ga_ABC123XYZ", "GS1.1.1730000000.1.0.1730000000.0.0.0"], ["optimizelyEndUserId", "oeu1698765432123r0.1234567890123"], ["_hjSessionUser_1", b64(JSON.stringify({ id: "abcdefgh-ijkl", created: 1698765432 }))], ["__cf_bm", OPAQUE], ["_uetsid", "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"]];
  it.each(NAMES)("%s: analytics name, so an opaque value is weak (masked, never refused) in every path, for an owner and a visitor", (name, value) => {
    expect(analyticsCookieName(name), name).toBe(true);
    for (const visitor of [false, true]) {
      for (const httpOnly of [false, true]) {
        const tier = cookieTier({ name, value, httpOnly }, visitor);
        expect(["weak", null], `${name} visitor=${String(visitor)}`).toContain(tier);
        // The state read and the Cookie header give the same tier.
        const told: ClassifiedValue[] = [];
        tellBrowserState({ cookies: [{ name, value, httpOnly }], origins: [] }, (item) => told.push(item), undefined, { visitor });
        expect(told.map((item) => item.tier), `state ${name}`).toEqual(tier === null ? [] : [tier]);
        expect(headerSecrets([{ name: "cookie", value: `${name}=${value}` }], { visitor }).map((item) => item.tier), `header ${name}`).toEqual(tier === null ? [] : [tier]);
      }
    }
  });
  it.each([["_ga"], ["optimizelyEndUserId"], ["__cf_bm"], ["_fbp"], ["_ttp"]])("%s with an opaque 32-character value is weak in the state read and in the Cookie header, owner and visitor; with a short one it is not registered", (name) => {
    for (const visitor of [false, true]) {
      const told: ClassifiedValue[] = [];
      tellBrowserState({ cookies: [{ name, value: OPAQUE, httpOnly: false }], origins: [] }, (item) => told.push(item), undefined, { visitor });
      expect(told, `state ${name}`).toEqual([{ value: OPAQUE, tier: "weak" }]);
      expect(headerSecrets([{ name: "cookie", value: `${name}=${OPAQUE}` }], { visitor }), `header ${name}`).toEqual([{ value: OPAQUE, tier: "weak" }]);
      expect(cookieTier({ name, value: "short", httpOnly: false }, visitor)).toBeNull();
      expect(cookieTier({ name, value: "Ab3dEf9hJk12", httpOnly: false }, visitor), `12 characters under ${name}`).toBeNull();
      expect(cookieTier({ name, value: "GA1.2.3", httpOnly: true }, visitor)).toBeNull();
    }
  });
  it("a JWT under an analytics name stays strong", () => {
    for (const visitor of [false, true]) expect(cookieTier({ name: "_ga", value: JWT, httpOnly: false }, visitor)).toBe("strong");
  });
});

describe("the host's two sequences, through a real Chromium", () => {
  const haveChromium = existsSync(chromium.executablePath());
  const VISITOR = "visitor-3f2504e0-4f89-11d3-9a0c-0305e82c3301";

  function recorder() {
    const learned: ClassifiedValue[] = [];
    const attached: Array<{ sessionRef: string; anonymous: boolean | undefined }> = [];
    const detached: string[] = [];
    const tracked: Array<Promise<unknown>> = [];
    const source: E2ESessionSyncSource = {
      read: async () => [], track: (promise) => { tracked.push(promise); }, learn: (items) => { learned.push(...items); },
      attach: (sessionRef, _reader, options) => { attached.push({ sessionRef, anonymous: options?.anonymous }); }, detach: (sessionRef) => { detached.push(sessionRef); },
    };
    return { source, learned, attached, detached, settle: async () => { await Promise.allSettled(tracked); } };
  }
  async function context(): Promise<{ origin: string; context: BrowserContext }> {
    const server: Server = createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/html", "set-cookie": `sb-abcdefgh-auth-token=base64-${b64(JSON.stringify({ access_token: JWT }))}; Path=/` });
      response.end(`<html><body><script>localStorage.setItem("visitor_id", "${VISITOR}"); localStorage.setItem("sb-abcdefgh-auth-token", JSON.stringify({ access_token: "${JWT}" }));</script></body></html>`);
      void request;
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)); }));
    const browser: Browser = await chromium.launch();
    closers.push(() => browser.close());
    return { origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, context: await browser.newContext() };
  }

  it.skipIf(!haveChromium)("adoptCaseContext remembers the context and wires it, for a visitor and for a signed-in session alike; closeCaseContext takes it out, detaches it and reads it", async () => {
    for (const anonymous of [true, false]) {
      const { origin, context: browserContext } = await context();
      const contexts = new Map<string, BrowserContext>();
      const r = recorder();
      const registered: string[] = [];
      const sessionRef = anonymous ? "visitor-1" : "owned-1";
      const isAnonymous = (ref: string): boolean => ref === "visitor-1";
      adoptCaseContext({ contexts, sessionRef, browserContext, isAnonymous, sessionSync: r.source, registerSecret: (value) => registered.push(value) });
      expect(contexts.get(sessionRef), "remembered").toBe(browserContext);
      expect(r.attached, "attached").toEqual([{ sessionRef, anonymous }]);
      const page = await browserContext.newPage();
      await page.goto(`${origin}/`);
      await r.settle();
      // The Set-Cookie answer was watched: the Supabase session cookie is registered whoever the visitor is.
      expect(registered.length, `set-cookie ${sessionRef}`).toBe(1);
      await closeCaseContext({ contexts, sessionRef, isAnonymous, sessionSync: r.source });
      expect(contexts.has(sessionRef), "forgotten").toBe(false);
      expect(r.detached, "detached").toEqual([sessionRef]);
      // The close read learned the token the page stored; the visitor id only for a signed-in session.
      const values = r.learned.map((item) => item.value);
      expect(values, `close read ${sessionRef}`).toContain(JWT);
      expect(values.includes(VISITOR), `visitor id ${sessionRef}`).toBe(!anonymous);
      // A second close finds nothing and still detaches.
      await closeCaseContext({ contexts, sessionRef, isAnonymous, sessionSync: r.source });
      expect(r.detached).toEqual([sessionRef, sessionRef]);
    }
  }, 90_000);

  it.skipIf(!haveChromium)("closeCaseContext on a session that was never adopted reads nothing and does not throw", async () => {
    const r = recorder();
    await closeCaseContext({ contexts: new Map(), sessionRef: "none", isAnonymous: () => true, sessionSync: r.source });
    expect(r.learned).toEqual([]);
    expect(r.detached).toEqual(["none"]);
  });
});

describe("the host holds one plain statement for each sequence (syntax tree, not a regex)", () => {
  const source = readFileSync(new URL("../../packages/verifier/src/executor/host.ts", import.meta.url), "utf8");
  const file = ts.createSourceFile("host.ts", source, ts.ScriptTarget.ES2022, true);
  const isFunction = (node: ts.Node): node is ts.FunctionLikeDeclaration => ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node);
  function calls(name: string): ts.CallExpression[] {
    const found: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => { if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) found.push(node); ts.forEachChild(node, visit); };
    visit(file);
    return found;
  }
  /** Whether a node holds a return anywhere outside nested functions. */
  function exits(node: ts.Node): boolean {
    let found = false;
    const visit = (child: ts.Node): void => { if (found || isFunction(child)) return; if (ts.isReturnStatement(child)) { found = true; return; } ts.forEachChild(child, visit); };
    visit(node);
    return found;
  }
  it.each([["adoptCaseContext"], ["closeCaseContext"]])("%s is called once, as a statement of its own at the top level of its callback, after no return and no visitor condition", (name) => {
    const found = calls(name);
    expect(found).toHaveLength(1);
    const call = found[0]!;
    const statement = call.parent.kind === ts.SyntaxKind.AwaitExpression ? call.parent.parent : call.parent;
    expect(ts.isExpressionStatement(statement), "an expression statement").toBe(true);
    const block = statement.parent;
    expect(ts.isBlock(block), "directly in a block").toBe(true);
    expect(isFunction(block.parent), "the block is a function body").toBe(true);
    const before = (block as ts.Block).statements.filter((item) => item.pos < statement.pos);
    for (const item of before) {
      expect(exits(item), `no exit before it: ${item.getText(file).slice(0, 60)}`).toBe(false);
      expect((ts.isIfStatement(item) || ts.isTryStatement(item) || ts.isSwitchStatement(item)) && /isAnonymous/.test(item.getText(file)), `no visitor condition before it: ${item.getText(file).slice(0, 60)}`).toBe(false);
    }
  });
  it("the host no longer touches the context map itself, and does not name the lower functions", () => {
    expect(source).not.toMatch(/ownedContexts\.(set|get|delete)\(/);
    expect(source).not.toMatch(/wireCaseContext|readCaseContextAtClose|wireSessionContext/);
    expect(source).toMatch(/adoptCaseContext\(\{ contexts: ownedContexts, sessionRef, browserContext, isAnonymous: store\.isAnonymous, sessionSync, registerSecret \}\)/);
    expect(source).toMatch(/closeCaseContext\(\{ contexts: ownedContexts, sessionRef, isAnonymous: store\.isAnonymous, sessionSync \}\)/);
  });
});
