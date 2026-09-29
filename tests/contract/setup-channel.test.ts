import { describe, expect, it } from "vitest";
import { firstProjectStep } from "../../packages/cli/src/init/finish-steps.js";
import { readSlackBotToken, SLACK_BOT_SCOPES } from "../../packages/cli/src/init/slack-app.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { addChannel, channelName, slackChannelApi, SlackRateLimitedError } from "../../packages/cli/src/setup/channel-add.js";
import type { SetupCommandContext, SetupRun } from "../../packages/cli/src/setup/command-context.js";
import { waitForThreadedReply } from "../../packages/cli/src/setup/reply-watch.js";
import { initContext, memoryInitSecrets, progressHandle, scriptedPrompter, T0 } from "../support/init-fakes.js";
import type { MemoryParameterStore } from "../support/memory-parameter-store.js";
import { CONTROL_PLANE, STAGING_SETTINGS, accessToken, fakeControlPlane, fakeSlackChannels, setupServices, turn } from "../support/setup-fakes.js";

const session = { controlPlaneUrl: CONTROL_PLANE, accessToken: "admin-token" };
const TEAM = "T0123456789";
const BOT = "U0BOT00001";
const BOT_TOKEN = "xoxb-fake-bot-token-value";
function clock() { let now = T0; return { now: () => now, sleep: async (ms: number) => { now += ms; } }; }

describe("finding the channel (Review Focus 3)", () => {
  it("drops a leading # and capitals", () => {
    expect(channelName("#Payments")).toBe("payments");
    expect(channelName("  ops-alerts ")).toBe("ops-alerts");
  });
});

