import { AsyncLocalStorage } from "node:async_hooks";
// Deployed job composition. No provider or policy store lives here.
import { OrgIdSchema, POLICY_ORIGINS, policyDataObject, createDefaultPolicySource, DEFAULT_CODE_SETTINGS, type OrgId, type AdapterRegistry, type PolicySource, type DocumentStore, type StoredDocument } from "@agentx/contracts";
import { CI_MODE_UNREADABLE_WORDS, checkedCiReporting, type CiReporting } from "../core-host/switch-blockers.js";

import type { CoreService } from "../core-host/core-runtime.js";
import type { TaskFlow } from "../core/task-flow/flow.js";
import { createStoreProjectSource } from "../core/task-flow/project-source.js";
import { createTaskFactsSource } from "../local/app/facts.js";
import { createCostLedger, costUsdOf } from "../core/cost/ledger.js";
import { createSessionService } from "../services/sessions.js";
import { createNoticeService, type NoticeServiceOptions } from "../services/notices.js";
import { taskPeopleRecipients } from "./task-people-recipients.js";
import { createMergeTrackingService, createMilestoneService } from "../services/merge-tracking.js";
import { rovaraCheckSource } from "../services/rovara-check.js";
import { createIdentityMergePeople, type MergePeople } from "../core/merge/people.js";
import { fixedCodeSettings } from "../core/merge/defaults.js";
import type { CodeSettingsReader, HumanEditSink } from "../core/merge/seams.js";
import type { SummaryCheckSource } from "../core/merge/summary-check.js";
import type { RepositoryResolver } from "../core/merge/host-port.js";
import type { SessionChangeHook, SummaryDependencies } from "../core/sessions/summary.js";
import { threadFollows } from "../core/channel/thread-notices.js";
import { ticketMomentsOnChange } from "../core/ticket-updates/moments.js";
import type { AttentionDeliveryDependencies } from "../core/notify/attention.js";
import { boundedCorePass } from "./core-job-pass.js";
import { evalCheckEvidencePort } from "../core/ci-evidence/eval-check-setting.js";
import { createTaskRepositoryEdgesSeam } from "../core/merge/repository-edges.js";
import { hostedEvidenceBlobs } from "../core-host/hosted-evidence.js";

// One invocation shares recovery pages and ownership reads across all company passes. No cache survives a scheduled run.
const recoveryPass = new AsyncLocalStorage<{
  pages: Map<string, Promise<Awaited<ReturnType<DocumentStore["query"]>>>>;
  owners: Map<string, Promise<string | undefined>>;
}>();
export function withSharedMergeRecovery<T>(work: () => Promise<T>): Promise<T> {
  return recoveryPass.run({ pages: new Map(), owners: new Map() }, work);
}
function recoveryStore(store: DocumentStore, companyId: string): DocumentStore {
  return new Proxy(store, { get(target, property) {
    if (property === "query") return async (query: Parameters<DocumentStore["query"]>[0]) => {
      const pass = recoveryPass.getStore();
      if (pass === undefined || query.pk !== "WORKFLOW_MERGE_RECOVERY") return await target.query(query);
      const key = JSON.stringify(query);
      let pending = pass.pages.get(key);
      if (pending === undefined) { pending = target.query(query); pass.pages.set(key, pending); }
      const page = await pending;
      const items: StoredDocument[] = [];
      for (const row of page.items) {
        if (typeof row["taskId"] !== "string") continue;
        let owner = pass.owners.get(row["taskId"]);
        if (owner === undefined) {
          owner = target.get({ pk: `DEVTASK#${row["taskId"]}`, sk: "META" }).then((task) => typeof task?.["companyId"] === "string" ? task["companyId"] : undefined);
          pass.owners.set(row["taskId"], owner);
        }
        if (await owner === companyId) items.push(row);
      }
      return { ...page, items };
    };
    const value = Reflect.get(target, property, target) as unknown;
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) as unknown : value;
  } });
}

