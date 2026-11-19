// Owner DEC 254zzz94: the in-Rovara Merge button on the hosted install (`GET/POST /v1/app/tasks/{id}/merge`, core-host/hosted-merge-routes.ts).
// WHO: the task owner or co-owner, a project admin, a company admin. WHERE: the website only (a press). SAFETY: Rovara's workflow rule plus GitHub's fresh read (open, not a draft, the head Rovara
// checked, checks passing, mergeable), GitHub's own merge API, one merge at a time, idempotent per request id, audited before GitHub is asked. Every refusal sends nothing to GitHub's merge endpoint.
// Mutants are listed in the PR body with the test that kills each.
/* eslint-disable @typescript-eslint/no-explicit-any -- a JSON answer is read field by field */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MERGE_NOT_READY_MESSAGES as M, ON_THE_WEBSITE_MESSAGE, type AuditEvent, type ChangeRequestStatus, type MergeResult, type OrgId, type OrgRole } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { HOSTED_MERGE_WORDS, MERGE_LOCK_MS, MERGE_PRESSED_AUDIT, MERGE_RESULT_AUDIT, isHostedMergePath, routeHostedMerge, type HostedMergeWiring } from "../../packages/broker/src/core-host/hosted-merge-routes.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { COMPANY_A, COMPANY_B } from "../support/wiki-build-fixtures.js";

const T0 = Date.parse("2026-11-18T12:00:00.000Z");
const OWNER = "owner-1", CO_OWNER = "co-owner-1", MAINTAINER = "maint-1", DEVELOPER = "dev-1", STRANGER = "stranger-1", ADMIN = "admin-1";
const TASK = "11111111-2222-4333-8444-555555555555";
const HEAD = "a".repeat(40), OTHER_HEAD = "b".repeat(40);
const REPO_URL = "https://github.com/acme/app";
type Body = Record<string, any>;

function taskDoc(overrides: { companyId?: OrgId; stage?: string; state?: string; headSha?: string; prState?: string; extraPull?: boolean } = {}) {
  const pull = (repositoryId: string, number: number) => ({ repositoryId, number, url: `https://github.com/acme/${repositoryId}/pull/${String(number)}`, headSha: overrides.headSha ?? HEAD, candidateDigest: "c".repeat(64), required: true, state: overrides.prState ?? "OPEN" });
  return {
    ...taskKey(TASK), taskId: TASK, companyId: overrides.companyId ?? COMPANY_A, developerId: OWNER, project: "shop", startingRevision: 3, workspaceId: "ws-1",
    workflow: { stage: overrides.stage ?? "WAIT_FOR_MERGE", state: overrides.state ?? "WAITING", revision: 9, pullRequests: [pull("app", 7), ...(overrides.extraPull === true ? [pull("lib", 8)] : [])] },
  };
}

function greenStatus(overrides: Partial<ChangeRequestStatus> = {}): ChangeRequestStatus {
  return {
    id: "7", state: "open", draft: false, headRevision: HEAD, targetBranch: "main", mergeableState: "clean", mergeable: true,
    checks: [{ name: "ci", state: "completed", conclusion: "success", required: true, url: "https://github.com/acme/app/runs/1" } as never],
    requiredChecks: [{ name: "ci" } as never], reviews: [], targetHasRequiredChecks: true, headDefinesChecks: true, requestedReviewers: 0, ...overrides,
  };
}

interface Options {
  webApp?: boolean; role?: OrgRole; person?: string; company?: OrgId; principalCompany?: string; task?: ReturnType<typeof taskDoc> | null; status?: ChangeRequestStatus | (() => ChangeRequestStatus) | "throw";
  merge?: MergeResult | "throw" | ((n: number) => MergeResult); wiring?: false; audit?: "fail"; grant?: "developer" | "administrator"; store?: MemoryDocumentStore; hostedMergeAbsent?: boolean; method?: string;
}