describe("agentx channel add (FR-041)", () => {
  it("joins a public channel the bot is not in, then binds it to the project", async () => {
    const plane = fakeControlPlane();
    const slack = fakeSlackChannels([{ id: "C0PAY00001", name: "payments", isPrivate: false, isMember: false }]);
    const result = await addChannel({ session, botToken: "xoxb-1", teamId: TEAM, botUserId: BOT, projectName: "payments-api", prompter: scriptedPrompter(["#Payments"]), write: () => undefined, ...clock(), services: { fetch: plane.fetch, slackChannels: slack }, flags: {} });
    expect(result).toEqual({ channelId: "C0PAY00001", channelName: "payments" });
    expect(slack.joined).toEqual(["C0PAY00001"]);
    expect(plane.bindings).toEqual([`${TEAM}/C0PAY00001`]);
    expect(plane.requests.find((r) => r.method === "PUT")?.body).toEqual({ projectName: "payments-api" });
  });

  it("does not join a channel the bot is already in", async () => {
    const plane = fakeControlPlane();
    const slack = fakeSlackChannels([{ id: "C0PAY00001", name: "payments", isPrivate: false, isMember: true }]);
    await addChannel({ session, botToken: "xoxb-1", teamId: TEAM, botUserId: BOT, projectName: "p", prompter: scriptedPrompter([]), write: () => undefined, ...clock(), services: { fetch: plane.fetch, slackChannels: slack }, flags: { channel: "payments" } });
    expect(slack.joined).toEqual([]);
    expect(plane.bindings).toEqual([`${TEAM}/C0PAY00001`]);
  });

  it("asks for an invite to a private channel, and waits until the bot can see it", async () => {
    const plane = fakeControlPlane();
    const slack = fakeSlackChannels([{ id: "G0SEC00001", name: "secret", isPrivate: true, isMember: true }], { visibleAfterFinds: 3 });
    const lines: string[] = [];
    const result = await addChannel({ session, botToken: "xoxb-1", teamId: TEAM, botUserId: BOT, projectName: "p", prompter: scriptedPrompter([]), write: (line) => lines.push(line), ...clock(), services: { fetch: plane.fetch, slackChannels: slack }, flags: { channel: "secret" } });
    expect(result.channelId).toBe("G0SEC00001");
    expect(lines.join("\n")).toContain(`If #secret is private, type /invite <@${BOT}> in it`);
    expect(slack.joined).toEqual([]);
    expect(slack.finds()).toBe(3);
  });

  it("gives up after 10 minutes, saying how to create the channel", async () => {
    const slack = fakeSlackChannels([]);
    const plane = fakeControlPlane();
    await expect(addChannel({ session, botToken: "xoxb-1", teamId: TEAM, botUserId: BOT, projectName: "p", prompter: scriptedPrompter([]), write: () => undefined, ...clock(), services: { fetch: plane.fetch, slackChannels: slack }, flags: { channel: "nope" } }))
      .rejects.toThrow("the bot cannot see a channel named #nope after 10 minutes; create it in Slack (or invite the bot to it, if it is private), then run this again");
    expect(plane.bindings).toEqual([]);
  });

  it("waits out a Slack rate limit and still finds the channel (fix round 1)", async () => {
    const plane = fakeControlPlane();
    const slack = fakeSlackChannels([{ id: "C0PAY00001", name: "payments", isPrivate: false, isMember: true }], { rateLimitedFinds: 1, retryAfterMs: 20_000 });
    const time = clock();
    const lines: string[] = [];
    const result = await addChannel({ session, botToken: "xoxb-1", teamId: TEAM, botUserId: BOT, projectName: "p", prompter: scriptedPrompter([]), write: (line) => lines.push(line), ...time, services: { fetch: plane.fetch, slackChannels: slack }, flags: { channel: "payments" } });
    expect(result.channelId).toBe("C0PAY00001");
    expect(slack.finds()).toBe(2);
    expect(time.now() - T0).toBe(20_000);
    expect(lines).toContain("Slack is limiting how often AgentX may list channels; trying again in 20 seconds.");
    expect(lines.join("\n")).not.toContain("/invite");
  });

  it("gives up at the deadline with the normal message when Slack keeps rate limiting (fix round 1)", async () => {
    const slack = fakeSlackChannels([{ id: "C0PAY00001", name: "payments", isPrivate: false, isMember: true }], { rateLimitedFinds: Number.POSITIVE_INFINITY, retryAfterMs: 60_000 });
    const time = clock();
    await expect(addChannel({ session, botToken: "xoxb-1", teamId: TEAM, botUserId: BOT, projectName: "p", prompter: scriptedPrompter([]), write: () => undefined, ...time, services: { fetch: fakeControlPlane().fetch, slackChannels: slack }, flags: { channel: "payments" } }))
      .rejects.toThrow("the bot cannot see a channel named #payments after 10 minutes; create it in Slack (or invite the bot to it, if it is private), then run this again");
    expect(time.now() - T0).toBe(10 * 60_000);
    expect(slack.finds()).toBe(11);
  });

  it("refuses a typed name that is not a channel name, before asking Slack", async () => {
    const slack = fakeSlackChannels([]);
    await expect(addChannel({ session, botToken: "xoxb-1", teamId: TEAM, botUserId: BOT, projectName: "p", prompter: scriptedPrompter([]), write: () => undefined, ...clock(), services: { fetch: fakeControlPlane().fetch, slackChannels: slack }, flags: { channel: "no spaces here" } }))
      .rejects.toThrow("--channel must be a Slack channel name, such as payments");
    expect(slack.finds()).toBe(0);
  });
});

