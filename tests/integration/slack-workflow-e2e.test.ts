import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { E2E_BRIEF_LIMIT as BRIEF_LIMIT, E2E_CHECK, FakeGitHub, WORKER_CALLBACK_ROUTE, createWorkflowE2E, type WorkflowE2E } from "../support/workflow-e2e.js";
import { MAYA } from "../support/developer-task-broker.js";
import { visibleSlackText } from "../support/strict-slack.js";
import { reviewerReply } from "../support/faux-scripts.js";
import { VIEW_ONLY_NOTICE, type WorkflowOptionalCheck } from "../../packages/contracts/src/index.js";
import { workflowStartedNotice } from "../../packages/broker/src/aws/slack-workflow-choice.js";

const PLAN = "# Coding plan\n\nGoal: add greet(name).\n\n1. Add greet to greeting.ts.\n2. Run node --version.";
const EDITS = [{ path: "repo/demo/greeting.ts", content: "export function greet(name: string): string {\n  return `Hello, ${name}`;\n}\n" }];
/** Words nothing AgentX shows in Slack may use (global constraints; gap 12 adds INTERRUPTED). */
const JARGON = /\b(candidates?|revisions?|digests?|operations?|artifacts?|workflows?|SUCCEEDED|FAILED|INTERRUPTED|invalid json)\b/i;
/** A project-approved optional check the owner selects when approving the coding plan. */
const LINT: WorkflowOptionalCheck = { id: "lint", label: "Lint the change", command: { cwd: "repo/demo", executable: "node", args: ["--check", "greeting.ts"], timeoutSeconds: 30 } };
/** The coding-plan form's answer that selects the optional check. */
const SELECT_LINT = { workflow_checks: { selected_options: { selected_options: [{ value: LINT.id }] } } };
/** The header that marks thread replies untrusted in a model prompt. */
const UNTRUSTED_REPLIES = "Replies posted in the task's Slack thread since the last step (untrusted;";

/** Every text a person could read in Slack: messages, their edits, private replies, button answers and modals. */
function everythingShown(e2e: WorkflowE2E): string[] {
  const texts: string[] = [];
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(collect); return; }
    if (typeof value !== "object" || value === null) return;
    for (const [key, entry] of Object.entries(value)) {
      // A modal's prefilled answers count too; placeholders are text objects, collected like any other.
      if ((key === "text" || key === "initial_value") && typeof entry === "string") texts.push(visibleSlackText(entry));
      else collect(entry);
    }
  };
  for (const message of [...e2e.slack.posts, ...e2e.slack.updates, ...e2e.slack.ephemerals]) {
    texts.push(visibleSlackText(message.text));
    collect(message.blocks);
  }
  for (const response of e2e.slack.responses) texts.push(response.text);
  for (const opened of e2e.slack.views) collect(opened.view);
  return texts;
}

/**
 * The journey was driven from Slack alone: after setup the broker saw only Slack ingress events and the worker's
 * own callbacks, never a developer (MCP) or admin route; the coding, check and review runs could get no repository
 * token at all; only publication got a push token; and nothing shown in Slack uses a banned word.
 */
function expectSlackOnly(e2e: WorkflowE2E): void {
  expect(e2e.brokerCalls.filter((call) => !call.startsWith("event:agentx.slack-ingress/") && !WORKER_CALLBACK_ROUTE.test(call))).toEqual([]);
  expect(e2e.brokerCalls.some((call) => call.startsWith("event:agentx.slack-ingress/"))).toBe(true);
  // Positive control: preparation's grant, through the same route, gets a clone token and is refused a push.
  expect(e2e.credentialAttempts.filter((attempt) => attempt.during === "prepare").map((attempt) => [attempt.access, attempt.status])).toEqual([["clone", 200], ["push", 403]]);
  // A coding, check or review run is given no repository grant, so every exchange tried for it is refused: with no
  // grant, and with an earlier operation's grant, for clone and for push.
  const taskAttempts = e2e.credentialAttempts.filter((attempt) => attempt.during === "task");
  expect(taskAttempts.filter((attempt) => attempt.status !== 403)).toEqual([]);
  for (const grant of ["none", "earlier"] as const) {
    for (const access of ["clone", "push"] as const) expect(taskAttempts.some((attempt) => attempt.grant === grant && attempt.access === access)).toBe(true);
  }
  // So the ledger holds one clone token, minted for preparation, and one push token, minted for publication; none during a task.
  expect(e2e.github.minted.map((entry) => [entry.during, entry.access])).toEqual([["prepare", "clone"], ["publish", "push"]]);
  expect(everythingShown(e2e).filter((text) => JARGON.test(text))).toEqual([]);
}

