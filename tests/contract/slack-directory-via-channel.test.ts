// Spec 062 Phase 7c1b: the Slack directory through the built-in Slack adapter. Against one fake Slack, the directory
// answers exactly as it does when it calls Slack itself: people, members, channels, the health check, refusals and
// outages. All in-process, through the adapter's real command route.
import { describe, expect, it, vi } from "vitest";
import { builtInAdapterRecord, generateWebhookSecret } from "../../packages/contracts/src/index.js";
import { slackDirectoryCall } from "../../packages/broker/src/aws/slack-directory-channel.js";
import { createSlackChannelCommandsHandler } from "../../packages/broker/src/aws/slack-adapter.js";
import { slackDirectory, type SlackDirectory, type SlackProblem } from "../../packages/broker/src/developer/slack-directory.js";

const NOW = Date.parse("2026-11-11T12:00:00.000Z");
const SECRET = generateWebhookSecret();
const TEAM = "T0123456789";
const adapter = builtInAdapterRecord({ channel: "slack", callbackUrl: "https://api.example.com/v1/slack/channel-events", commandsUrl: "https://api.example.com/v1/slack/channel-commands", secretName: "agentx/test/channel-adapter/slack" });
const urlOf = (url: string | URL | Request) => (url instanceof Request ? url.url : url.toString());
const bodyOf = (init: RequestInit | undefined) => (typeof init?.body === "string" ? init.body : "");

type SlackAnswer = (method: string, query: Record<string, string>) => Record<string, unknown> | Error;

/** The people and channels of one fake workspace, and its answers. */
const workspace: SlackAnswer = (method, query) => {
  const users: Record<string, Record<string, unknown>> = {
    U0000000001: { id: "U0000000001", team_id: TEAM, is_bot: false, deleted: false, name: "ana", real_name: "Ana Diaz", profile: { display_name: "ana.d", real_name: "Ana Diaz", email: "ana@example.com" } },
    U0000000002: { id: "U0000000002", team_id: "T0999999999", is_bot: false, is_stranger: true, name: "guest", profile: {} },
    U0000000003: { id: "U0000000003", team_id: "T0999999999", is_bot: false, enterprise_user: { teams: [TEAM] }, name: "grid", profile: { real_name: "Grid Person" } },
    U0000000004: { id: "U0000000004", team_id: TEAM, is_bot: true, name: "bot", profile: {} },
  };
  switch (method) {
    case "users.info": return users[query.user ?? ""] === undefined ? { ok: false, error: "user_not_found" } : { ok: true, user: users[query.user ?? ""] };
    case "users.lookupByEmail": return query.email === "ana@example.com" ? { ok: true, user: users.U0000000001 } : { ok: false, error: "users_not_found" };
    case "conversations.members":
      if (query.channel === "C0000000BAD") return { ok: false, error: "channel_not_found" };
      return query.cursor === undefined
        ? { ok: true, members: ["U0000000001", "U0000000002"], response_metadata: { next_cursor: "page2" } }
        : { ok: true, members: ["U0000000003", "U0000000004"], response_metadata: { next_cursor: "" } };
    case "conversations.info":
      return query.channel === "C0000000BAD" ? { ok: false, error: "channel_not_found" } : { ok: true, channel: { name: `name-${query.channel}`, is_private: query.channel === "G0000000001" } };
    case "conversations.list":
      return query.cursor === undefined
        ? { ok: true, channels: [{ id: "C0000000001", name: "general", is_private: false }], response_metadata: { next_cursor: "more" } }
        : { ok: true, channels: [{ id: "C0000000002", name: "web", is_private: false }, { id: "G0000000001", name: "secret", is_private: true }] };
    case "auth.test": return { ok: true, team_id: TEAM };
    default: return { ok: false, error: "unknown_method" };
  }
};

function slackFetch(answer: SlackAnswer) {
  const calls: string[] = [];
  const fetchFn = vi.fn<typeof fetch>(async (url) => {
    const parsed = new URL(urlOf(url));
    const method = parsed.pathname.replace("/api/", "");
    calls.push(method);
    const result = answer(method, Object.fromEntries(parsed.searchParams));
    if (result instanceof Error) throw result;
    return new Response(JSON.stringify(result), { status: 200 });
  });
  return { calls, fetchFn };
}

