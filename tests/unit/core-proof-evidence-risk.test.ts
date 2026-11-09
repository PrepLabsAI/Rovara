// Proof and evidence P4, the broker's half: scanner findings and migration evidence reach the pack, the pull request shows counts, and a NEW high or critical finding from a SECURITY scan raises the risk to high (the
// design's rule). The signal comes only from a pack for exactly this code, only from checks of kind security, and can only raise the level. With no port (the proof switch off) there is no signal and nothing is read.
import { describe, expect, it } from "vitest";
import { createCandidateManifest, type CheckEntry, type EvidencePack, type EvidenceRaw, type VerificationReport } from "../../packages/contracts/src/index.js";
import { evidenceLines } from "../../packages/broker/src/core/proof/evidence-lines.js";
import { keepEvidence, loadEvidencePack } from "../../packages/broker/src/core/proof/evidence-keep.js";
import { guardPack } from "../../packages/broker/src/core/proof/evidence-guard.js";
import { evidenceRiskSignal, kindOfRawCheck } from "../../packages/broker/src/core/proof/evidence-risk.js";
import { assessRisk, type RiskInput } from "../../packages/broker/src/core/proof/risk.js";
import { recomputeRisk } from "../../packages/broker/src/core/proof/pull-request-body.js";
import { evidenceRiskOfTask as riskOfTask, securityCheckIdsOf } from "../../packages/broker/src/core/proof/evidence-risk-input.js";
import { EVIDENCE_OP, EVIDENCE_TASK, evidenceWorld } from "../support/evidence-keep-world.js";
import { scanTextForTests } from "../support/evidence-scan.js";

const DIGEST = "c".repeat(64);
const OTHER = "e".repeat(64);
const TASK = EVIDENCE_TASK;
const OP = EVIDENCE_OP;
const entry = (id: string, label: string, over: Partial<CheckEntry> = {}): CheckEntry => ({ id, label, source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 700, exitCode: 0, ...over });
const severities = (over: Record<string, number> = {}) => ({ critical: 0, high: 0, medium: 0, low: 0, info: 0, ...over });
const findings = (tool: string, bySeverity: Record<string, number>, items: unknown[] = []) => ({ tool, newCount: Object.values(bySeverity).reduce((sum, count) => sum + count, 0), bySeverity: severities(bySeverity), items }) as NonNullable<EvidenceRaw["checks"][number]["findings"]>;
const rawOf = (checks: unknown[]) => ({ schemaVersion: 1, candidateDigest: DIGEST, checks });

async function keep(checks: unknown[], entries: CheckEntry[], policyKinds?: ReadonlyMap<string, "security" | "lint" | "migration" | "test">) {
  const w = evidenceWorld(JSON.stringify(rawOf(checks)));
  await keepEvidence(w.deps, { orgId: "org-a", task: TASK, operationId: OP, candidateDigest: DIGEST, checks: entries, ...(policyKinds === undefined ? {} : { policyKinds }) });
  return loadEvidencePack(w.deps.store.blobs, TASK, DIGEST);
}
const evidenceRiskOfTask = (reader: Parameters<typeof riskOfTask>[0], task: unknown, digest: string | undefined, security: readonly string[] = [], on = false) => riskOfTask(reader, task as typeof TASK, digest, security, on);
const prLine = (pack: EvidencePack) => evidenceLines({ pack, mode: "summary" }, DIGEST, 0).lines[0] ?? "";

