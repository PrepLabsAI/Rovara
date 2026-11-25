// journey-gate: tier-growth
// Tier growth on the NORMAL flow (TIER-GROWTH-MERGE, fixed). A task with no lighter flow whose plan names a small change and whose pull request rates ABOVE that estimate: merge tracking records the growth
// (`flow.grewAfterBuild`, core/build-step/changed-files.ts:160) and the tier pass (tier-checks.ts) now runs the HIGHER tier's code and security reviews on the current head, as it always did for the lighter flow, and records the
// tier review (`recordTierReview`). Until it is on the record for the head the merge VIEW is not ready, the press is refused in the same words, the session says what runs, and the standing reads In review (running) or
// Needs you (could not run, found problems, the task's spending limit). On the real core and the real worker; a fake reviewer answers the install's model call (`tierReviewCall`), metered like any paid call (`tierReviewMeter`).
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { GROWTH_WORDS, type WorkflowSnapshot } from "../../packages/contracts/src/index.js";
import { readTask } from "../../packages/broker/src/core/task-flow/reads.js";
import { standingFactsOf } from "../../packages/broker/src/core/task-view/index.js";
import { stateOf as standingStateOf } from "../../packages/broker/src/core/task-view/state.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";
import { runPriceFor } from "../support/hosted-run-price.js";
import { JOURNEY_COMPANY } from "../support/core-browser-journey.js";
import { createJourneyWorld, MAYA, type JourneyWorld } from "./harness/hosted-core.js";
import { criticAnswer, decide, fixUntilPush, landPush, reviewRound } from "./harness/feedback.js";
import { clean, planUntilCard, startTask } from "./harness/task.js";

let world: JourneyWorld | undefined;
afterEach(async () => { vi.unstubAllGlobals(); await world?.close(); world = undefined; });