/** The same directory twice: calling Slack itself, and through the adapter. */
function directories(answer: SlackAnswer = workspace) {
  const direct = slackFetch(answer);
  const adapted = slackFetch(answer);
  const problems: { direct: SlackProblem[]; adapted: SlackProblem[] } = { direct: [], adapted: [] };
  const commands = createSlackChannelCommandsHandler({ secret: async () => SECRET, botToken: async () => "xoxb-test", fetch: adapted.fetchFn, now: () => NOW });
  const call = slackDirectoryCall({
    adapter, teamId: TEAM, getSecret: async () => SECRET, checkAddresses: async () => undefined, now: () => NOW,
    fetch: async (url, init) => {
      const response = await commands({ rawPath: new URL(urlOf(url)).pathname, body: bodyOf(init), headers: init?.headers as Record<string, string>, requestContext: { http: { method: "POST" } } });
      return new Response(response.body, { status: response.statusCode, headers: response.headers });
    },
  });
  const make = (options: Partial<Parameters<typeof slackDirectory>[0]>, report: SlackProblem[]): SlackDirectory =>
    slackDirectory({ teamId: TEAM, botToken: async () => "xoxb-test", fetch: direct.fetchFn, now: () => NOW, cacheMs: 0, report: (problem) => { report.push(problem); }, ...options });
  return {
    direct: make({}, problems.direct),
    adapted: make({ call }, problems.adapted),
    calls: { direct: direct.calls, adapted: adapted.calls },
    problems,
  };
}

/** Runs one read on both, and expects the same answer and the same Slack calls. */
async function same<T>(read: (directory: SlackDirectory) => Promise<T>, answer?: SlackAnswer): Promise<T> {
  const { direct, adapted, calls, problems } = directories(answer);
  const expected = await read(direct);
  expect(await read(adapted)).toEqual(expected);
  expect(calls.adapted).toEqual(calls.direct);
  expect(problems.adapted.map((problem) => [problem.method, problem.error])).toEqual(problems.direct.map((problem) => [problem.method, problem.error]));
  return expected;
}

describe("the Slack directory through the adapter answers as Slack itself does", () => {
  it.each([
    ["a person in the team", "U0000000001", "active"],
    ["a guest from another organisation", "U0000000002", "gone"],
    ["a person linked to the team through Enterprise Grid", "U0000000003", "active"],
    ["a bot", "U0000000004", "gone"],
    ["someone Slack does not know", "U0000000009", "gone"],
  ])("for %s", async (_name, userId, status) => {
    expect(await same((directory) => directory.userStatus(userId))).toBe(status);
  });

  it("looks a person up by email, or finds none", async () => {
    expect(await same((directory) => directory.lookupByEmail("ana@example.com"))).toEqual({ userId: "U0000000001" });
    expect(await same((directory) => directory.lookupByEmail("nobody@example.com"))).toBe("none");
  });

  it("reads every page of a channel's members", async () => {
    expect(await same((directory) => directory.channelMembers("U0000000003", ["C0000000001"]))).toEqual({ ok: true, memberOf: ["C0000000001"] });
  });

  it("proves a person, with their name and channels", async () => {
    const proof = await same((directory) => directory.taskPersonProof("U0000000001", ["C0000000001"]));
    expect(proof).toEqual({ ok: true, user: { id: "U0000000001", teamId: TEAM, name: "ana.d" }, memberOf: ["C0000000001"] });
    expect(await same((directory) => directory.taskPersonProof("U0000000002", ["C0000000001"]))).toEqual({ ok: false, error: "ineligible" });
  });

  it("lists a channel's eligible people", async () => {
    const people = await same((directory) => directory.taskChannelPeople(["C0000000001"]));
    expect(people).toMatchObject({ ok: true });
    expect((people as { users: Array<{ id: string }> }).users.map((user) => user.id)).toEqual(["U0000000001", "U0000000003"]);
  });

  it("names channels, and leaves out one Slack does not know", async () => {
    expect(await same((directory) => directory.channelInfo(["C0000000001", "G0000000001", "C0000000BAD"]))).toEqual({ ok: true, channels: [
      { channelId: "C0000000001", name: "name-C0000000001", isPrivate: false },
      { channelId: "G0000000001", name: "name-G0000000001", isPrivate: true },
    ] });
  });

  it("finds a public channel by name across pages, and never a private one", async () => {
    expect(await same((directory) => directory.channelByName("web"))).toEqual({ ok: true, channel: { channelId: "C0000000002", name: "web" } });
    expect(await same((directory) => directory.channelByName("secret"))).toEqual({ ok: true });
  });

  it("checks the bot token and names its team", async () => {
    expect(await same((directory) => directory.authTest())).toEqual({ ok: true, teamId: TEAM });
  });

  it("reports a refusal about the token by Slack's code, and counts Slack unavailable", async () => {
    const refusing: SlackAnswer = () => ({ ok: false, error: "missing_scope" });
    expect(await same((directory) => directory.userStatus("U0000000001"), refusing)).toBe("unavailable");
    expect(await same((directory) => directory.authTest(), refusing)).toEqual({ ok: false, error: "missing_scope" });
  });

  it("counts Slack unavailable when it cannot be reached", async () => {
    const { adapted, problems } = directories(() => new TypeError("fetch failed"));
    expect(await adapted.userStatus("U0000000001")).toBe("unavailable");
    expect(await adapted.channelMembers("U0000000001", ["C0000000001"])).toEqual({ ok: false, error: "slack_unavailable" });
    expect(problems.adapted.map((problem) => problem.error)).toEqual(["unreachable", "unreachable"]);
  });
});
