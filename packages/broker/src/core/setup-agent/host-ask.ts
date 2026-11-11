// Setup host asks: the setup run hit a website its machine cannot reach, and the owner decides once, per project and host, whether the project may reach it.
//
// What this module owns:
//   - one ask per host per project: a second request for the same host JOINS the open ask (it only counts), and a refused host stays refused for a week. The ask says WHO asked, and that is the person the BROKER
//     recorded as the run's starter: `requestHostAsk` reads the run's own task record and takes nothing about a person from its caller (the worker's request only names the task it authenticated as);
//   - hosts refused WITHOUT a card (`host-refusal.ts`), counted per run and kind;
//   - the decision subject the approval gate decides: approving or refusing an ask is the owner's act, proved by the local page's session through the Approvers seam, bound to the ask as the owner saw it.
//
// An approved ask is a record, nothing more: it adds no authority of its own and changes no project. `approvedHostsOf` lists them, and the install's machines read that list when they start (the local worker's
// website list); an approval never reaches a machine that is already running.
//
// Stored like Cloud's (all in the project's own partition unless said): `SETUP_HOST_ASK#<host>` the ask; `SETUP_HOST_OPEN_COUNT` the number of open asks (the cap); `SETUP_HOST_REFUSED#<task>#<kind>` the per-run
// count of hosts refused without a card; and, in `SETUP_HOST_OPEN#<company>`, one index row per open ask so the cards of a whole company are one read.
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  INDEX_EXPIRY_ATTRIBUTE, SetupHostSchema, agentXError, change, orgScoped, projectPk, queryAll, when,
  type DocumentStore, type JsonValue, type OrgId, type Principal, type StoredDocument, type TestEnvProdDeny, type TransactItem,
} from "@agentx/contracts";
import { developerIdOf } from "../sessions/create.js";
import { taskKey } from "../task-flow/keys.js";
import { SubjectRefusal, type AppliedDecision, type DecisionAttempt, type DecisionSubject, type LoadedSubject } from "../decisions/approval-gate.js";
import { HOST_ASK_SK_PREFIX, SETUP_KEEP_SECONDS, hostAskKey, hostRefusedCountKey } from "./keys.js";
import { SETUP_HOST_REFUSALS, hostAlreadyAllowed, refuseSetupHost, type SetupHostRefusal } from "./host-refusal.js";

export { SETUP_HOST_CARD_MAX, SETUP_HOST_REFUSALS, hostAlreadyAllowed, isInternationalName, refuseSetupHost, type SetupHostRefusal } from "./host-refusal.js";

type Table = { store: DocumentStore; now: () => number };

/** How long a refused ask is remembered, so the same host does not come back as a new card every run. */
export const SETUP_HOST_REFUSED_MS = 7 * 86_400_000;
/** Open asks one project may hold at once, enforced by a counter row with a conditional write. */
export const SETUP_HOST_OPEN_MAX = 20;
/** The most a join counts: the counter is bounded by a conditional write, not by trust. */
export const SETUP_HOST_JOIN_MAX = 1_000;
/** The most index rows one company listing reads. */
export const SETUP_HOST_INDEX_MAX = 500;

/** The words a refusal is shown with (never a repository's or a model's words). */
export const SETUP_HOST_REFUSAL_WORDS: Record<SetupHostRefusal, string> = {
  not_a_host: "Not a plain website name.",
  address_literal: "An address, not a website name.",
  ip_in_name: "A name that stands for an address.",
  private_name: "A name that only means something inside one network.",
  too_long: "The name is too long to show whole.",
  paste_site: "A paste or file-drop website.",
  link_shortener: "A link-shortener website.",
  tunnel: "A tunnel to a machine outside the company.",
  webhook_sink: "A website that collects whatever is sent to it.",
  raw_storage: "Storage or hosting that anyone can upload to.",
  production: "On the production deny list.",
};