/** How many model inputs have been seen so far; `inputsSince` reads the ones after. */
function markInputs(e2e: WorkflowE2E): { prompts: number; turns: number } {
  return { prompts: e2e.prompts.length, turns: e2e.turns.length };
}

/**
 * The distinct model inputs since `mark` that contain `text`: session-opening prompts and the latest user message of
 * every later call (a session's tool-call rounds repeat the same message, so it is counted once).
 */
function inputsSince(e2e: WorkflowE2E, mark: { prompts: number; turns: number }, text: string): string[] {
  return [...new Set([...e2e.prompts.slice(mark.prompts), ...e2e.turns.slice(mark.turns).map((turn) => turn.userText)])].filter((input) => input.includes(text));
}

describe("Slack-only workflow, end to end in one process", () => {
  // The broker's structured log lines (such as slack.workflow_decision_saved) are captured here, not printed.
  let log: MockInstance<typeof console.log>;
  const logged = () => log.mock.calls.map(([line]) => String(line));
  beforeEach(() => { log = vi.spyOn(console, "log").mockImplementation(() => undefined); });
  afterEach(() => { log.mockRestore(); });

  it("takes a Quick request from a Slack mention through plan approval, coding, passing checks and automatic reviews to an automatic draft pull request", async () => {
    const OLDER = "farewell takes an untyped name.";
    const e2e = await createWorkflowE2E({ optionalChecks: [LINT], model: { plan: PLAN, edits: EDITS,
      // The code review notes an older problem in a file the change never touched: advisory, so it does not block.
      reviews: { CODE: [reviewerReply.json([{ text: OLDER, origin: "PRE_EXISTING", severity: "LOW", file: "repo/demo/farewell.ts", line: 1 }])] } },
      // Task 21: the classifier model sorts the plain request as a small change.
      route: () => ({ kind: "small_change", outcome: "ok" }) });
    // A plain request is routed: a small change gets a card suggesting Quick, and nothing starts until the requester's Start.
    expect(await e2e.mention("Add a greet(name) function")).toBe(200);
    expect(e2e.routeCalls).toEqual(["Add a greet(name) function"]);
    const routedCard = e2e.slack.lastPostWithAction("agentx_workflow_path_quick");
    expect(routedCard.text).toContain("Looks like a small change. I'll use Quick.");
    expect(e2e.db.find((item) => String(item.pk).startsWith("DEVTASK#"))).toEqual([]);
    await e2e.click("agentx_workflow_path_quick");
    expect(e2e.slack.updates.at(-1)?.text).toContain("chose Quick.");
    // The card is retired: its suggestion kept, its buttons gone.
    expect(JSON.stringify(e2e.slack.updates.at(-1)?.blocks)).toContain("Looks like a small change.");
    expect(JSON.stringify(e2e.slack.updates.at(-1)?.blocks)).not.toContain("\"actions\"");
    expect(e2e.workflow().path).toBe("QUICK");
    await e2e.settle();
    expect(e2e.slack.lastPostWithAction("agentx_workflow_approve").text).toContain("coding plan");
    // The owner's reply in their own task's thread is never met with the view-only notice, nor run as a chat request.
    expect(await e2e.mention("looks good so far")).toBe(200);
    expect(e2e.slack.posts.map((post) => post.text)).not.toContain(VIEW_ONLY_NOTICE);
    expect(e2e.chatQueue).toEqual([]);
    // Plain replies, with no mention, from the owner and a teammate are saved for the next step.
    expect(await e2e.mention("Keep the greeting in English.", { type: "message" })).toBe(200);
    expect(await e2e.mention("Please also handle an empty name.", { type: "message", user: "U0TEAMMATE1" })).toBe(200);
    expect(e2e.chatQueue).toEqual([]);
    // The owner approves the coding plan and selects the project's optional check.
    await e2e.click("agentx_workflow_approve");
    expect(e2e.slack.views.at(-1)?.view).toMatchObject({ title: { text: "Approve coding plan" } });
    expect(JSON.stringify(e2e.slack.views.at(-1)?.view.blocks)).toContain(LINT.label);
    await e2e.submitView(SELECT_LINT);
    await e2e.settle();
    expect(logged().some((line) => line.includes("slack.workflow_decision_saved"))).toBe(true);
    expect(e2e.workflow().decisions.at(-1)).toMatchObject({ decision: "APPROVE", selectedOptionalCheckIds: [LINT.id] });
    // The coding step reopens the planning conversation, so its prompt is that session's latest user turn, not a first prompt.
    const implementPrompt = [...e2e.prompts, ...e2e.turns.map((turn) => turn.userText)].find((prompt) => prompt.includes("Implement the human-approved plan"));
    // The mention above ("looks good so far") is the owner's too; all three reach the coding step.
    expect(implementPrompt).toMatch(new RegExp(`<thread_reply id="[0-9a-f]{16}" author="owner">looks good so far</thread_reply>`));
    expect(implementPrompt).toMatch(new RegExp(`<thread_reply id="[0-9a-f]{16}" author="owner">Keep the greeting in English.</thread_reply>`));
    expect(implementPrompt).toMatch(new RegExp(`<thread_reply id="[0-9a-f]{16}" author="teammate">Please also handle an empty name.</thread_reply>`));
    // ...inside the section that marks them untrusted.
    expect(implementPrompt).toContain(UNTRUSTED_REPLIES);
    // The mention got a private acknowledgement; nothing was posted in the thread for any reply.
    expect(e2e.slack.ephemerals.map((entry) => entry.text)).toEqual(["Saved. I'll include this at the next step."]);
    const workflow = e2e.workflow();
    // Once the checks passed, the code and security reviews started with no one asking, and both passed.
    expect(e2e.db.find((item) => item.entityType === "OPERATION" && item.workflowMode === "REVIEW")).toHaveLength(1);
    expect(e2e.db.find((item) => item.pk === "WORKFLOW_DISPATCH")).toEqual([]);
    expect(workflow.reviews?.map((review) => [review.role, review.status, review.candidateDigest]).sort()).toEqual([
      ["CRITIC", "PASS", workflow.candidate?.digest], ["SECURITY", "PASS", workflow.candidate?.digest],
    ]);
    // The first verified code pins where the task started, so reviewers see only this task's change.
    expect(workflow.reviewBase).toEqual([{ repositoryId: "demo", baseCommitSha: e2e.baseCommit }]);
    expect(workflow.candidate?.repositories[0]?.baseCommitSha).toBe(e2e.baseCommit);
    expect(workflow.verification?.results.every((result) => result.status === "PASS")).toBe(true);
    expect(await e2e.repoFile("greeting.ts")).toContain("export function greet");
    // The required check and the selected optional one both ran, each on exactly the code that was then reviewed and published.
    const checkedCode = workflow.candidate?.repositories[0]?.treeSha;
    expect(e2e.checkRuns.map((run) => run.command)).toEqual(expect.arrayContaining([E2E_CHECK, LINT.command]));
    expect(e2e.checkRuns.every((run) => run.tree === checkedCode)).toBe(true);
    // The older problem outside the change was kept as advisory and did not stop anything.
    expect(workflow.reviews?.flatMap((review) => review.findings ?? [])).toEqual([expect.objectContaining({ text: OLDER, origin: "PRE_EXISTING" })]);
    expect(e2e.slack.posts.some((post) => JSON.stringify(post.blocks ?? []).includes("agentx_workflow_send_back"))).toBe(false);

    // Then AgentX opened the draft pull request itself, of exactly the checked tree, with no MCP call and no click.
    expect(workflow.stage).toBe("WAIT_FOR_MERGE");
    expect(workflow.state).toBe("WAITING");
    const checkedTree = workflow.candidate?.repositories[0]?.treeSha;
    expect(e2e.github.pullRequests).toHaveLength(1);
    const pullRequest = e2e.github.pullRequests[0]!;
    expect(pullRequest).toMatchObject({ draft: true, tree: checkedTree, baseBranch: "main", state: "open" });
    expect(workflow.pullRequests).toEqual([expect.objectContaining({ number: pullRequest.number, url: pullRequest.url, headSha: pullRequest.commit })]);
    // One push, by the publish step with a push token; every token a coding, check or review run got was clone-only.
    const pushes = [...e2e.github.pushes.values()];
    expect(pushes).toHaveLength(1);
    expect(e2e.github.tokens.get(pushes[0]!.token)).toBe("push");
    expect(e2e.github.minted.filter((entry) => entry.access === "push").map((entry) => entry.during)).toEqual(["publish"]);
    expect(e2e.github.minted.filter((entry) => entry.during !== "publish").every((entry) => entry.access === "clone")).toBe(true);
    // The link is posted in the task's thread, briefly.
    const linkPost = e2e.slack.posts.find((post) => post.threadTs !== undefined && post.text.includes(pullRequest.url));
    expect(linkPost?.text).toMatch(/^Draft pull request opened: /);
    expect(visibleSlackText(linkPost!.text).length).toBeLessThanOrEqual(BRIEF_LIMIT);
    // Every post says each step once, in plain words: no status words, no internal terms, never the model's own output.
    const said = e2e.slack.posts.map((post) => visibleSlackText(post.text));
    expect(said.filter((text) => JARGON.test(text))).toEqual([]);
    expect(said.filter((text) => text.startsWith("*Coding plan v1 is ready for your approval.*"))).toHaveLength(1);
    expect(said.filter((text) => text.startsWith("Draft pull request opened"))).toHaveLength(1);
    // The approval card lost its buttons once approved, and says who approved it.
    const card = e2e.slack.updates.find((update) => update.text.startsWith("*Coding plan v1 is ready"));
    expect(JSON.stringify(card?.blocks)).not.toContain("agentx_workflow_approve");
    expect(card?.blocks.at(-1)).toMatchObject({ type: "context" });
    expectSlackOnly(e2e);
  }, 120_000);

  it("takes a Full request, chosen in plain words, through requirements, design and coding plan approvals to an automatic draft pull request", async () => {
    // Each document has more to it than a card shows: its last line must never reach Slack.
    const DOCS = {
      requirements: "# Requirements\n\nGoal: greet users by name.\n\nScope: one function.\n\nNon-goals: localisation.\n\nAcceptance: greet('Ada') returns Hello, Ada (requirements detail).",
      design: "# Design\n\nAdd greet() in greeting.ts.\n\nAffected: greeting.ts only.\n\nRisks: none known.\n\nAlternatives: a template string helper (design detail).",
      plan: `${PLAN}\n3. Keep the old export.\n\nRisks: none (plan detail).`,
    };
    const e2e = await createWorkflowE2E({ canvas: "unavailable", optionalChecks: [LINT], model: { edits: EDITS,
      plan: (latest) => /requirements brief/i.test(latest) ? DOCS.requirements : /design proposal/i.test(latest) ? DOCS.design : DOCS.plan } });
    expect(await e2e.mention("Add a greet(name) function")).toBe(200);
    expect(e2e.slack.lastPostWithAction("agentx_workflow_path_full").text).toContain("How should I handle this?");
    // The requester answers the question in their own words, with no button.
    expect(await e2e.mention("full please", { type: "message" })).toBe(200);
    expect(e2e.workflow().path).toBe("FULL");
    const taskPage = `https://agentx.example.test/review/${e2e.taskId()}/task`;

    const steps = [
      // `next` is what the step after the approval asks the model for: the first input to see the reply.
      { title: "Approve requirements", name: "Requirements", detail: "(requirements detail)", reply: { text: "Greet in English only.", author: "owner", next: "design proposal" } },
      { title: "Approve design", name: "Design", detail: "(design detail)", reply: { text: "Please keep the old export too.", author: "teammate", next: "ordered coding plan" } },
      { title: "Approve coding plan", name: "Coding plan", detail: "(plan detail)", reply: undefined },
    ] as const;
    const replied: Array<{ text: string; mark: ReturnType<typeof markInputs> }> = [];
    await e2e.settle();
    for (const [index, step] of steps.entries()) {
      // A brief card: what is waiting, a short summary and a link to the task page (no Canvas here), never the document itself.
      const card = e2e.slack.lastPostWithAction("agentx_workflow_approve");
      expect(card.text).toContain(`*${step.name} v1 is ready for your approval.*`);
      expect(card.text).toContain(`<${taskPage}|`);
      expect(card.text).not.toContain(step.detail);
      // A plain reply in the thread is saved, not answered in the thread, and reaches the next step's prompt marked untrusted.
      if (step.reply !== undefined) {
        replied.push({ text: step.reply.text, mark: markInputs(e2e) });
        expect(await e2e.mention(step.reply.text, { type: "message", ...(step.reply.author === "teammate" ? { user: "U0TEAMMATE1" } : {}) })).toBe(200);
      }
      await e2e.click("agentx_workflow_approve");
      expect(e2e.slack.views.at(-1)?.view).toMatchObject({ title: { text: step.title } });
      await e2e.submitView(index === steps.length - 1 ? SELECT_LINT : {});
      await e2e.settle();
      // The card keeps its words, loses its buttons and says who approved it.
      const decided = e2e.slack.updates.filter((update) => update.ts === card.ts).at(-1);
      expect(decided?.text).toContain(`*${step.name} v1 is ready for your approval.*`);
      expect(decided?.blocks.some((block) => (block as { type: string }).type === "actions")).toBe(false);
      expect(decided?.blocks.at(-1)).toMatchObject({ type: "context" });
      expect(JSON.stringify(decided?.blocks.at(-1))).toContain(`<@${MAYA.slackUserId}>`);
      if (step.reply !== undefined) {
        // The first model input after the reply is the next step's, and it carries the reply marked untrusted.
        const seen = inputsSince(e2e, replied.at(-1)!.mark, step.reply.text);
        expect(seen).toHaveLength(1);
        const next = seen[0]!;
        expect(next).toContain(step.reply.next);
        expect(next).toContain(UNTRUSTED_REPLIES);
        expect(next).toMatch(new RegExp(`<thread_reply id="[0-9a-f]{16}" author="${step.reply.author}">${step.reply.text.replaceAll(".", "\\.")}</thread_reply>`));
      }
    }
    await e2e.settle();

    // Each reply was given once: no later step (coding, reviews) saw it again.
    for (const reply of replied) expect(inputsSince(e2e, reply.mark, reply.text)).toHaveLength(1);

    const workflow = e2e.workflow();
    expect(workflow).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING", path: "FULL" });
    expect(workflow.decisions.filter((decision) => decision.decision === "APPROVE")).toHaveLength(3);
    // The code and security reviews ran once each, by themselves.
    expect(workflow.reviews).toHaveLength(2);
    expect(e2e.db.find((item) => item.entityType === "OPERATION" && item.workflowMode === "REVIEW")).toHaveLength(1);
    // The checks, required and selected, ran on the exact code the reviews saw and the pull request carries.
    const checkedCode = workflow.candidate!.repositories[0]!.treeSha;
    expect(e2e.checkRuns.map((run) => run.command)).toEqual(expect.arrayContaining([E2E_CHECK, LINT.command]));
    expect(e2e.checkRuns.every((run) => run.tree === checkedCode)).toBe(true);
    expect(workflow.reviews?.every((review) => review.status === "PASS" && review.candidateDigest === workflow.candidate?.digest)).toBe(true);
    expect(e2e.github.pullRequests).toEqual([expect.objectContaining({ draft: true, tree: checkedCode, state: "open" })]);
    expect(e2e.slack.posts.at(-1)?.text).toMatch(/^Draft pull request opened: <https:\/\/github\.com\/example\/demo\/pull\/1\|/);
    // No reply got a thread post of its own; no document reached Slack in full.
    expect(e2e.slack.posts.map((post) => post.text).filter((text) => steps.some((step) => step.reply !== undefined && text.includes(step.reply.text)))).toEqual([]);
    expect(everythingShown(e2e).filter((text) => steps.some((step) => text.includes(step.detail)))).toEqual([]);
    expectSlackOnly(e2e);
  }, 180_000);

  it("sends a review finding back to coding from Slack, and the fixed code passes its checks and reviews to a draft pull request", async () => {
    const FINDING = "greet drops the last letter of the name.";
    const OLDER = "farewell takes an untyped name.";
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS, reviews: {
      // The first code review finds a problem the change introduced, and an older one outside it; the review after the fix passes.
      CODE: [reviewerReply.json([
        { text: FINDING, origin: "INTRODUCED", severity: "HIGH", file: "repo/demo/greeting.ts", line: 2 },
        { text: OLDER, origin: "PRE_EXISTING", severity: "LOW", file: "repo/demo/farewell.ts", line: 1 },
      ]), reviewerReply.pass()],
      // The security reviewer first answers with a prose verdict table; its format retry passes. PASS rows never become findings.
      SECURITY: [reviewerReply.verdictRows(), reviewerReply.pass()] } } });
    expect(await e2e.mention("Add a greet(name) function")).toBe(200);
    await e2e.click("agentx_workflow_path_quick");
    await e2e.settle();
    await e2e.click("agentx_workflow_approve");
    await e2e.submitView({});
    await e2e.settle();
    // The reviews stopped it: Slack shows what they found, briefly, with the owner's ways on.
    expect(e2e.workflow()).toMatchObject({ stage: "REVIEW", state: "BLOCKED" });
    expect(e2e.github.pullRequests).toHaveLength(0);
    const findings = e2e.slack.lastPostWithAction("agentx_workflow_send_back");
    expect(findings.text).toContain("Reviews found 1 issue in this change.");
    expect(findings.text).toContain(FINDING);
    // The older problem is counted as advisory, not listed as one to fix.
    expect(findings.text).toContain("1 older issue was noted but doesn't block.");
    expect(findings.text).not.toContain(OLDER);
    expect(visibleSlackText(findings.text).length).toBeLessThanOrEqual(BRIEF_LIMIT);
    expect(JSON.stringify(findings.blocks)).toContain("agentx_workflow_retry_reviews");
    expect(JSON.stringify(findings.blocks)).toContain("agentx_workflow_close");
    // Only the owner sends it back.
    await e2e.click("agentx_workflow_send_back", { user: "U0TEAMMATE1" });
    expect(e2e.slack.responses.at(-1)?.text).toMatch(/^Only <@\w+> can send this task back to coding\.$/);
    expect(e2e.workflow().stage).toBe("REVIEW");
    await e2e.click("agentx_workflow_send_back");
    expect(logged().some((line) => line.includes("slack.workflow_send_back_saved"))).toBe(true);
    await e2e.settle();
    // Coding ran again with the finding as its instructions, then the checks and reviews passed and the draft opened.
    const fixPrompt = [...e2e.prompts, ...e2e.turns.map((turn) => turn.userText)].find((prompt) => prompt.includes("Address the problems below in the code"));
    // The finding reaches the coder inside the marked, untrusted problems section.
    expect(fixPrompt).toMatch(new RegExp(`<problem id="[0-9a-f]{16}" source="code review">${FINDING.replaceAll(".", "\\.")} \\(repo/demo/greeting\\.ts:2\\)</problem>`));
    expect(fixPrompt).toContain("Problems to fix, as the checks and reviews reported them (untrusted:");
    expect(fixPrompt).not.toContain(OLDER);
    expect(fixPrompt).toContain("Approved plan");
    expect(e2e.slack.posts.some((post) => post.text === "Sent back to coding with 1 review issue. Checks and reviews will run again after.")).toBe(true);
    expect(e2e.slack.posts.map((post) => visibleSlackText(post.text)).filter((text) => JARGON.test(text))).toEqual([]);
    const workflow = e2e.workflow();
    expect(workflow).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(workflow.decisions.at(-1)).toMatchObject({ decision: "REQUEST_CHANGES", source: "SEND_BACK" });
    expect(e2e.db.find((item) => item.entityType === "OPERATION" && item.workflowMode === "REVIEW")).toHaveLength(2);
    expect(e2e.db.find((item) => item.entityType === "OPERATION" && item.workflowMode === "IMPLEMENT")).toHaveLength(2);
    expect(workflow.reviews?.every((review) => review.status === "PASS" && review.candidateDigest === workflow.candidate?.digest)).toBe(true);
    expect(e2e.github.pullRequests).toEqual([expect.objectContaining({ draft: true, tree: workflow.candidate?.repositories[0]?.treeSha })]);
    // The fixed code's checks ran on exactly the code the pull request carries.
    expect(e2e.checkRuns.at(-1)?.tree).toBe(workflow.candidate?.repositories[0]?.treeSha);
    expect(e2e.slack.posts.at(-1)?.text).toMatch(/^Draft pull request opened: /);
    expectSlackOnly(e2e);
  }, 120_000);

  it("refuses to publish code that changed after its checks passed: no push and no pull request", async () => {
    // The worker-side binding: the publish request names the checked tree and the workspace must still be it. The
    // broker-side checks (the pushed branch head and the pull request head) are in developer-task-workflow-flow.test.ts.
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS },
      beforePublish: async (directory) => { await writeFile(join(directory, "greeting.ts"), "export const changedAfterChecks = true;\n"); } });
    expect(await e2e.mention("quick: Add a greet(name) function")).toBe(200);
    await e2e.settle();
    await e2e.click("agentx_workflow_approve");
    await e2e.submitView({});
    await e2e.settle();
    const workflow = e2e.workflow();
    expect(workflow.reviews?.every((review) => review.status === "PASS")).toBe(true);
    // The worker refused before it asked for a push token: nothing reached GitHub.
    expect(workflow.stage).toBe("PULL_REQUEST");
    expect(e2e.github.pushes.size).toBe(0);
    expect(e2e.github.pullRequests).toEqual([]);
    expect(e2e.github.minted.filter((entry) => entry.access === "push")).toEqual([]);
    expect(e2e.slack.posts.some((post) => post.text.startsWith("Draft pull request opened"))).toBe(false);
    // The owner is told, briefly, and offered a retry.
    const refused = e2e.slack.lastPostWithAction("agentx_workflow_retry_publish");
    expect(refused.text).toContain("couldn't open the draft pull request");
    // The owner retries from that post: once the retry is accepted, the post loses its buttons (the code is still not
    // the checked code, so the retry is refused again, and a new post offers the next retry).
    const before = e2e.workflow().revision;
    await e2e.click("agentx_workflow_retry_publish");
    await e2e.settle();
    expect(e2e.workflow().revision).toBeGreaterThan(before);
    const retired = e2e.slack.updates.filter((update) => update.ts === refused.ts).at(-1);
    expect(retired).toBeDefined();
    expect(JSON.stringify(retired!.blocks)).not.toContain("agentx_workflow_retry_publish");
    expect(e2e.github.pullRequests).toEqual([]);
    expect(everythingShown(e2e).filter((text) => JARGON.test(text))).toEqual([]);
  }, 120_000);

  it("starts a plain request on the path its requester answers in plain words, and ignores anyone else's answer", async () => {
    const e2e = await createWorkflowE2E();
    expect(await e2e.mention("Add a greet(name) function")).toBe(200);
    // A teammate's answer, and the requester's unrelated chatter, start nothing and reach no one.
    expect(await e2e.mention("full", { type: "message", user: "U0TEAMMATE1" })).toBe(200);
    expect(await e2e.mention("thinking about it", { type: "message" })).toBe(200);
    expect(e2e.db.find((item) => String(item.pk).startsWith("DEVTASK#"))).toEqual([]);
    expect(await e2e.mention("let's do full", { type: "message" })).toBe(200);
    expect(e2e.workflow().path).toBe("FULL");
    expect(e2e.slack.posts.at(-1)?.text).toBe(workflowStartedNotice("FULL"));
    expect(e2e.chatQueue).toEqual([]);
    // Task 19: the typed answer takes the question's buttons away and says who chose.
    const question = e2e.slack.lastPostWithAction("agentx_workflow_path_quick");
    const answered = e2e.slack.updates.find((update) => update.ts === question.ts);
    expect(answered?.text).toContain(`<@${MAYA.slackUserId}> chose Full.`);
    expect(answered?.blocks.some((block) => (block as { type: string }).type === "actions")).toBe(false);
    // The question's buttons are spent once the task started.
    await e2e.click("agentx_workflow_path_quick");
    expect(e2e.slack.responses.at(-1)?.text).toBe("This choice is no longer waiting.");
    expect(e2e.workflow().path).toBe("FULL");
  }, 60_000);

  it("keeps the chat agent reachable with chat:", async () => {
    const e2e = await createWorkflowE2E();
    expect(await e2e.mention("chat: what does greeting.ts export?")).toBe(200);
    expect(e2e.chatQueue).toEqual([expect.objectContaining({ text: "what does greeting.ts export?" })]);
    expect(e2e.slack.posts.some((post) => post.blocks !== undefined)).toBe(false);
  }, 60_000);

  it("answers a plain question through the chat agent, with no card and no task (Task 21)", async () => {
    const e2e = await createWorkflowE2E({ route: () => ({ kind: "question", outcome: "ok" }) });
    expect(await e2e.mention("What does greeting.ts export?")).toBe(200);
    expect(e2e.chatQueue).toEqual([expect.objectContaining({ text: "What does greeting.ts export?", userId: MAYA.slackUserId })]);
    expect(e2e.slack.posts).toEqual([]);
    expect(e2e.db.find((item) => String(item.pk).startsWith("DEVTASK#") || String(item.pk).startsWith("WORKFLOW_CHOICE#"))).toEqual([]);
    expect(e2e.routeLogs).toEqual([{ event: "route.classified", fields: expect.objectContaining({ kind: "question", outcome: "ok" }) as unknown }]);
    // Never the message's text in a log.
    expect(JSON.stringify(e2e.routeLogs)).not.toContain("greeting.ts");
  }, 60_000);

  it("skips the model for every prefix (Task 21)", async () => {
    const e2e = await createWorkflowE2E({ route: () => { throw new Error("the model must not be asked"); } });
    expect(await e2e.mention("chat: what does greeting.ts export?")).toBe(200);
    expect(await e2e.mention("workflow: add a greet(name) function", { ts: "1695500100.000001", threadTs: "1695500100.000001" })).toBe(200);
    expect(e2e.slack.lastPostWithAction("agentx_workflow_path_quick").text).toContain("How should I handle this?");
    expect(await e2e.mention("quick: add a greet(name) function", { ts: "1695500200.000001", threadTs: "1695500200.000001" })).toBe(200);
    expect(e2e.workflow().path).toBe("QUICK");
    expect(e2e.routeCalls).toEqual([]);
  }, 60_000);

  it("starts the other path from Use Full instead, refuses anyone else's press, and retires the card (Task 21)", async () => {
    const e2e = await createWorkflowE2E({ route: () => ({ kind: "small_change", outcome: "ok" }) });
    expect(await e2e.mention("Add a greet(name) function")).toBe(200);
    await e2e.click("agentx_workflow_path_full", { user: "U0TEAMMATE1" });
    expect(e2e.slack.responses.at(-1)?.text).toBe("Only the person who asked can choose.");
    await e2e.click("agentx_workflow_path_answer", { user: "U0TEAMMATE1" });
    expect(e2e.slack.responses.at(-1)?.text).toBe("Only the person who asked can choose.");
    expect(e2e.db.find((item) => String(item.pk).startsWith("DEVTASK#"))).toEqual([]);
    expect(e2e.chatQueue).toEqual([]);
    await e2e.click("agentx_workflow_path_full");
    expect(e2e.workflow().path).toBe("FULL");
    const retired = e2e.slack.updates.at(-1);
    expect(retired?.text).toContain(`<@${MAYA.slackUserId}> chose Full.`);
    expect(retired?.blocks.some((block) => (block as { type: string }).type === "actions")).toBe(false);
    const choice = logged().map((line) => JSON.parse(line) as Record<string, unknown>).find((line) => line.event === "route.choice");
    expect(choice).toMatchObject({ suggestion: "small_change", chosen: "FULL", choice: "switched_path" });
    expect(choice?.choiceId).toBe(e2e.routeLogs[0]?.fields.choiceId);
  }, 60_000);

  it("sends the original request to the chat agent from Just answer, or a typed answer, and starts no task (Task 21)", async () => {
    const e2e = await createWorkflowE2E({ route: () => ({ kind: "large_change", outcome: "ok" }) });
    expect(await e2e.mention("Rework how greetings are stored")).toBe(200);
    expect(e2e.slack.lastPostWithAction("agentx_workflow_path_full").text).toContain("Looks like a bigger change. I'll use Full");
    await e2e.click("agentx_workflow_path_answer");
    expect(e2e.chatQueue).toEqual([expect.objectContaining({ text: "Rework how greetings are stored", userId: MAYA.slackUserId })]);
    expect(e2e.slack.updates.at(-1)?.text).toBe(`<@${MAYA.slackUserId}> asked for an answer. I'll reply here.`);
    expect(e2e.slack.updates.at(-1)?.blocks.some((block) => (block as { type: string }).type === "actions")).toBe(false);
    // The spent card starts nothing more.
    await e2e.click("agentx_workflow_path_full");
    expect(e2e.slack.responses.at(-1)?.text).toBe("This choice is no longer waiting.");
    expect(e2e.db.find((item) => String(item.pk).startsWith("DEVTASK#"))).toEqual([]);
    expect(logged().some((line) => line.includes("\"event\":\"route.choice\"") && line.includes("\"choice\":\"just_answer\""))).toBe(true);

    // A typed `just answer`, in plain words, does the same.
    const typed = await createWorkflowE2E({ route: () => ({ kind: "small_change", outcome: "ok" }) });
    expect(await typed.mention("Fix the greeting typo")).toBe(200);
    expect(await typed.mention("just answer", { type: "message" })).toBe(200);
    expect(typed.chatQueue).toEqual([expect.objectContaining({ text: "Fix the greeting typo" })]);
    expect(typed.db.find((item) => String(item.pk).startsWith("DEVTASK#"))).toEqual([]);
  }, 60_000);

  it("offers Just answer, Quick and Full when the classifier times out, and Start is never pressed for the requester (Task 21)", async () => {
    const e2e = await createWorkflowE2E({ route: () => ({ kind: "unclear", outcome: "timeout" }) });
    expect(await e2e.mention("Make greetings better")).toBe(200);
    const card = e2e.slack.lastPostWithAction("agentx_workflow_path_answer");
    expect(card.text).toContain("How should I handle this?");
    expect(JSON.stringify(card.blocks)).not.toContain("\"Start\"");
    expect(e2e.routeLogs[0]).toMatchObject({ event: "route.classified", fields: { kind: "unclear", outcome: "timeout" } });
    expect(e2e.db.find((item) => String(item.pk).startsWith("DEVTASK#"))).toEqual([]);
    await e2e.click("agentx_workflow_path_quick");
    expect(e2e.workflow().path).toBe("QUICK");
  }, 60_000);
});

describe("FakeGitHub", () => {
  it("accepts a push only with a push token it minted, and records a draft pull request as a draft", async () => {
    const github = new FakeGitHub();
    const commit = "c".repeat(40);
    const tree = "b".repeat(40);
    expect(() => github.push(undefined, "agentx/a", commit, tree)).toThrow(/cannot push/);
    const clone = (await github.resolveCredential("ref", "https://github.com/example/demo.git", "clone")).token;
    expect(() => github.push(clone, "agentx/a", commit, tree)).toThrow(/cannot push/);
    expect(() => github.push("ghs_unknown", "agentx/a", commit, tree)).toThrow(/cannot push/);
    expect(github.pushes.size).toBe(0);
    const push = (await github.resolveCredential("ref", "https://github.com/example/demo.git", "push")).token;
    github.push(push, "agentx/a", commit, tree);
    await github.gateway.reconcilePullRequest({ repositoryUrl: "https://github.com/example/demo.git", headBranch: "agentx/a", baseBranch: "main", title: "t", draft: true });
    expect(github.pullRequests).toEqual([expect.objectContaining({ draft: true, commit, tree })]);
    expect(await github.gateway.getCommitTree("https://github.com/example/demo.git", commit)).toBe(tree);
  });
});