/** A plan that names one file the way the estimate reads it (a cited code range: the claim's text alone names nothing, and an estimate with no file named is already "standard"): the repository's manifest. Estimate: small. */
const SMALL_PLAN = planAnswer(
  planDocument({ title: "Add the health endpoint", claims: [{ id: "1", text: "The service answers /health.", evidence: [{ kind: "code", path: "repo/demo/package.json", startLine: 1, endLine: 1, note: "The service's manifest." }] }] }),
  { checks: { checks: [{ label: "node runs", cwd: "repo/demo", executable: "node", args: ["--version"], proves: ["1", "nc1"] }], none_reason: null } },
);
const bash = (command: string) => [fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" }), fauxAssistantMessage("I made the change.")];
/** `count` small TypeScript files in the repository's root: file0.ts, file1.ts... More than 3 files rates the diff "standard" (change-tier.ts `more_than_files`). */
const FILES = (count: number) => Array.from({ length: count }, (_, index) => `printf 'export const value${String(index)} = ${String(index)};\\n' > repo/demo/file${String(index)}.ts`).join(" && ");
/** One file of 450 lines: more than 400 lines of code rates the diff "risky" (`large_change`). */
const BIG = String.raw`node -e 'const fs=require("fs");fs.writeFileSync("repo/demo/big.ts",Array.from({length:450},(_,i)=>"export const line"+i+" = "+i+";").join("\n")+"\n")'`;
/** The tier pass (the model calls) runs only when a pass has more than 6 s left; the journeys' usual 5 s budget leaves it out. */
const TIER_PASS_BUDGET_MS = 60_000;
const OWNER_STATE = { stage: "WAIT_FOR_MERGE", state: "WAITING", blockReason: undefined };

type FlowView = NonNullable<WorkflowSnapshot["flow"]>;
const taskOf = async (w: JourneyWorld, taskId: string) => (await w.maya("GET", `/v1/dev/tasks/${taskId}`)).body.task as { status: string; workflow: WorkflowSnapshot };
const flowOf = async (w: JourneyWorld, taskId: string): Promise<FlowView> => (await taskOf(w, taskId)).workflow.flow!;
const stateOf = async (w: JourneyWorld, taskId: string) => { const { workflow } = await taskOf(w, taskId); return { stage: workflow.stage, state: workflow.state, blockReason: workflow.blockReason }; };
const tierReviews = (flow: FlowView) => (flow.quickChecks ?? []).filter((check) => (check.detail ?? "").startsWith("tier_review"));

/**
 * The MODEL GATEWAY the hosted root talks to, and what it was asked: the root is built with the gateway's address and the install's task-token key (`modelGateway`), so the grown tier's reviews go through the hosted
 * wiring (`core-host/hosted-tier-review.ts`: the task's own paid call over the gateway's agent route, its meter and cap), never through a reviewer put into the core's deps. Only the network is faked.
 * `mode`: answers, is down (503), or finds something that must be fixed. `spend`: whether the task's spending limit lets a call through (false: the gateway quotes a price no task cap can hold).
 */
interface Reviewer { other: string[]; mode: "ok" | "down" | "problem" | "unreadable" | "old"; /** The security review is down while the code review answers. */ securityDown: boolean; spend: boolean; calls: Array<{ purpose: string; level: string | undefined; files: string[]; step: string | undefined; kind: string | undefined; ceiling: number | undefined; payer: string | undefined; models: string[] | undefined }> }
const GATEWAY = "https://gateway.example";
/** The install's agent model (the deployment parameter the hosted root reads: no model is named in product code). */
const AGENT_MODEL = "claude-sonnet-4-6";
function installReviewer(w: JourneyWorld): Reviewer {
  const reviewer: Reviewer = { other: [], securityDown: false, mode: "ok", spend: true, calls: [] };
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== GATEWAY) return real(input, init);
    if (url.pathname === `/v1/service/companies/${JOURNEY_COMPANY}/rate-quote`) {
      const model = url.searchParams.get("model") ?? "";
      const dear = reviewer.spend ? {} : { inputUsdPerMillion: 1_000_000, outputUsdPerMillion: 1_000_000, cacheWriteUsdPerMillion: 1_000_000 };
      return Response.json({ runPrice: { ...runPriceFor(model, w.harness.world.clock.now), companyId: JOURNEY_COMPANY, catalogModel: model, ...dear } });
    }
    // The gateway also answers the company's rules (none): a task cannot start on this install without that read.
    if (url.pathname === "/v1/service/company-instructions") return Response.json({ company: (JSON.parse(init?.body as string) as { company: string }).company, version: "1", rules: [] });
    if (url.pathname !== "/v1/messages") { reviewer.other.push(url.pathname); return new Response("{}", { status: 404 }); }
    const token = new Headers(init?.headers).get("x-api-key") ?? "";
    const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString() || "{}") as { stp?: string; pay?: { kind?: string }; mdl?: string[]; reviewer?: { kind?: string; ceilingUsd?: number } };
    const prompt = (JSON.parse(init?.body as string) as { messages: Array<{ content: string }> }).messages[0]!.content;
    const data = /--- BEGIN UNTRUSTED DATA [^\n]*\n(.*)\n--- END/u.exec(prompt)?.[1];
    const purpose = prompt.includes("You are the security reviewer") ? "security_review" : "code_review";
    reviewer.calls.push({ purpose, level: /needs (standard|risky) checks/u.exec(prompt)?.[1], files: data === undefined ? [] : (JSON.parse(data) as { files: string[] }).files, step: claims.stp, kind: claims.reviewer?.kind, ceiling: claims.reviewer?.ceilingUsd, payer: claims.pay?.kind, models: claims.mdl });
    // A gateway older than the tier_review kind refuses the grant.
    if (reviewer.mode === "old") return new Response("{}", { status: 401 });
    if (reviewer.mode === "down" || (reviewer.securityDown && purpose === "security_review")) return new Response("{}", { status: 503 });
    if (reviewer.mode === "unreadable") return new Response("not json", { status: 200 });
    const findings = reviewer.mode === "problem" && purpose === "security_review" ? [{ text: "a secret is logged", mustFix: true }] : [];
    return Response.json({ content: [{ type: "text", text: JSON.stringify({ findings }) }], usage: { input_tokens: 400, output_tokens: 40 } });
  });
  return reviewer;
}
/** Where the task stands for its owner: the pill and the status line the served standing and the sessions read (`standingStateOf` over the facts `standingFactsOf` gathers from the real store). */
async function standingOf(w: JourneyWorld, taskId: string) {
  const deps = w.harness.runtime.flow.deps;
  const state = standingStateOf(await standingFactsOf(deps, (await readTask(deps, taskId))!));
  return { pill: state.pill, state: state.status.state, reason: state.status.reason, next: state.status.next };
}
const IN_REVIEW = (level: string) => ({ pill: "in_review", state: "checking", reason: GROWTH_WORDS.runningReason(level), next: GROWTH_WORDS.nextRunning });
const NEEDS_YOU = (words: string, next: string = GROWTH_WORDS.nextNeedsYou) => ({ pill: "decision", state: "needs_you", reason: words, next });
const owedSummary = (level: string, state: "checking" | "needs_you") => ({ status: "waiting", step: state === "checking" ? `Running the ${level} reviews` : `The ${level} reviews need you`, state });