function world(options: Options = {}) {
  const store = options.store ?? new MemoryDocumentStore();
  const company = options.company ?? COMPANY_A;
  if (options.task !== null) void store.put({ item: options.task ?? taskDoc() });
  const statusReads: string[] = [];
  const merges: Array<{ ref: unknown; input: unknown; scope: unknown }> = [];
  const gets: string[] = [];
  const counted = new Proxy(store, { get: (target, key) => {
    if (key === "get") return async (k: { pk: string; sk: string }) => { gets.push(k.pk); return target.get(k); };
    const value = Reflect.get(target, key, target) as unknown;
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
  } });
  const codeHost = {
    kind: "github",
    async changeRequestStatus(ref: { repository: { url: string }; id: string }) {
      statusReads.push(`${ref.repository.url}#${ref.id}`);
      if (options.status === "throw") throw new Error("boom: token ghs_secret");
      return typeof options.status === "function" ? options.status() : options.status ?? greenStatus();
    },
    ...(options.hostedMergeAbsent === true ? {} : { async merge(ref: unknown, input: unknown, scope: unknown): Promise<MergeResult> {
      merges.push({ ref, input, scope });
      if (options.merge === "throw") throw new Error("socket hang up ghs_secret");
      return typeof options.merge === "function" ? options.merge(merges.length) : options.merge ?? { outcome: "merged", method: "squash", fellBack: false };
    } }),
  };
  const wiring: HostedMergeWiring = {
    projectGrantRole: async (personId, project) => (project !== "shop" ? undefined : personId === MAINTAINER ? "administrator" : personId === DEVELOPER ? "developer" : options.grant),
    repository: async (project, revision, repositoryId, orgId) => (project === "shop" && revision === 3 && orgId === COMPANY_A ? { url: `https://github.com/acme/${repositoryId}`, codeHost: codeHost as never } : undefined),
    mergeMethod: async () => (options.method ?? "squash") as "squash",
  };
  const audited: AuditEvent[] = [];
  const audit = { stage: () => [], record: async (event: AuditEvent) => { if (options.audit === "fail") throw new Error("audit down"); audited.push(event); } };
  const flow = {
    store: counted, companyId: company,
    access: {
      // The flow's owner rule: the task's own person and a People co-owner act; a developer with the project grant reads.
      canAct: async (principal: { personId: string }, task: { developerId: string }) => principal.personId === task.developerId || principal.personId === CO_OWNER,
      canRead: async (principal: { personId: string }, task: { developerId: string }) => principal.personId === task.developerId || principal.personId === CO_OWNER || principal.personId === DEVELOPER,
    },
  } as never;
  const call = async (method: "GET" | "POST", body?: unknown, who: { person?: string; role?: OrgRole; webApp?: boolean; path?: string; raw?: string } = {}) => {
    const person = who.person ?? options.person ?? OWNER;
    const answer = await routeHostedMerge({
      request: { method, path: who.path ?? `/v1/app/tasks/${TASK}/merge`, headers: {}, body: who.raw ?? (body === undefined ? undefined : JSON.stringify(body)) } as never,
      path: who.path ?? `/v1/app/tasks/${TASK}/merge`,
      principal: { companyId: options.principalCompany ?? company, personId: person, displayName: "P", roles: [], provider: "rovara" },
      companyId: company, role: who.role ?? options.role ?? "member", flow, wiring: options.wiring === false ? undefined : wiring, audit, now: () => T0,
      webApp: who.webApp ?? options.webApp ?? true,
    });
    return { status: answer.statusCode, body: JSON.parse(answer.body) as Body };
  };
  return { call, store, merges, statusReads, audited, gets };
}

const press = (requestId = randomUUID()) => ({ requestId });

describe("hosted Merge button: paths", () => {
  it("serves GET and POST on /v1/app/tasks/<uuid>/merge only", () => {
    expect(isHostedMergePath(`/v1/app/tasks/${TASK}/merge`, "POST")).toBe(true);
    expect(isHostedMergePath(`/v1/app/tasks/${TASK}/merge`, "GET")).toBe(true);
    expect(isHostedMergePath(`/v1/app/tasks/${TASK}/merge`, "PUT")).toBe(false);
    expect(isHostedMergePath(`/v1/app/tasks/not-a-uuid/merge`, "POST")).toBe(false);
    expect(isHostedMergePath(`/v1/dev/tasks/${TASK}/merge`, "POST")).toBe(false);
  });
});