export const SETUP_HOST_ASK_STATES = ["open", "approved", "refused"] as const;
const AskRowSchema = z.object({
  entityType: z.literal("SETUP_HOST_ASK"), orgId: z.string(), project: z.string(), host: SetupHostSchema,
  state: z.enum(SETUP_HOST_ASK_STATES), requestedBy: z.string().regex(/^[a-f0-9]{64}$/u), taskId: z.string().uuid(),
  journalN: z.number().int().min(1).max(400).optional(),
  from: z.object({ path: z.string().min(1).max(500), line: z.number().int().min(1).max(10_000_000) }).strict().optional(),
  askedAt: z.string().datetime(), joined: z.number().int().min(0).max(1_000_000),
  /** The person who typed the command (in a setup run's "Run a command" box) whose blocked website led to this ask. Set by the broker from its own record of that command, never from the worker. */
  typedBy: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  decidedAt: z.string().datetime().optional(), decidedBy: z.string().optional(), refusalWords: z.string().max(200).optional(), resultRevision: z.number().int().positive().optional(),
  expiresAt: z.string().datetime().optional(),
}).passthrough();
export type SetupHostAsk = z.infer<typeof AskRowSchema>;

const countKey = (orgId: OrgId, project: string) => ({ pk: projectPk(orgId, project), sk: "SETUP_HOST_OPEN_COUNT" });
const indexPartition = (orgId: OrgId): string => orgScoped(orgId, "SETUP_HOST_OPEN");
const indexKey = (orgId: OrgId, project: string, host: string) => ({ pk: indexPartition(orgId), sk: `${project}#${host}` });
const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", "The website ask could not be read.");
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

/** The id an ask has in the audit and on its card: a hash of the company, project and host (no dot, no repository text). */
export const hostAskSubjectId = (orgId: string, project: string, host: string): string => createHash("sha256").update(`${orgId}\n${project}\n${host}`).digest("hex").slice(0, 32);

async function readAsk(table: Table, orgId: OrgId, project: string, host: string): Promise<SetupHostAsk | undefined> {
  const raw = await table.store.get(hostAskKey(orgId, project, host));
  if (raw === undefined) return undefined;
  const parsed = AskRowSchema.safeParse(raw);
  if (!parsed.success || parsed.data.orgId !== orgId || parsed.data.project !== project || parsed.data.host !== host) throw unavailable();
  return parsed.data;
}

/** A row whose store lifetime has passed (the store removes it some time later): it is no longer an ask, whatever its state says. */
const rowExpired = (row: Record<string, unknown>, nowMs: number): boolean => typeof row[INDEX_EXPIRY_ATTRIBUTE] === "number" && row[INDEX_EXPIRY_ATTRIBUTE] <= nowMs / 1000;
const refusedAndExpired = (ask: SetupHostAsk, nowMs: number): boolean => ask.state === "refused" && ask.expiresAt !== undefined && Date.parse(ask.expiresAt) <= nowMs;

/** The asks of one project, newest first (a damaged row is skipped, never guessed at). */
export async function listHostAsks(table: Table, orgId: OrgId, project: string, states: readonly SetupHostAsk["state"][] = ["open"]): Promise<SetupHostAsk[]> {
  const rows = await queryAll(table.store, { pk: projectPk(orgId, project), sk: { op: "beginsWith", prefix: HOST_ASK_SK_PREFIX } });
  const out: SetupHostAsk[] = [];
  for (const raw of rows) {
    const parsed = AskRowSchema.safeParse(raw);
    if (parsed.success && parsed.data.orgId === orgId && parsed.data.project === project && states.includes(parsed.data.state) && !refusedAndExpired(parsed.data, table.now()) && !rowExpired(raw, table.now())) out.push(parsed.data);
  }
  return out.sort((a, b) => b.askedAt.localeCompare(a.askedAt));
}

/** The hosts the owner approved for a project, for the install's machines to read when they start. An approval is a record: it reaches no machine that is already running. */
export async function approvedHostsOf(table: Table, orgId: OrgId, project: string): Promise<string[]> {
  return (await listHostAsks(table, orgId, project, ["approved"])).map((ask) => ask.host).sort();
}

/** How many hosts a run was refused without a card, by kind (a fixed vocabulary: the run's summary shows counts, never names). */
export async function refusedCountsOf(table: Table, orgId: OrgId, project: string, taskId: string): Promise<Partial<Record<SetupHostRefusal, number>>> {
  const out: Partial<Record<SetupHostRefusal, number>> = {};
  const counts = await Promise.all(SETUP_HOST_REFUSALS.map(async (kind) => {
    const item = await table.store.get(hostRefusedCountKey(orgId, project, taskId, kind));
    return [kind, typeof item?.["count"] === "number" ? item["count"] : 0] as const;
  }));
  for (const [kind, count] of counts) if (count > 0) out[kind] = count;
  return out;
}

