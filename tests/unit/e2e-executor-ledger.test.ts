import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileCaseLedger } from "../../packages/verifier/src/executor/case-ledger.js";
import { snapshotExecutorOutput, type ExecutorResultFile } from "../../packages/verifier/src/host/executor-readback.js";
import { createCredentialRedactor } from "../../packages/verifier/src/executor/redact.js";
import { createLaunchContexts, resolveE2EExecutorSuite } from "../../packages/verifier/src/executor/suite.js";
import { readValidatedE2EApplicationCaseObservation, readValidatedE2EApplicationCliCasePlan } from "../../packages/verifier/src/application-services.js";
import { createOrdersExecutorPlan } from "../support/e2e-orders-executor-fixture.js";

const fixture = createOrdersExecutorPlan({ probe: "api-state-positive-v1" });
const { plan, caseId } = fixture;
const resolved = resolveE2EExecutorSuite(plan);
const launch = createLaunchContexts(resolved)[0]!;
const signal = new AbortController().signal;
const digest = "a".repeat(64);
const roots: string[] = [];
async function root() { const dir = realpathSync(await mkdtemp(join(tmpdir(), "ledger-test-"))); roots.push(dir); return dir; }
afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const bytes = Buffer.from('{"ok":true}');

const sessionFacts = {
  sessionRef: "rovara-session-1", accountIdDigest: createHash("sha256").update("subject-1").digest("hex"), observedAt: new Date().toISOString(),
  login: { status: 200, role: "owner" }, identity: { status: 200, subjectIdDigest: createHash("sha256").update("subject-1").digest("hex"), tenantId: "tenant-a", role: "owner" },
  subject: { kind: "service" as const, processId: "app", origin: "http://app:4317" },
};

