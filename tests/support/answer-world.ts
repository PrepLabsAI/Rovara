// Test world for the answer service (lead 4, J1): two companies, two projects, a scripted model that records everything it was shown, and a code source whose files are readable only at the commit it
// was bound to (so a read at any other commit is "not there").
import { type OrgId, type WikiPageWrite, type WikiStore } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createWikiStore } from "../../packages/broker/src/core/wiki/store.js";
import { createAnswerService, type AnswerServiceDeps } from "../../packages/broker/src/core/answers/service.js";
import type { AnswerModelRefused} from "../../packages/broker/src/core/answers/ports.js";
import { type AnswerCodeSource, type AnswerModel, type AnswerModelReply, type AnswerModelSession, type AnswerModelTurn } from "../../packages/broker/src/core/answers/ports.js";

export const A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
export const B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
export const HEAD = "1".repeat(40);
export const OLD = "2".repeat(40);
export const T0 = Date.parse("2026-11-17T10:00:00.000Z");

export const REFUND_TS = [
  'import { charge } from "./pay.js";',
  "",
  "export const MAX_REFUND_DAYS = 30;",
  "export function refundLimit(order: Order): number {",
  "  return order.total * 0.5; // partial refunds up to half",
  "}",
  "export const RETRY_LIMIT = 200;",
].join("\n");

export interface CodeCalls { reads: Array<{ repo: string; path: string; commit: string; untilLine: number | undefined }>; headCalls: number }

/** A project's code: `files` by `repo/path`, readable only at `heads`. */
export function codeSource(files: Record<string, string>, heads: Record<string, string> = { web: HEAD }, calls: CodeCalls = { reads: [], headCalls: 0 }): AnswerCodeSource & { calls: CodeCalls } {
  return {
    repositories: Object.keys(heads),
    projectRepositories: Object.keys(heads),
    async heads() { calls.headCalls += 1; return new Map(Object.entries(heads)); },
    async read(repository, path, commit, options) {
      calls.reads.push({ repo: repository, path, commit, untilLine: options.untilLine });
      if (!(repository in heads) || heads[repository] !== commit) return undefined;
      return files[`${repository}/${path}`];
    },
    calls,
  };
}

export type Reply = string | { text: string; costCents?: number; tokens?: { input: number; output: number } } | Error;
export interface ScriptedModel extends AnswerModel {
  turns: AnswerModelTurn[];
  opened: Array<{ companyId: string; project: string; personId: string; answerId: string; ceilingCents: number }>;
  finished: Array<{ costCents?: number | undefined; tokens: number }>;
}

/** A model that answers from a script, one reply per turn (the last one repeats), and records every turn it was shown. */
export function scriptedModel(replies: readonly Reply[] | ((turn: AnswerModelTurn, n: number) => Reply), options: { available?: boolean; openRefusal?: AnswerModelRefused } = {}): ScriptedModel {
  const model: ScriptedModel = {
    turns: [], opened: [], finished: [],
    async available() { return options.available ?? true; },
    async open(input): Promise<AnswerModelSession> {
      if (options.openRefusal !== undefined) throw options.openRefusal;
      model.opened.push(input);
      return {
        async complete(turn): Promise<AnswerModelReply> {
          const n = model.turns.length;
          model.turns.push(turn);
          const picked = typeof replies === "function" ? replies(turn, n) : (replies[Math.min(n, replies.length - 1)] as Reply);
          if (picked instanceof Error) throw picked;
          return typeof picked === "string" ? { text: picked, model: "fake/model" } : { model: "fake/model", ...picked };
        },
        async finish(spent) { model.finished.push(spent); },
      };
    },
  };
  return model;
}

export const json = (value: unknown): string => JSON.stringify(value);
export const tool = (call: Record<string, unknown>): string => json({ action: "tool", ...call });
export const answer = (sentences: Array<{ text: string; cites: Array<Record<string, unknown>> }>, extra: Record<string, unknown> = {}): string => json({ action: "answer", sentences, ...extra });
export const refundCite = { repo: "web", path: "src/refund.ts", line: 3, quote: "export const MAX_REFUND_DAYS = 30;" };
export const goodSentence = { text: "Refunds are allowed for 30 days (`MAX_REFUND_DAYS`).", cites: [refundCite] };

export function page(tag: string, over: Partial<WikiPageWrite> = {}): WikiPageWrite {
  return {
    pageId: "billing", kind: "module", title: `Billing ${tag}`, summary: `How refunds work ${tag}`, order: 0, repos: [{ repo: "web", commit: OLD }],
    blocks: [
      { kind: "heading", blockId: "h0001", level: 2, text: `Refunds ${tag}` },
      { kind: "paragraph", blockId: "p0001", text: `Refunds run through the refund module ${tag}.`, claimIds: ["c0001"] },
    ],
    claims: [{ claimId: "c0001", text: `Refund limit lives in refund.ts ${tag}`, citations: [{ repo: "web", path: "src/refund.ts", commit: OLD, line: 3, quote: "export const MAX_REFUND_DAYS = 30;" }], source: "found", checkedAt: "2026-11-17T09:00:00.000Z" }],
    buildId: "build-0001",
    ...over,
  };
}

export interface World {
  store: MemoryDocumentStore;
  clock: { now: number };
  wiki(companyId: OrgId): WikiStore;
  /** Who may ask: `company/project/person`. */
  roles: Set<string>;
  service(input?: { companyId?: OrgId; model?: AnswerModel | undefined; code?: (project: string) => AnswerCodeSource | undefined; over?: Partial<AnswerServiceDeps> }): ReturnType<typeof createAnswerService>;
  logs: Array<Record<string, unknown>>;
}

export function world(): World {
  const store = new MemoryDocumentStore();
  const clock = { now: T0 };
  let n = 0;
  const roles = new Set<string>();
  const logs: Array<Record<string, unknown>> = [];
  const wiki = (companyId: OrgId): WikiStore => createWikiStore({ store, companyId, now: () => clock.now, newId: () => `id-${companyId.slice(-4)}-${String(++n).padStart(4, "0")}` });
  return {
    store, clock, wiki, roles, logs,
    service(input = {}) {
      const companyId = input.companyId ?? A;
      return createAnswerService({
        companyId, store, wiki: wiki(companyId), now: () => clock.now, log: (entry) => logs.push(entry),
        access: { mayAsk: async (personId, project) => roles.has(`${companyId}/${project}/${personId}`) },
        code: async (project) => (input.code === undefined ? codeSource({ "web/src/refund.ts": REFUND_TS }) : input.code(project)),
        model: "model" in input ? input.model : scriptedModel([answer([goodSentence])]),
        ...input.over,
      });
    },
  };
}

export const body = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ requestId: `req-${Math.random().toString(36).slice(2, 12)}`, question: "How long do refunds last?", ...extra });