/**
 * The person the BROKER recorded as the run's starter, from the run's own task record: the setup-run task of this company and project, started by its creator. Undefined for any task that is not such a run. This is
 * the only source of an ask's requester: no worker, payload or request names a person.
 */
export async function setupRunStarterOf(table: Table, orgId: OrgId, project: string, taskId: string, options: { requireRunning?: boolean } = {}): Promise<string | undefined> {
  if (!z.string().uuid().safeParse(taskId).success) return undefined;
  const task = await table.store.get(taskKey(taskId));
  if (task === undefined || task["purpose"] !== "setup_agent" || (task["orgId"] ?? task["companyId"]) !== orgId || task["project"] !== project) return undefined;
  // A NEW ask comes from a run that is going: a closed or ended run asks nothing (an approval of an earlier ask does not need the run to be going).
  if (options.requireRunning === true && (task["closedAt"] !== undefined || task["agentRunEnd"] !== undefined || task["setupAgentResult"] !== undefined)) return undefined;
  // The person is named the way every record of this install names one (a hash of the identity adapter's name and the person's id), so the same person is the same 64 hex in a Cloud install.
  return typeof task["developerId"] === "string" && typeof task["provider"] === "string" ? developerIdOf({ provider: task["provider"], personId: task["developerId"] }) : undefined;
}

export type HostAskOutcome =
  | { outcome: "refused"; reason: SetupHostRefusal; words: string }
  | { outcome: "no_run" }
  | { outcome: "already_allowed" }
  | { outcome: "created" | "joined"; ask: SetupHostAsk }
  | { outcome: "refused_before"; ask: SetupHostAsk }
  | { outcome: "too_many_open" };

/** What a request to ask is. There is NO requester here: the person comes from the run's task record (`setupRunStarterOf`). `taskId` is the run the caller is authenticated as (the operation's task, never a field of the worker's body). */
export interface HostAskInput {
  orgId: OrgId; project: string; host: string; taskId: string;
  journalN?: number | undefined; from?: { path: string; line: number } | undefined;
  /** The websites reachable by the project's own list now (to say "already allowed"): the hosts the owner approved before, and the install's own list. */
  projectDomains: readonly string[];
  prodDeny?: TestEnvProdDeny | undefined;
  /** The person who typed the command that hit the blocked website, when one did: filled in by the broker from its own stored command (the worker names only the command's place), never from a payload. */
  typedBy?: string | undefined;
}

async function countRefusal(table: Table, input: HostAskInput, kind: SetupHostRefusal): Promise<void> {
  await table.store.update({
    key: hostRefusedCountKey(input.orgId, input.project, input.taskId, kind),
    ops: [change.add("count", 1), change.set("entityType", "SETUP_HOST_REFUSED"), change.set(INDEX_EXPIRY_ATTRIBUTE, Math.floor(table.now() / 1000) + SETUP_KEEP_SECONDS)],
  }).catch(() => undefined);
}

/**
 * The setup run saw `host` blocked. A task that is not this company's setup run asks nothing. Refused kinds make no card and no ask row, only a per-run count. A host that is already reachable needs no ask.
 * Otherwise the ask is created (with the open-asks counter and the company index row in one transaction), or joined when one is open (the join only counts, up to a bound). Two runs racing for a new host make one row;
 * the 21st open ask of a project is `too_many_open`, by a conditional write on the counter.
 */