describe("hosted Merge button: who may merge", () => {
  for (const [label, person, role] of [["the task owner", OWNER, "member"], ["a People co-owner", CO_OWNER, "member"], ["a project admin (maintainer)", MAINTAINER, "member"], ["a company admin", ADMIN, "admin"], ["a company owner", ADMIN, "owner"]] as const) {
    it(`${label} merges through GitHub's merge API with the head Rovara checked`, async () => {
      const w = world();
      const requestId = randomUUID();
      const answer = await w.call("POST", { requestId }, { person, role });
      expect(answer).toEqual({ status: 200, body: { status: "MERGED", pullRequests: [{ repositoryId: "app", number: 7 }] } });
      expect(w.merges).toEqual([{ ref: { repository: { url: "https://github.com/acme/app" }, id: "7", url: "" }, input: { revision: HEAD, method: "squash" }, scope: { orgId: COMPANY_A } }]);
      const basis = person === OWNER || person === CO_OWNER ? "task-owner" : person === MAINTAINER ? "project-admin" : "company-admin";
      expect(w.audited.map((event) => [event.action, event.actor.id, event.details?.["basis"], event.details?.["requestId"]])).toEqual([[MERGE_PRESSED_AUDIT, person, basis, requestId], [MERGE_RESULT_AUDIT, person, basis, requestId]]);
      expect(w.audited[1]!.details?.["outcome"]).toBe("merged");
      expect(w.audited[0]!.subject).toEqual({ type: "task", id: TASK });
    });
  }

  it("uses the project's merge method", async () => {
    const w = world({ method: "merge" });
    expect((await w.call("POST", press())).status).toBe(200);
    expect((w.merges[0]!.input as Body).method).toBe("merge");
  });

  it("a merge method the code host does not know (never rebase) refuses, and nothing is sent", async () => {
    const w = world({ method: "rebase" });
    expect(await w.call("POST", press())).toEqual({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: HOSTED_MERGE_WORDS.unavailable } } });
    expect(w.merges).toEqual([]);
  });

  it("a developer who may read the task is refused in fixed words, and nothing is read from or sent to GitHub", async () => {
    const w = world();
    const answer = await w.call("POST", press(), { person: DEVELOPER });
    expect(answer).toEqual({ status: 403, body: { error: { code: "FORBIDDEN", message: HOSTED_MERGE_WORDS.notAllowed } } });
    expect(w.statusReads).toEqual([]);
    expect(w.merges).toEqual([]);
    expect(w.audited).toEqual([]);
  });

  it("a developer project grant is not a project admin's", async () => {
    const w = world({ grant: "developer" });
    expect((await w.call("POST", press(), { person: "someone-with-dev-grant" })).status).toBe(404);
    expect(w.merges).toEqual([]);
  });

  it("someone who may not read the task reads 'task not found', exactly as a missing task", async () => {
    const w = world();
    const stranger = await w.call("POST", press(), { person: STRANGER });
    const missing = await world({ task: null }).call("POST", press());
    expect(stranger).toEqual({ status: 404, body: { error: { code: "TASK_NOT_FOUND", message: "no such task" } } });
    expect(missing).toEqual(stranger);
    expect(w.merges).toEqual([]);
    expect(w.statusReads).toEqual([]);
  });

  it("another company's task is not found, even for a company admin or a project admin of the same project name", async () => {
    for (const [person, role] of [[ADMIN, "admin"], [MAINTAINER, "member"], [OWNER, "member"]] as const) {
      const w = world({ task: taskDoc({ companyId: COMPANY_B }) });
      expect(await w.call("POST", press(), { person, role })).toEqual({ status: 404, body: { error: { code: "TASK_NOT_FOUND", message: "no such task" } } });
      expect(await w.call("GET", undefined, { person, role })).toEqual({ status: 404, body: { error: { code: "TASK_NOT_FOUND", message: "no such task" } } });
      expect(w.merges).toEqual([]);
      expect(w.statusReads).toEqual([]);
    }
  });

  it("a principal of another company than the membership's is not found", async () => {
    const w = world({ principalCompany: COMPANY_B });
    expect((await w.call("POST", press(), { role: "admin" })).status).toBe(404);
    expect(w.merges).toEqual([]);
  });
});

