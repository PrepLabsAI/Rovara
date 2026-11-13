// Spec 062 Phase 7c3b (FR-080): Slack modals as the protocol's forms. Every modal the core's handlers open reads as a
// form that renders back to the same modal, so moving the forms behind the channel API changes nothing a person sees;
// a submission's state goes both ways too.
import { describe, expect, it } from "vitest";
import {
  ChannelFormSchema, createWorkflowSnapshot, formOfSlackModal, formValuesOfSlackState, slackModalOf, slackStateOfFormValues, submitWorkflowArtifact,
} from "../../packages/contracts/src/index.js";
import { chatGptPasteModal, chatGptResultView } from "../../packages/core/src/aws/slack-chatgpt.js";
import { detailsMessageView } from "../../packages/core/src/aws/slack-details-view.js";
import { workflowSlackHandlers, type SlackBlockAction } from "../../packages/core/src/aws/slack-interactivity.js";

const nowSeconds = 1_758_657_600;
const requester = "U0123456789";
const thread = { teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1695500000.000001" };
const taskId = "44444444-4444-5444-8444-444444444444";
const digest = "a".repeat(64);
const workflow = submitWorkflowArtifact(createWorkflowSnapshot({
  taskId, ownerId: "b".repeat(64), now: new Date(nowSeconds * 1_000).toISOString(),
  checkPolicy: {
    required: [{ id: "required-1", label: "npm test", command: { cwd: "workspace", executable: "npm", args: ["test"], timeoutSeconds: 120 } }],
    optional: [{ id: "coverage", label: "Coverage report", command: { cwd: "workspace", executable: "npm", args: ["run", "coverage"], timeoutSeconds: 120 } }], selectedOptionalIds: [],
  },
}), { expectedRevision: 1, now: new Date(nowSeconds * 1_000).toISOString(), artifact: {
  id: "plan-1", type: "plan", version: 1, sha256: digest, producer: "agentx-plan", objectKey: "private/owner/workspace/op/plan.md", createdAt: new Date(nowSeconds * 1_000).toISOString(),
} });
const task = { taskId, slackUserId: requester, share: thread, workflow };
const press = (actionId: string, value: unknown): SlackBlockAction => ({
  actionId, value: JSON.stringify(value), userId: requester, userTeamId: thread.teamId, workspaceTeamId: thread.teamId, enterpriseId: "", userEnterpriseId: "",
  requestStartedAt: nowSeconds * 1_000, thread, messageTs: "1695500001.000002", messageText: "plan", responseUrl: "https://hooks.slack.com/actions/T0BSHLLUGBD/1/abc", triggerId: "1.2.3",
});

/** The modal a handler opens for a press. */
async function opened(actionId: string, value: unknown, extra: Partial<Parameters<typeof workflowSlackHandlers>[0]> = {}): Promise<Record<string, unknown>> {
  let view: Record<string, unknown> | undefined;
  const handlers = workflowSlackHandlers({ loadTask: async () => task, openView: async (_trigger, modal) => { view = modal; }, submit: async () => undefined, ...extra });
  await handlers.handleAction(press(actionId, value));
  if (view === undefined) throw new Error(`${actionId} opened no modal`);
  return view;
}

const roundTrips = (view: Record<string, unknown>) => {
  const form = formOfSlackModal(view);
  expect(form, JSON.stringify(view).slice(0, 300)).toBeDefined();
  expect(ChannelFormSchema.parse(form)).toEqual(form);
  expect(slackModalOf(form!)).toEqual(view);
};

describe("every modal the core opens is a form that renders back to the same modal", () => {
  it("the plan approval, with its locked and optional checks", async () => {
    roundTrips(await opened("agentx_workflow_approve", { taskId, revision: workflow.revision, digest, decision: "APPROVE" }));
  });

  it("the plan's request for changes", async () => {
    roundTrips(await opened("agentx_workflow_changes", { taskId, revision: workflow.revision, digest, decision: "REQUEST_CHANGES" }));
  });

  it("Task People, with its person and role pickers", async () => {
    roundTrips(await opened("agentx_task_people", { taskId }, {
      getPeople: async () => ({ revision: 3, orphaned: false, people: [{ developerId: "d1", slackUserId: requester, name: "Ana", role: "owner" }], canManage: true, canTakeOwnership: false, addPeopleUrl: "https://agentx.example.test/add" }) as never,
    }));
  });

  it("ChatGPT's paste form and its result", () => {
    roundTrips(chatGptPasteModal({ channel: thread.channelId, threadTs: thread.threadTs }));
    roundTrips(chatGptResultView("ChatGPT is connected."));
  });

  it("a Details message", () => {
    roundTrips(detailsMessageView("Details are not available for this reply.") as unknown as Record<string, unknown>);
  });

  it("refuses a modal block it does not know, rather than show it differently", () => {
    expect(formOfSlackModal({ type: "modal", callback_id: "x", title: { type: "plain_text", text: "X" }, blocks: [{ type: "header", text: { type: "plain_text", text: "x" } }] })).toBeUndefined();
    expect(formOfSlackModal({ type: "home", blocks: [] })).toBeUndefined();
  });
});

describe("a submission's state", () => {
  it("reads as the form's values and back, as Slack's own submissions read", () => {
    const state = {
      workflow_feedback: { reason: { type: "plain_text_input", value: "keep the old menu" } },
      workflow_checks: { selected_options: { type: "checkboxes", selected_options: [{ value: "coverage" }] } },
      task_person: { person: { type: "users_select", selected_user: requester } },
      task_role: { role: { type: "static_select", selected_option: { value: "owner" } } },
    };
    const values = formValuesOfSlackState(state)!;
    expect(values).toEqual({
      workflow_feedback: { reason: { kind: "text", value: "keep the old menu" } },
      workflow_checks: { selected_options: { kind: "checkboxes", values: ["coverage"] } },
      task_person: { person: { kind: "person", value: requester } },
      task_role: { role: { kind: "select", value: "owner" } },
    });
    expect(slackStateOfFormValues(values)).toEqual(state);
  });
});