export async function requestHostAsk(table: Table, input: HostAskInput): Promise<HostAskOutcome> {
  const requestedBy = await setupRunStarterOf(table, input.orgId, input.project, input.taskId, { requireRunning: true });
  if (requestedBy === undefined) return { outcome: "no_run" };
  const host = typeof input.host === "string" ? (input.host.endsWith(".") ? input.host.slice(0, -1) : input.host) : "";
  const reason = refuseSetupHost(host, input.prodDeny);
  if (reason !== undefined) { await countRefusal(table, input, reason); return { outcome: "refused", reason, words: SETUP_HOST_REFUSAL_WORDS[reason] }; }
  const name = host.toLowerCase();
  if (hostAlreadyAllowed(name, input.projectDomains)) return { outcome: "already_allowed" };
  let recounted = false;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const existing = await readAsk(table, input.orgId, input.project, name);
    const nowMs = table.now();
    // An approved ask whose host is no longer covered does not block a new ask; an expired refusal neither.
    const replaceable = existing === undefined || refusedAndExpired(existing, nowMs) || existing.state === "approved" || rowExpired(existing, nowMs);
    if (!replaceable && existing !== undefined) {
      if (existing.state === "refused") return { outcome: "refused_before", ask: existing };
      // Open: join. The count is bounded by a conditional write; at the bound the join is simply not counted.
      await table.store.update({ key: hostAskKey(input.orgId, input.project, name), ops: [change.add("joined", 1)], condition: when.and(when.eq("state", "open"), when.lt("joined", SETUP_HOST_JOIN_MAX)) });
      return { outcome: "joined", ask: (await readAsk(table, input.orgId, input.project, name)) ?? existing };
    }
    const row = AskRowSchema.parse({
      ...hostAskKey(input.orgId, input.project, name), entityType: "SETUP_HOST_ASK", orgId: input.orgId, project: input.project, host: name, state: "open", requestedBy, taskId: input.taskId,
      ...(input.journalN === undefined ? {} : { journalN: input.journalN }), ...(input.from === undefined ? {} : { from: { path: input.from.path.slice(0, 500), line: input.from.line } }),
      ...(input.typedBy === undefined ? {} : { typedBy: input.typedBy }),
      askedAt: new Date(nowMs).toISOString(), joined: 0, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(nowMs / 1000) + SETUP_KEEP_SECONDS,
    });
    const steps: TransactItem[] = [
      // 0: the ask. A new row, an expired refusal, or an approved one whose host is not covered now. Never an open row.
      { kind: "put", item: json(row) as StoredDocument, condition: when.or(when.absent(), when.and(when.eq("state", "refused"), when.lte("expiresAt", new Date(nowMs).toISOString())), when.eq("state", "approved"), when.lte(INDEX_EXPIRY_ATTRIBUTE, Math.floor(nowMs / 1000))) },
      // 1: the cap.
      { kind: "update", key: countKey(input.orgId, input.project), ops: [change.add("open", 1), change.set("entityType", "SETUP_HOST_OPEN_COUNT"), change.set(INDEX_EXPIRY_ATTRIBUTE, Math.floor(nowMs / 1000) + SETUP_KEEP_SECONDS)], condition: when.or(when.notExists("open"), when.lt("open", SETUP_HOST_OPEN_MAX)) },
      // 2: the company index.
      { kind: "put", item: { ...indexKey(input.orgId, input.project, name), entityType: "SETUP_HOST_OPEN", orgId: input.orgId, project: input.project, host: name, ask: json(row), [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(nowMs / 1000) + SETUP_KEEP_SECONDS } },
    ];
    const result = await table.store.transact(steps);
    if (result.applied) return { outcome: "created", ask: row };
    if (result.failed.includes(1)) {
      // The counter says full. Asks that expired were never subtracted, so before refusing it is counted again from the asks that are really open; a counter that was too high is set right (only if nobody moved
      // it meanwhile) and the ask is tried again.
      if (!recounted && await recountOpenAsks(table, input.orgId, input.project)) { recounted = true; continue; }
      return { outcome: "too_many_open" };
    }
    // Raced: read again and join.
  }
  throw unavailable();
}

/** Sets the project's open-asks counter to the number of asks that are really open, when that is LESS than the counter says. The write holds only while the counter is what was read. */
async function recountOpenAsks(table: Table, orgId: OrgId, project: string): Promise<boolean> {
  const seen = (await table.store.get(countKey(orgId, project)))?.["open"];
  if (typeof seen !== "number") return false;
  const real = (await listHostAsks(table, orgId, project, ["open"])).length;
  if (real >= seen) return false;
  return (await table.store.update({ key: countKey(orgId, project), ops: [change.set("open", real)], condition: when.eq("open", seen) })).applied;
}

/** The owner takes an approved website back: the host reads as refused (and may be asked about again at once), so a machine that starts from now on does not reach it. A machine already running keeps its list. */
export async function forgetApprovedHost(table: Table, orgId: OrgId, project: string, host: string, by: string): Promise<boolean> {
  const at = new Date(table.now()).toISOString();
  const written = await table.store.update({
    key: hostAskKey(orgId, project, host.trim().toLowerCase()),
    ops: [change.set("state", "refused"), change.set("decidedAt", at), change.set("decidedBy", by), change.set("expiresAt", at), change.set("refusalWords", "The owner took the approval back.")],
    condition: when.and(when.eq("entityType", "SETUP_HOST_ASK"), when.eq("state", "approved")),
  });
  return written.applied;
}

