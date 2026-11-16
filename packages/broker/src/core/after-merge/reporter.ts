// The real reporter (M7 slice 2): one report tells three places through the ports Code already has, each independently and at most once per report:
//
//   pull_request   one comment of Rovara's own fixed text on the merged pull request (`CodeHost.postComment`), on the code host the task's own project pins for that repository, in the company's scope. (A GitHub Check would need
//                  the App's `checks: write`, which it does not have; a comment needs nothing new.) The text is one line of at most 200 characters with no control character and no `@`, as the port requires.
//   task           one line on the task's session timeline (a system `status` event), written in the same transaction as the "sent" row, so it exists exactly once.
//   chat           one `progress` line in the thread the task was started from, only when that thread's tenant is this company's and the host serves the person who started it (decision 131), under an event id made from the report
//                  id (a chat adapter drops a repeat of an event id).
//
// A surface that does not exist for this task (no pull request port on that host, no session, no thread) is skipped, not failed. A surface that fails is left unmarked and the report as a whole throws (fixed words), so the watcher
// keeps it pending and the next sweep sends again: only the surfaces that did not succeed are tried again. The report's own text is already made inert by the watcher; nothing here adds a word of anyone's.
//
// Company binding: the task must be this company's (the record names it), the host and the repository come from that task's pinned project (`AfterMergeHosts`), the pull request address must be the one the report's repository and
// number name, the session and the thread are read under the company's keys, and every row written is under `ORG#<company>#AFTER_MERGE_SENT`. A report for a task that is not this company's is dropped without telling anyone.
import { createHash, randomUUID } from "node:crypto";
import { INDEX_EXPIRY_ATTRIBUTE, OrgIdSchema, agentSessionKey, change, when, type ChannelEvent, type DocumentStore, type OrgId, type RegistryView } from "@agentx/contracts";
import { taskKey } from "../task-flow/keys.js";
import { taskSessionId } from "../sessions/create.js";
import { sessionEventItem } from "../sessions/store.js";
import { githubPullRequestAddress } from "../proof/revert/merge-commit-index.js";
import { personIsServed, tenantIsCompanys, type ChannelCompanyOf, type ChannelMemberRule } from "../channel/company.js";
import { readTaskThread } from "../channel/threads.js";
import type { AfterMergeHosts } from "./deploy-source.js";
import type { AfterMergeLog, AfterMergeReport, AfterMergeReporter } from "./ports.js";
import { SENT_ENTITY, SURFACES, WATCH_KEPT_DAYS, expiryOf, readSent, sentKey, type Surface } from "./records.js";

const LEASE_MS = 120_000;
const COMMENT_MAX = 200;
const NOT_DELIVERED = "after_merge: a surface was not told";

export interface AfterMergeReporterOptions {
  store: DocumentStore;
  hosts: AfterMergeHosts;
  /** The chat adapters (`registry.get("channel", name)`). Absent: no chat line. */
  registry?: Pick<RegistryView, "get"> | undefined;
  now: () => number;
  /** Decision 131: which company a chat tenant belongs to; a thread in another company's tenant is never sent to. Absent: one company, whose every tenant is. */
  companyOf?: ChannelCompanyOf | undefined;
  /** Decision 131: whether the host serves the person who started the task now. Absent: every linked person is served. */
  isMember?: ChannelMemberRule | undefined;
  /** The task's page, when the host has an https address for it. Absent: the line says nothing of where to open it. */
  taskUrl?: ((taskId: string) => string | undefined) | undefined;
  /** Turns a surface off (default on). Read at each use. */
  surfaces?: Partial<Record<Surface, boolean>> | (() => Partial<Record<Surface, boolean>>) | undefined;
  log?: AfterMergeLog | undefined;
}

const sha = (...parts: string[]): string => createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");