describe("the Slack channel API", () => {
  function rateLimited(retryAfter: string | undefined) {
    return (async () => new Response("", { status: 429, headers: retryAfter === undefined ? {} : { "retry-after": retryAfter } })) as unknown as typeof globalThis.fetch;
  }

  it("reports HTTP 429 as a rate limit, honoring Retry-After: 30 s when missing or unreadable, at most 60 s (fix round 1)", async () => {
    const wait = async (retryAfter: string | undefined) => {
      const error = await slackChannelApi(rateLimited(retryAfter)).find(BOT_TOKEN, "payments").then(() => undefined, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(SlackRateLimitedError);
      return (error as SlackRateLimitedError).retryAfterMs;
    };
    expect(await wait("7")).toBe(7_000);
    expect(await wait(undefined)).toBe(30_000);
    expect(await wait("soon")).toBe(30_000);
    expect(await wait("600")).toBe(60_000);
  });

  function fakeSlack(pages: Array<Record<string, unknown>>, joinAnswer: Record<string, unknown> = { ok: true }) {
    const calls: Array<{ url: URL; authorization: string | undefined }> = [];
    let page = 0;
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const parsed = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
      calls.push({ url: parsed, authorization: (init?.headers as Record<string, string>).authorization });
      const body = parsed.pathname === "/api/conversations.join" ? joinAnswer : pages[page++] ?? { ok: true, channels: [] };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch;
    return { fetch, calls };
  }

  it("lists public and private channels, not archived, following the cursor", async () => {
    const slack = fakeSlack([
      { ok: true, channels: [{ id: "C0AAA00001", name: "general", is_private: false, is_member: true }], response_metadata: { next_cursor: "next1" } },
      { ok: true, channels: [{ id: "G0SEC00001", name: "secret", is_private: true, is_member: true }], response_metadata: { next_cursor: "" } },
    ]);
    expect(await slackChannelApi(slack.fetch).find(BOT_TOKEN, "secret")).toEqual({ id: "G0SEC00001", name: "secret", isPrivate: true, isMember: true });
    expect(slack.calls.map((call) => call.url.pathname)).toEqual(["/api/conversations.list", "/api/conversations.list"]);
    expect(slack.calls[0]!.url.searchParams.get("types")).toBe("public_channel,private_channel");
    expect(slack.calls[0]!.url.searchParams.get("exclude_archived")).toBe("true");
    expect(slack.calls[0]!.url.searchParams.has("cursor")).toBe(false);
    expect(slack.calls[1]!.url.searchParams.get("cursor")).toBe("next1");
    expect(slack.calls.every((call) => call.authorization === `Bearer ${BOT_TOKEN}`)).toBe(true);
    // The token goes only in the header, never the address.
    expect(slack.calls.every((call) => !call.url.href.includes(BOT_TOKEN))).toBe(true);
  });

  it("answers undefined when no page has the channel", async () => {
    const slack = fakeSlack([{ ok: true, channels: [{ id: "C0AAA00001", name: "general" }] }]);
    expect(await slackChannelApi(slack.fetch).find(BOT_TOKEN, "payments")).toBeUndefined();
  });

  it("joins by channel id", async () => {
    const slack = fakeSlack([]);
    await slackChannelApi(slack.fetch).join(BOT_TOKEN, "C0PAY00001");
    expect(slack.calls[0]!.url.pathname).toBe("/api/conversations.join");
    expect(slack.calls[0]!.url.searchParams.get("channel")).toBe("C0PAY00001");
  });

  it("names the manifest's scopes on missing_scope, and every one is in the manifest", async () => {
    const slack = fakeSlack([{ ok: false, error: "missing_scope" }]);
    await expect(slackChannelApi(slack.fetch).find(BOT_TOKEN, "payments"))
      .rejects.toThrow("Slack conversations.list refused: missing_scope; reinstall the Slack app from its manifest so it has channels:read, groups:read and channels:join");
    expect(SLACK_BOT_SCOPES).toEqual(expect.arrayContaining(["channels:read", "groups:read", "channels:join"]));
  });

  it("never echoes an unexpected Slack error text", async () => {
    const slack = fakeSlack([], { ok: false, error: `bad ${BOT_TOKEN}` });
    const error = await slackChannelApi(slack.fetch).join(BOT_TOKEN, "C0PAY00001").then(() => undefined, (caught: unknown) => caught as Error);
    expect(error?.message).toBe("RUNTIME_UNAVAILABLE: Slack conversations.join refused: unknown_error");
  });

  it("refuses to walk more than 50 pages, naming the command that binds by id", async () => {
    const pages = Array.from({ length: 51 }, (_, index) => ({ ok: true, channels: [], response_metadata: { next_cursor: `c${index}` } }));
    const slack = fakeSlack(pages);
    await expect(slackChannelApi(slack.fetch).find(BOT_TOKEN, "payments"))
      .rejects.toThrow("the workspace has more than 50000 channels to search; bind the channel by id with agentx admin slack bind --team <team-id> --channel <channel-id> --project <name>");
    expect(slack.calls).toHaveLength(50);
  });
});

describe("the stored bot token (F25)", () => {
  it("reads the bot token from the environment's Slack secret", async () => {
    expect(await readSlackBotToken(memoryInitSecrets({ "agentx/staging/slack": JSON.stringify({ botToken: BOT_TOKEN, signingSecret: "s" }) }), "staging")).toBe(BOT_TOKEN);
  });

  it("says what to do when there is none, without echoing what the secret holds", async () => {
    const secrets = memoryInitSecrets({ "agentx/staging/slack": JSON.stringify({ botToken: "not-a-bot-token-value" }) });
    const error = await readSlackBotToken(secrets, "staging").then(() => undefined, (caught: unknown) => caught as Error);
    expect(error?.message).toBe("CONFIG_INVALID: secret agentx/staging/slack holds no Slack bot token; run agentx init again so the Slack app step stores it");
    await expect(readSlackBotToken(memoryInitSecrets(), "staging")).rejects.toThrow("holds no Slack bot token");
  });
});

describe("waiting for the threaded reply (FR-018 step 11)", () => {
  it("passes on an answered turn in that channel received after the prompt", async () => {
    const plane = fakeControlPlane();
    const time = clock();
    const lines: string[] = [];
    const pending = waitForThreadedReply({ env: "staging", session, fetch: plane.fetch, teamId: TEAM, channelId: "C0PAY00001", channelName: "payments", botUserId: BOT, rerun: "agentx init", write: (line) => lines.push(line), ...time,
      sleep: async (ms) => { await time.sleep(ms); plane.turns = [turn({ subject: `${TEAM}/C0PAY00001/1790000000.000100`, receivedAt: new Date(time.now()).toISOString(), disposition: "answered" })]; } });
    expect((await pending).eventId).toMatch(/^Ev/);
    expect(lines[0]).toBe(`In #payments, post a message that mentions <@${BOT}>, for example "<@${BOT}> what can you do?". Waiting up to 10 minutes for AgentX to reply in its thread.`);
    expect(lines.at(-1)).toBe("AgentX replied in #payments in 8 seconds.");
  });

  it("ignores turns in other channels and turns from before the prompt", async () => {
    const plane = fakeControlPlane();
    plane.turns = [
      turn({ subject: `${TEAM}/C0OTHER001/1.1`, receivedAt: new Date(T0 + 1000).toISOString(), disposition: "answered" }),
      turn({ subject: `${TEAM}/C0PAY00001/1.1`, receivedAt: new Date(T0 - 60_000).toISOString(), disposition: "answered" }),
    ];
    await expect(waitForThreadedReply({ env: "staging", session, fetch: plane.fetch, teamId: TEAM, channelId: "C0PAY00001", channelName: "payments", botUserId: BOT, rerun: "agentx init", write: () => undefined, ...clock(), timeoutMs: 60_000 }))
      .rejects.toThrow("no AgentX reply in #payments within 1 minute; check that the message mentioned the bot, that Slack shows the Request URL as Verified, and agentx --env staging admin turns export --since 15m, then run agentx init again");
  });

  it("gives up after 10 minutes by default, naming the next step", async () => {
    const plane = fakeControlPlane();
    const time = clock();
    await expect(waitForThreadedReply({ env: "staging", session, fetch: plane.fetch, teamId: TEAM, channelId: "C0PAY00001", channelName: "payments", botUserId: BOT, rerun: "agentx init", write: () => undefined, ...time }))
      .rejects.toThrow("no AgentX reply in #payments within 10 minutes; check that the message mentioned the bot, that Slack shows the Request URL as Verified, and agentx --env staging admin turns export --since 15m, then run agentx init again");
    expect(time.now() - T0).toBe(10 * 60_000);
  });

  it("says 1 minute, not 1 minutes, when it asks for the mention (fix round 1)", async () => {
    const lines: string[] = [];
    await expect(waitForThreadedReply({ env: "staging", session, fetch: fakeControlPlane().fetch, teamId: TEAM, channelId: "C0PAY00001", channelName: "payments", botUserId: BOT, rerun: "agentx init", write: (line) => lines.push(line), ...clock(), timeoutMs: 60_000 }))
      .rejects.toThrow("within 1 minute;");
    expect(lines[0]).toContain("Waiting up to 1 minute for AgentX to reply in its thread.");
  });

  it("names the command that is running as the one to run again (fix round 1)", async () => {
    const plane = fakeControlPlane();
    plane.turns = [turn({ subject: `${TEAM}/C0PAY00001/1.1`, receivedAt: new Date(T0 + 1000).toISOString(), disposition: "failed", error: { name: "WorkerUnavailable" } })];
    await expect(waitForThreadedReply({ env: "staging", session, fetch: plane.fetch, teamId: TEAM, channelId: "C0PAY00001", channelName: "payments", botUserId: BOT, rerun: "agentx channel add --project payments-api --channel payments", write: () => undefined, ...clock() }))
      .rejects.toThrow("fix it, then run agentx channel add --project payments-api --channel payments again");
  });

  it("does not pass on an error reply, naming the turn's disposition (Review Focus 4)", async () => {
    const plane = fakeControlPlane();
    plane.turns = [turn({ subject: `${TEAM}/C0PAY00001/1.1`, receivedAt: new Date(T0 + 1000).toISOString(), disposition: "failed", error: { name: "WorkerUnavailable" } })];
    await expect(waitForThreadedReply({ env: "staging", session, fetch: plane.fetch, teamId: TEAM, channelId: "C0PAY00001", channelName: "payments", botUserId: BOT, rerun: "agentx init", write: () => undefined, ...clock() }))
      .rejects.toThrow("AgentX replied in #payments, but the turn ended as failed (WorkerUnavailable); see agentx --env staging admin turns export --since 15m, fix it, then run agentx init again");
  });

  it("asks the export for turns since just before the prompt", async () => {
    const plane = fakeControlPlane();
    plane.turns = [turn({ subject: `${TEAM}/C0PAY00001/1.1`, receivedAt: new Date(T0 + 1000).toISOString() })];
    await waitForThreadedReply({ env: "staging", session, fetch: plane.fetch, teamId: TEAM, channelId: "C0PAY00001", channelName: "payments", botUserId: BOT, rerun: "agentx init", write: () => undefined, ...clock() });
    expect(plane.requests.map((request) => request.path)).toEqual(["/v1/admin/turns"]);
    expect(plane.requests[0]!.token).toBe("admin-token");
  });
});

describe("agentx channel add on the command line (F9)", () => {
  const SLACK_SECRET = JSON.stringify({ botToken: BOT_TOKEN, signingSecret: "0123456789abcdef0123456789abcdef" });
  function fakeSetupContext(plane = fakeControlPlane(), slack = fakeSlackChannels([{ id: "C0PAY00001", name: "payments", isPrivate: false, isMember: false }])) {
    const time = clock();
    const lines: string[] = [];
    const run = (): SetupRun => ({
      env: "staging", settings: STAGING_SETTINGS, session: { controlPlaneUrl: CONTROL_PLANE, accessToken: accessToken({ "cognito:groups": ["agentx-admin"] }) },
      secrets: memoryInitSecrets({ "agentx/staging/slack": SLACK_SECRET }),
      services: setupServices({ fetch: plane.fetch, slackChannels: slack }),
      prompter: scriptedPrompter([]), write: (line) => { lines.push(line); }, ...time,
      print: (_result, text) => { lines.push(text); },
    });
    const context: SetupCommandContext = { open: async () => run(), openAws: async () => { throw new Error("test setup: openAws not expected"); } };
    return { context, lines, slack };
  }
  async function cli(argv: string[], setup: SetupCommandContext) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await executeCli(argv, { setup, stdout: { write: (text: string) => stdout.push(text) }, stderr: { write: (text: string) => stderr.push(text) } });
    return { code, stdout: stdout.join(""), stderr: stderr.join("") };
  }

  it("takes the global --project before the command", async () => {
    const plane = fakeControlPlane();
    const { context, lines, slack } = fakeSetupContext(plane);
    const result = await cli(["--project", "payments-api", "channel", "add", "--env", "staging", "--channel", "payments", "--no-check"], context);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(plane.requests.find((request) => request.method === "PUT")?.body).toEqual({ projectName: "payments-api" });
    expect(lines).toContain("Bound #payments to payments-api\n");
    expect(slack.tokens).toEqual([BOT_TOKEN, BOT_TOKEN]);
    expect([...lines, result.stdout, result.stderr].join("\n")).not.toContain(BOT_TOKEN);
  });

  it("takes --project after the command too", async () => {
    const plane = fakeControlPlane();
    const { context } = fakeSetupContext(plane);
    const result = await cli(["channel", "add", "--project", "payments-api", "--env", "staging", "--channel", "payments", "--no-check"], context);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(plane.requests.find((request) => request.method === "PUT")?.body).toEqual({ projectName: "payments-api" });
  });

  it("refuses without --project, binding nothing", async () => {
    const plane = fakeControlPlane();
    const { context } = fakeSetupContext(plane);
    const result = await cli(["channel", "add", "--env", "staging", "--channel", "payments", "--no-check"], context);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("--project is required; pass --project <name>, the project to bind the channel to");
    expect(plane.bindings).toEqual([]);
  });

  it("by default waits for the threaded reply before it reports", async () => {
    const plane = fakeControlPlane();
    plane.turns = [turn({ subject: `${TEAM}/C0PAY00001/1.1`, receivedAt: new Date(T0 + 1000).toISOString() })];
    const { context, lines } = fakeSetupContext(plane);
    const result = await cli(["--project", "payments-api", "channel", "add", "--env", "staging", "--channel", "payments"], context);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(lines).toContain("AgentX replied in #payments in 8 seconds.");
    expect(plane.requests.some((request) => request.path === "/v1/admin/turns")).toBe(true);
  });
});