// ---- the decision

/** The subject kind the approval gate decides for a host ask. */
export const SETUP_HOST_KIND = "setup-host";

/** What the owner saw: the host as it was asked, and when. A different ask for the host (a later one) is another digest. */
export const hostAskDigest = (ask: Pick<SetupHostAsk, "host" | "askedAt">): string => createHash("sha256").update(`setup-host\n${ask.host}\n${ask.askedAt}`).digest("hex");
/** The revision a host ask is decided at. An ask has one version. */
export const HOST_ASK_REVISION = 1;

/** The open ask a subject id names, found in the company's index of open asks. */
async function openAskBySubject(store: Pick<DocumentStore, "query">, orgId: OrgId, subjectId: string): Promise<SetupHostAsk | undefined> {
  const rows = await queryAll(store, { pk: indexPartition(orgId), limit: 100 });
  for (const row of rows.slice(0, SETUP_HOST_INDEX_MAX)) {
    const parsed = AskRowSchema.safeParse(row["ask"]);
    if (parsed.success && parsed.data.orgId === orgId && row["project"] === parsed.data.project && row["host"] === parsed.data.host && hostAskSubjectId(orgId, parsed.data.project, parsed.data.host) === subjectId) return parsed.data;
  }
  return undefined;
}

/**
 * The gate's subject for a host ask. Approving lets the install's machines reach the host when they next start; refusing keeps the host out for a week. It decides nothing about the project's code. The owner is the
 * approver (Code's one company has one owner); a repository collaborator's comment is never one (`SubjectRefusal`). Both outcomes settle the ask, its index row and the open counter in the decision's transaction.
 */
export function createSetupHostSubject(options: { store: DocumentStore; prodDeny?: (project: string) => Promise<TestEnvProdDeny | undefined> }): DecisionSubject {
  return {
    kind: SETUP_HOST_KIND,
    async load(companyId, subjectId): Promise<LoadedSubject | undefined> {
      const ask = await openAskBySubject(options.store, companyId, subjectId);
      if (ask === undefined || ask.state !== "open") return undefined;
      return {
        key: hostAskKey(companyId, ask.project, ask.host),
        guard: when.and(when.eq("state", "open"), when.eq("askedAt", ask.askedAt)),
        waiting: true,
        // A website for the setup run is a change to what a repository's code can reach: high, so only the owner's own page session decides it (a comment never does).
        request: { kind: "setup_host", subject: { type: "setup_host", id: subjectId }, projectName: ask.project, revision: HOST_ASK_REVISION, artifactDigest: hostAskDigest(ask), risk: "high" },
        state: { ask },
      };
    },
    async apply(loaded, attempt: DecisionAttempt, approvers: readonly Principal[], at: string): Promise<AppliedDecision> {
      const { ask } = loaded.state as { ask: SetupHostAsk };
      if (!approvers.every((approver) => approver.roles.includes("owner"))) throw new SubjectRefusal("not_the_approver", "Only the owner decides a website for a setup run.");
      const approver = approvers[0]!;
      const now = Date.parse(at);
      const open: TransactItem[] = [
        { kind: "delete", key: indexKey(ask.orgId, ask.project, ask.host) },
        { kind: "update", key: countKey(ask.orgId, ask.project), ops: [change.add("open", -1)], condition: when.gt("open", 0) },
      ];
      if (attempt.outcome === "approve") {
        // The host is checked against the refusal list AGAIN: the list or the deny list may have changed since the ask.
        const refusal = refuseSetupHost(ask.host, options.prodDeny === undefined ? undefined : await options.prodDeny(ask.project));
        if (refusal !== undefined) throw new SubjectRefusal("invalid", SETUP_HOST_REFUSAL_WORDS[refusal]);
        return { ops: [change.set("state", "approved"), change.set("decidedAt", at), change.set("decidedBy", approver.personId)], extra: open, result: { host: ask.host, state: "approved" } };
      }
      if (attempt.outcome === "reject") {
        return {
          ops: [change.set("state", "refused"), change.set("decidedAt", at), change.set("decidedBy", approver.personId), change.set("expiresAt", new Date(now + SETUP_HOST_REFUSED_MS).toISOString()), change.set("refusalWords", "A person refused it.")],
          extra: open, result: { host: ask.host, state: "refused" },
        };
      }
      throw new SubjectRefusal("invalid_outcome", "A website ask is approved or refused.");
    },
  };
}
