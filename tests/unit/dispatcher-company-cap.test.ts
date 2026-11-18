// CORE-DISPATCH-HOOK-SIGNER-20261117 (DEC 254zzz6 D1, full fix): the dispatcher's gate before each model run (run.start) resolves a project's per-task limit as the broker does, through
// the company rules service, asked with the dispatcher's own KMS signer over the policy hook key. So a run is never dispatched past a company limit the broker's booking stop would
// then apply (the bounded overshoot of about one model call). Every check here has a mutant: see the PR body.
import { createPublicKey, randomUUID, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GetPublicKeyCommand, SignCommand } from "@aws-sdk/client-kms";
import { companyScoped, policyHookKeyThumbprint, type MeterEntry, type OrgId } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import {
  COMPANY_DAY_CAP_REACHED, PROJECT_TASK_CAP_REACHED, SPEND_UNKNOWN, TASK_CAP_REACHED, createHostedAdmission, createHostedLedger, type HostedAdmissionSettings,
} from "../../packages/broker/src/core-host/hosted-modules.js";
import { RUN_START_ACTION } from "../../packages/broker/src/core/task-flow/money-stop.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { dispatcherProjectTaskCap } from "../../packages/broker/src/aws/engine-policy-hook.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { ADDRESS, ISSUER, fakeService, makeKey } from "./policy-hook-fixture.js";
import { COMPANY_A_ID, COMPANY_B_ID } from "../../packages/testing/src/isolation/two-company.js";

const A = COMPANY_A_ID as OrgId;
const B = COMPANY_B_ID as OrgId;
const DAY = "2026-11-18";
const NOW = new Date(`${DAY}T10:00:00.000Z`);
const KEY_ARN = "arn:aws:kms:us-west-2:111122223333:key/00000000-0000-4000-8000-000000000001";
const JWKS = "https://rules.example/keys";
// The failure case of the row: the install's task cap and the project's own limit are both above the company's limit.
const SETTINGS: HostedAdmissionSettings = { allowedCompanies: "all", taskCapMicros: 25_000_000, companyDayCapMicros: 100_000_000 };
const hookKey = makeKey("hook");
const installKey = makeKey("install");
const HOOK = JSON.stringify({ address: ADDRESS, jwks: JWKS, thumbprints: [policyHookKeyThumbprint(hookKey.jwk)] });
const ENV: NodeJS.ProcessEnv = { ROVARA_POLICY_HOOK: HOOK, POLICY_HOOK_KEY_ARN: KEY_ARN, DEVELOPER_TOKEN_ISSUER: ISSUER };
const exactMeter = {
  async price() { return null; },
  async record(e: MeterEntry) { return { cost: { micros: e.usage.tokens.input, currency: "USD" }, source: "price-table" as const }; },
};

