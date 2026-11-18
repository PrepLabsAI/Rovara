// Team knowledge read OUTSIDE Rovara, the one implementation behind BOTH doors: the laptop's lessons routes (`local/app/lessons-routes.ts`) and the hosted twin (`core-host/knowledge-api.ts`). Everything that decides what a tool is
// given and what it costs lives here, so the two can never drift apart: the per-minute rate, the token's permission and project, the project's existence, the day's limit (300 a person, fail closed, counted before anything is
// read), the body's shape (no `all`), the one gate that picks the units (`local-tools.ts`), the audit record written BEFORE the answer (no record, no answer), and the once-a-day notice above 150 distinct units.
// The caller (a route) has already proved WHO is asking (a person's sign-in, or a script token that is valid) and that the person is on the project's roster now; this module proves the rest and never reads who acts from a body.
import { createHash } from "node:crypto";
import {
  LOCAL_KNOWLEDGE_DAY_LIMIT_MESSAGE, LOCAL_KNOWLEDGE_DISTINCT_ALERT, LocalKnowledgeAreasBodySchema, LocalLessonsBodySchema, agentXError, companyScoped, type DocumentStore,
} from "@agentx/contracts";
import { takeRate } from "../core/script-tokens/rate.js";
import type { KnowledgeLimits } from "./knowledge-limits.js";
import { LOCAL_OFF_MESSAGES, LocalLessonsUnavailable, knowledgeAreasForLocalTool, lessonsForLocalTool, renderLocalLessons, type LocalLessonsDeps, type LocalOffReason, type LocalToolsCounter } from "./local-tools.js";
import { emitAudit, requireAudit } from "./policy.js";
import type { LessonsRuntime } from "./runtime.js";
import type { ScopeKey } from "./store.js";
import type { Lesson } from "./types.js";

/** Reads a minute per person, across both tools. */
export const LOCAL_LESSONS_PER_MINUTE = 60;
export const KNOWLEDGE_UNAVAILABLE = "Rovara can't read lessons right now. Try again.";
export const KNOWLEDGE_NO_SUCH_PROJECT = "No such project.";

export type KnowledgeTool = "lessons" | "areas";

/** What a tool is told when its body asks for every lesson at once (`all`): lessons are given a few at a time, for a task or a part of the code, and never in bulk (#974, owner DEC 254zzz14). */
export const LOCAL_ALL_REFUSED = "all: Rovara gives lessons a few at a time, for a task or a part of the code. It does not give them all at once.";

/** What a call needs of the lessons runtime. */
export type KnowledgeRuntime = Pick<LessonsRuntime, "store" | "settings" | "access" | "localTools" | "audit">;

export interface KnowledgeServeOptions {
  companyId: string;
  /** Where the per-minute rate rows live (the company's own store). */
  store: DocumentStore;
  now: () => number;
  runtime: KnowledgeRuntime;
  /** The day's limits and the distinct count, and the day counter of numbers: built where the store's expiry attribute may be named (`knowledgeReadStores`). */
  limits: KnowledgeLimits;
  counter: LocalToolsCounter;
  /** The display names a unit that leaves Rovara must not hold. Throws when a name cannot be read (fail closed). */
  names: (developerId: string, key: ScopeKey, found: readonly Lesson[]) => Promise<readonly string[]>;
  /** Whether the company has this project. */
  projectExists: (project: string) => Promise<boolean>;
  /** Tells the company's admins once (the call that takes a person above the line). Absent: the audit record alone says it. Never changes the answer. */
  tellAdmins?: ((notice: { noticeId: string; developerId: string; project: string }) => Promise<void>) | undefined;
  log?: ((entry: Record<string, unknown>) => void) | undefined;
}

export interface KnowledgeCall {
  project: string;
  /** The person (the token's creator for a script token): the key of every limit. */
  developerId: string;
  tool: KnowledgeTool;
  body?: string | undefined;
  /** Set when the caller holds a script token: its permissions and projects are checked here again. */
  token?: { readonly tokenId?: string | undefined; readonly permissions: readonly string[]; readonly projects: readonly string[] } | undefined;
}