describe("scanner findings and migrations in the pack", () => {
  const items = [{ ruleId: "B608", severity: "high", path: "src/db.py", line: 7, message: "SQL built from input" }];

  it("a scan by a known security scanner is a security check; the pull request shows counts only, with high and critical named", async () => {
    const pack = await keep([{ checkId: "readiness:0", findings: findings("Bandit", { high: 1, low: 1 }, items) }], [entry("readiness:0", "bandit -r .", { after: "failed", exitCode: 1 })]);
    expect(pack?.checks[0]).toMatchObject({ kind: "security", findings: { tool: "Bandit", newCount: 2, bySeverity: { high: 1, low: 1 } } });
    expect(prLine(pack!)).toBe("Checks by kind: security scan ✗: 2 new (1 high or critical)");
    expect(prLine(pack!)).not.toMatch(/B608|SQL|db\.py/u);
  });

  it("a scan by any other tool is a lint check: it shows its count, and never raises the risk", async () => {
    const pack = await keep([{ checkId: "readiness:0", findings: findings("ESLint", { high: 3 }) }], [entry("readiness:0", "eslint .", { after: "failed", exitCode: 1 })]);
    expect(pack?.checks[0]?.kind).toBe("lint");
    expect(prLine(pack!)).toBe("Checks by kind: lint ✗ (3 new findings)");
    expect(evidenceRiskSignal(pack, DIGEST)).toBeUndefined();
  });

  it("the approved check policy's kind wins over the guess", async () => {
    const pack = await keep([{ checkId: "readiness:0", findings: findings("Custom Scanner", { critical: 1 }) }], [entry("readiness:0", "custom", { after: "failed", exitCode: 1 })], new Map([["readiness:0", "security"]]));
    expect(pack?.checks[0]?.kind).toBe("security");
    expect(evidenceRiskSignal(pack, DIGEST)).toEqual({ highNewFindings: 1 });
    const lint = await keep([{ checkId: "readiness:0", findings: findings("Bandit", { critical: 1 }) }], [entry("readiness:0", "bandit", { after: "failed", exitCode: 1 })], new Map([["readiness:0", "lint"]]));
    expect(evidenceRiskSignal(lint, DIGEST)).toBeUndefined();
  });

  it("a scan that was already failing and has nothing new keeps its (empty) findings; a scan that newly failed with none is not shown as clean", async () => {
    const already = await keep([{ checkId: "readiness:0", findings: findings("Bandit", {}) }], [entry("readiness:0", "bandit", { before: "failed", after: "failed", class: "already_failing", exitCode: 1 })]);
    expect(already?.checks[0]?.findings?.newCount).toBe(0);
    expect(prLine(already!)).toBe("Checks by kind: security scan ✗: 0 new findings");
    const regression = await keep([{ checkId: "readiness:0", findings: findings("Bandit", {}) }], [entry("readiness:0", "bandit", { after: "failed", class: "regression", exitCode: 1 })]);
    expect(regression?.checks[0]?.findings).toBeUndefined();
  });

  it("migration evidence marks a migration check; the pull request says applied and rolled back, or that the rollback failed", async () => {
    const pack = await keep([{ checkId: "readiness:0", migrations: { applied: ["0002_orders"], rolledBack: true, schemaChanges: ["create table orders"] } }], [entry("readiness:0", "alembic upgrade head")]);
    expect(pack?.checks[0]?.kind).toBe("migration");
    expect(prLine(pack!)).toBe("Checks by kind: migrations: 1 applied and rolled back cleanly");
    const failed = await keep([{ checkId: "readiness:0", migrations: { applied: ["0002_orders"], rolledBack: false, schemaChanges: [] } }], [entry("readiness:0", "alembic upgrade head")]);
    expect(prLine(failed!)).toBe("Checks by kind: migrations: 1 applied, rollback failed");
    const unknown = await keep([{ checkId: "readiness:0", migrations: { applied: ["0002_orders"], rolledBack: null, schemaChanges: [] } }], [entry("readiness:0", "alembic upgrade head")]);
    expect(prLine(unknown!)).toBe("Checks by kind: migrations: 1 applied");
  });

  it("a finding whose text holds personal data loses its texts but keeps its counts, so the high findings still reach the risk rule (the data guard)", async () => {
    const pack = await keep([{ checkId: "readiness:0", findings: findings("Bandit", { high: 1 }, [{ ruleId: "B1", severity: "high", path: "fixtures/jane.doe@gmail.com.py", line: 1, message: "x" }]) }], [entry("readiness:0", "bandit", { after: "failed", exitCode: 1 })]);
    expect(pack?.checks[0]?.findings).toEqual({ tool: "bandit", newCount: 1, bySeverity: severities({ high: 1 }), items: [] });
    expect(pack?.checks[0]?.kind).toBe("security");
    expect(JSON.stringify(pack)).not.toContain("jane.doe");
    expect(evidenceRiskSignal(pack, DIGEST)).toEqual({ highNewFindings: 1 });
    // An unknown tool's name is not kept (it may be what tripped the guard): a fixed word instead, and the check is no longer a known security scan.
    const unknown = await keep([{ checkId: "readiness:0", findings: findings("jane.doe@gmail.com scanner", { high: 1 }) }], [entry("readiness:0", "x", { after: "failed", exitCode: 1 })], new Map([["readiness:0", "security"]]));
    expect(unknown?.checks[0]?.findings?.tool).toBe("scanner");
    expect(evidenceRiskSignal(unknown, DIGEST)).toEqual({ highNewFindings: 1 });
  });

  it("the pack-level guard keeps a scan's counts too when a text in the built pack trips it", () => {
    const built = { schemaVersion: 1, candidateDigest: DIGEST, environment: { tier: "sandbox", envRevision: 0, services: [], data: "synthetic", accounts: [] }, selection: { method: "full", selected: 0, total: 0 }, api: [], browser: [], notTested: [],
      checks: [{ checkId: "readiness:0", kind: "security", label: "bandit", before: "passed", after: "failed", class: "regression", durationMs: 1,
        findings: { tool: "Bandit", newCount: 1, bySeverity: severities({ critical: 1 }), items: [{ ruleId: "B1", severity: "critical", path: "a@gmail.com.py", line: 1, message: "m" }] } }] } as unknown as EvidencePack;
    const guarded = guardPack(built, [], { accountIds: [], hosts: [], arnPrefixes: [] }, scanTextForTests);
    expect(guarded.pack?.checks[0]?.findings).toEqual({ tool: "bandit", newCount: 1, bySeverity: severities({ critical: 1 }), items: [] });
    expect(guarded.dropped.parts).toBe(1);
  });

  it("high findings that could not be compared are kept, shown in fixed words, and not dropped as 'a failed scan with none new'", async () => {
    const pack = await keep([{ checkId: "readiness:0", findings: { ...findings("Bandit", {}), unverified: 2 } }], [entry("readiness:0", "bandit", { after: "failed", class: "regression", exitCode: 1 })]);
    expect(pack?.checks[0]?.findings).toMatchObject({ newCount: 0, unverified: 2 });
    expect(prLine(pack!)).toBe("Checks by kind: security scan ✗: 2 high or critical findings could not be compared with the original code");
    expect(evidenceRiskSignal(pack, DIGEST)).toEqual({ highNewFindings: 0, unverifiedHighFindings: 2 });
  });

  it("a migration name that holds personal data loses the check's migration details (the data guard), and the check keeps the broker's own verdict", async () => {
    const pack = await keep([{ checkId: "readiness:0", migrations: { applied: ["0002_jane.doe@gmail.com"], rolledBack: true, schemaChanges: [] } }], [entry("readiness:0", "alembic upgrade head")]);
    expect(pack?.checks[0]?.migrations).toBeUndefined();
    expect(pack?.checks[0]).toMatchObject({ after: "passed" });
  });

  it("guesses a kind only from what the raw part carries", () => {
    expect(kindOfRawCheck({ checkId: "a" })).toBeUndefined();
    expect(kindOfRawCheck({ checkId: "a", findings: findings("Semgrep OSS", {}) })).toBe("security");
    expect(kindOfRawCheck({ checkId: "a", findings: findings("CodeQL", {}) })).toBe("security");
    expect(kindOfRawCheck({ checkId: "a", findings: findings("pylint", {}) })).toBe("lint");
  });
});

