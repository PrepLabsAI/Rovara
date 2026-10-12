import { describe, expect, it } from "vitest";
import { CHANNEL_MEMBERS_MAX_CHANNELS } from "@agentx/contracts";
import { slackDirectory } from "../../packages/broker/src/developer/slack-directory.js";
import { BOT_TOKEN, T0, TEAM, fakeSlack, routeFetch } from "../support/developer-fakes.js";

type Problem = { method: string; status: number | undefined; error: string };
const requestUrl = (input: Parameters<typeof fetch>[0]) => new URL(input instanceof URL ? input.href : typeof input === "string" ? input : input.url);

function directory(users: Parameters<typeof fakeSlack>[0]["users"], channels: Record<string, string[]> = {}, options: { maxCallsPerRequest?: number; botToken?: string; channelInfo?: Record<string, { name: string; isPrivate?: boolean }> } = {}) {
  let clock = T0;
  const problems: Problem[] = [];
  const fake = fakeSlack({ users, channels, ...(options.channelInfo === undefined ? {} : { channelInfo: options.channelInfo }) });
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

  it("answers a full batch of cold channels within one request's default call budget, with room for a second page each", async () => {
    const channels = Object.fromEntries(Array.from({ length: CHANNEL_MEMBERS_MAX_CHANNELS }, (_, index) => [`C0CH${String(index).padStart(5, "0")}`, index === 7 ? ["U0MAYA001"] : ["U01"]]));
    const { dir, fetch } = directory([], channels);
    expect(await dir.channelMembers("U0MAYA001", Object.keys(channels))).toEqual({ ok: true, memberOf: ["C0CH00007"] });
    expect(membersCalls(fetch)).toBe(CHANNEL_MEMBERS_MAX_CHANNELS);
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

describe("fresh task person proof", () => {
  it("lists a complete fresh bounded channel directory without reusing warm membership", async () => {
    const channels = { C0PAY0001: ["U0MAYA001", "U0OTHER01"] };
    const { dir } = directory([
      { userId: "U0MAYA001", name: "Maya Chen" },
      { userId: "U0OTHER01", name: "Other Owner" },
    ], channels);
    await dir.channelMembers("U0OTHER01", ["C0PAY0001"]);
    channels.C0PAY0001 = ["U0MAYA001"];
    await expect(dir.taskChannelPeople(["C0PAY0001"])).resolves.toEqual({ ok: true, users: [
      { id: "U0MAYA001", teamId: TEAM, name: "Maya Chen", memberOf: ["C0PAY0001"] },
    ] });
  });
  it("warm_membership_cache_does_not_keep_departed_owner_authorized", async () => {
    const channels = { C0PAY0001: ["U0MAYA001"] };
    const { dir, fetch } = directory([{ userId: "U0MAYA001", name: "Maya Chen" }], channels);
    expect(await dir.channelMembers("U0MAYA001", ["C0PAY0001"])).toEqual({ ok: true, memberOf: ["C0PAY0001"] });

    channels.C0PAY0001.length = 0;

    expect(await dir.taskPersonProof("U0MAYA001", ["C0PAY0001"])).toEqual({
      ok: true,
      user: { id: "U0MAYA001", teamId: TEAM, name: "Maya Chen" },
      memberOf: [],
    });
    expect(membersCalls(fetch)).toBe(2);
  });

  it("invite_then_reread_ignores_cached_preinvite_state", async () => {
    const channels = { C0PAY0001: [] as string[] };
    const { dir, fetch } = directory([{ userId: "U0MAYA001", name: "Maya Chen" }], channels);
    expect(await dir.channelMembers("U0MAYA001", ["C0PAY0001"])).toEqual({ ok: true, memberOf: [] });

    channels.C0PAY0001.push("U0MAYA001");

    expect(await dir.taskPersonProof("U0MAYA001", ["C0PAY0001"])).toMatchObject({ ok: true, memberOf: ["C0PAY0001"] });
    expect(membersCalls(fetch)).toBe(2);
  });

  it("does not join a previously in-flight display read", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let calls = 0;
    const fetch: typeof globalThis.fetch = async (input) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/users.info") return Response.json({ ok: true, user: { id: "U0MAYA001", team_id: TEAM, deleted: false, is_bot: false, real_name: "Maya Chen" } });
      if (url.pathname === "/api/conversations.members") {
        calls += 1;
        if (calls === 1) {
          await firstStarted;
          return Response.json({ ok: true, members: ["U0MAYA001"], response_metadata: { next_cursor: "" } });
        }
        return Response.json({ ok: true, members: [], response_metadata: { next_cursor: "" } });
      }
      throw new Error(`unexpected Slack method: ${url.pathname}`);
    };
    const dir = slackDirectory({ teamId: TEAM, botToken: async () => BOT_TOKEN, fetch, now: () => T0 });
    const display = dir.channelMembers("U0MAYA001", ["C0PAY0001"]);
    while (calls === 0) await Promise.resolve();

    const proof = await dir.taskPersonProof("U0MAYA001", ["C0PAY0001"]);
    releaseFirst!();

    expect(proof).toMatchObject({ ok: true, memberOf: [] });
    await expect(display).resolves.toEqual({ ok: true, memberOf: ["C0PAY0001"] });
    expect(calls).toBe(2);
  });

  it("rejects a deleted, bot, foreign, Slack Connect, mismatched, or malformed user", async () => {
    const base = { ok: true, user: { id: "U0MAYA001", team_id: TEAM, deleted: false, is_bot: false, real_name: "Maya Chen" } };
    const cases: Array<{ reply: unknown; error: "ineligible" | "slack_unavailable" }> = [
      { reply: { ...base, user: { ...base.user, deleted: true } }, error: "ineligible" },
      { reply: { ...base, user: { ...base.user, is_bot: true } }, error: "ineligible" },
      { reply: { ...base, user: { ...base.user, team_id: "T0OTHER1" } }, error: "ineligible" },
      { reply: { ...base, user: { ...base.user, is_stranger: true } }, error: "ineligible" },
      { reply: { ...base, user: { ...base.user, id: "U0OTHER01" } }, error: "slack_unavailable" },
      { reply: { ...base, user: { ...base.user, id: "not-a-slack-id" } }, error: "slack_unavailable" },
      { reply: { ok: true, user: null }, error: "slack_unavailable" },
    ];
    for (const { reply, error } of cases) {
      const fetch: typeof globalThis.fetch = async (input) => requestUrl(input).pathname === "/api/users.info"
        ? Response.json(reply)
        : Response.json({ ok: true, members: [], response_metadata: { next_cursor: "" } });
      const dir = slackDirectory({ teamId: TEAM, botToken: async () => BOT_TOKEN, fetch, now: () => T0 });
      await expect(dir.taskPersonProof("U0MAYA001", ["C0PAY0001"])).resolves.toEqual({ ok: false, error });
    }
  });

  it("accepts absent optional eligibility flags and rejects unreadable present flags", async () => {
    const eligible = { ok: true, user: { id: "U0MAYA001", team_id: TEAM, is_bot: false, real_name: "Maya Chen" } };
    const fetchWithoutFlags: typeof globalThis.fetch = async (input) => requestUrl(input).pathname === "/api/users.info"
      ? Response.json(eligible)
      : Response.json({ ok: true, members: [], response_metadata: { next_cursor: "" } });
    const withoutFlags = slackDirectory({ teamId: TEAM, botToken: async () => BOT_TOKEN, fetch: fetchWithoutFlags, now: () => T0 });
    await expect(withoutFlags.taskPersonProof("U0MAYA001", ["C0PAY0001"])).resolves.toMatchObject({ ok: true });

    const malformedFlags: Array<Record<string, unknown>> = [{ deleted: [] }, { is_bot: [] }, { is_stranger: {} }];
    for (const fields of malformedFlags) {
      const fetch: typeof globalThis.fetch = async (input) => requestUrl(input).pathname === "/api/users.info"
        ? Response.json({ ...eligible, user: { ...eligible.user, ...fields } })
        : Response.json({ ok: true, members: [], response_metadata: { next_cursor: "" } });
      const dir = slackDirectory({ teamId: TEAM, botToken: async () => BOT_TOKEN, fetch, now: () => T0 });
      await expect(dir.taskPersonProof("U0MAYA001", ["C0PAY0001"])).resolves.toEqual({ ok: false, error: "slack_unavailable" });
    }
  });

  it("fails closed on malformed members, partial paging, caps, and timeouts", async () => {
    const user = { ok: true, user: { id: "U0MAYA001", team_id: TEAM, deleted: false, is_bot: false, real_name: "Maya Chen" } };
    for (const members of [
      { ok: true, members: ["not-a-slack-id"], response_metadata: { next_cursor: "" } },
      { ok: true, members: ["U0MAYA001"], response_metadata: { next_cursor: 42 } },
      { ok: true, members: ["U0MAYA001"], response_metadata: { next_cursor: "next" } },
    ]) {
      let memberCalls = 0;
      const fetch: typeof globalThis.fetch = async (input) => {
        const url = requestUrl(input);
        if (url.pathname === "/api/users.info") return Response.json(user);
        memberCalls += 1;
        if (memberCalls > 1) throw new TypeError("timed out");
        return Response.json(members);
      };
      const dir = slackDirectory({ teamId: TEAM, botToken: async () => BOT_TOKEN, fetch, now: () => T0, maxPages: 1 });
      await expect(dir.taskPersonProof("U0MAYA001", ["C0PAY0001"])).resolves.toEqual({ ok: false, error: "slack_unavailable" });
    }

    const channels = Object.fromEntries(Array.from({ length: CHANNEL_MEMBERS_MAX_CHANNELS }, (_, index) => [`C0CH${String(index).padStart(5, "0")}`, ["U0MAYA001"]]));
    const { dir, fetch } = directory([{ userId: "U0MAYA001", name: "Maya Chen" }], channels);
    const result = await dir.taskPersonProof("U0MAYA001", Object.keys(channels));
    expect(result).toMatchObject({ ok: true, memberOf: Object.keys(channels) });
    expect(fetch.calls.filter((call) => call.includes("users.info") || call.includes("conversations.members"))).toHaveLength(51);
  });
});

describe("conversations.info for channel names (R10)", () => {
  it("returns each channel's name and privacy, and caches them for 10 minutes", async () => {
    const { dir, fetch, tick } = directory([], {}, { channelInfo: { C0PAY0001: { name: "payments-dev", isPrivate: false }, C0SEC0001: { name: "payments-sec", isPrivate: true } } });
    expect(await dir.channelInfo(["C0PAY0001", "C0SEC0001"])).toEqual({ ok: true, channels: [
      { channelId: "C0PAY0001", name: "payments-dev", isPrivate: false },
      { channelId: "C0SEC0001", name: "payments-sec", isPrivate: true },
    ] });
    await dir.channelInfo(["C0PAY0001"]);
    expect(fetch.calls.filter((call) => call.includes("conversations.info"))).toHaveLength(2);
    tick(600_001);
    await dir.channelInfo(["C0PAY0001"]);
    expect(fetch.calls.filter((call) => call.includes("conversations.info"))).toHaveLength(3);
  });

  it("leaves out a channel Slack does not know, and is unavailable when Slack is down", async () => {
    const { dir, fake } = directory([], {}, { channelInfo: { C0PAY0001: { name: "payments-dev", isPrivate: false } } });
    expect(await dir.channelInfo(["C0PAY0001", "C0GONE001"])).toEqual({ ok: true, channels: [{ channelId: "C0PAY0001", name: "payments-dev", isPrivate: false }] });
    fake.state.down = true;
    expect(await dir.channelInfo(["C0OTHER01"])).toEqual({ ok: false, error: "slack_unavailable" });
  });
});

describe("conversations.info limits (Task 7 fix round 1)", () => {
  const many = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`C0CH${String(index).padStart(5, "0")}`, { name: `chan-${index}`, isPrivate: false }]));
  const infoCalls = (fetch: { calls: string[] }) => fetch.calls.filter((call) => call.includes("conversations.info")).length;

  it("makes at most 20 cold calls per request and leaves the rest unnamed", async () => {
    const channels = many(60);
    const { dir, fetch, problems } = directory([], {}, { channelInfo: channels });
    const answer = await dir.channelInfo(Object.keys(channels));
    expect(infoCalls(fetch)).toBe(20);
    expect(answer).toEqual({ ok: true, channels: Object.keys(channels).sort().slice(0, 20).map((channelId, index) => ({ channelId, name: `chan-${index}`, isPrivate: false })) });
    expect(problems).toEqual([{ method: "conversations.info", status: undefined, error: "call_cap_reached" }]);
    // Cached names cost nothing, so the next request names the next 20.
    const next = await dir.channelInfo(Object.keys(channels));
    expect(infoCalls(fetch)).toBe(40);
    expect(next.ok && next.channels).toHaveLength(40);
  });

  it("returns the names gathered so far when Slack rate limits midway", async () => {
    const channels = many(5);
    const fake = fakeSlack({ users: [], channelInfo: channels });
    let calls = 0;
    const problems: Problem[] = [];
    const fetch = routeFetch(async (url) => (url.pathname === "/api/conversations.info" && ++calls > 2 ? Response.json({ ok: false, error: "ratelimited" }, { status: 429 }) : undefined), fake.handler);
    const dir = slackDirectory({ teamId: TEAM, botToken: async () => BOT_TOKEN, fetch, now: () => T0, report: (problem) => { problems.push(problem); } });
    expect(await dir.channelInfo(Object.keys(channels))).toEqual({ ok: true, channels: [
      { channelId: "C0CH00000", name: "chan-0", isPrivate: false },
      { channelId: "C0CH00001", name: "chan-1", isPrivate: false },
    ] });
    expect(calls).toBe(3);
    expect(problems).toEqual([{ method: "conversations.info", status: 429, error: "ratelimited" }]);
  });

  it("counts a channel with no is_private flag as private (fail closed)", async () => {
    const { dir } = directory([], {}, { channelInfo: { C0PAY0001: { name: "payments-dev" } } });
    expect(await dir.channelInfo(["C0PAY0001"])).toEqual({ ok: true, channels: [{ channelId: "C0PAY0001", name: "payments-dev", isPrivate: true }] });
  });
});
