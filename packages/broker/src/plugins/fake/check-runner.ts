// A CheckRunner over the in-memory model: checks are what the model holds for a revision, runs are started and finished by the test.
import { createHash } from "node:crypto";
import {
  agentXError, CheckStartRequestSchema, CheckTargetSchema, HostScopeSchema,
  type Check, type CheckConclusion, type CheckRunRef, type CheckRunner, type CheckRunnerCapabilities, type CheckStartRequest, type CheckTarget, type HostScope, type ReadBudget,
  type UntrustedText,
} from "@agentx/contracts";
import type { FakeHostModel } from "./model.js";

export const FAKE_RUNNER_KIND = "fake-checks";
/** The most of a log a tail returns. */
export const LOG_TAIL_MAX_CHARS = 16_384;

export const FAKE_CHECK_RUNNER_CAPABILITIES: CheckRunnerCapabilities = { listByChangeRequest: true, listByRevision: true, logTail: true, start: true, rerun: true };

export class FakeCheckRunner implements CheckRunner {
  readonly kind = FAKE_RUNNER_KIND;
  readonly capabilities = FAKE_CHECK_RUNNER_CAPABILITIES;

  constructor(readonly model: FakeHostModel) {}

  protected scope(scope: HostScope): void {
    if (!HostScopeSchema.safeParse(scope).success) throw agentXError("CONFIG_INVALID", "the plug-in call has no valid scope");
  }

  /** The revision a target names. A repository nobody registered is never read. */
  protected revisionOf(target: CheckTarget): string {
    const parsed = CheckTargetSchema.parse(target);
    const repository = parsed.kind === "change-request" ? parsed.ref.repository : parsed.repository;
    if (repository.url !== this.model.url) throw agentXError("CONFIG_INVALID", "the repository is not registered with this runner");
    if (parsed.kind === "revision" || parsed.kind === "run") return parsed.revision;
    const cr = this.model.changeRequests.find((entry) => entry.id === parsed.ref.id);
    if (cr === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "the host has no such change request");
    return this.model.headRevisionOf(cr);
  }

  async listChecks(target: CheckTarget, scope: HostScope, budget?: ReadBudget): Promise<Check[]> {
    this.scope(scope);
    budget?.beforeRequest();
    const revision = this.revisionOf(target);
    const parsed = CheckTargetSchema.parse(target);
    if (parsed.kind === "run") {
      const found = this.model.findRun(parsed.run.id);
      return (found === undefined ? [] : [found.check]);
    }
    return (this.model.checksOf(revision));
  }

  async logTail(target: CheckTarget, check: Check, scope: HostScope, budget?: ReadBudget): Promise<UntrustedText | undefined> {
    this.scope(scope);
    budget?.beforeRequest();
    this.revisionOf(target);
    if (check.runId === undefined) return (undefined);
    const log = this.model.logOf(check.runId);
    return (log === undefined ? undefined : log.slice(-LOG_TAIL_MAX_CHARS));
  }

  async start(request: CheckStartRequest, scope: HostScope): Promise<{ run: CheckRunRef; check: Check }> {
    this.scope(scope);
    const parsed = CheckStartRequestSchema.parse(request);
    if (parsed.repository.url !== this.model.url) throw agentXError("CONFIG_INVALID", "the repository is not registered with this runner");
    // The idempotency key makes a retry the same run.
    const id = `run-${createHash("sha256").update(`${parsed.project}\n${parsed.gate}\n${parsed.revision}\n${parsed.idempotencyKey}`).digest("hex").slice(0, 16)}`;
    const run = { runner: FAKE_RUNNER_KIND, id };
    const existing = this.model.findRun(id);
    if (existing !== undefined) return ({ run, check: existing.check });
    const check: Check = { name: parsed.gate, state: "pending", required: false, url: `https://builds.example.test/${id}`, runId: id, source: parsed.project };
    this.model.upsertCheck(parsed.revision, check);
    return ({ run, check });
  }

  async getRun(target: Extract<CheckTarget, { kind: "run" }>, scope: HostScope): Promise<Check> {
    this.scope(scope);
    this.revisionOf(target);
    const found = this.model.findRun(target.run.id);
    if (found === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "the runner has no such run");
    return (found.check);
  }

  async rerun(target: CheckTarget, check: Check, scope: HostScope): Promise<void> {
    this.scope(scope);
    this.revisionOf(target);
    const found = check.runId === undefined ? undefined : this.model.findRun(check.runId);
    if (found === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "the runner has no such run");
    const { conclusion: _conclusion, ...rest } = found.check;
    void _conclusion;
    this.model.upsertCheck(found.revision, { ...rest, state: "pending" });
    return;
  }

  /** Test driver: the run finishes with a conclusion. */
  finish(runId: string, conclusion: CheckConclusion, log?: string): void {
    const found = this.model.findRun(runId);
    if (found === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "the runner has no such run");
    this.model.upsertCheck(found.revision, { ...found.check, state: "completed", conclusion });
    if (log !== undefined) this.model.setLog(runId, log);
  }
}