/**
 * The laptop's own "off" answer (the install's lessons switch is off, or does not cover the company), in the shape of the tool asked: a client reads the same fixed words it reads from a laptop. Reads nothing, so it is also
 * what a caller is told before anyone has been looked up.
 */
export function knowledgeOffAnswer(tool: KnowledgeTool, project: string, at: number, reason: LocalOffReason = "install_switch"): object {
  const message = LOCAL_OFF_MESSAGES[reason];
  if (tool === "areas") return { status: "off", reason, message, project, repos: [], more: 0, complete: true };
  return { status: "off", reason, message, project, lessons: [], markdown: renderLocalLessons({ project, lessons: [], at, complete: true, note: message }), complete: true };
}

export interface KnowledgeServer { read(call: KnowledgeCall): Promise<object> }

export function createKnowledgeServer(options: KnowledgeServeOptions): KnowledgeServer {
  const { companyId, runtime, limits, counter, now } = options;

  async function read(call: KnowledgeCall): Promise<object> {
    const { project, developerId, tool } = call;
    let allowed: boolean;
    try { allowed = await takeRate(options.store, { pk: companyScoped(options.companyId, "LESSON_LOCAL_READS"), sk: developerId }, LOCAL_LESSONS_PER_MINUTE, 60_000, now); }
    catch { throw agentXError("RUNTIME_UNAVAILABLE", KNOWLEDGE_UNAVAILABLE); }
    if (!allowed) throw agentXError("TOO_MANY_REQUESTS", "Too many lesson requests. Try again in a minute.");
    if (call.token !== undefined && (!call.token.permissions.includes("lessons") || !call.token.projects.includes(project))) throw agentXError("NOT_FOUND", KNOWLEDGE_NO_SUCH_PROJECT);
    let exists: boolean;
    try { exists = await options.projectExists(project); } catch { throw agentXError("RUNTIME_UNAVAILABLE", KNOWLEDGE_UNAVAILABLE); }
    if (!exists) throw agentXError("NOT_FOUND", KNOWLEDGE_NO_SUCH_PROJECT);
    const via = call.token === undefined ? "person" : "token";
    const count = async (found: number, refusal?: string): Promise<void> => { try { await counter.count({ orgId: companyId, project, developerId, lessons: found, refusal }); } catch { /* bookkeeping only */ } };
    // The day's limit, counted before anything is read and fail closed: a counter that cannot be read refuses the call. Fixed words; nothing the caller sent is echoed.
    let within: boolean;
    try { within = await limits.takeCall(companyId, developerId); } catch { throw agentXError("RUNTIME_UNAVAILABLE", KNOWLEDGE_UNAVAILABLE); }
    if (!within) { await count(0, "day_limit"); throw agentXError("TOO_MANY_REQUESTS", LOCAL_KNOWLEDGE_DAY_LIMIT_MESSAGE); }
    /** One audit record per answer, written BEFORE the text is returned (no record, no answer): the tool, how it asked, how many units and their ids. Never text. */
    const audited = async (ids: readonly string[]): Promise<void> => {
      const units = ids.slice(0, 10);
      const ok = await requireAudit(runtime.audit, { action: "lesson.knowledge_read", workspaceId: companyId, project, actor: developerId, facts: { tool, via, units: units.length, ...(call.token?.tokenId === undefined ? {} : { tokenId: call.token.tokenId }), ...Object.fromEntries(units.map((id, index) => [`u${String(index + 1)}`, id])) } });
      if (!ok) { await count(0, "audit"); throw agentXError("RUNTIME_UNAVAILABLE", KNOWLEDGE_UNAVAILABLE); }
    };
    /** After the answer is allowed: the distinct units this person was served today; the call that takes it above the line tells the admins once. Never changes the answer. */
    const noteServed = async (ids: readonly string[]): Promise<void> => {
      if (ids.length === 0) return;
      try {
        const noted = await limits.noteServed({ companyId, project, developerId, unitIds: ids });
        if (!noted.crossed) return;
        await emitAudit(runtime.audit, { action: "lesson.knowledge_read_alert", workspaceId: companyId, project, actor: developerId, facts: { distinct: noted.distinct, line: LOCAL_KNOWLEDGE_DISTINCT_ALERT } });
        const noticeId = `knowledge-${new Date(now()).toISOString().slice(0, 10)}-${createHash("sha256").update(developerId).digest("hex").slice(0, 16)}`;
        await options.tellAdmins?.({ noticeId, developerId, project });
      } catch (error) { options.log?.({ component: "lessons", event: "knowledge.note_failed", error: error instanceof Error ? error.name : "unknown" }); /* the answer stands; the failure is visible */ }
    };
    const deps: LocalLessonsDeps = {
      store: runtime.store, settings: runtime.settings, access: runtime.access, localTools: runtime.localTools, now,
      names: async (key, found) => await options.names(developerId, key, found),
      log: (event, fields) => options.log?.({ component: "lessons", event, ...Object.fromEntries(Object.entries(fields).filter(([, value]) => typeof value === "number" || typeof value === "boolean")) }),
    };
    let raw: unknown;
    try { raw = call.body === undefined || call.body === "" ? {} : JSON.parse(call.body); } catch { throw agentXError("CONFIG_INVALID", "body: is not JSON"); }
    // The bulk mode is gone (#974, owner DEC 254zzz14): a lessons body that names `all` (true or false) gets one fixed sentence, never the value and never a partial answer. (The areas body is strict and has no `all`.)
    // Batch 17: the batch-16 rule, moved here with the rest of the read (#995).
    if (tool === "lessons" && typeof raw === "object" && raw !== null && !Array.isArray(raw) && Object.hasOwn(raw, "all")) throw agentXError("CONFIG_INVALID", LOCAL_ALL_REFUSED);
    const shape = tool === "areas" ? LocalKnowledgeAreasBodySchema : LocalLessonsBodySchema;
    const checked = shape.safeParse(raw);
    if (!checked.success) {
      const issue = checked.error.issues[0];
      // Field names only: the values are the caller's.
      throw agentXError("CONFIG_INVALID", `${issue === undefined || issue.path.length === 0 ? "body" : issue.path.join(".")}: ${issue === undefined || issue.code === "unrecognized_keys" ? "has a field this route does not take" : issue.message}`);
    }
    if (tool === "areas") {
      let outcome: Awaited<ReturnType<typeof knowledgeAreasForLocalTool>>;
      try { outcome = await knowledgeAreasForLocalTool(deps, { orgId: companyId, project, remote: (checked.data as { repo?: string }).repo }); } catch (error) {
        await count(0, error instanceof LocalLessonsUnavailable ? "unavailable" : "error");
        throw agentXError("RUNTIME_UNAVAILABLE", KNOWLEDGE_UNAVAILABLE);
      }
      if (outcome.kind === "unknown_repo") { await count(0, "unknown_repo"); throw agentXError("NOT_FOUND", KNOWLEDGE_NO_SUCH_PROJECT); }
      await audited([]);
      await count(0, outcome.answer.reason);
      return outcome.answer;
    }
    const parsed = { data: checked.data as ReturnType<typeof LocalLessonsBodySchema.parse> };
    let outcome: Awaited<ReturnType<typeof lessonsForLocalTool>>;
    try {
      outcome = await lessonsForLocalTool(deps, { orgId: companyId, project, remote: parsed.data.repo, task: parsed.data.task, files: parsed.data.files, stage: parsed.data.stage });
    } catch (error) {
      await count(0, error instanceof LocalLessonsUnavailable ? "unavailable" : "error");
      throw agentXError("RUNTIME_UNAVAILABLE", KNOWLEDGE_UNAVAILABLE);
    }
    if (outcome.kind === "unknown_repo") {
      await count(0, "unknown_repo");
      throw agentXError("NOT_FOUND", KNOWLEDGE_NO_SUCH_PROJECT);
    }
    const ids = outcome.answer.lessons.map((lesson) => lesson.id);
    await audited(ids);
    await count(ids.length, outcome.answer.reason);
    await noteServed(ids);
    return outcome.answer;
  }

  return { read };
}