describe("hosted Merge button: website only", () => {
  it("a press from the CLI or an AI tool is refused with the website words before anything is read", async () => {
    const w = world();
    const answer = await w.call("POST", press(), { webApp: false, role: "owner" });
    expect(answer).toEqual({ status: 403, body: { error: { code: "FORBIDDEN", message: ON_THE_WEBSITE_MESSAGE } } });
    expect(w.gets).toEqual([]);
    expect(w.statusReads).toEqual([]);
    expect(w.merges).toEqual([]);
  });

  it("reading whether it would merge works from any client (tools can read)", async () => {
    const w = world();
    expect(await w.call("GET", undefined, { webApp: false })).toEqual({ status: 200, body: { mayMerge: true, ready: true, pullRequests: [{ repositoryId: "app", number: 7, url: "https://github.com/acme/app/pull/7" }] } });
    expect(w.merges).toEqual([]);
  });
});

describe("hosted Merge button: only when Rovara's checks are green and GitHub says mergeable", () => {
  const refusals: Array<[string, Options, string]> = [
    ["red checks", { status: greenStatus({ checks: [{ name: "ci", state: "completed", conclusion: "failure", required: true, url: "https://github.com/acme/app/runs/1" } as never] }) }, M.checks],
    ["checks still running", { status: greenStatus({ checks: [{ name: "ci", state: "in_progress", required: true, url: "https://github.com/acme/app/runs/1" } as never] }) }, M.checks],
    ["no checks at all", { status: greenStatus({ checks: [], requiredChecks: [], targetHasRequiredChecks: false }) }, M.checks],
    ["GitHub blocks it (branch protection)", { status: greenStatus({ mergeableState: "blocked" }) }, HOSTED_MERGE_WORDS.blocked],
    ["a conflict", { status: greenStatus({ mergeableState: "conflicted", mergeable: false }) }, HOSTED_MERGE_WORDS.conflicted],
    ["mergeable false", { status: greenStatus({ mergeable: false }) }, HOSTED_MERGE_WORDS.conflicted],
    ["behind a base that must be up to date", { status: greenStatus({ mergeableState: "behind" }) }, HOSTED_MERGE_WORDS.behind],
    ["GitHub has not decided yet", { status: greenStatus({ mergeableState: "unknown" }) }, M.notTrackedYet],
    ["a draft", { status: greenStatus({ draft: true }) }, M.draft],
    ["a closed pull request", { status: greenStatus({ state: "closed" }) }, M.notOpen],
    ["new commits since Rovara checked", { status: greenStatus({ headRevision: OTHER_HEAD }) }, HOSTED_MERGE_WORDS.headMoved],
    ["a task still being changed", { task: taskDoc({ stage: "REVIEW", state: "RUNNING" }) }, M.changing],
    ["a task blocked on its checks", { task: taskDoc({ state: "BLOCKED" }) }, M.changing],
    ["a merged task", { task: taskDoc({ stage: "MERGED", state: "COMPLETE" }) }, M.taskClosed],
    ["no recorded head", { task: (() => { const t = taskDoc(); delete (t.workflow.pullRequests[0] as Body)["headSha"]; return t; })() }, M.changing],
  ];
  for (const [label, options, words] of refusals) {
    it(`${label}: refused in fixed words, nothing sent to GitHub's merge endpoint`, async () => {
      const w = world(options);
      const answer = await w.call("POST", press());
      expect(answer).toEqual({ status: 409, body: { error: { code: "MERGE_NOT_READY", message: words } } });
      expect(w.merges).toEqual([]);
      expect(w.audited).toEqual([]);
      const view = await w.call("GET");
      expect(view.body).toEqual({ mayMerge: true, ready: false, message: words, pullRequests: expect.any(Array) });
      // The lock was never taken: a good press goes through once the cause is gone.
      expect(await w.store.get({ pk: `ORG#${COMPANY_A}#HOSTED_MERGE`, sk: `${TASK}#LOCK` })).toBeUndefined();
    });
  }

  it("with two pull requests, the refusal names the repository", async () => {
    const w = world({ task: taskDoc({ extraPull: true }), status: () => (w.statusReads.length === 2 ? greenStatus({ mergeableState: "blocked" }) : greenStatus()) });
    const answer = await w.call("POST", press());
    expect(answer.body.error.message).toBe(M.repository("lib", HOSTED_MERGE_WORDS.blocked));
    expect(w.merges).toEqual([]);
  });

  it("GitHub that cannot be read refuses without echoing the cause", async () => {
    const w = world({ status: "throw" });
    const answer = await w.call("POST", press());
    expect(answer).toEqual({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: HOSTED_MERGE_WORDS.unavailable } } });
    expect(JSON.stringify(answer)).not.toContain("ghs_");
    expect(w.merges).toEqual([]);
  });

  it("a code host without merge says merging is not set up", async () => {
    const w = world({ hostedMergeAbsent: true });
    expect((await w.call("POST", press())).body.error.message).toBe(HOSTED_MERGE_WORDS.notSetUp);
  });

  it("an install without the wiring says merging is not set up, before reading the task", async () => {
    const w = world({ wiring: false });
    expect(await w.call("POST", press())).toEqual({ status: 404, body: { error: { code: "NOT_FOUND", message: HOSTED_MERGE_WORDS.notSetUp } } });
    expect(w.gets).toEqual([]);
  });

  it("an already merged pull request on GitHub answers merged without a merge call", async () => {
    const w = world({ status: greenStatus({ state: "merged" }) });
    expect((await w.call("POST", press())).body).toEqual({ status: "MERGED", pullRequests: [{ repositoryId: "app", number: 7 }] });
    expect(w.merges).toEqual([]);
  });
});

