// RD-2.0-READ-RULE: the one "may this person read this task" function (core/task-flow/read-rule.ts), by the table of 14 kinds of person x every read, run against the FUNCTION and against the REAL ROUTES (the dev routes, the
// merge route, the answers read, the real aws task rule routes over a fake table), plus the rules around it: the company first, the stored share only after the core's own rule said no, an unknown stored role is no share, a
// failing seam, one decision per request, and money and source code that belong to the decision. The golden of today's exact answers is tests/contract/rd-2-0-read-rule-golden.test.ts.
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentXError, agentXError } from "@agentx/contracts";
import { pageRule } from "../../packages/broker/src/aws/core-task-rule-routes.js";
import type { DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import type { DeveloperTaskRouteDependencies } from "../../packages/broker/src/aws/developer-tasks.js";
import type { DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { standingOf } from "../../packages/broker/src/core/task-actions/standing.js";
import { decideTaskRead, mayReadSourceCode, type TaskRead, type TaskReadDecision, type TaskReadMode, type TaskReadSeams } from "../../packages/broker/src/core/task-flow/read-rule.js";
import type { TaskAccess } from "../../packages/broker/src/core/task-flow/deps.js";
import { ALL_PERSONAS, CHANNEL_STARTER, OTHER_COMPANY, PERSONAS, readRuleWorld, personaAccess, personaOf, type Persona, type PersonaName, type ReadName } from "../support/read-rule-world.js";
import { FAKE_COMPANY } from "../support/core-host-fakes.js";

type Cell = TaskReadMode | "refused" | "part";
/** The reads the function is asked. */
const FUNCTION_READS = ["task", "answers", "readable", "merge", "events", "share", "diff", "plan", "evidence", "spec", "checks", "changes", "timeline", "comments"] as const satisfies readonly TaskRead[];

// One row per person, one cell per read, in FUNCTION_READS order: task, answers, readable, merge, events, share, diff, plan, evidence, spec, checks, changes, timeline, comments.
// o = owner (how they were admitted: the task's own person, or the owner rule), r = reader, p = page rule, s = shared, k = script, - = refused, x = part not shown.
const TABLE: Record<PersonaName, string> = {
  "owner":            "o o o o o o p o o o o o o p",
  "co-owner":         "r r r r r - p o o r r r r p",
  "project member":   "- - - - - - - - - - - - - -",
  "commenter":        "r r r r r - p - - r r r r p",
  "viewer":           "r r r r r - p - - r r r r p",
  "shared reader":    "s s - - s s - - - x x x s -",
  "unknown role":     "- - - - - - - - - - - - - -",
  "left the project": "- - - - - - - - - - - - - -",
  "company admin":    "- - - - - - - - - - - - - -",
  "admin and shared": "s s - - s s - - - x x x s -",
  "removed member":   "- - - - - - - - - - - - - -",
  "stranger":         "- - - - - - - - - - - - - -",
  "other company":    "- - - - - - - - - - - - - -",
  // A script token reads the task read, and the proof index (the host then refuses it its own words after the task was looked up).
  "script token":     "k - - - - - - - k - - - - -",
  // The starters whom the company's own rule still admits (it re-reads no grant for the task's own person with no People list) are refused on EVERY read: the live company membership and current project grant are re-read for every way in.
  "starter removed from the project": "- - - - - - - - - - - - - -",
  "starter removed from the company": "- - - - - - - - - - - - - -",
  // THE SLACK SHARE (the owner's open question): no grant, not on the list, in the channel the task is shared into: the plan comments and the diff, nothing else (CHANNEL_SHARE_PARTS, one cell each).
  "channel share member": "- - - - - - p - - - - - - p",
  // Not in the loops: a task started through the bound channel with no grant is refused on every read on the core (the hotfix's ruling (a)).
  "starter via the bound channel": "- - - - - - - - - - - - - -",
};
const CELL: Record<string, Cell> = { o: "owner", r: "reader", p: "page", s: "shared", k: "script", "-": "refused", x: "part" };
const expectedOf = (persona: PersonaName, read: TaskRead): Cell => CELL[TABLE[persona].split(" ")[(FUNCTION_READS as readonly TaskRead[]).indexOf(read)]!]!;

/** The seams the host binds for this person: the stored share (a live project member's, as stored) and the old People page rule. */
function seamsOf(persona: Persona, withLiveGrant = true): TaskReadSeams {
  return {
    sharedReader: async () => (persona.share !== undefined && persona.projectMember ? { role: persona.share } : undefined),
    // The host's live company membership and current project grant for this person (absent on a laptop).
    ...(withLiveGrant ? { liveGrant: async () => persona.role !== undefined && persona.projectMember } : {}),
    peoplePage: async () => {
      if (persona.viaShare === true) return { viaChannelShare: true as const };
      if (persona.people === undefined) throw agentXError("TASK_NOT_FOUND", "no task here that you can see");
    },
  };
}

async function decideAs(w: Awaited<ReturnType<typeof readRuleWorld>>, persona: Persona, read: TaskRead, over: { seams?: TaskReadSeams; deps?: Partial<Awaited<ReturnType<typeof flowDeps>>> } = {}): Promise<TaskReadDecision> {
  const deps = { ...await flowDeps(w), ...over.deps };
  return decideTaskRead(deps, { caller: { principal: w.caller(persona).principal }, taskId: w.taskIdOf(persona), read, role: persona.role, scriptToken: persona.scriptToken === true, seams: over.seams ?? seamsOf(persona) });
}
const flowDeps = async (w: Awaited<ReturnType<typeof readRuleWorld>>) => (await w.app.runtimeFor(FAKE_COMPANY)).flow.deps;
const outcomeOf = async (promise: Promise<TaskReadDecision>): Promise<Cell> => {
  try { return (await promise).mode; } catch (error) {
    if (error instanceof AgentXError && error.code === "TASK_PART_NOT_SHOWN") return "part";
    if (error instanceof AgentXError && error.code === "TASK_NOT_FOUND") return "refused";
    throw error;
  }
};

for (const hosted of [false, true]) describe(`the one read rule: 16 kinds of person x every read, on the function (${hosted ? "the hosted rule: it proves the grant, the starters who left are refused by it" : "a rule that trusts the stored person: the seam is the only grant check"})`, () => {
  for (const persona of ALL_PERSONAS) {
    it(`${persona.name}: ${TABLE[persona.name]}`, async () => {
      const w = await readRuleWorld({ hosted });
      for (const read of FUNCTION_READS) expect(await outcomeOf(decideAs(w, persona, read)), `${persona.name} | ${read}`).toBe(expectedOf(persona.name, read));
    });
  }
});

// RD-2d: the file behind a link of the checks read is a part of the checks: for every kind of person it is decided exactly as the checks read is (a share is told the part is not shown; a person the task is not shown to, the missing task).
for (const hosted of [false, true]) describe(`the one read rule: the evidence file read answers every person as the checks read does (${hosted ? "the hosted rule" : "a rule that trusts the stored person"})`, () => {
  for (const persona of ALL_PERSONAS) {
    it(`${persona.name}`, async () => {
      const w = await readRuleWorld({ hosted });
      const checks = await outcomeOf(decideAs(w, persona, "checks"));
      const file = await outcomeOf(decideAs(w, persona, "evidenceFile"));
      // A script token reads the task read and the proof index alone; the evidence file is refused to it (the mount refuses it before the rule).
      expect(file, persona.name).toBe(persona.scriptToken === true ? "refused" : checks);
      expect(await outcomeOf(decideAs(w, persona, "evidenceFile")), persona.name).toBe(file);
    });
  }
});

describe("the one read rule: the evidence file route asks it (RD-2d)", () => {
  const request = (id: string) => ({ method: "GET", path: `/v1/app/tasks/${id}/evidence/${"a".repeat(64)}`, headers: {}, body: "" });
  it("a share is told the checks are not shown (403), a person the task is not shown to reads a missing task, and nobody is served a file the pack does not name", async () => {
    const w = await readRuleWorld({ hosted: true });
    for (const name of ["shared reader", "admin and shared"] as const) {
      const persona = personaOf(name);
      const answer = await w.routes.route(request(w.taskIdOf(persona)), w.caller(persona));
      expect(answer?.statusCode, name).toBe(403);
      expect(JSON.parse(answer!.body), name).toEqual({ error: { code: "TASK_PART_NOT_SHOWN", message: "The owner shared this task's summary with you. The checks are not shown." } });
    }
    for (const name of ["owner", "co-owner", "commenter", "viewer", "stranger", "company admin", "other company", "left the project"] as const) {
      const persona = personaOf(name);
      const answer = await w.routes.route(request(w.taskIdOf(persona)), w.caller(persona));
      expect(answer?.statusCode, name).toBe(404);
      expect((JSON.parse(answer!.body) as { error: { code: string } }).error.code, name).toBe("TASK_NOT_FOUND");
    }
  }, 60_000);
});

for (const hosted of [false, true]) describe(`the one read rule: the same table on the real routes (${hosted ? "the hosted rule" : "a rule that trusts the stored person"})`, () => {
  // The route's answer, said as the function says it: admitted or refused (or told the part is not shown). The removed member and the script token are answered before the rule is asked, by the host.
  const routeCell = (read: ReadName, answer: { status: number; code?: string; message?: string; shape?: string }): "admitted" | "refused" | "part" | "other" => {
    if (answer.code === "TASK_PART_NOT_SHOWN") return "part";
    if (answer.code === "TASK_NOT_FOUND") return "refused";
    if (read === "answers") return answer.shape === "outcome:answered" ? "admitted" : answer.shape === "outcome:not_found" ? "refused" : "other";
    if (read === "readable") return answer.status === 200 ? "admitted" : "refused";
    if (answer.status === 401 || answer.status === 403 || answer.message === "route not found") return "other";
    return "admitted";
  };
  const ROUTE_READS: ReadonlyArray<[ReadName, TaskRead]> = [["task", "task"], ["answers", "answers"], ["readable", "readable"], ["merge", "merge"], ["events", "events"], ["diff", "diff"], ["comments", "comments"], ["plan", "plan"], ["evidence", "evidence"], ...NEW_READS_ON_ROUTES()];
  function NEW_READS_ON_ROUTES(): Array<[ReadName, TaskRead]> { return NEW_READ_NAMES.map((name) => [name, name]); }
  it("every cell the function admits is admitted by the route, every cell it refuses is refused", async () => {
    const w = await readRuleWorld({ hosted });
    const wrong: string[] = [];
    for (const persona of ALL_PERSONAS) {
      for (const [route, rule] of ROUTE_READS) {
        const answer = await w.ask(persona, route);
        const got = routeCell(route, answer);
        if (persona.name === "removed member") { if (route !== "readable" ? answer.status !== 401 : got !== "refused") wrong.push(`${persona.name} | ${route}: ${JSON.stringify(answer)}`); continue; }
        if (persona.name === "script token" && route !== "task") { if (got === "admitted") wrong.push(`${persona.name} | ${route}: admitted`); continue; }
        // The merge route's standing also admits a company owner or admin and a project admin to merge (not a read decision): those answer past the rule.
        if (route === "merge" && persona.role === "admin") { if (got === "refused") wrong.push(`${persona.name} | merge: refused`); continue; }
        // Where the company's rule trusts the stored person, the merge standing (its owner way in is the rule's own proof) admits the two starters who left; the hosted rule refuses them.
        if (route === "merge" && !hosted && persona.starter === true) { if (got === "refused") wrong.push(`${persona.name} | merge: refused`); continue; }
        const want = expectedOf(persona.name, rule);
        // The answers read hands a share no plan text (option B), so the scripted answer that cites the plan cannot be verified for it: "not found" is the share's answer there.
        const expectedRoute = want === "refused" || (route === "answers" && want === "shared") ? "refused" : want === "part" ? "part" : "admitted";
        // The four new reads are stubs until their lanes fill them: a person admitted is told the fixed ROUTE_NOT_SERVED (so "admitted" is that answer here); a filled read answers 200.
        if (NEW_READ_NAMES.includes(route as never) && got === "admitted" && (FILLED_READS.includes(route) ? answer.status !== 200 : answer.code !== "ROUTE_NOT_SERVED")) { wrong.push(`${persona.name} | ${route}: ${JSON.stringify(answer)}`); continue; }
        if (got !== expectedRoute) wrong.push(`${persona.name} | ${route}: function ${want}, route ${got} ${JSON.stringify(answer)}`);
      }
    }
    expect(wrong).toEqual([]);
  }, 120_000);
});
const NEW_READ_NAMES = ["spec", "checks", "changes", "timeline"] as const;
/** The new reads whose lane has filled the stub: a person admitted is served (200), not told ROUTE_NOT_SERVED. */
const FILLED_READS: readonly string[] = [
  "spec", // RD-2a
  "changes", // RD-2b2
  "checks", // RD-2b1
];

describe("the one read rule: what the decision carries", () => {
  it("money follows the company role rule (the stored owner as a member, or a company owner or admin), never a co-owner, a reader or a share alone; a script token has none", async () => {
    const w = await readRuleWorld();
    const money: Record<string, boolean> = {};
    for (const persona of PERSONAS) {
      try { money[persona.name] = (await decideAs(w, persona, "task")).money; } catch { /* refused: no decision */ }
    }
    expect(money).toEqual({ "owner": true, "co-owner": false, "commenter": false, "viewer": false, "shared reader": false, "admin and shared": true, "script token": false });
    // The real routes agree: the task view carries `money` for these, and for a live co-owner (the task's OWN money alone, DEC 254zzz398: `taskViewFor` keeps that predicate), and for nobody else.
    for (const persona of PERSONAS) {
      const answer = await w.ask(persona, "task");
      if (answer.status !== 200) continue;
      expect(answer.shape, persona.name).toContain(money[persona.name] === true || persona.name === "co-owner" ? "task:money" : "task:no-money");
    }
  });

  it("source code follows the grant RE-READ this request: every way in but a script token carries it where the host's live grant says yes; with no live-grant seam (a laptop) nobody does", async () => {
    const w = await readRuleWorld();
    const flags: Record<string, boolean> = {};
    for (const [persona, read] of [["owner", "task"], ["co-owner", "plan"], ["commenter", "task"], ["shared reader", "task"], ["owner", "events"], ["commenter", "diff"], ["script token", "task"]] as const) {
      const decision = await decideAs(w, personaOf(persona), read);
      flags[`${persona} | ${read}`] = decision.sourceCode;
      // The checks' code-derived details (scan items, findings, failing-test names, output links) follow the same rule, decided in the same place.
      expect(decision.codeDetails, `${persona} | ${read}`).toBe(decision.sourceCode);
    }
    expect(flags).toEqual({ "owner | task": true, "co-owner | plan": true, "commenter | task": true, "shared reader | task": true, "owner | events": true, "commenter | diff": true, "script token | task": false });
    // No seam, no proof: not the owner, not a People reader, not the old page rule.
    for (const [persona, read] of [["owner", "task"], ["commenter", "task"], ["commenter", "diff"], ["owner", "events"]] as const) {
      expect((await decideAs(w, personaOf(persona), read, { seams: seamsOf(personaOf(persona), false) })).sourceCode, `${persona} | ${read} without a live grant seam`).toBe(false);
    }
    expect(mayReadSourceCode({ grantProved: false, principal: { companyId: FAKE_COMPANY } }, { companyId: FAKE_COMPANY })).toBe(false);
    // Per reader and per task: another company's task never carries source code, whatever proved the grant.
    expect(mayReadSourceCode({ grantProved: true, principal: { companyId: FAKE_COMPANY } }, { companyId: "org_corehost00000000000b" })).toBe(false);
  });

  it("every way in re-reads the live grant: a person the company's own rule still admits (the task's starter, gone from the project, no People list; gone from the company, a People list) is refused on every read, and a live-grant seam that fails is a no", async () => {
    const w = await readRuleWorld();
    for (const name of ["starter removed from the project", "starter removed from the company"] as const) {
      const starter = personaOf(name);
      // The company's own rule says yes (that is the hole): without the live grant they are the task's owner on every read.
      const unbound = seamsOf(starter, false);
      for (const read of ["task", "answers", "readable", "merge", "events", "plan", "evidence", "spec"] as const) expect(await outcomeOf(decideAs(w, starter, read, { seams: unbound })), `${name} | ${read} before the grant is re-read`).not.toBe("refused");
      for (const read of FUNCTION_READS) expect(await outcomeOf(decideAs(w, starter, read)), `${name} | ${read}`).toBe("refused");
    }
    const owner = personaOf("owner");
    for (const read of ["task", "events", "plan"] as const) expect(await outcomeOf(decideAs(w, owner, read, { seams: { ...seamsOf(owner), liveGrant: async () => { throw new Error("grant table down"); } } })), read).toBe("refused");
  });

  it("one grant check, not two: where the company's own rule says it re-reads the grant (the hosted rule), the live-grant seam is not asked for its ways in; the old page rule and the stored person on the events still ask it once", async () => {
    const proving = await readRuleWorld({ access: { ...personaAccess(), provesProjectGrant: true } });
    const asked = vi.fn(async () => true);
    const seams = { ...seamsOf(personaOf("owner")), liveGrant: asked };
    for (const read of ["task", "readable", "merge", "plan", "spec"] as const) expect((await decideAs(proving, personaOf("owner"), read, { seams })).sourceCode, read).toBe(true);
    expect(asked).not.toHaveBeenCalled();
    // The ways the company's rule does not prove ask the seam, once each.
    for (const read of ["diff", "events"] as const) expect((await decideAs(proving, personaOf("owner"), read, { seams })).sourceCode, read).toBe(true);
    expect(asked).toHaveBeenCalledTimes(2);
    // The hosted rule says it proves the grant; a fake that does not, does not.
    expect(personaAccess().provesProjectGrant).toBeUndefined();
    const { hostedTaskAccess } = await import("../../packages/broker/src/aws/core-engine-root.js");
    expect(hostedTaskAccess({ membershipOf: async () => undefined, projectGrant: async () => false, companyId: FAKE_COMPANY }).provesProjectGrant).toBe(true);
  });

  it("the live grant is read in the TASK'S company: a person moved to another company between two reads, with a same-named grant there, is refused on every way in the grant guards", async () => {
    const w = await readRuleWorld();
    const owner = personaOf("owner");
    for (const read of ["task", "events", "diff", "comments"] as const) expect((await w.ask(owner, read)).code, `${read} before the move`).not.toBe("TASK_NOT_FOUND");
    w.moveTo(owner, OTHER_COMPANY);
    for (const read of ["task", "events", "diff", "comments", "evidence", "plan"] as const) expect((await w.ask(owner, read)).code, `${read} after the move`).toBe("TASK_NOT_FOUND");
  });

  it("the same for a person the grant is asked of by the PROJECT GRANT (not as the task's own person): a People commenter, let in by the page rule and the read rule, moved to another company with a same-named grant there, is refused on the diff, the comments, the task and the events", async () => {
    // The task's own person is asked by the hotfix's own-task test (which passes the task's company itself); a People entry is asked by `canReadProject(person, project, company)`: the line that must pass the TASK'S company.
    const w = await readRuleWorld();
    const commenter = personaOf("commenter");
    for (const read of ["diff", "comments", "task", "events"] as const) expect((await w.ask(commenter, read)).code, `${read} before the move`).not.toBe("TASK_NOT_FOUND");
    w.moveTo(commenter, OTHER_COMPANY);
    for (const read of ["diff", "comments", "task", "events"] as const) expect((await w.ask(commenter, read)).code, `${read} after the move`).toBe("TASK_NOT_FOUND");
  });

  it("a host that proves the grant but binds no live-grant seam admits nobody by the ways that need it (the stored person on the events and the readers routes, the old page rule): fail closed; a laptop (no proof) does not", async () => {
    const hosted = await readRuleWorld({ access: { ...personaAccess(), provesProjectGrant: true } });
    const owner = personaOf("owner");
    const none = seamsOf(owner, false);
    for (const read of ["share", "diff", "comments"] as const) expect(await outcomeOf(decideAs(hosted, owner, read, { seams: none })), `${read} without the seam, hosted`).toBe("refused");
    // The ways the company's rule proves itself need no seam (the events are also admitted by the company's read rule, so the stored person alone is the readers routes').
    for (const read of ["task", "plan", "merge", "events"] as const) expect(await outcomeOf(decideAs(hosted, owner, read, { seams: none })), read).not.toBe("refused");
    const laptop = await readRuleWorld();
    for (const read of ["share", "diff"] as const) expect(await outcomeOf(decideAs(laptop, owner, read, { seams: none })), `${read} on a laptop`).not.toBe("refused");
  });

  it("channel access holds an OLD-engine task only (the hotfix's ruling (a)): on a core task a person who started it through the bound channel, with no grant, is refused on every read with the same 404, their hold on their task read once per way in; the task's person with the grant is read once per way in too", async () => {
    const w = await readRuleWorld({ hosted: true, diffPullRequest: true });
    for (const read of ["events", "diff", "comments"] as const) {
      w.ownTaskReads.length = 0;
      expect((await w.ask(CHANNEL_STARTER, read)).code, `${read} for the channel starter`).toBe("TASK_NOT_FOUND");
      expect(w.ownTaskReads.length, `${read}: the hold on their task is read once`).toBe(1);
    }
    for (const read of ["task", "plan", "evidence", "merge", "spec"] as const) expect((await w.ask(CHANNEL_STARTER, read)).code, read).toBe("TASK_NOT_FOUND");
    // The task's person who holds the grant: once per way in (the events by the stored person, the diff by the page rule, whose own re-check the seam does not repeat).
    for (const read of ["events", "diff", "comments"] as const) {
      w.ownTaskReads.length = 0;
      expect((await w.ask(personaOf("owner"), read)).code, read).not.toBe("TASK_NOT_FOUND");
      expect(w.ownTaskReads.length, `${read} for the owner`).toBe(1);
    }
    // A person with no grant and no channel (the starter who left) is refused on the same reads.
    for (const read of ["events", "diff", "comments"] as const) expect((await w.ask(personaOf("starter removed from the project"), read)).code, read).toBe("TASK_NOT_FOUND");
  });

  it("THE SLACK SHARE: a person with no grant, not on the list, in the channel the task is shared into reads the plan comments and the diff (as today) and nothing else; each read is its own cell of CHANNEL_SHARE_PARTS; the decision carries no source code (no grant was proved), and the grant is not asked of them", async () => {
    const w = await readRuleWorld({ hosted: true, diffPullRequest: true });
    const member = personaOf("channel share member");
    expect((await w.ask(member, "diff")).code).not.toBe("TASK_NOT_FOUND");
    expect((await w.ask(member, "comments")).shape).toBe("comments");
    for (const read of ["task", "events", "plan", "evidence", "merge", "spec", "checks", "changes", "timeline", "answers"] as const) {
      const answer = await w.ask(member, read);
      expect(answer.code === "TASK_NOT_FOUND" || (read === "answers" && answer.shape === "outcome:not_found"), `${read}: ${JSON.stringify(answer)}`).toBe(true);
    }
    // The decision: admitted by the page rule's channel share, no source code, no code details.
    const decision = await decideAs(w, member, "diff");
    expect([decision.mode, decision.sourceCode, decision.codeDetails]).toEqual(["page", false, false]);
    // The grant seam is never asked of them (they hold none, by design).
    const asked = vi.fn(async () => false);
    const seams = { ...seamsOf(member), liveGrant: asked };
    expect((await decideAs(w, member, "comments", { seams })).mode).toBe("page");
    expect(asked).not.toHaveBeenCalled();
  });

  it("the old page rule's cached channel-membership branch (ten-minute list) cannot be reached for a plan comments or a diff read: the core's page rule seam strips the Slack identity, so a removed member is never honoured from the cache", async () => {
    const channelMember = vi.fn(async () => true);
    const deps = { documentClient: { send: async () => ({}) }, tableName: "state", now: () => Date.now(), checkAccess: async () => ({ revision: 1, policy: {}, access: "channel", channelIds: ["C0SHARED"] }), channelMember, slackTeamId: "T0SHARED", companyId: FAKE_COMPANY } as unknown as DeveloperTaskRouteDependencies;
    const task = { taskId: randomUUID(), developerId: "e".repeat(64), project: "payments", companyId: FAKE_COMPANY, share: { teamId: "T0SHARED", channelId: "C0SHARED", threadTs: "1700000000.000100" } } as unknown as DeveloperTaskRecord;
    const slackCaller = { developerId: "b".repeat(64), sessionId: "s", amr: "slack", name: "Bea", slackUserId: "U0BEA00001" } as DeveloperCaller;
    await expect(pageRule(deps, slackCaller, task)).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    expect(channelMember).not.toHaveBeenCalled();
  });

  it("the diff route reads the pull request only for a person the rule admits, and the starters who left are refused before it", async () => {
    const w = await readRuleWorld({ diffPullRequest: true });
    for (const persona of ALL_PERSONAS) {
      if (persona.name === "removed member" || persona.name === "script token") continue;
      w.diffReads.length = 0;
      const answer = await w.ask(persona, "diff");
      const admitted = expectedOf(persona.name, "diff") === "page";
      expect(answer.code, persona.name).toBe(admitted ? undefined : "TASK_NOT_FOUND");
      expect(w.diffReads.length, `${persona.name} reads of the pull request`).toBe(admitted ? 1 : 0);
    }
  });

  it("a plan the owner shared only the summary of is not handed over by the answers read: the shared reader's answer cannot cite it", async () => {
    const w = await readRuleWorld();
    expect((await w.ask(personaOf("owner"), "answers")).shape).toBe("outcome:answered");
    expect((await w.ask(personaOf("shared reader"), "answers")).shape).toBe("outcome:not_found");
    expect((await w.ask(personaOf("commenter"), "answers")).shape).toBe("outcome:answered");
  });

  it("the actions standing's reader check asks the one rule", async () => {
    const w = await readRuleWorld();
    const deps = await flowDeps(w);
    const record = (await import("../../packages/broker/src/core/task-flow/reads.js")).readTask;
    const task = (await record(deps, w.taskId))!;
    const standing = async (name: PersonaName) => (await standingOf(deps, { principal: w.caller(personaOf(name)).principal }, task))?.kind;
    expect(await standing("commenter")).toBe("reader");
    expect(await standing("stranger")).toBeUndefined();
    expect(await standing("shared reader")).toBeUndefined();
  });

  it("source code is decided afresh for each request (the answer cache of the changes read sits behind it): two readers of one task, one after the other, get their own flags", async () => {
    const w = await readRuleWorld();
    const flags: boolean[] = [];
    for (const [persona, read] of [["owner", "changes"], ["owner", "events"], ["commenter", "changes"], ["owner", "events"], ["owner", "changes"]] as const) flags.push((await decideAs(w, personaOf(persona), read)).sourceCode);
    expect(flags).toEqual([true, true, true, true, true]);
    // The flag is the decision of THIS request: a seam that answers differently the next time gives a different flag at once.
    const owner = personaOf("owner");
    expect((await decideAs(w, owner, "changes", { seams: { ...seamsOf(owner), liveGrant: async () => false } }).catch(() => undefined))?.sourceCode).toBeUndefined();
  });

  it("a stored role the code does not know is no share: refused as a missing task, and logged (once per read) with the role bounded", async () => {
    const w = await readRuleWorld();
    const log = vi.fn();
    const deps = { log };
    for (const read of ["task", "events"] as const) {
      expect(await outcomeOf(decideAs(w, personaOf("unknown role"), read, { deps, seams: { sharedReader: async () => ({ role: "editor".repeat(30) }) } }))).toBe("refused");
    }
    expect(log.mock.calls.map(([entry]) => (entry as { event: string }).event)).toEqual(["developer.task_reader_unknown_role", "developer.task_reader_unknown_role"]);
    expect(String((log.mock.calls[0]![0] as { role: string }).role).length).toBeLessThanOrEqual(40);
    expect(log.mock.calls[0]![0]).toMatchObject({ taskId: w.taskId });
  });

  it("a failing lookup of the stored share is 'no' and is logged once, in fixed words with no person and no task", async () => {
    const w = await readRuleWorld();
    const log = vi.fn();
    const down = { sharedReader: async (): Promise<never> => { throw Object.assign(new Error("grant table down for person-x"), { name: "ProvisionedThroughputExceededException" }); } };
    expect(await outcomeOf(decideAs(w, personaOf("shared reader"), "task", { deps: { log }, seams: down }))).toBe("refused");
    expect(log.mock.calls).toEqual([[{ event: "developer.task_reader_lookup_failed", errorName: "ProvisionedThroughputExceededException" }]]);
  });
});

describe("the one read rule: the order and the failures", () => {
  it("the company is checked before any seam is asked, whoever holds a share row", async () => {
    const w = await readRuleWorld();
    const other = personaOf("other company");
    const shared = vi.fn(async () => ({ role: "viewer" }));
    const page = vi.fn(async () => undefined);
    for (const read of FUNCTION_READS) expect(await outcomeOf(decideAs(w, other, read, { seams: { sharedReader: shared, peoplePage: page } })), read).toBe("refused");
    expect(shared).not.toHaveBeenCalled();
    expect(page).not.toHaveBeenCalled();
    // And a missing task, for a person of the right company.
    const deps = await flowDeps(w);
    await expect(decideTaskRead(deps, { caller: { principal: w.caller(personaOf("shared reader")).principal }, taskId: randomUUID(), read: "task", seams: { sharedReader: shared } })).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    expect(shared).not.toHaveBeenCalled();
  });

  it("the stored share is asked only after the core's own rule said not found: never for a person it admits, never after another failure; a People denial reads as not found and then asks", async () => {
    const shared = vi.fn(async () => ({ role: "viewer" }));
    const accessOf = (canRead: NonNullable<TaskAccess["canRead"]>): TaskAccess => ({ ...personaAccess(), canRead });
    const owner = personaOf("owner");
    const reader = personaOf("shared reader");
    const admitted = await readRuleWorld({ access: accessOf(async () => true) });
    expect((await decideAs(admitted, owner, "task", { seams: { sharedReader: shared } })).mode).toBe("owner");
    expect(shared).not.toHaveBeenCalled();
    const broken = await readRuleWorld({ access: accessOf(async () => { throw new Error("people store down"); }) });
    await expect(decideAs(broken, reader, "task", { seams: { sharedReader: shared } })).rejects.toThrow("people store down");
    expect(shared).not.toHaveBeenCalled();
    const denied = await readRuleWorld({ access: accessOf(async () => { throw agentXError("TASK_ACCESS_DENIED", "task access could not be verified"); }) });
    expect((await decideAs(denied, reader, "task", { seams: { sharedReader: shared } })).mode).toBe("shared");
    expect(shared).toHaveBeenCalledTimes(1);
  });

  it("a lookup of the stored share that fails is 'no' on every read (the events and the readers routes included)", async () => {
    const w = await readRuleWorld();
    const reader = personaOf("shared reader");
    const down = { sharedReader: async (): Promise<never> => { throw new Error("grant table down"); } };
    for (const read of ["task", "answers", "events", "share"] as const) expect(await outcomeOf(decideAs(w, reader, read, { seams: down })), read).toBe("refused");
  });

  it("a person the old page rule refuses is refused with that rule's own words, and another failure of it stays a failure", async () => {
    const w = await readRuleWorld();
    const stranger = personaOf("stranger");
    await expect(decideAs(w, stranger, "diff", { seams: { peoplePage: async () => { throw agentXError("TASK_ACCESS_DENIED", "you can't open this task yet"); } } })).rejects.toMatchObject({ code: "TASK_ACCESS_DENIED" });
    await expect(decideAs(w, stranger, "diff", { seams: { peoplePage: async () => { throw new Error("people store down"); } } })).rejects.toThrow("people store down");
    await expect(decideAs(w, stranger, "diff", { seams: {} })).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
  });

  it("the diff and the plan and proof never admit a stored share, even where the old page rule is not bound (the source code follows the repository's access, pending the owner's answer)", async () => {
    const w = await readRuleWorld();
    const shared = { sharedReader: async () => ({ role: "viewer" }) };
    for (const read of ["diff", "plan", "evidence"] as const) expect(await outcomeOf(decideAs(w, personaOf("shared reader"), read, { seams: shared })), read).toBe("refused");
  });

  it("the refusal words are the ones each read always had", async () => {
    const w = await readRuleWorld();
    const stranger = personaOf("stranger");
    const words = async (read: TaskRead) => { try { await decideAs(w, stranger, read); } catch (error) { return (error as AgentXError).message; } return ""; };
    expect(await words("task")).toBe("TASK_NOT_FOUND: no such task");
    expect(await words("merge")).toBe("TASK_NOT_FOUND: no such task");
    expect(await words("events")).toBe(`TASK_NOT_FOUND: no task ${w.taskId} of yours`);
    expect(await words("share")).toBe(`TASK_NOT_FOUND: no task ${w.taskId} of yours`);
  });
});

describe("the one read rule: one decision per request, made by the mount", () => {
  it("the task page's new reads ask the company's rule once per request; no handler asks again", async () => {
    const canRead = vi.fn(async () => true);
    const canAct = vi.fn(async () => true);
    const w = await readRuleWorld({ access: { ...personaAccess(), canRead, canAct } });
    const owner = personaOf("owner");
    for (const read of NEW_READ_NAMES) {
      canRead.mockClear(); canAct.mockClear();
      await w.ask(owner, read);
      expect(canRead, read).toHaveBeenCalledTimes(1);
      expect(canAct, read).not.toHaveBeenCalled();
    }
  });
});

describe("the one read rule: no second copy of the rule", () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith(".ts") ? [path] : [];
  });
  const root = new URL("../../packages/broker/src", import.meta.url).pathname;
  const sources = walk(root).map((path) => ({ path: path.slice(root.length + 1), text: readFileSync(path, "utf8") }));
  const where = (pattern: RegExp): string[] => sources.filter(({ text }) => pattern.test(text)).map(({ path }) => path).sort();
  const count = (pattern: RegExp): Record<string, number> => Object.fromEntries(sources.flatMap(({ path, text }) => { const found = text.match(new RegExp(pattern.source, "gu"))?.length ?? 0; return found === 0 ? [] : [[path, found] as const]; }).sort());

  it("no file in core-host imports or defines a reader of its own, and the old names exist nowhere", () => {
    expect(sources.filter(({ path }) => path.startsWith("core-host/")).length).toBeGreaterThan(20);
    expect(where(/\b(loadReadableTask|readsAsReader|sharedReaderTask)\b/u)).toEqual([]);
  });

  it("only the read rule asks the company's read rule (`access.canRead`): a handler that asks it itself fails here", () => {
    expect(where(/\baccess\??\.canRead\b/u)).toEqual(["core/task-flow/read-rule.ts"]);
  });

  it("the old People page rule (`resolveCoreTaskAccess`, `resolveTaskReadAccess`) is asked only by the files that bind it as the rule's seam and by the old page routes: a new reader of it fails here", () => {
    expect(where(/\b(resolveCoreTaskAccess|resolveTaskReadAccess)\b/u)).toEqual([
      "aws/core-task-rule-routes.ts", "aws/developer-tasks.ts", "aws/task-e2e-artifact.ts", "developer/page-comment-access.ts", "developer/task-access.ts", "developer/task-code-routes.ts",
    ]);
  });

  it("`loadOwnedTask` in the core host is for owner MOVES only: a GET read asks the rule (the count of each file is pinned, so a new use is looked at)", () => {
    const owned = count(/\bloadOwnedTask\(/u);
    expect(Object.fromEntries(Object.entries(owned).filter(([path]) => path.startsWith("core-host/")))).toEqual({ "core-host/dev-routes.ts": 7, "core-host/parity-task-routes.ts": 2 });
  });

  it("only the read rule and the two files that bind its seams call the stored share's reader", () => {
    expect(where(/\breaderShare\b/u)).toEqual(["aws/core-task-rule-routes.ts", "aws/task-readers.ts"]);
  });
});