/** The task up to a draft pull request out of draft, CI green and a linked colleague's approval on its head, and merge tracking having read it twice. The plan is SMALL_PLAN; `command` is what the coder writes. */
async function build(w: JourneyWorld, command: string) {
  const taskId = await startTask(w);
  await planUntilCard(w, taskId, { plan: SMALL_PLAN });
  await w.approvePlan(taskId);
  expect((await w.runStep("IMPLEMENT", bash(command))).operation.status).toBe("SUCCEEDED");
  expect((await w.runStep("REVIEW", clean())).operation.status).toBe("SUCCEEDED");
  const pullRequest = await w.publish();
  pullRequest.draft.draft = false;
  await w.linkGithubAsConnected(MAYA, "maya-gh");
  await w.linkColleagueGithub("priya");
  approveHead(w, pullRequest, pullRequest.commit, "11");
  await w.runJobs();
  await w.runJobs(120, TIER_PASS_BUDGET_MS);
  return { taskId, pullRequest };
}
/** CI passes on `commit` and the linked colleague approves it (the code host's side of a head). */
function approveHead(w: JourneyWorld, pullRequest: Awaited<ReturnType<JourneyWorld["publish"]>>, commit: string, runId: string): void {
  const model = w.harness.world.host.model;
  model.setChecks(commit, [{ name: "unit", state: "completed", conclusion: "success", required: false, url: "", runId }]);
  model.addReview(pullRequest.draft.id, { login: "priya", state: "APPROVED", revision: commit });
}
/** The merge button as the web app draws it (the view) alone: nothing is pressed. */
const viewOf = async (w: JourneyWorld, taskId: string) => (await w.maya("GET", `/v1/app/tasks/${taskId}/merge`)).body as { ready: boolean; message?: string };
/** The merge button as the web app draws it (the view), then the press the web app makes with what the view showed. */
async function press(w: JourneyWorld, taskId: string) {
  const seen = (await w.maya("GET", `/v1/app/tasks/${taskId}/merge`)).body as { mayMerge: boolean; ready: boolean; message?: string; risk: string; heads: unknown };
  const answer = await w.maya("POST", `/v1/app/tasks/${taskId}/merge`, { requestId: randomUUID(), expectedHeads: seen.heads, risk: seen.risk });
  return { view: { mayMerge: seen.mayMerge, ready: seen.ready, message: seen.message, risk: seen.risk }, status: answer.status, body: answer.body };
}
const REFUSED = (message: string) => ({ error: { code: "MERGE_NOT_READY", message } });
/** A teammate's comment, the owner's approval of its fix, the fix's coding step and its push, then CI and approval on the new head and merge tracking reading it twice. */
async function sendBack(w: JourneyWorld, taskId: string, pullRequest: Awaited<ReturnType<JourneyWorld["publish"]>>, comment: string, command: string) {
  w.harness.world.host.model.addDiscussionComment(pullRequest.draft.id, "priya", comment);
  const card = await reviewRound(w, taskId, criticAnswer("file0.ts"));
  expect((await decide(w, taskId, card, "APPROVE")).status).toBe(200);
  const landed = await landPush(w, await fixUntilPush(w, command));
  expect({ update: landed.update.status, result: landed.result.status }, "the core takes the push").toEqual({ update: 200, result: 200 });
  approveHead(w, pullRequest, landed.commit, "12");
  await w.runJobs();
  await w.runJobs(120, TIER_PASS_BUDGET_MS);
  return landed;
}
/** What the owner is shown besides the press: the session summary the web lists, and the decisions waiting for them. */
async function whatTheOwnerSees(w: JourneyWorld, taskId: string) {
  const sessions = (await w.maya("GET", "/v1/app/sessions")).body.sessions as Array<{ summary: { status: string; step: string; display: { state: string; next: string } } }>;
  const cards = (await w.maya("GET", "/v1/app/decisions")).body.cards as Array<{ taskId?: string }>;
  return { summary: { status: sessions[0]!.summary.status, step: sessions[0]!.summary.step, state: sessions[0]!.summary.display.state, next: sessions[0]!.summary.display.next }, cards: cards.filter((card) => card.taskId === taskId) };
}

