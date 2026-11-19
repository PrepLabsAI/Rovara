// Broker-owned evidence, existing decision subjects and transactional audit. No HTTP mark-setting input.
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { agentXError, canonicalJson, classifyBlockedWorkflow, companyScoped, isValidTestId, projectPk, when, type AuditEvent, type EvidencePack, type NightlyBaseline, type StoredNightlyHealth, type OrgId, type Principal, type TransactItem, type WorkflowSnapshot } from "@agentx/contracts";
import type { TestEnvDeps } from "./deps.js";
import { documentOf } from "./deps.js";
import { readLatestNightlyHealth } from "./nightly.js";
import { NIGHTLY_ENVIRONMENT_CAUSES } from "./nightly-health.js";
import { nightlyBaselineUsable, usableNightlyBaseline } from "./nightly-usable.js";
import { readableFailingTests, RESULT_RULES } from "../proof/verification-result.js";
import { SubjectRefusal, type DecisionSubject } from "../decisions/approval-gate.js";
import type { DecisionItem } from "../decisions/project.js";

export const verificationResultsEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env["ROVARA_VERIFICATION_RESULTS"] === "1";
export const KNOWN_FAILING_SUBJECT = "known_failing";
const MAX = 500, CARD_MAX = 20, TASK_MAX = 100;
const Test = z.object({ name: z.string().refine(isValidTestId), checkId: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/u) }).strict();
const Mark = Test.extend({ markedBy: z.string().min(1), markedAt: z.string().datetime(), epoch: z.number().int().positive(), version: z.string().uuid() }).strict();
const Marks = z.object({ version: z.number().int().positive(), marks: z.array(Mark).max(MAX) });
const Record = z.object({ companyId: z.string(), project: z.string(), cause: z.string(), epoch: z.number().int().positive(), version: z.number().int().positive(), state: z.enum(["open", "marked", "dismissed", "resolved"]), createdAt: z.string().datetime(), expiresAt: z.string().datetime(), taskIds: z.array(z.string()).max(TASK_MAX), taskCount: z.number().int().nonnegative(), tests: z.array(Test).max(CARD_MAX), evidenceDigest: z.string(), sourceTaskId: z.string(), candidateDigest: z.string() });
type Row = z.infer<typeof Record>;
export type KnownFailingMark = z.infer<typeof Mark>;
export interface KnownFailingDeps extends TestEnvDeps {
  workflowOf?: (companyId: OrgId, project: string, taskId: string) => Promise<WorkflowSnapshot | undefined>;
  mayMaintain: (principal: Principal, project: string) => Promise<boolean>;
  evidenceOf: (companyId: OrgId, project: string, taskId: string, candidateDigest: string) => Promise<EvidencePack | undefined>;
}
const hash = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");
const recordsPk = (company: string): string => companyScoped(company, "FIX_SETUP");
const recordKey = (company: string, id: string) => ({ pk: recordsPk(company), sk: id });
const marksKey = (company: string, project: string) => ({ pk: projectPk(company, project), sk: "KNOWN_FAILING" });
const stale = () => agentXError("CHANGE_STALE", "The evidence or mark changed. Reload and decide again.");

/** A missing marks row is empty; a damaged or incomplete row throws and must never become an exemption. */
export async function readKnownFailingMarks(deps: Pick<TestEnvDeps, "store">, company: string, project: string) {
  const raw = await deps.store.get(marksKey(company, project));
  return raw === undefined ? { version: 0, marks: [] as KnownFailingMark[] } : Marks.parse(raw);
}

/** Unlike the display fallback, an unreadable or cut branch set cannot authorize an exemption. */
export async function knownFailingTaskBranches(deps: Pick<TestEnvDeps, "store">, taskId: string): Promise<string[] | undefined> {
  try {
    const page = await deps.store.query({ pk: `DEVTASK#${taskId}`, sk: { op: "beginsWith", prefix: "MERGE_TRACKING#" }, limit: 100 });
    if (page.cursor !== undefined) return undefined;
    const open = page.items.filter((row) => row["state"] === "open");
    if (open.some((row) => typeof row["baseBranch"] !== "string" || row["baseBranch"] === "")) return undefined;
    return [...new Set(open.map((row) => row["baseBranch"] as string))];
  } catch { return undefined; }
}