/** The pull request comment: Rovara's fixed prefix and the report's inert words, with no control character and no `@` (the port refuses both), cut to the port's 200 characters. */
export function pullRequestLineOf(text: string): string {
  const plain = `Rovara: ${text}`.replace(/[\p{Cc}@]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (plain.length <= COMMENT_MAX) return plain;
  const points = Array.from(plain);
  while (points.join("").length > COMMENT_MAX - 1) points.pop();
  return `${points.join("")}…`;
}

/** An address the chat may show: a plain https pull request address with no sign-in data. */
function plainHttpsLink(link: string): string | undefined {
  try {
    const url = new URL(link);
    return url.protocol === "https:" && url.username === "" && url.password === "" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

type Told = "sent" | "skipped";

export function createAfterMergeReporter(options: AfterMergeReporterOptions): AfterMergeReporter {
  const { store } = options;
  const log: AfterMergeLog = options.log ?? (() => undefined);
  const surfacesOn = (): Partial<Record<Surface, boolean>> => (typeof options.surfaces === "function" ? options.surfaces() : options.surfaces ?? {});

  /** Claims one surface of one report: "claimed" (go, with the claim's own id), "done" (already told), "busy" (another pass is telling it now). */
  async function claim(orgId: OrgId, reportId: string, surface: Surface): Promise<{ kind: "claimed"; claimId: string } | { kind: "done" } | { kind: "busy" }> {
    const key = sentKey(orgId, reportId, surface);
    const nowMs = options.now();
    const claimId = randomUUID();
    const written = await store.put({
      item: { ...key, entityType: SENT_ENTITY, orgId, reportId, surface, state: "sending", claimId, leaseUntil: nowMs + LEASE_MS, [INDEX_EXPIRY_ATTRIBUTE]: expiryOf(nowMs, WATCH_KEPT_DAYS) },
      condition: when.or(when.absent(), when.and(when.eq("state", "sending"), when.lt("leaseUntil", nowMs))),
    });
    if (written.applied) return { kind: "claimed", claimId };
    return readSent(await store.get(key), orgId)?.state === "sending" ? { kind: "busy" } : { kind: "done" };
  }

  async function tell(orgId: OrgId, reportId: string, surface: Surface, deliver: () => Promise<Told>): Promise<"told" | "busy" | "failed"> {
    const claimed = await claim(orgId, reportId, surface);
    if (claimed.kind === "done") return "told";
    if (claimed.kind === "busy") return "busy";
    const key = sentKey(orgId, reportId, surface);
    // Only this pass's own claim is ever deleted or marked done: a pass that ran past its lease never touches the claim another pass took over.
    const mine = when.and(when.eq("state", "sending"), when.eq("claimId", claimed.claimId));
    try {
      await deliver();
    } catch (error) {
      // Fixed words and the error's class only: its message may carry the host's or the chat's own text.
      log("after_merge.surface_failed", { level: "warn", surface, error: error instanceof Error ? error.name : "unknown" });
      await store.delete({ key, condition: mine }).catch(() => undefined);
      return "failed";
    }
    let marked: boolean;
    try {
      marked = (await store.update({ key, ops: [change.set("state", "done"), change.remove(["leaseUntil"])], condition: mine })).applied;
    } catch {
      marked = false;
    }
    // The surface was told but not marked (or the claim was taken over meanwhile): the claim runs out and it is told once more. Said in fixed words, so the repeat is not a mystery.
    if (!marked) log("after_merge.sent_mark_failed", { level: "warn", surface });
    return "told";
  }

  return {
    async report(orgId: OrgId, report: AfterMergeReport): Promise<void> {
      if (!OrgIdSchema.safeParse(orgId).success || !/^[0-9a-f]{64}$/u.test(report.reportId)) return;
      const record = await store.get(taskKey(report.taskId));
      // A task that is not this company's (or is gone) is told to nobody: the report is dropped, never sent through another company's host or thread.
      if (record === undefined || (record["companyId"] ?? record["orgId"]) !== orgId || record["taskId"] !== report.taskId) { log("after_merge.report_task_gone", { level: "warn" }); return; }
      const sessionId = typeof record["sessionId"] === "string" ? record["sessionId"] : taskSessionId(report.taskId);
      const on = surfacesOn();
      const results: Array<"told" | "busy" | "failed"> = [];

      if (on.pull_request !== false) {
        results.push(await tell(orgId, report.reportId, "pull_request", async (): Promise<Told> => {
          const address = githubPullRequestAddress(report.url);
          // The comment goes on the pull request the report is about, and no other: the address, the repository and the number must agree.
          if (address === undefined || address.repositoryFullName.toLowerCase() !== report.repository || address.number !== report.number) { log("after_merge.pull_request_mismatch", { level: "warn" }); return "skipped"; }
          const host = await options.hosts.forTask(orgId, report.taskId, report.repository);
          if (host === undefined || typeof host.codeHost.postComment !== "function") return "skipped";
          await host.codeHost.postComment({ repository: host.repository, id: String(report.number), url: report.url }, pullRequestLineOf(report.text), host.scope);
          return "sent";
        }));
      }

      if (on.task !== false) {
        results.push(await tellTask(orgId, report, sessionId));
      }

      if (on.chat !== false && options.registry !== undefined) {
        const registry = options.registry;
        results.push(await tell(orgId, report.reportId, "chat", async (): Promise<Told> => {
          const thread = await readTaskThread(store, orgId, sessionId);
          if (thread === undefined) return "skipped";
          const { conversation } = thread;
          if (!(await tenantIsCompanys(options.companyOf, orgId, conversation.channel, conversation.tenant))) { log("after_merge.chat_other_company", { level: "warn" }); return "skipped"; }
          if (options.isMember !== undefined && (thread.actor === undefined || !(await personIsServed(options.isMember, orgId, thread.personId, thread.actor)))) { log("after_merge.chat_not_member", { level: "warn" }); return "skipped"; }
          const adapter = registry.get("channel", conversation.channel);
          if (adapter === undefined) return "skipped";
          const where = options.taskUrl?.(report.taskId);
          const link = plainHttpsLink(report.url);
          const text = `${report.text}${link === undefined ? "" : `\n${link}`}${where === undefined ? "" : `\nTask: ${where}`}`;
          const event: ChannelEvent = {
            version: 1, id: `evt_${sha("after-merge-report", orgId, report.reportId).slice(0, 32)}`, channel: conversation.channel, conversation, createdAt: new Date(options.now()).toISOString(), type: "progress", data: { text },
          };
          await adapter.deliver(event);
          return "sent";
        }));
      }

      if (results.some((result) => result !== "told")) throw new Error(NOT_DELIVERED);
    },
  };

  /** The session's timeline line, written with the "sent" row in one transaction: it exists exactly once, and only when the company's session exists. */
  async function tellTask(orgId: OrgId, report: AfterMergeReport, sessionId: string): Promise<"told" | "busy" | "failed"> {
    const key = sentKey(orgId, report.reportId, "task");
    try {
      const done = readSent(await store.get(key), orgId);
      if (done?.state === "done") return "told";
      const session = await store.get(agentSessionKey(orgId, sessionId, "META"));
      if (session === undefined || session["orgId"] !== orgId) return "told";
      const nowMs = options.now();
      const result = await store.transact([
        sessionEventItem({ orgId, sessionId: sessionId }, { eventId: `evt_${sha("after-merge-report", orgId, report.reportId).slice(0, 24)}`, at: new Date(nowMs).toISOString(), type: "status", actor: { kind: "system" }, text: report.text }),
        { kind: "put", item: { ...key, entityType: SENT_ENTITY, orgId, reportId: report.reportId, surface: "task", state: "done", [INDEX_EXPIRY_ATTRIBUTE]: expiryOf(nowMs, WATCH_KEPT_DAYS) }, condition: when.absent() },
      ]);
      void result;
      return "told";
    } catch (error) {
      log("after_merge.surface_failed", { level: "warn", surface: "task", error: error instanceof Error ? error.name : "unknown" });
      return "failed";
    }
  }
}

export const REPORT_SURFACES = SURFACES;