/** PolicySource scopes are adapter-issued, unambiguous company/project pairs. No cache: policy is read live. */
export function policyCiReporting(source: PolicySource = createDefaultPolicySource()): CiReporting {
  return {
    honest: true,
    async ciMode(task) {
      try {
        if (!OrgIdSchema.safeParse(task?.orgId).success || typeof task.project !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(task.project)) throw new Error();
        const result = await source.resolve({ key: `company/${task.orgId}/project/${task.project}` }, {});
        if (!policyDataObject(result) || result.status !== "resolved" || !policyDataObject(result.values) || !policyDataObject(result.values["real_check"])) throw new Error();
        const value = result.values["real_check"];
        if (!POLICY_ORIGINS.some((origin) => origin === value["origin"])) throw new Error();
        if (!Array.isArray(result.issues) || result.issues.length > 10 || !result.issues.every((issue) => ["invalid_input", "invalid_pattern", "not_measured", "not_ceilinged", "not_raisable", "not_upward", "no_ceiling", "conflicting_bounds", "work_limit"].includes(issue))) throw new Error();
        const mode = value["value"];
        if (mode !== "sandbox_only" && mode !== "their_ci_watch" && mode !== "their_ci_fix" && mode !== "rovara_real_run") throw new Error();
        return mode;
      } catch { throw new Error(CI_MODE_UNREADABLE_WORDS); }
    },
  };
}

export interface BrokerCoreServicesOptions {
  companyId: OrgId;
  flow: TaskFlow;
  registry: AdapterRegistry;
  ciMode: NonNullable<CiReporting["ciMode"]>;
  repository?: RepositoryResolver;
  people?: MergePeople;
  settings?: CodeSettingsReader;
  /** The "Rovara" Check's source (its gate, facts and address). Absent: no Check. The merge tracking service adds the verdict that the description's words come from. */
  summaryCheck?: SummaryCheckSource;
  /** L4-LM1c: the company's lessons' notice of a person's push to a Rovara pull request (the core engine gives it with the company's own lessons). Absent: nothing is told. */
  humanEdit?: HumanEditSink | undefined;
  summary?: Pick<SummaryDependencies, "facts" | "cost">;
  /** `adminNotice` (L4-AK1H): whether a person may be told an admin notice now (an owner or admin of the company, read at delivery). Absent: no one is, and a queued admin notice is dropped (fail closed). */
  notification?: Pick<AttentionDeliveryDependencies, "companyOf" | "access" | "address" | "link" | "thread" | "emailLinks" | "upkeep" | "adminNotice" | "planCarded" | "setupPausedTold" | "doneToldInThread"> & Pick<NoticeServiceOptions, "remember"> & { registry?: AttentionDeliveryDependencies["registry"] | undefined };
  /** HW5: write the chat thread's moments (the plan waits for review, the task was closed) when a session that follows a thread changes, on the company's milestones. Needs `flow.deps.milestones` (lessons built); else none. */
  threadMoments?: boolean;
  now?: () => Date;
  log?: (entry: Record<string, unknown>) => void;
}

type JobServices = Record<"merge-tracking" | "session-sweep" | "notify-deliver", CoreService>;

/**
 * L4-RC: the deployed broker's job services, with the "Rovara" Check on for every company's tasks (owner decision 2026-11-17). The Check's "Details" has no link here: Code has no address for a core task's page (a core task's
 * pull request description carries none either), and the old `/review/<task>/task` page is for the first workflow's tasks only. The company's own code host writes it (aws/core-code-host.ts keeps the company rules).
 */
export function createHostedBrokerCoreServices(options: Omit<BrokerCoreServicesOptions, "summaryCheck">): JobServices {
  return createBrokerCoreServices({ ...options, summaryCheck: rovaraCheckSource() });
}