describe("file case ledger", () => {
  it("allows one action window per case/action", async () => {
    const ledger = createFileCaseLedger(await root(), plan);
    await ledger.actionWindows.begin({ caseId, actionIndex: 0, actionDigest: digest }, signal);
    await expect(ledger.actionWindows.begin({ caseId, actionIndex: 0, actionDigest: digest }, signal)).rejects.toThrow("action window already used");
    await expect(ledger.actionWindows.finish({ caseId, actionIndex: 0, actionDigest: digest }, signal)).resolves.toEqual({ confirmed: true });
    await expect(ledger.actionWindows.begin({ caseId, actionIndex: 0, actionDigest: digest }, signal)).rejects.toThrow("action window already used");
    await expect(ledger.actionWindows.finish({ caseId, actionIndex: 1, actionDigest: digest }, signal)).rejects.toThrow(/never opened/);
  });

  it("rejects evidence for a case not in the plan", async () => {
    const ledger = createFileCaseLedger(await root(), plan);
    await expect(ledger.evidence.recordCaseEvidence({ caseId: "nope", kind: "case-capture", bytes, mediaType: "application/json" }, signal)).rejects.toThrow("unknown case");
  });

  it("never writes outside its root", async () => {
    const dir = await root();
    const ledger = createFileCaseLedger(dir, plan);
    for (const name of ["../x", "a/b", "..", "/etc/passwd", ".hidden", "x\0y"]) {
      await expect(ledger.evidence.recordCaseEvidence({ caseId, kind: "case-capture", name, bytes } as never, signal)).rejects.toThrow();
    }
    expect(await readdir(dir)).toEqual([]);
    expect(() => createFileCaseLedger("relative/root", plan)).toThrow(/absolute/);
  });

  it("returns a ref that binds the exact bytes and stores them in observations", async () => {
    const dir = await root();
    const ledger = createFileCaseLedger(dir, plan);
    const ref = await ledger.evidence.recordCaseEvidence({ caseId, kind: "case-capture", bytes, mediaType: "application/json" }, signal) as { artifactId: string; sha256: string; byteLength: number };
    expect(ref).toMatchObject({ sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.byteLength, mediaType: "application/json" });
    const stored = JSON.parse(await readFile(join(dir, "observations", `${ref.artifactId}.json`), "utf8")) as { content: string; caseId: string };
    expect(stored).toMatchObject({ caseId, content: '{"ok":true}' });
  });

  it("stores downloads as raw files under downloads/", async () => {
    const dir = await root();
    const ledger = createFileCaseLedger(dir, plan);
    const csv = Buffer.from("id,customer\r\na1,Ada\r\n");
    await ledger.evidence.recordCaseEvidence({ caseId, kind: "download", bytes: csv, mediaType: "text/csv" }, signal);
    const files = await readdir(join(dir, "downloads"));
    expect(files).toHaveLength(1);
    expect(await readFile(join(dir, "downloads", files[0]!))).toEqual(csv);
  });

  it("refuses evidence that carries an account credential", async () => {
    const ledger = createFileCaseLedger(await root(), plan);
    const leaking = Buffer.from(JSON.stringify({ note: plan.accounts[0]!.password }));
    await expect(ledger.evidence.recordCaseEvidence({ caseId, kind: "step-observation", bytes: leaking, mediaType: "application/json" }, signal)).rejects.toThrow(/credential/);
    const emailLeak = Buffer.from(`row,${plan.accounts[0]!.email}`);
    await expect(ledger.evidence.recordCaseEvidence({ caseId, kind: "download", bytes: emailLeak, mediaType: "text/csv" }, signal)).rejects.toThrow(/credential/);
  });

  it("serves the sealed case plan that the host validates, and refuses a foreign launch", async () => {
    const ledger = createFileCaseLedger(await root(), plan);
    const shard = resolved.suite.shards[0]!;
    const declaration = { preparedEnvironmentDigest: resolved.suite.preparedEnvironmentDigest,
      target: { targetId: shard.targetId, app: null },
      cases: shard.expectedCases.map((item) => ({ caseId: item.caseId, upstreamTestId: item.upstreamTestId, targetId: item.targetId,
        assertionBindings: resolved.suite.assertionBindings.get(item.caseId)! })) };
    const casePlan = await readValidatedE2EApplicationCliCasePlan({ reader: ledger.casePlans, launchContext: launch, declaration, caseId, signal });
    expect(casePlan.expected.caseId).toBe(caseId);
    expect(casePlan.runtimeAccountRef.profileId).toBe("orders-owner");
    await expect(ledger.casePlans.readCasePlan({ launchContext: { ...launch, runId: "00000000-0000-4000-8000-000000000000" }, caseId,
      upstreamTestId: casePlan.expected.upstreamTestId, targetId: casePlan.expected.targetId }, signal)).rejects.toThrow(/foreign/);
    await expect(ledger.casePlans.readCasePlan({ launchContext: launch, caseId: "nope", upstreamTestId: "x", targetId: "y" }, signal)).rejects.toThrow("unknown case");
  });

  it("builds an observation binding that the host validator accepts", async () => {
    const dir = await root();
    const ledger = createFileCaseLedger(dir, plan, { observations: { sessionFacts: () => sessionFacts, upstreamRunId: () => "0190a000-0000-7000-8000-000000000001" } });
    const casePlan = await ledger.casePlans.readCasePlan({ launchContext: launch, caseId, upstreamTestId: resolved.suite.expectedCases[0]!.upstreamTestId,
      targetId: resolved.suite.expectedCases[0]!.targetId }, signal);
    const observation = await readValidatedE2EApplicationCaseObservation({ reader: ledger.caseObservations, launchContext: launch, plan: casePlan,
      ownedClientRef: "rovara-session-1", expectedSubjectKind: "service", signal });
    expect(observation.identityEvidence).toHaveLength(4);
    expect(observation.binding.sessionRef).toBe("rovara-session-1");
    expect(observation.binding.assertionProducers).toHaveLength(casePlan.scenario.assertions.length);
    // Four evidence items, plus the binding itself, persisted for the host and bound to its own digest.
    const files = await readdir(join(dir, "observations"));
    expect(files.filter((name) => name.startsWith("ev-"))).toHaveLength(4);
    const persisted = JSON.parse(await readFile(join(dir, "observations", `binding-${caseId.replaceAll(":", "_")}.json`), "utf8")) as { sha256: string; binding: unknown };
    expect(persisted.binding).toEqual(observation.binding);
    expect(persisted.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("persists observation and asset bindings that the host snapshot reads back, and refuses a binding that changed", async () => {
    const dir = await root();
    const ledger = createFileCaseLedger(dir, plan, { observations: { sessionFacts: () => sessionFacts, upstreamRunId: () => "0190a000-0000-7000-8000-000000000001" } });
    const casePlan = await ledger.casePlans.readCasePlan({ launchContext: launch, caseId, upstreamTestId: resolved.suite.expectedCases[0]!.upstreamTestId,
      targetId: resolved.suite.expectedCases[0]!.targetId }, signal);
    const observation = await readValidatedE2EApplicationCaseObservation({ reader: ledger.caseObservations, launchContext: launch, plan: casePlan,
      ownedClientRef: "rovara-session-1", expectedSubjectKind: "service", signal });
    const ref = await ledger.recordApprovedAsset({ caseId, assetId: "api-state-positive/v1", bytes });
    const asset = { caseId, assertionIndex: 0, kind: "state-probe" as const, id: "api-state-positive/v1", manifestDigest: digest, ref };
    await ledger.recordAssetBinding(asset);
    const result: ExecutorResultFile = { schemaVersion: "e2e-executor-result/v1", exitCode: 0, reason: null, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      node: { version: "v22.23.2", execPath: "/usr/local/bin/node", platform: "linux", arch: "arm64" }, runId: resolved.binding.runId, groupId: resolved.binding.groupId, shards: [] };
    const snapshot = await snapshotExecutorOutput(dir, result);
    expect(snapshot.observationBindings).toEqual([observation.binding]);
    expect(snapshot.assertionAssets).toEqual([asset]);
    const file = join(dir, "observations", `binding-${caseId.replaceAll(":", "_")}.json`);
    await writeFile(file, (await readFile(file, "utf8")).replace("rovara-session-1", "rovara-session-2"));
    await expect(snapshotExecutorOutput(dir, result)).rejects.toThrow(/digest the executor recorded/);
  });

  it("refuses to read the output of a run whose evidence directories are links", async () => {
    const result: ExecutorResultFile = { schemaVersion: "e2e-executor-result/v1", exitCode: 0, reason: null, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      node: { version: "v22.23.2", execPath: "/usr/local/bin/node", platform: "linux", arch: "arm64" }, runId: resolved.binding.runId, groupId: resolved.binding.groupId, shards: [] };
    for (const name of ["observations", "downloads"]) {
      const dir = await root(); const elsewhere = await root();
      const ledger = createFileCaseLedger(dir, plan);
      await ledger.evidence.recordCaseEvidence({ caseId, kind: "download", bytes: Buffer.from("id\r\n"), mediaType: "text/csv" }, signal);
      await expect(snapshotExecutorOutput(dir, result)).resolves.toBeDefined();
      // Swap the real directory for a link to a directory the executor does not own, keeping its contents readable through it.
      await rm(join(elsewhere, name), { recursive: true, force: true });
      await rename(join(dir, name), join(elsewhere, name));
      await symlink(join(elsewhere, name), join(dir, name), "dir");
      if (name === "downloads") await mkdir(join(dir, "observations"), { recursive: true });
      await expect(snapshotExecutorOutput(dir, result), name).rejects.toThrow(new RegExp(`${name} is not a real directory`));
    }
  });

  it("closes after the run deadline", async () => {
    const ledger = createFileCaseLedger(await root(), plan, { clock: () => new Date(resolved.deadlineAtMs + 1) });
    await expect(ledger.evidence.recordCaseEvidence({ caseId, kind: "case-capture", bytes, mediaType: "application/json" }, signal)).rejects.toThrow(/deadline/);
  });
});

describe("credential redaction", () => {
  const accounts = [{ profileId: "orders-owner", email: "owner-1@example.invalid", password: "correct horse battery staple 1" }];
  const redactor = createCredentialRedactor(accounts);
  it("replaces every spelling with the account label", () => {
    const text = `login ${accounts[0]!.email} / ${accounts[0]!.password} ${encodeURIComponent(accounts[0]!.email)} ${JSON.stringify(accounts[0]!.password)}`;
    const cleaned = redactor.text(text);
    expect(cleaned).not.toContain("owner-1");
    expect(cleaned).not.toContain("correct horse");
    expect(cleaned).toContain("<account:orders-owner>");
  });
  it("detects credentials in bytes", () => {
    expect(redactor.contains(Buffer.from(`x ${accounts[0]!.password} y`))).toBe(true);
    expect(redactor.contains(Buffer.from("nothing here"))).toBe(false);
  });
});
