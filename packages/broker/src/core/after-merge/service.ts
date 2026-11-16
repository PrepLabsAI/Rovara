// The after-merge watcher as one service for ONE company (M7 slice 2): the ingress calls a host makes when something arrives, and the periodic pass.
//
//   codeHostEvent(event)   a neutral code host event, after the adapter verified its delivery (`events.normalise`). Only `deployment.status` means anything here; every other event is ignored.
//   triggerEvent(event)    an alarm: a trigger event the engine already defines (cloudwatch, datadog, sentry, grafana, pagerduty, vercel deployment error).
//   pass({ budgetMs })     the periodic pass (a core job, or a laptop's timer): the sweep (close windows that ended, send again what could not be sent) and, when the host supplies recent merges, the deploy read
//                          that backs up a deployment event that never came.
//
// ONE company per service: the company is fixed when the service is made, so an event cannot name another. A host that serves several companies (Cloud's ingress) makes one service per company and picks it by the
// installation or the alarm source's own company mapping, never by anything in the event. Every entry point is OFF unless the project's `afterMergeWatch` setting says on (the watcher checks that itself), and a store or
// host fault never throws out of an entry point: it answers `unavailable` with fixed words and the next delivery or pass tries again.
import { CodeHostEventSchema, OrgIdSchema, type OrgId } from "@agentx/contracts";
import { RECONCILE_MS_MAX, deployFactOfEvent, reconcileDeployments, type AfterMergeHosts, type DeploymentTarget, type ReconcileLimits, type ReconcileOutcome } from "./deploy-source.js";
import { closeDueWatches, observeDeployment, observeSignal, type DeploymentOutcome, type SignalOutcome, type SweepOutcome } from "./watch.js";
import type { AfterMergeDeps } from "./ports.js";

export type CodeHostEventOutcome = DeploymentOutcome | { kind: "ignored"; reason: "not_a_deployment" | "invalid_event" };

export interface AfterMergeServiceOptions {
  companyId: OrgId;
  deps: AfterMergeDeps;
  /** The code hosts of this company's tasks, for the deploy read. Absent: no read (events only). */
  hosts?: AfterMergeHosts | undefined;
  /** The merges to ask the host about this pass (repository and merge commit), newest first: a host that can name its recent merges supplies them. Absent or empty: no read. */
  recentMerges?: (() => Promise<readonly DeploymentTarget[]>) | undefined;
  limits?: ReconcileLimits | undefined;
}

export interface AfterMergeService {
  readonly companyId: OrgId;
  codeHostEvent(event: unknown): Promise<CodeHostEventOutcome>;
  triggerEvent(event: unknown): Promise<SignalOutcome>;
  /** One periodic pass: a small report of counts for the log (fixed words and numbers only). */
  pass(options: { budgetMs: number }): Promise<Record<string, unknown>>;
}

/** The most sweep rounds one pass runs (each round handles one batch); a pass with more waiting leaves the rest to the next. */
const SWEEP_ROUNDS_MAX = 5;

export function createAfterMergeService(options: AfterMergeServiceOptions): AfterMergeService {
  const { companyId, deps } = options;
  // Checked when the service is made, not at the first event: a bad company is a wiring bug.
  if (!OrgIdSchema.safeParse(companyId).success) throw new Error("the after-merge service needs a company id");
  /** When the host last said slow down, until (milliseconds since the epoch). */
  let pausedUntil = 0;
  return {
    companyId,
    async codeHostEvent(event: unknown): Promise<CodeHostEventOutcome> {
      const parsed = CodeHostEventSchema.safeParse(event);
      if (!parsed.success) return { kind: "ignored", reason: "invalid_event" };
      if (parsed.data.type !== "deployment.status") return { kind: "ignored", reason: "not_a_deployment" };
      const fact = deployFactOfEvent(parsed.data);
      // A repository that is not a GitHub address cannot be matched to a merge Rovara made.
      if (fact === undefined) return { kind: "ignored", reason: "invalid_fact" };
      return observeDeployment(deps, companyId, fact);
    },
    triggerEvent(event: unknown): Promise<SignalOutcome> {
      return observeSignal(deps, companyId, event);
    },
    async pass(passOptions: { budgetMs: number }): Promise<Record<string, unknown>> {
      const deadline = deps.now().getTime() + Math.max(0, passOptions.budgetMs);
      const total: SweepOutcome = { closed: 0, delivered: 0, more: false };
      let rounds = 0;
      for (; rounds < SWEEP_ROUNDS_MAX && deps.now().getTime() < deadline; rounds += 1) {
        const swept = await closeDueWatches(deps, companyId);
        total.closed += swept.closed;
        total.delivered += swept.delivered;
        total.more = swept.more;
        if (!swept.more) break;
      }
      const report: Record<string, unknown> = { closed: total.closed, delivered: total.delivered, more: total.more };
      if (options.hosts !== undefined && options.recentMerges !== undefined && deps.now().getTime() < deadline) {
        let targets: readonly DeploymentTarget[] = [];
        try {
          targets = await options.recentMerges();
        } catch {
          deps.log?.("after_merge.recent_merges_failed", { level: "warn" });
        }
        // The deploy read stays inside the pass's own time, and a host that said slow down is left alone until its time (at most an hour, at least a minute).
        const nowMs = deps.now().getTime();
        const outcomes: ReconcileOutcome[] = targets.length === 0 || nowMs < pausedUntil ? [] : await reconcileDeployments(deps, companyId, options.hosts, targets, { ...options.limits, ms: Math.min(options.limits?.ms ?? RECONCILE_MS_MAX, Math.max(0, deadline - nowMs)) });
        for (const outcome of outcomes) if (outcome.kind === "rate_limited") pausedUntil = Math.min(Math.max(outcome.retryAt, nowMs + 60_000), nowMs + 3_600_000);
        report["rateLimited"] = outcomes.some((outcome) => outcome.kind === "rate_limited");
        report["read"] = outcomes.filter((outcome) => outcome.kind === "read").length;
        report["readSkipped"] = outcomes.filter((outcome) => outcome.kind === "skipped").length;
        report["readUnavailable"] = outcomes.filter((outcome) => outcome.kind === "unavailable").length;
      }
      return report;
    },
  };
}