/** Built once for one company's runtime. Each pass binds all internal store work to ONE allowance. */
export function createBrokerCoreServices(options: BrokerCoreServicesOptions): JobServices {
  const { companyId, flow, registry } = options;
  if (!OrgIdSchema.safeParse(companyId).success || flow.deps.companyId !== companyId) throw new Error("the core job company does not match its flow");
  const ci = checkedCiReporting({ honest: true, ciMode: options.ciMode });
  if (ci === undefined) throw new Error("the core jobs need a CI mode reader");
  const clock = options.now ?? (() => new Date());
  const now = () => clock().getTime();
  // Existing helpers may log error class names supplied by adapters. Deployed job evidence uses fixed words only.
  const log = () => options.log?.({ event: "core_job.notice", companyId });
  const people = options.people ?? createIdentityMergePeople(registry.require("identity"), { hostProvider: "github" });
  const settings = options.settings ?? fixedCodeSettings(DEFAULT_CODE_SETTINGS);
  const pass = (work: Parameters<typeof boundedCorePass>[2]) => boundedCorePass(flow.deps.store, now, work);
  const depsFor = (store: TaskFlow["deps"]["store"]): TaskFlow["deps"] => ({ ...flow.deps, store, projects: createStoreProjectSource(store, companyId) });
  const sessionScan = { cursor: undefined as string | undefined };
  const notifyScan = { cursor: undefined as string | undefined };
  const mergeScan = { cursor: undefined as string | undefined, complete: false };
  // L4-HW7: the merge's milestones (`merged`, `stuck`, the order warning) are the COMPANY's own milestone service, the one that has the handlers registered on it (the chat thread, the ticket write-back, the lessons
  // and team-record capture, as on the laptop's one `milestones`), so each is told once and a handler that failed is told again by the lessons pass's `deliverDue`. Read at pass time: the company's lessons attach it to the
  // flow before the first pass. A company whose lessons are not built has no milestone handler anywhere (nothing could be registered), so the rows and session lines are written as before and there is nobody to tell.
  const mergeMilestones = (store: TaskFlow["deps"]["store"]): NonNullable<TaskFlow["deps"]["milestones"]> => flow.deps.milestones ?? createMilestoneService({ store, now });
  const noticesFor = (store: TaskFlow["deps"]["store"]) => createNoticeService({ store, now: clock, log, inbox: true, peopleOf: taskPeopleRecipients(store), ...options.notification, registry: options.notification?.registry ?? registry });
  return {
    "session-sweep": pass(async (store, deadlineMs) => {
      const deps = depsFor(store);
      const ledger = options.summary === undefined ? createCostLedger({ store, metering: registry.require("metering"), now: clock }) : undefined;
      const summary = options.summary ?? { facts: createTaskFactsSource(deps), cost: { async costUsd(_orgId: string, taskId: string) {
        const value = costUsdOf(await ledger!.taskCost(companyId, taskId));
        if (value === undefined) throw new Error("the session cost is unavailable");
        return value;
      } } };
      // HW5: a session that follows a chat thread gets its `plan_ready` and `closed` moments (the thread's plan card and end line). Written in THIS pass's store; the items and the delivery are the company's milestones (handlers
      // registered). A company with no milestones (no lessons) writes none. A ticket's own moments are not written here (`ticketBindings: false`): only a thread's.
      const moments: readonly SessionChangeHook[] = options.threadMoments === true && deps.milestones !== undefined
        ? [ticketMomentsOnChange({ store, milestones: deps.milestones, now, follows: threadFollows({ store }), ticketBindings: false, companyId, log: () => log() })] : [];
      const sessions = createSessionService({ store, ...summary, notices: noticesFor(store), onChange: moments, now: clock, log });
      return { ...await sessions.sweep({ companyId, scan: sessionScan, maxItems: 100, budgetMs: Math.max(0, deadlineMs - now()) }) };
    }),
    "notify-deliver": pass(async (store, deadlineMs) => {
      const notices = noticesFor(store);
      // A deployed chat needs its tenant/company mapping. Do not consume the queue using the laptop's one-company default.
      if ((options.notification?.registry ?? registry).names("channel").length > 0 && options.notification?.companyOf === undefined) throw new Error("the notification company mapping is unavailable");
      const report = await notices.deliver({ deadlineMs, companyId, scan: notifyScan, maxItems: 100 });
      return report === undefined ? { skipped: "no_notification_transport" } : { ...report };
    }),
    "merge-tracking": pass(async (store, deadlineMs) => {
      let failed = 0;
      const trackingLog = (entry: Record<string, unknown>) => {
        if (entry["event"] === "sweep.read_failed" || entry["event"] === "sweep.row_failed") failed += 1;
        log();
      };
      const tracking = createMergeTrackingService({ flow: depsFor(recoveryStore(store, companyId)), registry, companyId, scan: mergeScan, people, settings, milestones: mergeMilestones(store), now, log: trackingLog,
        ciMode: ci.ciMode,
        // L4-EVCI2: the customer's confirmed eval check, kept per company and project (core/ci-evidence/eval-check-setting.ts); nothing confirmed: a pass is what it was.
        ciEvidence: evalCheckEvidencePort({ store, companyId }),
        repositoryEdges: createTaskRepositoryEdgesSeam({ flow: depsFor(recoveryStore(store, companyId)), blobs: hostedEvidenceBlobs({ blobs: registry.require("object-storage"), store, companyId }), companyId }),
        ...(options.repository === undefined ? {} : { repository: options.repository }), ...(options.summaryCheck === undefined ? {} : { summaryCheck: options.summaryCheck }), ...(options.humanEdit === undefined ? {} : { humanEdit: options.humanEdit }),
      });
      const report = await tracking.sweep({ budgetMs: Math.max(0, deadlineMs - now()) });
      const tierChecked = now() < deadlineMs ? await tracking.tierChecks() : 0;
      return { ...report, tierChecked, complete: mergeScan.complete && failed === 0, failed };
    }),
  };
}
