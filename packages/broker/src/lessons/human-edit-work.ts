// L4-LM1c: the consumer's half of the human-edit job: `HumanEditWorkDeps.run` (human-edit.ts, `learnFromHumanEdit`). It takes the queued job (coordinates only), proves everything again from the company's own records and the
// code host, reads the person's edit live, names the authors as canonical developer ids and hands the changed lines to the extractor ONCE. The extractor's own model call is the reflector's: the customer's own AI account
// through the same pipeline model and learning spend as a task-end reflection, and it refuses with that path's own words when the customer has none (never Rovara-paid).
//
// What the queue's message is trusted for: nothing but where to look. Each of these is checked here, not in the message:
//   - the company: the job's company is this company's (the host that built this ran only for it), and the task is read now and must be this company's, on the job's project;
//   - the pull request: it is one of the task's own (number and address as the task recorded them), in a repository the task's own project pins (`repos.ofTask`, resolved for this company), never a repository the
//     message names; the host's own name for that repository must be the job's;
//   - the head: the host shows the job's head as the pull request's head now. A head that moved on is `skipped`: the newer push has its own job whose range includes this one's commits;
//   - the authors: the same proof the producer made (`readPersonEdit`), each person then mapped to a member of this company by the host's stable account id (`personOf`); one that cannot be mapped means nothing is handed
//     on, so a lesson never names a different person than the one who wrote the lines.
import type { ChangeRequestRef, CodeHost, HostScope, OrgId, RepositoryRef } from "@agentx/contracts";
import { providerOf } from "../plugins/routing.js";
import { changeRequestRef } from "../core/merge/host-port.js";
import type { TaskRecord } from "../core/task-flow/records.js";
import { aclSourceOf } from "../local/app/lessons-sources.js";
import type { HumanEditExtractorPort, HumanEditJob } from "./capture-types.js";
import { HumanEditAllowanceError, allowanceBudget, readPersonEdit, type HostPerson, type HumanEditRead } from "./human-edit-read.js";
import type { Audience } from "./types.js";

/** What the worker may spend on the host for one job: requests (the commits it walks and the pull request's own read), and no more. */
export const HUMAN_EDIT_WORK_REQUESTS_MAX = 40;

/** One repository of a task's project, as lessons see it (`local/app/lessons-repos.ts`, which satisfies this). */
export interface HumanEditRepository {
  url: string;
  place: string;
  fullName: string;
  codeHost: Pick<CodeHost, "commitChanges" | "getChangeRequest" | "kind" | "provider">;
  repository: RepositoryRef;
  scope: HostScope;
}

export interface HumanEditRunDeps {
  companyId: OrgId;
  ownTask(taskId: string): Promise<TaskRecord | undefined>;
  repos: { ofTask(project: string, startingRevision: number, name: string): Promise<HumanEditRepository | undefined> };
  /** The canonical developer id of the member of THIS company a code host account is, or undefined (not linked, not in this company). THROWS when it cannot tell. */
  personOf(account: HostPerson, provider: string): Promise<string | undefined>;
  extractor: HumanEditExtractorPort;
  now: () => number;
}

export function createHumanEditRun(deps: HumanEditRunDeps): (job: HumanEditJob) => Promise<"handed_on" | "skipped"> {
  return async (job) => {
    // The company, from the job and from the record read now.
    if (job.repo.workspaceId !== deps.companyId) return "skipped";
    const task = await deps.ownTask(job.taskId);
    if (task === undefined || task.workflow === undefined || task.project !== job.project) return "skipped";
    const pullRequest = (task.workflow.pullRequests ?? []).find((entry) => entry.number === job.pullRequest.number && entry.url === job.pullRequest.url);
    if (pullRequest === undefined) return "skipped";
    const repo = await deps.repos.ofTask(task.project, task.startingRevision, pullRequest.repositoryId);
    if (repo === undefined || repo.fullName.toLowerCase() !== job.repo.fullName.toLowerCase()) return "skipped";
    const provider = providerOf(repo.codeHost);
    // The head the host shows now must be the job's.
    const budget = allowanceBudget(undefined, HUMAN_EDIT_WORK_REQUESTS_MAX);
    budget.beforeRequest();
    const ref: ChangeRequestRef = changeRequestRef(repo.url, pullRequest.number);
    const live = await repo.codeHost.getChangeRequest(ref, repo.scope);
    if (live.headRevision !== job.headSha || (job.headRef !== undefined && live.sourceBranch !== job.headRef)) return "skipped";
    // The person's edit, proved and read again.
    // More requests than the job's allowance is a diff too large to read: skipped, the same way every time (never retried).
    const read: HumanEditRead = await readPersonEdit({ host: repo.codeHost, repository: repo.repository, scope: repo.scope, base: job.candidateHeadSha, head: job.headSha, budget })
      .catch((error: unknown) => { if (error instanceof HumanEditAllowanceError) return { kind: "skip", reason: "diff_too_large" } as const; throw error; });
    if (read.kind === "skip") return "skipped";
    // Every person is a member of this company, by the host's stable id; one that is not (or that cannot be told) means nothing is handed on.
    const authors: string[] = [];
    for (const person of read.people) {
      const developerId = await deps.personOf(person, provider);
      if (developerId === undefined || developerId === "") return "skipped";
      if (!authors.includes(developerId)) authors.push(developerId);
    }
    const audience: Audience = { kind: "restricted", acl: { source: aclSourceOf(provider), scope: repo.place, capturedAt: new Date(deps.now()).toISOString(), liveCheck: "none" } };
    await deps.extractor.extract({
      workspaceId: deps.companyId, project: task.project, repo: repo.fullName, taskId: task.taskId, pullRequest: { number: pullRequest.number, url: pullRequest.url },
      trust: "member", authorCount: authors.length, authors, audience, scope: repo.place, files: read.files, link: pullRequest.url,
    });
    return "handed_on";
  };
}