export function createKnownFailing(deps: KnownFailingDeps) {
  const enabled = () => verificationResultsEnabled(deps.env);
  const maintain = async (company: string, project: string, principal: Principal) => enabled() && principal.companyId === company && await deps.mayMaintain(principal, project).catch(() => false);
  const audit = (event: AuditEvent): readonly TransactItem[] => {
    if (deps.audit === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "The audit ledger is unavailable.");
    const staged = deps.audit.stage(event);
    if (staged.length === 0) throw agentXError("RUNTIME_UNAVAILABLE", "The audit ledger is unavailable.");
    return staged;
  };
  const read = async (company: string, id: string): Promise<Row | undefined> => {
    const raw = await deps.store.get(recordKey(company, id));
    if (raw === undefined) return undefined;
    const row = Record.parse(raw);
    if (row.companyId !== company) throw stale();
    return row;
  };
  const eligible = async (companyId: OrgId, project: string, taskId: string, evidence: EvidencePack) => {
    const taskBranches = await knownFailingTaskBranches(deps, taskId);
    if (taskBranches === undefined) return [];
    const baseline = await usableNightlyBaseline(deps, companyId, project, { taskBranches });
    const failures = evidence.checks.filter((check) => check.after === "failed");
    if (baseline === undefined || failures.length === 0) return [];
    const tests: z.infer<typeof Test>[] = [];
    for (const check of failures) {
      const names = readableFailingTests(check);
      if (check.class !== "already_failing" || check.before !== "failed" || check.kind !== "test" || names === undefined || names.some((name) => !baseline.failed.includes(name) || check.tests!.newTests.includes(name))) return [];
      for (const name of names) tests.push({ name, checkId: check.checkId });
    }
    if (tests.length > CARD_MAX || new Set(tests.map((test) => hash(test))).size !== tests.length || !z.array(Test).safeParse(tests).success) return [];
    return tests.sort((a, b) => a.checkId.localeCompare(b.checkId) || a.name.localeCompare(b.name));
  };
  const binding = (row: Row, marks: Awaited<ReturnType<typeof readKnownFailingMarks>>) => ({ revision: row.version, artifactDigest: hash([row.companyId, row.project, row.cause, row.epoch, row.version, row.tests, row.evidenceDigest, marks]) });
  const current = async (company: OrgId, id: string) => {
    const row = await read(company, id);
    if (row === undefined) return undefined;
    if (row.sourceTaskId === "") {
      const night = await readLatestNightlyHealth(deps, company, row.project);
      if (night === undefined || hash(night) !== row.evidenceDigest || !(await nightlyBaselineUsable(deps, company, row.project, night.baseline))) throw stale();
      const marks = await readKnownFailingMarks(deps, company, row.project);
      return { row, marks, binding: binding(row, marks) };
    }
    if (row.candidateDigest === "") {
      const workflow = await deps.workflowOf?.(company, row.project, row.sourceTaskId);
      if (workflow?.state !== "BLOCKED" || hash(workflow) !== row.evidenceDigest) throw stale();
      const marks = await readKnownFailingMarks(deps, company, row.project);
      return { row, marks, binding: binding(row, marks) };
    }
    const pack = await deps.evidenceOf(company, row.project, row.sourceTaskId, row.candidateDigest);
    if (pack === undefined || pack.candidateDigest !== row.candidateDigest || hash(pack) !== row.evidenceDigest || hash(await eligible(company, row.project, row.sourceTaskId, pack)) !== hash(row.tests)) throw stale();
    const marks = await readKnownFailingMarks(deps, company, row.project);
    return { row, marks, binding: binding(row, marks) };
  };
  const item = (id: string, row: Row, marks: Awaited<ReturnType<typeof readKnownFailingMarks>>): Extract<DecisionItem, { kind: "fix_setup" }> => {
    const seen = binding(row, marks);
    return { kind: "fix_setup", subjectId: `${id}_${seen.artifactDigest}`, project: row.project, title: "Fix test setup", cause: row.cause, step: row.cause === "fails-on-original-code" ? "Tests fail on original code" : "Test environment", taskCount: row.taskCount, knownFailingTests: row.tests.length, unconfirmedFailing: 0, eligibleTests: row.tests, createdAt: row.createdAt, expiresAt: row.expiresAt, openPath: `/app/projects/${encodeURIComponent(row.project)}/setup`, contentVersion: seen.artifactDigest, binding: seen };
  };
  const subject: DecisionSubject = {
    kind: KNOWN_FAILING_SUBJECT,
    async load(company, id) {
      if (!enabled()) return undefined;
      const parts = /^([a-f0-9]{64})_([a-f0-9]{64})$/u.exec(id);
      if (parts === null) return undefined;
      const found = await current(company, parts[1]!);
      if (found !== undefined && found.binding.artifactDigest !== parts[2]) return undefined;
      if (found === undefined) return undefined;
      const { row, binding: seen } = found;
      return { key: recordKey(company, parts[1]!), guard: when.and(when.eq("version", row.version), when.eq("epoch", row.epoch), when.eq("state", "open")), waiting: row.state === "open", request: { kind: KNOWN_FAILING_SUBJECT, subject: { type: KNOWN_FAILING_SUBJECT, id }, projectName: row.project, revision: seen.revision, artifactDigest: seen.artifactDigest, risk: "medium", expiresAt: row.expiresAt }, state: found };
    },
    async apply(loaded, attempt, approvers, at) {
      const { row, marks } = loaded.state as NonNullable<Awaited<ReturnType<typeof current>>>;
      const website = (attempt.details as { webApp?: unknown } | undefined)?.webApp === true;
      if (!website || approvers.length !== 1 || !(await maintain(attempt.companyId, row.project, approvers[0]!))) throw new SubjectRefusal("not_the_approver", "A current maintainer must decide on the website.");
      if (attempt.outcome !== "approve" && attempt.outcome !== "reject") throw new SubjectRefusal("invalid_outcome", "This action is unavailable.");
      const fresh = await current(attempt.companyId, attempt.subjectId.split("_")[0]!);
      if (fresh === undefined || hash(fresh.binding) !== hash(loaded.request && { revision: loaded.request.revision, artifactDigest: loaded.request.artifactDigest })) throw new SubjectRefusal("invalid", "The evidence changed.");
      if (attempt.outcome === "reject") return { ops: [{ op: "set", path: ["state"], value: "dismissed" }, { op: "set", path: ["version"], value: row.version + 1 }] };
      if (row.tests.length === 0 || row.tests.some((test) => marks.marks.some((mark) => mark.name === test.name && mark.checkId === test.checkId)) || marks.marks.length + row.tests.length > MAX) throw new SubjectRefusal("invalid", "No complete eligible test set.");
      const actor = approvers[0]!;
      // Stage before constructing any mutation. The gate commits these steps with the subject and decision.
      const staged = audit({ eventId: `known-failing:${attempt.requestId}`, companyId: attempt.companyId, at, actor: { type: "person", id: actor.personId }, action: "known_failing.marked", subject: { type: "project", id: row.project }, details: { project: row.project, cause: row.cause, count: row.tests.length, epoch: row.epoch, version: row.version, testsDigest: hash(row.tests) } });
      const extra: TransactItem[] = [...staged, { kind: "put", item: documentOf({ ...marksKey(attempt.companyId, row.project), version: marks.version + 1, marks: [...marks.marks, ...row.tests.map((test) => ({ ...test, markedBy: actor.personId, markedAt: at, epoch: row.epoch, version: randomUUID() }))] }), condition: marks.version === 0 ? when.absent() : when.eq("version", marks.version) }];
      return { ops: [{ op: "set", path: ["state"], value: "marked" }, { op: "set", path: ["version"], value: row.version + 1 }], extra };
    },
  };
  return {
    subject,
    async observeBlocked(input: { companyId: OrgId; project: string; taskId: string; workflow: WorkflowSnapshot }) {
      if (!enabled() || input.workflow.state !== "BLOCKED") return;
      const cause = classifyBlockedWorkflow(input.workflow, {}).find((signal) => RESULT_RULES[signal.code].kind === "environment")?.code;
      if (cause === undefined) return;
      const id = hash([input.project, cause]), old = await read(input.companyId, id), open = old?.state === "open";
      const evidenceDigest = hash(input.workflow);
      if (old?.evidenceDigest === evidenceDigest) return;
      const ids = open ? [...new Set([...old.taskIds, input.taskId])] : [input.taskId];
      const row: Row = { companyId: input.companyId, project: input.project, cause, epoch: open ? old.epoch : (old?.epoch ?? 0) + 1, version: (old?.version ?? 0) + 1, state: "open", createdAt: open ? old.createdAt : new Date(deps.now()).toISOString(), expiresAt: new Date(deps.now() + 86_400_000).toISOString(), taskIds: ids.slice(0, TASK_MAX), taskCount: Math.min(TASK_MAX, ids.length), tests: [], evidenceDigest, sourceTaskId: input.taskId, candidateDigest: "" };
      if (!(await deps.store.put({ item: documentOf({ ...recordKey(input.companyId, id), entityType: "FIX_SETUP", ...row }), condition: old === undefined ? when.absent() : when.eq("version", old.version) })).applied) throw stale();
    },
    async observe(input: { companyId: OrgId; project: string; taskId: string; workflow: WorkflowSnapshot; evidence: EvidencePack }) {
      if (!enabled() || input.workflow.candidate?.digest !== input.evidence.candidateDigest) return undefined;
      const tests = await eligible(input.companyId, input.project, input.taskId, input.evidence);
      const original = input.evidence.checks.some((check) => check.after === "failed" && check.class === "already_failing");
      // Causes are the broker's fixed classification, never printed output or a caller's words.
      const cause = original ? "fails-on-original-code" : classifyBlockedWorkflow(input.workflow, {}).find((signal) => RESULT_RULES[signal.code].kind === "environment")?.code;
      if (cause === undefined) return undefined;
      const id = hash([input.project, cause]), old = await read(input.companyId, id), open = old?.state === "open";
      const evidenceDigest = hash(input.evidence);
      if (old !== undefined && !open && old.evidenceDigest === evidenceDigest && old.taskIds.includes(input.taskId)) return undefined;
      if (open && old.evidenceDigest === evidenceDigest && old.taskIds.includes(input.taskId)) return item(id, old, await readKnownFailingMarks(deps, input.companyId, input.project));
      const ids = open ? [...new Set([...old.taskIds, input.taskId])] : [input.taskId];
      const row: Row = { companyId: input.companyId, project: input.project, cause, epoch: open ? old.epoch : (old?.epoch ?? 0) + 1, version: (old?.version ?? 0) + 1, state: "open", createdAt: open ? old.createdAt : new Date(deps.now()).toISOString(), expiresAt: new Date(deps.now() + 86_400_000).toISOString(), taskIds: ids.slice(0, TASK_MAX), taskCount: Math.min(TASK_MAX, ids.length), tests: cause === "fails-on-original-code" ? tests : [], evidenceDigest, sourceTaskId: input.taskId, candidateDigest: input.evidence.candidateDigest };
      const written = await deps.store.put({ item: documentOf({ ...recordKey(input.companyId, id), entityType: "FIX_SETUP", ...row }), condition: old === undefined ? when.absent() : when.eq("version", old.version) });
      if (!written.applied) throw stale();
      return item(id, row, await readKnownFailingMarks(deps, input.companyId, input.project));
    },
    async items(company: OrgId, principal: Principal): Promise<DecisionItem[]> {
      if (!enabled() || principal.companyId !== company) return [];
      const page = await deps.store.query({ pk: recordsPk(company), limit: 100 });
      const items: DecisionItem[] = [];
      for (const raw of page.items) {
        const row = Record.parse(raw);
        if (row.companyId !== company || row.state !== "open" || Date.parse(row.expiresAt) <= deps.now() || !(await maintain(company, row.project, principal))) continue;
        const found = await current(company, raw.sk).catch(() => undefined);
        if (found !== undefined) items.push(item(raw.sk, row, found.marks));
      }
      return items;
    },
    async marks(company: string, project: string) { const rows = await readKnownFailingMarks(deps, company, project); return { max: MAX, marks: rows.marks }; },
    async undo(company: string, project: string, principal: Principal, website: boolean, selected: KnownFailingMark) {
      if (!website || !(await maintain(company, project, principal))) throw agentXError("FORBIDDEN", "Use the website as a current project maintainer.");
      const current = await readKnownFailingMarks(deps, company, project);
      const target = current.marks.find((mark) => hash(mark) === hash(selected));
      if (target === undefined) throw stale();
      const staged = audit({ eventId: `known-failing:undo:${target.version}`, companyId: company, at: new Date(deps.now()).toISOString(), actor: { type: "person", id: principal.personId }, action: "known_failing.undone", subject: { type: "project", id: project }, details: { count: 1, epoch: target.epoch, testsDigest: hash([{ name: target.name, checkId: target.checkId }]) } });
      const result = await deps.store.transact([...staged, { kind: "put", item: documentOf({ ...marksKey(company, project), version: current.version + 1, marks: current.marks.filter((mark) => mark.version !== target.version) }), condition: when.eq("version", current.version) }]);
      if (!result.applied) throw stale();
    },
    async health(company: OrgId, project: string, baseline: NightlyBaseline, health: StoredNightlyHealth | undefined) {
      if (!enabled() || health?.class !== "environment" || !NIGHTLY_ENVIRONMENT_CAUSES.includes(health.cause as typeof NIGHTLY_ENVIRONMENT_CAUSES[number]) || !(await nightlyBaselineUsable(deps, company, project, baseline))) return;
      const cause = health.cause!, id = hash([project, cause]), old = await read(company, id), open = old?.state === "open";
      const evidenceDigest = hash({ baseline, health });
      if (old?.evidenceDigest === evidenceDigest) return;
      const row: Row = { companyId: company, project, cause, epoch: open ? old.epoch : (old?.epoch ?? 0) + 1, version: (old?.version ?? 0) + 1, state: "open", createdAt: open ? old.createdAt : new Date(deps.now()).toISOString(), expiresAt: new Date(deps.now() + 86_400_000).toISOString(), taskIds: open ? old.taskIds : [], taskCount: open ? old.taskCount : 0, tests: [], sourceTaskId: "", candidateDigest: "", evidenceDigest };
      if (!(await deps.store.put({ item: documentOf({ ...recordKey(company, id), entityType: "FIX_SETUP", ...row }), condition: old === undefined ? when.absent() : when.eq("version", old.version) })).applied) throw stale();
    },
    async nightly(company: OrgId, project: string, baseline: NightlyBaseline, passedNames: readonly string[] = []) {
      if (!enabled() || baseline.tests.failed !== 0 || baseline.tests.skipped !== 0 || baseline.tests.total === 0 || baseline.tests.passed !== baseline.tests.total || !(await nightlyBaselineUsable(deps, company, project, baseline))) return;
      const current = await readKnownFailingMarks(deps, company, project);
      const removed = current.marks.filter((mark) => passedNames.includes(mark.name) && Date.parse(mark.markedAt) <= Date.parse(baseline.finishedAt));
      if (removed.length > 0) {
        const staged = audit({ eventId: `known-failing:nightly:${hash([company, project, baseline.finishedAt, current.version])}`, companyId: company, at: new Date(deps.now()).toISOString(), actor: { type: "system", id: "nightly" }, action: "known_failing.nightly_removed", subject: { type: "project", id: project }, details: { count: removed.length, version: current.version, testsDigest: hash(removed.map(({ name, checkId }) => ({ name, checkId }))) } });
        const result = await deps.store.transact([...staged, { kind: "put", item: documentOf({ ...marksKey(company, project), version: current.version + 1, marks: current.marks.filter((mark) => !removed.some((old) => old.version === mark.version)) }), condition: when.eq("version", current.version) }]);
        if (!result.applied) throw stale();
      }
      const page = await deps.store.query({ pk: recordsPk(company), limit: 100 });
      for (const raw of page.items) {
        const row = Record.parse(raw);
        if (row.companyId === company && row.project === project && row.state === "open") await deps.store.update({ key: recordKey(company, raw.sk), condition: when.eq("version", row.version), ops: [{ op: "set", path: ["state"], value: "resolved" }, { op: "set", path: ["version"], value: row.version + 1 }] });
      }
    },
  };
}