describe("agentx channel add's next step (fix round 1)", () => {
  it("tells the engineer to run agentx channel add again, not agentx init", async () => {
    const plane = fakeControlPlane();
    plane.turns = [turn({ subject: `${TEAM}/C0PAY00001/1.1`, receivedAt: new Date(T0 + 1000).toISOString(), disposition: "failed", error: { name: "WorkerUnavailable" } })];
    const time = clock();
    const setup: SetupCommandContext = {
      open: async () => ({
        env: "staging", settings: STAGING_SETTINGS, session, secrets: memoryInitSecrets({ "agentx/staging/slack": JSON.stringify({ botToken: BOT_TOKEN }) }),
        services: setupServices({ fetch: plane.fetch, slackChannels: fakeSlackChannels([{ id: "C0PAY00001", name: "payments", isPrivate: false, isMember: true }]) }),
        prompter: scriptedPrompter([]), write: () => undefined, ...time, print: () => undefined,
      }),
      openAws: async () => { throw new Error("test setup: openAws not expected"); },
    };
    const stderr: string[] = [];
    const code = await executeCli(["--project", "payments-api", "channel", "add", "--env", "staging", "--channel", "#Payments"], { setup, stdout: { write: () => undefined }, stderr: { write: (text: string) => stderr.push(text) } });
    expect(code).not.toBe(0);
    expect(stderr.join("")).toContain("fix it, then run agentx --env staging channel add --project payments-api --channel payments again");
    expect(stderr.join("")).not.toContain("agentx init");
  });
});