describe("hosted Merge button: GitHub's answer", () => {
  it("a refusal from GitHub is told in fixed words (never GitHub's text) and the lock is given back", async () => {
    const w = world({ merge: { outcome: "refused", reason: "forbidden", hostMessage: "Resource not accessible by integration ghs_secret" } });
    const answer = await w.call("POST", press());
    expect(answer.status).toBe(409);
    expect(answer.body.error.message).toBe(M.notMerged("app", "Rovara's GitHub App is not allowed to merge it"));
    expect(JSON.stringify(answer)).not.toContain("ghs_");
    expect(w.audited.map((event) => [event.action, event.details?.["outcome"]])).toEqual([[MERGE_PRESSED_AUDIT, undefined], [MERGE_RESULT_AUDIT, "refused"]]);
    expect(await w.store.get({ pk: `ORG#${COMPANY_A}#HOSTED_MERGE`, sk: `${TASK}#LOCK` })).toBeUndefined();
  });

  it("a merge whose answer was lost says to check GitHub, with no cause echoed", async () => {
    const w = world({ merge: "throw" });
    const answer = await w.call("POST", press());
    expect(answer).toEqual({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: HOSTED_MERGE_WORDS.outcomeUnknown } } });
    expect(JSON.stringify(answer)).not.toContain("ghs_");
  });

  it("two pull requests: the second refused after the first merged is a half merge, and a later press finishes it", async () => {
    const w = world({ task: taskDoc({ extraPull: true }), merge: (n) => (n === 1 ? { outcome: "merged", method: "squash", fellBack: false } : { outcome: "refused", reason: "head_changed" }) });
    const answer = await w.call("POST", press());
    expect(answer).toEqual({ status: 409, body: { error: { code: "MERGE_NOT_READY", message: M.halfMerged("app #7", "lib #8", "its code changed after Rovara checked it") } } });
    expect(w.merges).toHaveLength(2);
    expect(w.audited.at(-1)!.details?.["outcome"]).toBe("half_merged");
  });

  it("two pull requests merge in repository order", async () => {
    const w = world({ task: taskDoc({ extraPull: true }) });
    expect((await w.call("POST", press())).body).toEqual({ status: "MERGED", pullRequests: [{ repositoryId: "app", number: 7 }, { repositoryId: "lib", number: 8 }] });
    expect(w.merges.map((m) => (m.ref as Body).repository.url)).toEqual(["https://github.com/acme/app", "https://github.com/acme/lib"]);
  });
});

