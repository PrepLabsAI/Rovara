// Owner DEC 254zzz104: the merge core's dependencies for ONE company's runtime on the hosted install, for the Merge button (core-host/hosted-merge-routes.ts). The same seams the company's merge
// tracking reads (aws/core-job-services.ts, services/merge-tracking.ts), so the press and tracking judge a task alike:
//   - the people as one hosted rule reads them (`createHostedMergePeople`: the requesters are the creator while a member and the People list's current owners), the same for the press and tracking;
//   - the task as the core reads it (`mergeTaskOf`; another company's task reads as absent), the project's pinned repository on the registry's code host (the company's own resolver; another company's asks
//     resolve nothing), the base branch from Rovara's own pull request record (never GitHub's word), the linked pull requests, the people's code-host accounts (identity), the project's merge rules, the
//     company's milestones and session lines, and the validated CI mode reader of the runtime;
//   - `requirePassingCi`: the checks must have passed ("no CI" never shows the button: owner, DEC 254zzz104);
//   - a branch the host needs up to date makes the tracking row due now (the sync slot), as tracking's own wake.
//   - the second review's merge wait (the task's second opinion and the owner's acknowledgements), and the merge order from the task's own repository edges (the company-bound evidence store);
//   - while the install has a company rules service (the policy hook), nothing is built: that service is asked only at an approver's verdict, which a website press does not make, so a press there would
//     merge without the company's rules. The route then says merging from Rovara is not set up (the person merges on GitHub). Asking the service for a person's press is a follow-up.
// No CI mode reader on the runtime (an invalid or missing wiring): throws, and the route says merging is not set up.
import type { AdapterRegistry, ApprovalRequest, AuditSink, CodeSettings, OrgId, Principal } from "@agentx/contracts";
import { agentXError } from "@agentx/contracts";
import type { CoreRuntime } from "../core-host/core-runtime.js";
import type { MergeDependencies } from "../core/merge/merge.js";
import type { MergeTask } from "../core/merge/seams.js";
import type { CodeSettingsReader } from "../core/merge/seams.js";
import { fixedCodeSettings } from "../core/merge/defaults.js";
import { storeLinkedChangeRequests } from "../core/merge/linked.js";
import { createHostedMergePeople, type HostedTaskPeopleSource } from "./hosted-merge-people.js";
import { readTask } from "../core/task-flow/reads.js";
import { pullRequestRecordOf } from "../core/build-step/records.js";
import { createMilestoneService, createRepositoryResolver, mergeTaskOf, sessionTimeline, wakeMergeTrackingForPerson } from "../services/merge-tracking.js";
import { createTaskRepositoryEdgesSeam } from "../core/merge/repository-edges.js";
import { hostedEvidenceBlobs } from "../core-host/hosted-evidence.js";
import { personPressOf } from "../core/policy-hook/approvers.js";

export const HOSTED_MERGE_SETTINGS_REFUSED = "the project's merge rules could not be read";

export function hostedMergeDependencies(input: { runtime: CoreRuntime; registry: AdapterRegistry; settings: CodeSettingsReader | undefined; defaults: CodeSettings; now: () => number; policyHook: boolean; audit?: AuditSink | undefined; taskPeople: HostedTaskPeopleSource }): MergeDependencies {
  const { runtime, registry, now } = input;
  const companyId: OrgId = runtime.companyId;
  const flow = runtime.flow.deps;
  const ciMode = runtime.ciReporting?.ciMode;
  if (ciMode === undefined) throw new Error("the company's CI mode reader is not wired");
  const store = flow.store;
  const resolve = createRepositoryResolver(flow, registry);
  const given = input.settings ?? fixedCodeSettings(input.defaults);
  const approvers = registry.require("approvers");
  const personPress = input.policyHook ? personPressOf(approvers) : undefined;
  if (input.policyHook && personPress === undefined) throw new Error("the company rules service is not asked for a website press yet");
  const identity = registry.require("identity");
  // Asked about another company, the settings refuse: a runtime never reads another company's merge rules.
  const settings: CodeSettingsReader = { read: async (orgId, project) => {
    if (orgId !== companyId) throw agentXError("RUNTIME_UNAVAILABLE", HOSTED_MERGE_SETTINGS_REFUSED);
    return given.read(orgId, project);
  } };
  return {
    store,
    host: {
      repository: (project, revision, repositoryId, orgId) => (orgId !== companyId ? Promise.resolve(undefined) : resolve(project, revision, repositoryId, companyId)),
      scope: (orgId) => ({ orgId }),
      loadTask: async (taskId) => { const record = await readTask(flow, taskId); return record === undefined ? undefined : mergeTaskOf(record, companyId); },
      recordedBase: async (workspaceId, repositoryId, number) => (await pullRequestRecordOf(flow, workspaceId, repositoryId, number))?.baseBranch,
      requireSyncForMerge: async (task) => { await wakeMergeTrackingForPerson(store, task.taskId, now()); },
    },
    approvers,
    // The request's own sink when the route gives it (it names the client the press came through), else the flow's.
    audit: input.audit ?? flow.audit,
    people: createHostedMergePeople(identity, input.taskPeople),
    identity,
    ...(personPress === undefined ? {} : {
      requesterOf: async (task: MergeTask) => task.creatorId === undefined ? undefined : identity.getPrincipal(companyId, task.creatorId),
      personPress: (request: ApprovalRequest, presser: Principal) => personPress.decideForPerson(request, presser),
    }),
    settings,
    milestones: flow.milestones ?? createMilestoneService({ store, now }),
    timeline: sessionTimeline(),
    links: storeLinkedChangeRequests(store),
    now,
    ciMode: (task) => ciMode(task),
    requirePassingCi: true,
    // The second review that did not run waits for the owner (the merge card's wait), as everywhere else.
    mergeWait: (task) => flow.secondReview?.mergeWait(task),
    repositoryEdges: createTaskRepositoryEdgesSeam({ flow, blobs: hostedEvidenceBlobs({ blobs: registry.require("object-storage"), store, companyId }), companyId }),
  };
}