describe("the first-project init step's channel", () => {
  const PROJECT = { name: "payments-api", revision: 1 };
  const SLACK = { appId: "A0APP00001", teamId: TEAM, botUserId: BOT };
  function context(plane = fakeControlPlane(), slack = fakeSlackChannels([{ id: "C0PAY00001", name: "payments", isPrivate: false, isMember: false }])) {
    const made = initContext({
      secrets: memoryInitSecrets({ "agentx/staging/slack": JSON.stringify({ botToken: BOT_TOKEN }) }),
      flags: { channel: "#payments" }, setup: setupServices({ fetch: plane.fetch, slackChannels: slack }),
    });
    (made.store as MemoryParameterStore).values.set("/agentx/staging/settings", JSON.stringify(STAGING_SETTINGS));
    return made;
  }

  it("binds the channel with the recorded Slack facts, and records it", async () => {
    const plane = fakeControlPlane();
    const made = context(plane);
    const progress = progressHandle({ ...progressHandle().value(), project: PROJECT, slack: SLACK });
    expect(await firstProjectStep().run(made, progress)).toEqual({ status: "done", note: "project payments-api in #payments" });
    expect(progress.value().project).toEqual({ ...PROJECT, channelId: "C0PAY00001", channelName: "payments", teamId: TEAM });
    expect(plane.bindings).toEqual([`${TEAM}/C0PAY00001`]);
    expect(made.lines.join("\n")).not.toContain(BOT_TOKEN);
  });

  it("binds nothing again when the channel is recorded", async () => {
    const plane = fakeControlPlane();
    const slack = fakeSlackChannels([]);
    const progress = progressHandle({ ...progressHandle().value(), project: { ...PROJECT, channelId: "C0PAY00001", channelName: "payments", teamId: TEAM }, slack: SLACK });
    expect(await firstProjectStep().run(context(plane, slack), progress)).toEqual({ status: "done", note: "project payments-api in #payments" });
    expect(plane.bindings).toEqual([]);
    expect(slack.finds()).toBe(0);
  });

  it("says the Slack app step must finish first when progress has no Slack facts", async () => {
    const progress = progressHandle({ ...progressHandle().value(), project: PROJECT });
    await expect(firstProjectStep().run(context(), progress))
      .rejects.toThrow("install progress has no Slack app facts; the Slack app step must finish first, so run agentx init again");
  });
});
