import { describe, expect, it, vi } from "vitest";
import type { TaskPeopleDisplayReadRequest, TaskPeopleDisplayReadResponse } from "../../packages/contracts/src/developer.js";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { slackDirectory } from "../../packages/broker/src/developer/slack-directory.js";
import { taskPeopleDisplayAdmission } from "../../packages/broker/src/developer/task-people-display-budget.js";

const TEAM = "T0BUDGET1";
const CHANNEL = "C0BUDGET1";
const USER = "U0BUDGET1";
const proof = { kind: "task-person-proof" as const, slackUserId: USER, channelIds: [CHANNEL] };
const listing = { kind: "task-channel-people" as const, channelIds: [CHANNEL] };

const response = (request: TaskPeopleDisplayReadRequest, used: number): TaskPeopleDisplayReadResponse => request.operation === "proof"
  ? { operation: "proof", admission: { version: 1, slackCallsUsed: used }, result: {
    ok: true, user: { id: request.request.slackUserId, teamId: TEAM, name: "Budget User" }, memberOf: request.request.channelIds,
  } }
  : { operation: "directory", admission: { version: 1, slackCallsUsed: used }, result: { ok: true, users: [] } };

describe("Task People whole-view admission budget", () => {
  it("shares one Slack-call allowance across independent proofs and the complete directory", async () => {
    const requests: TaskPeopleDisplayReadRequest[] = [];
    const admission = taskPeopleDisplayAdmission({ now: () => 10_000, read: async (request) => {
      requests.push(request);
      return response(request, request.operation === "proof" ? 2 : 96);
    } });

    admission.admitIdentity("a".repeat(64));
    await expect(admission.proof(proof)).resolves.toMatchObject({ ok: true });
    await expect(admission.proof(proof)).resolves.toMatchObject({ ok: true });
    await expect(admission.directory(listing)).resolves.toMatchObject({ ok: true });

    expect(requests.map((request) => request.admission.slackCallsLimit)).toEqual([100, 98, 96]);
    admission.close();
  });

  it("seals after a lost or overstated usage receipt and starts no later read", async () => {
    for (const mode of ["lost", "skew"] as const) {
      let calls = 0;
      const admission = taskPeopleDisplayAdmission({ now: () => 10_000, read: async (request) => {
        calls += 1;
        if (mode === "lost") throw new Error("inert lost reply");
        return response(request, request.admission.slackCallsLimit + 1);
      } });
      await expect(admission.proof(proof)).rejects.toMatchObject({ code: "SLACK_UNAVAILABLE" });
      await expect(admission.directory(listing)).rejects.toMatchObject({ code: "SLACK_UNAVAILABLE" });
      expect(calls).toBe(1);
    }
  });

  it("counts native and linked external principals separately before publishing a directory", async () => {
    const admission = taskPeopleDisplayAdmission({ now: () => 10_000, read: async (request) => request.operation === "proof"
      ? response(request, 1)
      : { operation: "directory", admission: { version: 1, slackCallsUsed: 1 }, result: { ok: true, users: [
        { id: USER, teamId: TEAM, name: "Budget User", memberOf: [CHANNEL] },
      ] } } });
    admission.noteNativeIdentity(developerIdForSlackUser("U0NATIVE01"), "U0NATIVE01");
    for (let index = 0; index < 99; index += 1) admission.admitIdentity(index.toString(16).padStart(64, "0"));
    await expect(admission.directory(listing)).rejects.toMatchObject({ code: "SLACK_UNAVAILABLE" });
  });

  it("meters exact-bound pages, rate limits, transport failures and the pre-fetch deadline", async () => {
    let clock = 1_000;
    let mode: "pages" | "rate" | "transport" | "deadline" = "pages";
    let memberPage = 0;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      if (mode === "transport") throw new Error("inert transport failure");
      const method = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname.split("/").at(-1);
      if (mode === "rate") return new Response(JSON.stringify({ ok: false, error: "ratelimited" }), { status: 429 });
      if (method === "conversations.members") {
        memberPage += 1;
        return new Response(JSON.stringify({ ok: true, members: memberPage === 1 ? [] : [USER],
          response_metadata: { next_cursor: memberPage === 1 ? "next" : "" } }));
      }
      return new Response(JSON.stringify({ ok: true, user: {
        id: USER, team_id: TEAM, name: "Budget User", is_bot: false, deleted: false, is_stranger: false,
      } }));
    });
    const directory = slackDirectory({ teamId: TEAM, botToken: async () => {
      if (mode === "deadline") clock += 20_001;
      return "INERT";
    }, fetch, now: () => clock });

    await expect(directory.taskPeopleDisplayRead({ kind: "task-people-display-read", operation: "directory",
      admission: { version: 1, deadlineAt: clock + 20_000, slackCallsLimit: 3 }, request: listing,
      remainingNewIdentities: 100, knownNativeSlackUserIds: [] })).resolves.toMatchObject({
      admission: { slackCallsUsed: 3 }, result: { ok: true, users: [{ id: USER }] },
    });
    for (const failure of ["rate", "transport", "deadline"] as const) {
      mode = failure;
      memberPage = 0;
      fetch.mockClear();
      const answer = await directory.taskPeopleDisplayRead({ kind: "task-people-display-read", operation: "proof",
        admission: { version: 1, deadlineAt: clock + 20_000, slackCallsLimit: 2 }, request: proof });
      expect(answer.result).toEqual({ ok: false, error: "slack_unavailable" });
      expect(answer.admission.slackCallsUsed).toBe(failure === "deadline" ? 0 : 1);
      expect(fetch).toHaveBeenCalledTimes(failure === "deadline" ? 0 : 1);
    }
  });
});