describe("hosted Merge button: one merge, one answer per request", () => {
  it("the same request id again answers the stored result without asking GitHub", async () => {
    const w = world();
    const body = press();
    const first = await w.call("POST", body);
    const reads = w.statusReads.length;
    const second = await w.call("POST", body);
    expect(second).toEqual(first);
    expect(w.merges).toHaveLength(1);
    expect(w.statusReads).toHaveLength(reads);
    expect(w.audited.filter((event) => event.action === MERGE_PRESSED_AUDIT)).toHaveLength(1);
  });

  it("a request id another person used is refused, and nothing is sent", async () => {
    const w = world();
    const body = press();
    await w.call("POST", body);
    const answer = await w.call("POST", body, { person: MAINTAINER });
    expect(answer).toEqual({ status: 409, body: { error: { code: "IDEMPOTENCY_CONFLICT", message: HOSTED_MERGE_WORDS.requestReused } } });
    expect(w.merges).toHaveLength(1);
  });

  it("a press while another press holds the task's lock is refused, and nothing is sent", async () => {
    const w = world();
    await w.store.put({ item: { pk: `ORG#${COMPANY_A}#HOSTED_MERGE`, sk: `${TASK}#LOCK`, requestId: randomUUID(), personId: CO_OWNER, until: T0 + MERGE_LOCK_MS } });
    const answer = await w.call("POST", press());
    expect(answer).toEqual({ status: 409, body: { error: { code: "MERGE_NOT_READY", message: HOSTED_MERGE_WORDS.inProgress } } });
    expect(w.merges).toEqual([]);
  });

  it("a lock left by a press that died is taken once it has run out", async () => {
    const w = world();
    await w.store.put({ item: { pk: `ORG#${COMPANY_A}#HOSTED_MERGE`, sk: `${TASK}#LOCK`, requestId: randomUUID(), personId: CO_OWNER, until: T0 - 1 } });
    expect((await w.call("POST", press())).status).toBe(200);
    expect(w.merges).toHaveLength(1);
  });

  it("no audit record, no merge", async () => {
    const w = world({ audit: "fail" });
    const answer = await w.call("POST", press());
    expect(answer).toEqual({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: HOSTED_MERGE_WORDS.unavailable } } });
    expect(w.merges).toEqual([]);
    expect(await w.store.get({ pk: `ORG#${COMPANY_A}#HOSTED_MERGE`, sk: `${TASK}#LOCK` })).toBeUndefined();
  });

  it("a body with anything but a UUID request id is refused in fixed words", async () => {
    for (const raw of ['{"requestId":"x"}', `{"requestId":"${randomUUID()}","force":true}`, "not json", "[]"]) {
      const w = world();
      expect(await w.call("POST", undefined, { raw })).toEqual({ status: 400, body: { error: { code: "CONFIG_INVALID", message: HOSTED_MERGE_WORDS.body } } });
      expect(w.merges).toEqual([]);
    }
  });
});

describe("hosted Merge button: the readiness read", () => {
  it("a reader who may not merge is told so without any GitHub read", async () => {
    const w = world();
    expect(await w.call("GET", undefined, { person: DEVELOPER })).toEqual({ status: 200, body: { mayMerge: false, ready: false, pullRequests: [{ repositoryId: "app", number: 7, url: "https://github.com/acme/app/pull/7" }] } });
    expect(w.statusReads).toEqual([]);
  });

  it("someone who may not read the task reads 'task not found'", async () => {
    expect((await world().call("GET", undefined, { person: STRANGER })).status).toBe(404);
  });
});