const hrefOf = (url: Parameters<typeof globalThis.fetch>[0]): string => (typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
/** A fake KMS over the install's question key: answers GetPublicKey and Sign as KMS does, recording each request. `fail` makes that command throw. */
function fakeKms(fail?: "sign" | "public-key") {
  const sent: Array<{ command: string; input: Record<string, unknown> }> = [];
  return {
    sent,
    async send(command: unknown) {
      if (command instanceof GetPublicKeyCommand) {
        sent.push({ command: "GetPublicKey", input: { ...command.input } });
        if (fail === "public-key") throw new Error("private-canary kms down");
        return { PublicKey: new Uint8Array(createPublicKey(installKey.privateKey).export({ type: "spki", format: "der" })), KeyUsage: "SIGN_VERIFY" };
      }
      if (command instanceof SignCommand) {
        sent.push({ command: "Sign", input: { ...command.input, Message: undefined } });
        if (fail === "sign") throw new Error("private-canary kms down");
        return { Signature: new Uint8Array(sign("RSA-SHA256", Buffer.from(command.input.Message as Uint8Array), installKey.privateKey)) };
      }
      throw new Error("an unexpected KMS command");
    },
  };
}

/** `locks` maps a company to the dollar limit its rules service locks `model_budget_usd` at (absent: no lock); an Error: the service does not answer. */
function world(locks: Record<string, number | Error>, options: { env?: NodeJS.ProcessEnv; kms?: ReturnType<typeof fakeKms> } = {}) {
  const store = new MemoryDocumentStore();
  const db = new FakeDynamoDb();
  const now = () => NOW;
  const ledger = createHostedLedger({ store, metering: exactMeter, now });
  const service = fakeService({ key: hookKey, now: () => NOW.getTime(), answer: (asked) => {
    const lock = locks[String(asked.q["cid"])];
    return lock instanceof Error ? lock : { locks: lock === undefined ? {} : { model_budget_usd: lock } };
  } });
  const fetch: typeof globalThis.fetch = async (url, init) => (hrefOf(url) === JWKS ? new Response(JSON.stringify({ keys: [hookKey.jwk] })) : await service.fetch(url, init));
  const kms = options.kms ?? fakeKms();
  const projectTaskCap = dispatcherProjectTaskCap(options.env ?? ENV, { documentClient: db, tableName: "state", now: () => NOW.getTime() }, kms, fetch);
  const admission = createHostedAdmission({ settings: SETTINGS, store, ledger, now, runStopWired: true, projectTaskCap });
  const task = async (companyId: string, project: string, spentMicros = 0) => {
    const taskId = randomUUID();
    await store.put({ item: { ...taskKey(taskId), entityType: "DEVELOPER_TASK", taskId, companyId, project } });
    if (spentMicros > 0) await book(companyId, taskId, spentMicros);
    return taskId;
  };
  const book = (companyId: string, taskId: string, micros: number) =>
    ledger.recordUsage({ companyId, entryId: randomUUID(), at: NOW.toISOString(), taskId, usage: { provider: "anthropic", modelId: "m", tokens: { input: micros, output: 0, cacheRead: 0, cacheWrite: 0 } } });
  const projectLimit = (companyId: string, project: string, usd: number) => db.set({
    pk: companyScoped(companyId, `PROJECT_SETTINGS#${project}`), sk: "META", entityType: "PROJECT_SETTINGS", companyId, projectName: project, overrides: { model_budget_usd: usd }, revision: 1,
    updatedAt: NOW.toISOString(), updatedBy: "d".repeat(64),
  });
  const runStart = (companyId: string, taskId: string) =>
    admission.admit({ companyId, idempotencyKey: `${RUN_START_ACTION}:${randomUUID()}`, action: RUN_START_ACTION, subject: { type: "task", id: taskId } });
  return { task, book, projectLimit, runStart, kms, asked: service.asked };
}
const refused = (code: string, message: string) => ({ allowed: false, code, message });

describe("the dispatcher's run.start gate applies the company's limit (the rules service)", () => {
  it("a company limit below the project's own: the run is refused at the company's limit, not dispatched against the project's", async () => {
    const w = world({ [A]: 5 });
    w.projectLimit(A, "web", 20);
    const over = await w.task(A, "web", 5_000_000);
    expect(await w.runStart(A, over)).toEqual(refused("task_cap", PROJECT_TASK_CAP_REACHED));
    const under = await w.task(A, "web", 4_999_999);
    expect(await w.runStart(A, under)).toEqual({ allowed: true });
  });

  it("the project's own limit still applies when it is the lower one, and alone where the install has no rules service (nothing asked, nothing signed)", async () => {
    const w = world({ [A]: 10 });
    w.projectLimit(A, "web", 2);
    expect(await w.runStart(A, await w.task(A, "web", 2_000_000))).toEqual(refused("task_cap", PROJECT_TASK_CAP_REACHED));
    expect(await w.runStart(A, await w.task(A, "web", 1_999_999))).toEqual({ allowed: true });

    const plain = world({ [A]: 0 }, { env: {} });
    plain.projectLimit(A, "web", 2);
    expect(await plain.runStart(A, await plain.task(A, "web", 2_000_000))).toEqual(refused("task_cap", PROJECT_TASK_CAP_REACHED));
    expect(await plain.runStart(A, await plain.task(A, "web", 1_000_000))).toEqual({ allowed: true });
    expect(plain.asked).toEqual([]);
    expect(plain.kms.sent).toEqual([]);
  });

  it("the install's task cap still applies above every limit", async () => {
    const w = world({});
    expect(await w.runStart(A, await w.task(A, "web", 25_000_000))).toEqual(refused("task_cap", TASK_CAP_REACHED));
  });

  it("a company-day-cap breach is refused at dispatch", async () => {
    const w = world({});
    await w.task(A, "api", 100_000_000);
    expect(await w.runStart(A, await w.task(A, "web"))).toEqual(refused("company_day_cap", COMPANY_DAY_CAP_REACHED));
    // Another company's day is its own.
    expect(await w.runStart(B, await w.task(B, "web"))).toEqual({ allowed: true });
  });

  it("asks for the asking company only: another company's lock never applies, and each question names its own company", async () => {
    const w = world({ [A]: 1 });
    expect(await w.runStart(B, await w.task(B, "web", 2_000_000))).toEqual({ allowed: true });
    expect(await w.runStart(A, await w.task(A, "web", 2_000_000))).toEqual(refused("task_cap", PROJECT_TASK_CAP_REACHED));
    expect(new Set(w.asked.map((asked) => `${String(asked.q["cid"])}/${String(asked.q["pid"])}`))).toEqual(new Set([`${B}/web`, `${A}/web`]));
  });

  it("signs each question with the dispatcher's own key, exactly as the key policy allows it (RS256 over the raw input), and reads its public key", async () => {
    const w = world({ [A]: 5 });
    await w.runStart(A, await w.task(A, "web"));
    const signs = w.kms.sent.filter((entry) => entry.command === "Sign");
    expect(signs.length).toBeGreaterThan(0);
    for (const entry of signs) expect(entry.input).toMatchObject({ KeyId: KEY_ARN, MessageType: "RAW", SigningAlgorithm: "RSASSA_PKCS1_V1_5_SHA_256" });
    expect(w.kms.sent.filter((entry) => entry.command === "GetPublicKey").map((entry) => entry.input)).toEqual([{ KeyId: KEY_ARN }]);
  });
});

describe("fails closed: a signer or rules service that cannot be used refuses the run (spend unknown), never the project's limit alone", () => {
  const SPEND = refused("spend_unknown", SPEND_UNKNOWN);
  it("KMS refuses to sign, or to give the public key", async () => {
    for (const fail of ["sign", "public-key"] as const) {
      const w = world({ [A]: 5 }, { kms: fakeKms(fail) });
      expect(await w.runStart(A, await w.task(A, "web")), fail).toEqual(SPEND);
    }
  });

  it("the install's signer is not configured (no key or no issuer)", async () => {
    for (const missing of ["POLICY_HOOK_KEY_ARN", "DEVELOPER_TOKEN_ISSUER"] as const) {
      const env = { ...ENV, [missing]: "" };
      const w = world({ [A]: 5 }, { env });
      expect(await w.runStart(A, await w.task(A, "web")), missing).toEqual(SPEND);
      expect(w.kms.sent, missing).toEqual([]);
    }
  });

  it("the rules service settings do not read, or the service does not answer", async () => {
    for (const env of [{ ...ENV, ROVARA_POLICY_HOOK: "{not json" }, { ...ENV, ROVARA_POLICY_HOOK: JSON.stringify({ address: ADDRESS }) }]) {
      const w = world({ [A]: 5 }, { env });
      expect(await w.runStart(A, await w.task(A, "web")), env.ROVARA_POLICY_HOOK).toEqual(SPEND);
    }
    const silent = world({ [A]: new Error("private-canary") });
    expect(await silent.runStart(A, await silent.task(A, "web"))).toEqual(SPEND);
  });
});

describe("the dispatcher is wired to this reader", () => {
  it("hands dispatcherProjectTaskCap (the process environment, the State table, its KMS client) to the deployed security modules, never a reader without the rules service", () => {
    const source = readFileSync(new URL("../../packages/broker/src/aws/dispatcher.ts", import.meta.url), "utf8");
    expect(source).toContain('projectTaskCap: dispatcherProjectTaskCap(process.env, { documentClient, tableName: requiredEnvironment("STATE_TABLE_NAME"), now: () => Date.now() }, kms)');
    expect(source).not.toMatch(/projectTaskCapReader\(/u);
    expect(source).toMatch(/^const kms = new KMSClient\(awsClientConfiguration\);$/mu);
  });
});
