import { describe, expect, it } from "vitest";
import { slackDirectory } from "../../packages/broker/src/developer/slack-directory.js";
import { BOT_TOKEN, T0, TEAM, fakeSlack, routeFetch } from "../support/developer-fakes.js";

type Problem = { method: string; status: number | undefined; error: string };

function directory(users: Parameters<typeof fakeSlack>[0]["users"], channels: Record<string, string[]> = {}, options: { maxCallsPerRequest?: number; botToken?: string } = {}) {
  let clock = T0;
  const problems: Problem[] = [];
  const fake = fakeSlack({ users, channels });
  const fetch = routeFetch(fake.handler);
  const dir = slackDirectory({
    teamId: TEAM, botToken: async () => options.botToken ?? BOT_TOKEN, fetch, now: () => clock, report: (problem) => { problems.push(problem); },
    ...(options.maxCallsPerRequest === undefined ? {} : { maxCallsPerRequest: options.maxCallsPerRequest }),
  });
  return { fake, fetch, dir, problems, tick: (ms: number) => { clock += ms; } };
}
const membersCalls = (fetch: { calls: string[] }) => fetch.calls.filter((call) => call.includes("conversations.members")).length;

describe("users.info at refresh (FR-007, R22)", () => {
  it("is active for a person in the team, including an Enterprise Grid member of it", async () => {
    const { dir } = directory([{ userId: "U0A000001", name: "A" }, { userId: "U0B000001", name: "B", teamId: "T0HOME01", enterpriseTeams: [TEAM] }]);
    expect(await dir.userStatus("U0A000001")).toBe("active");
    expect(await dir.userStatus("U0B000001")).toBe("active");
  });

  it("is gone for a deactivated user, a bot, a user of another team, or an unknown user", async () => {
    const { dir } = directory([
      { userId: "U0D000001", name: "D", deleted: true },
      { userId: "U0E000001", name: "E", isBot: true },
      { userId: "U0F000001", name: "F", teamId: "T0OTHER1" },
    ]);
    for (const id of ["U0D000001", "U0E000001", "U0F000001", "U0NOBODY1"]) expect(await dir.userStatus(id)).toBe("gone");
  });

  it("is unavailable when Slack is down or rate limits, so a refresh never signs anyone out for it", async () => {
    const { dir, fake } = directory([{ userId: "U0A000001", name: "A" }]);
    fake.state.down = true;
    expect(await dir.userStatus("U0A000001")).toBe("unavailable");
    fake.state.down = false;
    fake.state.rateLimited = true;
    expect(await dir.userStatus("U0A000001")).toBe("unavailable");
  });
});

describe("Slack errors about the bot token", () => {
  it("treats account_inactive as unavailable: it describes the bot token, so it must not sign everyone out", async () => {
    const { dir, fake } = directory([{ userId: "U0A000001", name: "A", email: "a@example.com" }]);
    fake.state.botError = "account_inactive";
    expect(await dir.userStatus("U0A000001")).toBe("unavailable");
    expect(await dir.lookupByEmail("a@example.com")).toBe("unavailable");
  });

  it("reports the Slack error code and HTTP status, so a misconfiguration is not mistaken for an outage, and never the bot token", async () => {
    const { dir, fake, problems } = directory([{ userId: "U0A000001", name: "A" }], { C0PAY0001: ["U0A000001"] }, { botToken: "xoxb-planted-wrong-token" });
    expect(await dir.userStatus("U0A000001")).toBe("unavailable");
    expect(await dir.channelMembers("U0A000001", ["C0PAY0001"])).toEqual({ ok: false, error: "slack_unavailable" });
    fake.state.rateLimited = true;
    expect(await dir.userStatus("U0A000001")).toBe("unavailable");
    fake.state.rateLimited = false;
    fake.state.down = true;
    expect(await dir.userStatus("U0A000001")).toBe("unavailable");
    expect(problems).toEqual([
      { method: "users.info", status: 200, error: "invalid_auth" },
      { method: "conversations.members", status: 200, error: "invalid_auth" },
      { method: "users.info", status: 429, error: "ratelimited" },
      { method: "users.info", status: undefined, error: "unreachable" },
    ]);
    expect(JSON.stringify(problems)).not.toContain("xoxb-");
  });
});