describe("tier growth on the normal flow (no lighter flow)", () => {
  it("CONTROL: a small plan and a diff that stays small (one file) merges on the first press, no tier growth is recorded and no reviewer is asked", async () => {
    world = await createJourneyWorld({ modelGateway: { url: GATEWAY, model: AGENT_MODEL } });
    const w = world;
    const reviewer = installReviewer(w);
    const { taskId, pullRequest } = await build(w, FILES(1));
    const flow = await flowOf(w, taskId);
    expect({ tier: flow.tier?.level, source: flow.tier?.source, estimate: flow.tierHistory?.[0]?.level, grew: flow.grewAfterBuild, skipped: flow.skippedSteps }, "the estimate was small and the diff is small").toEqual({ tier: "small", source: "diff", estimate: "small", grew: undefined, skipped: undefined });
    const pressed = await press(w, taskId);
    expect({ status: pressed.status, body: pressed.body, merged: pullRequest.draft.state }).toEqual({ status: 200, body: { status: "MERGED", pullRequests: [{ repositoryId: "demo", number: 1 }] }, merged: "merged" });
    expect(reviewer.calls, "a change that did not grow is asked of no reviewer").toEqual([]);
    w.proof.assertAllCore();
  }, 240_000);

  it("a small plan whose diff rates standard: the task reads In review with the reason, the merge view is not ready and the press says the same words while the standard reviews run; once both ran on the head it merges", async () => {
    world = await createJourneyWorld({ modelGateway: { url: GATEWAY, model: AGENT_MODEL } });
    const w = world;
    const reviewer = installReviewer(w);
    reviewer.mode = "down";
    const { taskId, pullRequest } = await build(w, FILES(4));
    const flow = await flowOf(w, taskId);
    expect(flow.tierHistory?.[0], "the plan-time estimate").toMatchObject({ level: "small", source: "estimate", kinds: ["dependency"], reasons: [] });
    expect(flow.tier, "the diff tier").toMatchObject({ level: "standard", source: "diff", reasons: [{ code: "more_than_files" }], headSha: pullRequest.commit });
    expect({ grew: flow.grewAfterBuild && { from: flow.grewAfterBuild.from, to: flow.grewAfterBuild.to }, skipped: flow.skippedSteps }, "grown, nothing skipped").toEqual({ grew: { from: "small", to: "standard" }, skipped: undefined });
    expect(reviewer.calls.length, "the reviews were asked for on the grown level (the model was down)").toBeGreaterThan(0);
    expect(reviewer.calls.every((call) => call.level === "standard")).toBe(true);
    // Paid as the task's own call: the gateway's agent route, a task token for the review step, the task's payer, the one model.
    expect(reviewer.calls.every((call) => call.step === "tier_review" && call.kind === "tier_review" && (call.ceiling ?? 0) > 0 && call.payer !== undefined && call.models?.length === 1), "through the hosted wiring, as a tier_review grant with a ceiling").toBe(true);
    // WHILE they run: In review with the reason, the view is not ready, the press says the same words, nothing merged, and the session says what runs.
    const words = GROWTH_WORDS.running("standard");
    const pressed = await press(w, taskId);
    expect(pressed.view, "the view the person presses from").toEqual({ mayMerge: true, ready: false, message: words, risk: "low" });
    expect({ status: pressed.status, body: pressed.body }, "the press").toEqual({ status: 409, body: REFUSED(words) });
    expect(pullRequest.draft.state).toBe("open");
    expect(await standingOf(w, taskId)).toEqual(IN_REVIEW("standard"));
    expect(await stateOf(w, taskId)).toEqual(OWNER_STATE);
    expect(await whatTheOwnerSees(w, taskId), "no 'Ready to merge'").toEqual({ summary: { status: "waiting", step: "Running the standard reviews", state: "checking", next: GROWTH_WORDS.nextRunning }, cards: [] });
    // The reviewer is back: the next pass runs both reviews on this head and records the tier review.
    reviewer.mode = "ok";
    reviewer.calls.length = 0;
    for (let pass = 0; pass < 4 && tierReviews(await flowOf(w, taskId)).length === 0; pass += 1) await w.runJobs(1300, TIER_PASS_BUDGET_MS);
    expect(tierReviews(await flowOf(w, taskId)).map((check) => check.detail), "recorded for exactly this head, at the grown level").toEqual([`tier_review level=standard head=${pullRequest.commit}`]);
    expect(reviewer.calls.map((call) => call.purpose).sort(), "the code review and the security review").toEqual(["code_review", "security_review"]);
    expect(reviewer.calls.every((call) => call.level === "standard" && call.files.length === 4), "of the whole patch").toBe(true);
    // Wired by the hosted root (nothing was put into the core's deps by this test), and each call's usage is on the task's cost ledger, like any paid call of the task.
    const deps = w.harness.runtime.flow.deps;
    expect({ call: typeof deps.tierReviewCall, meter: typeof deps.tierReviewMeter }).toEqual({ call: "function", meter: "function" });
    expect(w.harness.db.find((row) => String(row.sk).startsWith("ENTRY#tier-review:")).length, "the two reviews' usage is booked on the task").toBe(2);
    const merged = await press(w, taskId);
    expect(merged.view).toEqual({ mayMerge: true, ready: true, message: undefined, risk: "low" });
    expect({ status: merged.status, body: merged.body, state: pullRequest.draft.state }).toEqual({ status: 200, body: { status: "MERGED", pullRequests: [{ repositoryId: "demo", number: 1 }] }, state: "merged" });
    w.proof.assertAllCore();
  }, 300_000);

  it("a second push that grows it further (standard to risky): the standard review of the old head does not count, the same round runs at risky on the new head, and then it merges", async () => {
    world = await createJourneyWorld({ modelGateway: { url: GATEWAY, model: AGENT_MODEL } });
    const w = world;
    const reviewer = installReviewer(w);
    const { taskId, pullRequest } = await build(w, FILES(4));
    const first = tierReviews(await flowOf(w, taskId)).map((check) => check.detail);
    expect(first, "the standard reviews ran on the first head").toEqual([`tier_review level=standard head=${pullRequest.commit}`]);
    expect((await viewOf(w, taskId)).ready, "and it was ready").toBe(true);
    reviewer.mode = "down";
    reviewer.calls.length = 0;
    const landed = await sendBack(w, taskId, pullRequest, "Please add a long table.", BIG);
    const flow = await flowOf(w, taskId);
    expect(flow.tier, "the new head's diff tier").toMatchObject({ level: "risky", source: "diff", headSha: landed.commit });
    expect(flow.grewAfterBuild && { from: flow.grewAfterBuild.from, to: flow.grewAfterBuild.to }, "the higher growth is recorded").toEqual({ from: "small", to: "risky" });
    // The old head's standard review is on the record and is no help: the new head owes the risky reviews.
    expect(tierReviews(flow).map((check) => check.detail), "only the old head has a review").toEqual(first);
    const words = GROWTH_WORDS.running("risky");
    const refused = await press(w, taskId);
    expect(refused.view, "not ready on the new head").toEqual({ mayMerge: true, ready: false, message: words, risk: "medium" });
    expect({ status: refused.status, body: refused.body }).toEqual({ status: 409, body: REFUSED(words) });
    expect(await standingOf(w, taskId)).toEqual(IN_REVIEW("risky"));
    expect(reviewer.calls.every((call) => call.level === "risky")).toBe(true);
    reviewer.mode = "ok";
    reviewer.calls.length = 0;
    for (let pass = 0; pass < 4 && !tierReviews(await flowOf(w, taskId)).some((check) => (check.detail ?? "").includes(landed.commit)); pass += 1) await w.runJobs(1300, TIER_PASS_BUDGET_MS);
    expect(tierReviews(await flowOf(w, taskId)).map((check) => check.detail), "the risky review is recorded for the new head").toEqual([...first, `tier_review level=risky head=${landed.commit}`]);
    expect(reviewer.calls.map((call) => `${call.purpose}:${String(call.level)}`).sort()).toEqual(["code_review:risky", "security_review:risky"]);
    expect({ status: (await press(w, taskId)).status, state: pullRequest.draft.state }).toEqual({ status: 200, state: "merged" });
    w.proof.assertAllCore();
  }, 400_000);

  it("a send-back that brings the diff back to ONE file does not lower the bar: growth stays, the old head's review does not count, the standard reviews run on the new head, and the words never say 'more than 3 files'", async () => {
    world = await createJourneyWorld({ modelGateway: { url: GATEWAY, model: AGENT_MODEL } });
    const w = world;
    const reviewer = installReviewer(w);
    const { taskId, pullRequest } = await build(w, FILES(4));
    const first = tierReviews(await flowOf(w, taskId)).map((check) => check.detail);
    expect(first).toEqual([`tier_review level=standard head=${pullRequest.commit}`]);
    reviewer.mode = "down";
    reviewer.calls.length = 0;
    const landed = await sendBack(w, taskId, pullRequest, "Please drop the extra files.", "rm repo/demo/file1.ts repo/demo/file2.ts repo/demo/file3.ts");
    const changed = execFileSync("git", ["-C", w.repository, "diff", "--name-only", w.baseCommit, "HEAD"], { encoding: "utf8" }).trim().split("\n");
    expect(changed, "the pull request now changes one file, which rates small (the control)").toEqual(["file0.ts"]);
    const flow = await flowOf(w, taskId);
    // Sticky: the level never goes down, and the growth stays, but the person is told the truth about THIS change.
    expect(flow.tier, "the tier on the new head").toMatchObject({ level: "standard", headSha: landed.commit });
    expect(flow.grewAfterBuild && { from: flow.grewAfterBuild.from, to: flow.grewAfterBuild.to }, "growth stays").toEqual({ from: "small", to: "standard" });
    expect(tierReviews(flow).map((check) => check.detail), "the old head's review is not this head's").toEqual(first);
    const refused = await press(w, taskId);
    expect(refused.view.ready).toBe(false);
    expect(refused.view.message).toBe(GROWTH_WORDS.running("standard"));
    expect(refused.view.message, "no words about files that are gone").not.toContain("3 files");
    expect(refused.status).toBe(409);
    expect(await standingOf(w, taskId)).toEqual(IN_REVIEW("standard"));
    reviewer.mode = "ok";
    reviewer.calls.length = 0;
    for (let pass = 0; pass < 4 && !tierReviews(await flowOf(w, taskId)).some((check) => (check.detail ?? "").includes(landed.commit)); pass += 1) await w.runJobs(1300, TIER_PASS_BUDGET_MS);
    expect(reviewer.calls.map((call) => `${call.purpose}:${String(call.level)}:${call.files.join(",")}`).sort(), "both reviews, at standard, on the one-file patch").toEqual(["code_review:standard:file0.ts", "security_review:standard:file0.ts"]);
    expect({ status: (await press(w, taskId)).status, state: pullRequest.draft.state }).toEqual({ status: 200, state: "merged" });
    w.proof.assertAllCore();
  }, 400_000);

  it("CAP: the task's spending limit stops the extra review round; the person is told that (Needs you, the cap words), the merge view is not ready, nothing merges; once the limit lets it through the reviews run and it merges", async () => {
    world = await createJourneyWorld({ modelGateway: { url: GATEWAY, model: AGENT_MODEL } });
    const w = world;
    const reviewer = installReviewer(w);
    reviewer.spend = false;
    const { taskId, pullRequest } = await build(w, FILES(4));
    const words = GROWTH_WORDS.cap("standard");
    const pressed = await press(w, taskId);
    expect(pressed.view).toEqual({ mayMerge: true, ready: false, message: words, risk: "low" });
    expect({ status: pressed.status, body: pressed.body }).toEqual({ status: 409, body: REFUSED(words) });
    expect(reviewer.calls, "no call was made past the limit").toEqual([]);
    expect(await standingOf(w, taskId)).toEqual(NEEDS_YOU(words, GROWTH_WORDS.nextRaiseLimit));
    await w.runJobs();
    expect((await whatTheOwnerSees(w, taskId)).summary, "the list says it too (the stored summary is refreshed by the session sweep)").toMatchObject(owedSummary("standard", "needs_you"));
    expect(pullRequest.draft.state).toBe("open");
    reviewer.spend = true;
    for (let pass = 0; pass < 4 && tierReviews(await flowOf(w, taskId)).length === 0; pass += 1) await w.runJobs(1300, TIER_PASS_BUDGET_MS);
    expect(tierReviews(await flowOf(w, taskId))).toHaveLength(1);
    expect({ status: (await press(w, taskId)).status, state: pullRequest.draft.state }).toEqual({ status: 200, state: "merged" });
    w.proof.assertAllCore();
  }, 400_000);

  it("the reviews find something that must be fixed: Needs you with that reason, never ready, never merged", async () => {
    world = await createJourneyWorld({ modelGateway: { url: GATEWAY, model: AGENT_MODEL } });
    const w = world;
    const reviewer = installReviewer(w);
    reviewer.mode = "problem";
    const { taskId, pullRequest } = await build(w, FILES(4));
    const words = GROWTH_WORDS.foundProblems("standard");
    const pressed = await press(w, taskId);
    expect(pressed.view).toEqual({ mayMerge: true, ready: false, message: words, risk: "low" });
    expect({ status: pressed.status, body: pressed.body }).toEqual({ status: 409, body: REFUSED(words) });
    expect(await standingOf(w, taskId)).toEqual(NEEDS_YOU(words));
    expect(tierReviews(await flowOf(w, taskId)), "no review is recorded for a head with problems").toEqual([]);
    for (let pass = 0; pass < 2; pass += 1) await w.runJobs(1300, TIER_PASS_BUDGET_MS);
    expect((await press(w, taskId)).status, "more passes do not shop for a clean answer").toBe(409);
    expect(pullRequest.draft.state).toBe("open");
    w.proof.assertAllCore();
  }, 300_000);

  it("PARTIAL: when the security review cannot run, the code review that passed on this head is not paid for again; and an answer that cannot be read is booked and never repeated", async () => {
    world = await createJourneyWorld({ modelGateway: { url: GATEWAY, model: AGENT_MODEL } });
    const w = world;
    const reviewer = installReviewer(w);
    reviewer.securityDown = true;
    const { taskId, pullRequest } = await build(w, FILES(4));
    expect(reviewer.calls.filter((call) => call.purpose === "code_review"), "the code review ran once and passed").toHaveLength(1);
    expect(tierReviews(await flowOf(w, taskId))).toEqual([]);
    const booked = () => w.harness.db.find((row) => String(row.sk).startsWith("ENTRY#tier-review:")).length;
    const paidFirst = booked();
    expect(paidFirst, "the code review's usage is on the ledger").toBe(1);
    reviewer.securityDown = false;
    reviewer.calls.length = 0;
    for (let pass = 0; pass < 4 && tierReviews(await flowOf(w, taskId)).length === 0; pass += 1) await w.runJobs(1300, TIER_PASS_BUDGET_MS);
    expect(reviewer.calls.map((call) => call.purpose), "only the review that had not run is asked").toEqual(["security_review"]);
    expect(tierReviews(await flowOf(w, taskId))).toHaveLength(1);
    expect({ status: (await press(w, taskId)).status, state: pullRequest.draft.state }).toEqual({ status: 200, state: "merged" });
    w.proof.assertAllCore();
  }, 400_000);

  it("an answer that cannot be read is a paid call: it is booked, asked once, and the task is not left unbooked", async () => {
    world = await createJourneyWorld({ modelGateway: { url: GATEWAY, model: AGENT_MODEL } });
    const w = world;
    const reviewer = installReviewer(w);
    reviewer.mode = "unreadable";
    await build(w, FILES(4));
    expect(reviewer.calls.filter((call) => call.purpose === "code_review"), "no second paid call after an answer that could not be read").toHaveLength(1);
    expect(w.harness.db.find((row) => String(row.sk).startsWith("ENTRY#tier-review:")).length, "booked, never at nothing").toBeGreaterThanOrEqual(1);
    w.proof.assertAllCore();
  }, 300_000);

  it("OLD GATEWAY: a gateway that does not know the tier_review kind refuses the grant (401): nothing is booked, the review never runs, the person reads could-not-run once the runs are spent, and the change never merges", async () => {
    world = await createJourneyWorld({ modelGateway: { url: GATEWAY, model: AGENT_MODEL } });
    const w = world;
    const reviewer = installReviewer(w);
    reviewer.mode = "old";
    const { taskId, pullRequest } = await build(w, FILES(4));
    for (let pass = 0; pass < 3 && (await viewOf(w, taskId)).message !== GROWTH_WORDS.couldNotRun("standard"); pass += 1) await w.runJobs(1300, TIER_PASS_BUDGET_MS);
    const words = GROWTH_WORDS.couldNotRun("standard");
    const pressed = await press(w, taskId);
    expect({ status: pressed.status, body: pressed.body }).toEqual({ status: 409, body: REFUSED(words) });
    expect(await standingOf(w, taskId)).toEqual(NEEDS_YOU(words, GROWTH_WORDS.nextRetry));
    expect(w.harness.db.find((row) => String(row.sk).startsWith("ENTRY#tier-review:")), "a refused call spent nothing").toHaveLength(0);
    expect(tierReviews(await flowOf(w, taskId))).toEqual([]);
    expect(pullRequest.draft.state).toBe("open");
    w.proof.assertAllCore();
  }, 400_000);

  it("BAR: a grown change can never merge without the higher tier's reviews on the current head, even when this install has no model gateway wired at all: the person is told it could not run, and only the code host's own merge is left", async () => {
    world = await createJourneyWorld();
    const w = world;
    const { taskId, pullRequest } = await build(w, FILES(4));
    expect(w.harness.runtime.flow.deps.tierReviewCall, "no gateway, no reviewer: the hosted root wires none").toBeUndefined();
    const words = GROWTH_WORDS.noReviewer("standard");
    const pressed = await press(w, taskId);
    expect(pressed.view).toEqual({ mayMerge: true, ready: false, message: words, risk: "low" });
    expect({ status: pressed.status, body: pressed.body }).toEqual({ status: 409, body: REFUSED(words) });
    expect(await standingOf(w, taskId)).toEqual(NEEDS_YOU(words, GROWTH_WORDS.nextNoReviewer));
    expect(tierReviews(await flowOf(w, taskId))).toEqual([]);
    expect(pullRequest.draft.state).toBe("open");
    w.proof.assertAllCore();
  }, 300_000);
});
