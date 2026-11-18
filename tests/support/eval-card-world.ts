// Shared world for the L4-EVC tests (tests/unit/eval-setup-card.test.ts and the hosted route test): one company's store, people, setup runs that reported an eval, the card and the one-act approval.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach } from "vitest";
import { evalCommandFingerprintOf, type Approvers, type DocumentStore, type OrgRole, type Principal, type SetupEvalDiscoveryReport } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createNoopAuditSink } from "../../packages/broker/src/ports/policy-defaults.js";
import { createDecisionGate } from "../../packages/broker/src/core/decisions/approval-gate.js";
import { handleSetupAgentCallback } from "../../packages/broker/src/core/setup-agent/callback.js";
import { readEvalCard } from "../../packages/broker/src/core/setup-agent/eval-card.js";
import { confirmEvalDiscovery, readEvalDiscovery, type EvalDiscoveryConfirmDeps } from "../../packages/broker/src/core/setup-agent/eval-discovery.js";
import { EVAL_SPEND_KIND, createEvalSpendSubject, readEvalSpendItem, readEvalSpendRecord } from "../../packages/broker/src/core/setup-agent/eval-spend.js";
import { setupAgentKey } from "../../packages/broker/src/core/setup-agent/keys.js";
import type { SessionMembers } from "../../packages/broker/src/core/sessions/access.js";
import { deployedSessionMembers } from "../../packages/broker/src/core-host/deployed-decisions.js";
import { workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { workspaceKeys } from "../../packages/broker/src/core/task-flow/workspace-location.js";
import { taskKey } from "../../packages/broker/src/developer/task-records.js";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";

export const A = COMPANY_A.orgId;
export const B = COMPANY_B.orgId;
export const project = "demo";
export const NOW = Date.parse("2026-11-18T05:00:00.000Z");
export const CAP = 50_000_000;
const SCORE = "score: exact match\n";
const JUDGE = { kind: "rule", scoringPath: "evals/demo/score.txt" } as const;
export const MODEL = "gemini-2.5-flash"; export const VERSION = "gemini-2.5-flash-001";
const IMAGE = `registry.example/worker@sha256:${"e".repeat(64)}`;
export const command = { executable: "node", args: ["evals/run.js", "--out", "rovara-measures.json"], cwd: "." };
export const reportPath = { cwd: ".", argument: "rovara-measures.json" };
/** $0.10 a case at 2 calls: two cases cost $0.60 for the three runs, $0.20 for one run, at most $1.80 for a check. */
export const COST_PER_CASE = 100_000;

export const names = (n: number) => Array.from({ length: n }, (_, i) => `q${i + 1}`);
export const suite = (n: number, over: Record<string, unknown> = {}) => ({
  selection: "evals/demo", repository: "web",
  questions: names(n).map((id, i) => ({ id, category: i === 1 ? "safety" : "ordinary", path: `evals/demo/${id}.txt` })),
  command, report: reportPath, commandFingerprint: evalCommandFingerprintOf(command, reportPath), judge: JUDGE, subsetSupported: true,
  catalogRowId: "gemini", model: MODEL, modelVersion: VERSION, image: IMAGE, route: "gateway", maxCallsPerQuestion: 2, maxCostMicrosPerQuestion: COST_PER_CASE, ...over,
});
export const reportOf = (n = 2, over: Record<string, unknown> = {}): SetupEvalDiscoveryReport => ({ schemaVersion: 1, suites: [suite(n, over)] }) as SetupEvalDiscoveryReport;
export const filesOf = (n: number, edits: Record<string, string> = {}): Record<string, string> => ({ ...Object.fromEntries(names(n).map(id => [`evals/demo/${id}.txt`, `question ${id}\n`])), "evals/demo/score.txt": SCORE, ...edits });
export const pathsOf = (n: number) => names(n).map(id => `evals/demo/${id}.txt`);

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(r => rm(r, { recursive: true, force: true }))); });
const g = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
async function repository(files: Record<string, string>) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "evc-"))); roots.push(dir);
  g(dir, "init", "-q");
  for (const [p, c] of Object.entries(files)) { await mkdir(dirname(join(dir, p)), { recursive: true }); await writeFile(join(dir, p), c); }
  g(dir, "add", "-A"); g(dir, "commit", "-qm", "base");
  return { dir, baseSha: g(dir, "rev-parse", "HEAD") };
}
export const gitReader = (dir: string): NonNullable<EvalDiscoveryConfirmDeps["readFile"]> => async (_repository, path, commit) => {
  try { return execFileSync("git", ["show", `${commit}:${path}`], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return undefined; }
};

export const person = (companyId: string, personId: string): Principal => ({ companyId, personId, provider: "test-identity", displayName: personId, roles: [] });
export type Role = { company: OrgRole; grant?: "developer" | "administrator" } | undefined;
export const ROLES: Record<string, Role> = {
  owner: { company: "owner" }, admin: { company: "admin" }, maintainer: { company: "member", grant: "administrator" }, member: { company: "member" }, contributor: { company: "member", grant: "developer" }, revoked: undefined,
};
function people(companyId: string, roles: Record<string, Role>) {
  return { membershipOf: async (personId: string) => { const role = roles[personId]; return role === undefined ? undefined : { companyId, role: role.company }; },
    projectGrantRole: async (personId: string, p: string) => (p === project ? roles[personId]?.grant : undefined) };
}

/** One company with a store shared by every setup run made on it (a later run is a later report on the same project). */
export type EvalCardWorld = ReturnType<typeof makeCompany>;
export const company = (...args: Parameters<typeof makeCompany>): EvalCardWorld => makeCompany(...args);
function makeCompany(companyId: string, roles: Record<string, Role> = { ...ROLES }, store: DocumentStore = new MemoryDocumentStore()) {
  const members: SessionMembers = deployedSessionMembers(companyId, people(companyId, roles));
  let decider: Principal = person(companyId, "admin");
  const approvers: Approvers = { requirement: async () => ({ methods: ["local-session"], minApprovers: 1, selfApprovalAllowed: true }), verify: async (_request, proof) => ({ approved: true, approver: decider, method: proof.method, proofId: proof.proofId }) };
  const gate = createDecisionGate({ store, approvers, audit: createNoopAuditSink(), subjects: [createEvalSpendSubject({ store, companyId, members })], now: () => new Date(NOW) });
  const approved: string[] = [];
  const decide = async (offer: { requestId: string; revision: number; artifactDigest: string }, principal: Principal) => {
    decider = principal; approved.push(offer.requestId);
    const result = await gate.decide({ companyId, kind: EVAL_SPEND_KIND, subjectId: project, requestId: offer.requestId, outcome: "approve", seen: { revision: offer.revision, artifactDigest: offer.artifactDigest }, credentials: [{ method: "local-session", token: "t" }] });
    if (result.status === "refused") throw new Error(`refused:${result.reason}`);
  };
  const state = { cap: CAP as number | undefined };
  /** A setup run that reported `report` for files `files`. */
  async function run(files: Record<string, string>, report: SetupEvalDiscoveryReport) {
    const repo = await repository(files);
    const workspaceId = randomUUID(); const taskId = randomUUID();
    await store.put({ item: { ...workspaceKey(companyId, workspaceId), entityType: "WORKSPACE", id: workspaceId, companyId } });
    await store.put({ item: { ...(await workspaceKeys({ store, companyId }, workspaceId)).taskPointerKey(), taskId } });
    await store.put({ item: { ...taskKey(taskId), taskId, workspaceId, project, companyId, purpose: "setup_agent", preparedBase: [{ repositoryId: "web", baseCommitSha: repo.baseSha }] } });
    await store.put({ item: { ...setupAgentKey(companyId, project), entityType: "SETUP_AGENT", taskId } });
    const operation = { kind: "task", workflowMode: "SETUP_AGENT", status: "RUNNING", workspaceId, companyId };
    await handleSetupAgentCallback({ store, companyId, now: () => NOW, log: () => undefined }, operation, { kind: "eval_discovery", report });
    const deps = (over: Partial<EvalDiscoveryConfirmDeps> = {}): EvalDiscoveryConfirmDeps => ({ store, companyId, now: () => NOW, members, ...(state.cap === undefined ? {} : { monthlyCap: async () => state.cap, healthRuns: true }),
      latest: async (p) => (p === project ? { revision: 7, definition: { repositories: [{ name: "web", url: "https://github.com/acme/web" }] } } : undefined), readFile: gitReader(repo.dir), approve: decide, ...over });
    const digest = async () => (await readEvalDiscovery({ store, companyId }, project))!.reportDigest;
    const card = (as: Principal = person(companyId, "admin")) => readEvalCard({ store, companyId, members, monthlyCap: async () => state.cap }, project, as);
    /** The person's yes as the hosted route sends it: the paths and the dollars they were shown. */
    const approve = async (as: Principal = person(companyId, "admin"), over: Record<string, unknown> = {}, depsOver: Partial<EvalDiscoveryConfirmDeps> = {}) => {
      const seen = (await card(as)).suites[0]!.seen;
      return confirmEvalDiscovery(deps(depsOver), project, { taskId, reportDigest: await digest(), selection: "evals/demo", paths: report.suites[0]!.questions.map(q => q.path), approve: true, seen, ...over }, as);
    };
    const confirmOnly = async (as: Principal = person(companyId, "admin")) =>
      confirmEvalDiscovery(deps(), project, { taskId, reportDigest: await digest(), selection: "evals/demo", paths: report.suites[0]!.questions.map(q => q.path) }, as);
    return { repo, taskId, deps, digest, card, approve, confirmOnly };
  }
  const table = { store, companyId, members };
  const record = () => readEvalSpendRecord(table, project);
  const item = () => readEvalSpendItem(table, project);
  return { store, companyId, members, roles, state, run, approved, record, item, table, decide, gate, setDecider: (p: Principal) => { decider = p; } };
}