describe("users.lookupByEmail (FR-012)", () => {
  it("links an active person in the team, and nobody else", async () => {
    const { dir } = directory([
      { userId: "U0A000001", name: "A", email: "a@example.com" },
      { userId: "U0D000001", name: "D", email: "d@example.com", deleted: true },
    ]);
    expect(await dir.lookupByEmail("a@example.com")).toEqual({ userId: "U0A000001" });
    expect(await dir.lookupByEmail("d@example.com")).toBe("none");
    expect(await dir.lookupByEmail("nobody@example.com")).toBe("none");
  });
});

describe("conversations.members (FR-013)", () => {
  it("pages through members and answers which channels the user is in", async () => {
    const { dir } = directory([], { C0PAY0001: ["U01", "U02", "U03", "U0MAYA001"], C0LEDGER1: ["U01"] });
    expect(await dir.channelMembers("U0MAYA001", ["C0PAY0001", "C0LEDGER1"])).toEqual({ ok: true, memberOf: ["C0PAY0001"] });
  });

  it("caches a channel's members for at most 10 minutes", async () => {
    const { dir, fetch, tick } = directory([], { C0PAY0001: ["U0MAYA001"] });
    await dir.channelMembers("U0MAYA001", ["C0PAY0001"]);
    tick(599_000);
    await dir.channelMembers("U0OTHER01", ["C0PAY0001"]);
    expect(fetch.calls.filter((call) => call.includes("conversations.members"))).toHaveLength(1);
    tick(2_000);
    await dir.channelMembers("U0MAYA001", ["C0PAY0001"]);
    expect(fetch.calls.filter((call) => call.includes("conversations.members"))).toHaveLength(2);
  });

  it("shares one Slack read when two requests want the same cold channel at once", async () => {
    const { dir, fetch } = directory([], { C0PAY0001: ["U01", "U02", "U03", "U0MAYA001"] });
    const [first, second] = await Promise.all([dir.channelMembers("U0MAYA001", ["C0PAY0001"]), dir.channelMembers("U01", ["C0PAY0001"])]);
    expect(first).toEqual({ ok: true, memberOf: ["C0PAY0001"] });
    expect(second).toEqual({ ok: true, memberOf: ["C0PAY0001"] });
    expect(membersCalls(fetch)).toBe(2);
  });

  it("caps the Slack calls one request can make on a cold cache, and fails closed past the cap", async () => {
    const { dir, fetch } = directory([], { C0A000001: ["U01", "U02", "U03", "U04"], C0B000001: ["U05", "U06", "U07", "U0MAYA001"] }, { maxCallsPerRequest: 3 });
    expect(await dir.channelMembers("U0MAYA001", ["C0A000001", "C0B000001"])).toEqual({ ok: false, error: "slack_unavailable" });
    expect(membersCalls(fetch)).toBe(3);
  });

  it("fails closed when Slack cannot be reached or a channel cannot be read", async () => {
    const { dir, fake } = directory([], { C0PAY0001: ["U0MAYA001"] });
    expect(await dir.channelMembers("U0MAYA001", ["C0GONE001"])).toEqual({ ok: false, error: "slack_unavailable" });
    fake.state.down = true;
    expect(await dir.channelMembers("U0MAYA001", ["C0PAY0001"])).toEqual({ ok: false, error: "slack_unavailable" });
  });

  it("is unavailable, not empty, when the environment has no team ID", async () => {
    const fake = fakeSlack({ users: [] });
    const dir = slackDirectory({ teamId: undefined, botToken: async () => BOT_TOKEN, fetch: routeFetch(fake.handler), now: () => T0 });
    expect(await dir.channelMembers("U0MAYA001", ["C0PAY0001"])).toEqual({ ok: false, error: "slack_unavailable" });
    expect(await dir.userStatus("U0MAYA001")).toBe("unavailable");
  });
});