describe("the risk rule", () => {
  const code = createCandidateManifest([{ repositoryId: "payments", commitSha: "1".repeat(40), treeSha: "1".repeat(40), baseCommitSha: "e".repeat(40) }]);
  const clean: VerificationReport = { reviewOnly: false, passed: [{ label: "Unit tests" }], failed: [], notChecked: [], testsAdded: [] };
  const input = (over: Partial<RiskInput> = {}): RiskInput => ({ changedFiles: [{ repository: "payments", path: "src/retry.ts", added: 3, removed: 1 }], changedFilesComplete: true, report: clean, acceptedFindings: [], securityFindings: 0, candidateDigest: code.digest, ...over });
  const pack = (kind: string, bySeverity: Record<string, number>, digest = code.digest) => ({ schemaVersion: 1, candidateDigest: digest, checks: [{ checkId: "readiness:0", kind, label: "scan", before: "passed", after: "failed", class: "regression", durationMs: 1, findings: findings("Bandit", bySeverity) }] }) as unknown as EvidencePack;

  it("a new high or critical security finding makes the change high risk, with a fixed reason", () => {
    const risk = assessRisk(input({ evidence: { highNewFindings: 2 } }));
    expect(risk.level).toBe("high");
    expect(risk.reasons).toContain("A security scan found 2 new high or critical findings.");
    expect(assessRisk(input({ evidence: { highNewFindings: 1 } })).reasons).toContain("A security scan found 1 new high or critical finding.");
  });

  it("changes nothing without the signal: no evidence, or none high, gives the level and reasons the change had before evidence existed", () => {
    expect(assessRisk(input())).toEqual(assessRisk(input({ evidence: undefined })));
    expect(assessRisk(input({ evidence: { highNewFindings: 0 } }))).toEqual(assessRisk(input()));
    expect(assessRisk(input()).level).toBe("low");
  });

  it("high findings that could not be compared make the change at least medium, never silently low, and say so in a fixed sentence", () => {
    const risk = assessRisk(input({ evidence: { highNewFindings: 0, unverifiedHighFindings: 3 } }));
    expect(risk.level).toBe("medium");
    expect(risk.reasons).toContain("A security scan reported 3 high or critical findings that could not be compared with the original code, so it needs review.");
    expect(assessRisk(input({ evidence: { highNewFindings: 0, unverifiedHighFindings: 1 } })).reasons.join(" ")).toContain("1 high or critical finding that could not");
    // A new high finding still wins; a change that is already high stays high; none unverified changes nothing.
    expect(assessRisk(input({ evidence: { highNewFindings: 1, unverifiedHighFindings: 2 } })).level).toBe("high");
    expect(assessRisk(input({ evidence: { highNewFindings: 0, unverifiedHighFindings: 0 } }))).toEqual(assessRisk(input()));
    expect(evidenceRiskSignal(pack("lint", { high: 1 }), code.digest)).toBeUndefined();
  });

  it("only raises: a change that is already high stays high, with the finding added to its reasons", () => {
    const risk = assessRisk(input({ changedFiles: [{ repository: "payments", path: "infra/main.ts", added: 1, removed: 1 }], evidence: { highNewFindings: 1 } }));
    expect(risk.level).toBe("high");
    expect(risk.reasons).toHaveLength(2);
  });

  it("the signal counts critical and high from security checks of a pack for exactly this code, and nothing else", () => {
    expect(evidenceRiskSignal(pack("security", { high: 1, critical: 2, medium: 5 }), code.digest)).toEqual({ highNewFindings: 3 });
    expect(evidenceRiskSignal(pack("security", { medium: 5, low: 2 }), code.digest)).toBeUndefined();
    expect(evidenceRiskSignal(pack("lint", { high: 5 }), code.digest)).toBeUndefined();
    expect(evidenceRiskSignal(pack("security", { high: 1 }, OTHER), code.digest)).toBeUndefined();
    expect(evidenceRiskSignal(pack("security", { high: 1 }), undefined)).toBeUndefined();
    expect(evidenceRiskSignal(undefined, code.digest)).toBeUndefined();
  });

  it("with no port (the proof switch off) nothing is read and there is no signal; a port that fails is no signal; a port is asked for exactly this code", async () => {
    expect(await evidenceRiskOfTask(undefined, TASK, code.digest)).toBeUndefined();
    const asked: Array<string | undefined> = [];
    const port = { async pack(_task: unknown, digest: string | undefined) { asked.push(digest); return pack("security", { high: 1 }); } };
    expect(await evidenceRiskOfTask(port, TASK, undefined)).toBeUndefined();
    expect(asked).toEqual([]);
    expect(await evidenceRiskOfTask(port, TASK, code.digest)).toEqual({ highNewFindings: 1 });
    expect(asked).toEqual([code.digest]);
    expect(await evidenceRiskOfTask({ pack: async () => { throw new Error("down"); } }, TASK, code.digest)).toBeUndefined();
    expect(await evidenceRiskOfTask({ pack: async () => pack("security", { high: 1 }, OTHER) }, TASK, code.digest)).toBeUndefined();
  });

  // EV-2 (Sonnet re-check of evidence-p3p4) and S-1 (Opus review of proof-fixes): when the approved policy has a security check, a scan that could not be checked must not leave the change Low.
  describe("a security check whose scan could not be checked", () => {
    const SEC = ["readiness:0"];
    const unavailable = { highNewFindings: 0, evidenceUnavailable: true as const };
    const withoutFindings = () => { const base = pack("security", {}); return { ...base, checks: base.checks.map((check) => Object.fromEntries(Object.entries(check).filter(([name]) => name !== "findings"))) } as unknown as EvidencePack; };

    it("is evidenceUnavailable when there is no pack, the read fails, or the pack is for other code; the risk is at least Medium, in a fixed sentence", async () => {
      expect(await evidenceRiskOfTask({ pack: async () => undefined }, TASK, code.digest, SEC)).toEqual(unavailable);
      expect(await evidenceRiskOfTask({ pack: async () => { throw new Error("down"); } }, TASK, code.digest, SEC)).toEqual(unavailable);
      expect(await evidenceRiskOfTask({ pack: async () => pack("security", { high: 1 }, OTHER) }, TASK, code.digest, SEC)).toEqual(unavailable);
      const risk = assessRisk(input({ evidence: unavailable }));
      expect(risk.level).toBe("medium");
      expect(risk.reasons).toContain("The proof evidence for this code was not available, so a security scan could not be checked, and it needs review.");
    });

    it("is evidenceUnavailable when the pack is there but the security check has no findings (dropped as inconsistent or untrusted, or the scan wrote nothing that could be read) or is not in the pack at all (S-1)", async () => {
      expect(await evidenceRiskOfTask({ pack: async () => withoutFindings() }, TASK, code.digest, SEC)).toEqual(unavailable);
      expect(await evidenceRiskOfTask({ pack: async () => pack("security", {}) }, TASK, code.digest, ["readiness:3"])).toEqual(unavailable);
      // A new high finding in one security check still counts when another one is unavailable.
      const two = { ...pack("security", { high: 1 }), checks: [...pack("security", { high: 1 }).checks, { ...withoutFindings().checks[0]!, checkId: "readiness:1" }] } as EvidencePack;
      expect(await evidenceRiskOfTask({ pack: async () => two }, TASK, code.digest, ["readiness:0", "readiness:1"])).toEqual({ highNewFindings: 1, evidenceUnavailable: true });
      expect(assessRisk(input({ evidence: { highNewFindings: 1, evidenceUnavailable: true } })).level).toBe("high");
    });

    it("changes nothing without a security check in the policy, with the pack and its findings there, or with no candidate", async () => {
      expect(await evidenceRiskOfTask({ pack: async () => undefined }, TASK, code.digest, [])).toBeUndefined();
      expect(await evidenceRiskOfTask({ pack: async () => undefined }, TASK, code.digest)).toBeUndefined();
      expect(await evidenceRiskOfTask({ pack: async () => undefined }, TASK, undefined, SEC)).toBeUndefined();
      expect(await evidenceRiskOfTask({ pack: async () => withoutFindings() }, TASK, code.digest, [])).toBeUndefined();
      expect(await evidenceRiskOfTask({ pack: async () => pack("security", { medium: 1 }) }, TASK, code.digest, SEC)).toBeUndefined();
      expect(await evidenceRiskOfTask({ pack: async () => pack("security", { high: 2 }) }, TASK, code.digest, SEC)).toEqual({ highNewFindings: 2 });
      expect(assessRisk(input({ evidence: { highNewFindings: 0, evidenceUnavailable: undefined } }))).toEqual(assessRisk(input()));
    });

    it("fails closed when the caller has no evidence port while the proof switch is on and a security check is expected; with the switch off there is no port and no signal", async () => {
      expect(await evidenceRiskOfTask(undefined, TASK, code.digest, SEC, true)).toEqual(unavailable);
      expect(await evidenceRiskOfTask(undefined, TASK, code.digest, SEC, false)).toBeUndefined();
      expect(await evidenceRiskOfTask(undefined, TASK, code.digest, [], true)).toBeUndefined();
      expect(await evidenceRiskOfTask(undefined, TASK, undefined, SEC, true)).toBeUndefined();
    });

    it("the security checks of a policy are named by the id the worker reports (readiness:<index> in selected order)", () => {
      const check = (id: string, kind?: string) => ({ id, label: id, ...(kind === undefined ? {} : { kind }) });
      const policy = { required: [check("unit", "test"), check("sast", "security")], optional: [check("deps", "security"), check("lint", "lint")], selectedOptionalIds: ["deps", "lint"], proposed: [] };
      expect(securityCheckIdsOf(policy as never)).toEqual(["readiness:1", "readiness:2"]);
      expect(securityCheckIdsOf({ ...policy, required: [check("unit", "test")], optional: [], selectedOptionalIds: [] } as never)).toEqual([]);
      expect(securityCheckIdsOf(undefined)).toEqual([]);
    });
  });

  it("recomputeRisk gives the recorded level of the code with the signal, and is the same object-for-object without it", async () => {
    const { createWorkflowSnapshot } = await import("../../packages/contracts/src/task-workflow-node.js");
    const workflow = { ...createWorkflowSnapshot({ taskId: "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6", ownerId: "a".repeat(64), now: "2026-11-04T12:00:00.000Z", definitionVersion: "1.1.0" }), candidate: code };
    const files = { files: [{ repository: "payments", path: "src/retry.ts", added: 3, removed: 1 }], complete: true };
    const without = recomputeRisk(workflow, files, {});
    expect(recomputeRisk(workflow, files, {}, undefined)).toEqual(without);
    const withSignal = recomputeRisk(workflow, files, {}, { highNewFindings: 1 });
    expect(withSignal.risk?.level).toBe("high");
    expect(without.risk?.level).not.toBe("high");
  });
});
