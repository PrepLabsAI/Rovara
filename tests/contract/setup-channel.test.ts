import { SLACK_MODEL_WORDS } from "@agentx/contracts";
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

});

describe("the stored bot token (F25)", () => {

  it("says what to do when there is none, without echoing what the secret holds", async () => {
    const secrets = memoryInitSecrets({ "agentx/staging/slack": JSON.stringify({ botToken: "not-a-bot-token-value" }) });
    const error = await readSlackBotToken(secrets, "staging").then(() => undefined, (caught: unknown) => caught as Error);
    expect(error?.message).toBe("CONFIG_INVALID: secret agentx/staging/slack holds no Slack bot token; run agentx init again so the Slack app step stores it");
    await expect(readSlackBotToken(memoryInitSecrets(), "staging")).rejects.toThrow("holds no Slack bot token");
  });
});

describe("waiting for the threaded reply (FR-018 step 11)", () => {

  it("does not count a fixed refusal as the first reply, and says which words came back (#1586)", async () => {
    const plane = fakeControlPlane();
    const refusal = turn({ subject: `${TEAM}/C0PAY00001/3.1`, receivedAt: new Date(T0 + 1000).toISOString(), disposition: "answered", responseText: SLACK_MODEL_WORDS.unavailable });
    plane.turns = [refusal];
    const reported = new Set<string>();
    await expect(waitForThreadedReply({ env: "staging", session, fetch: plane.fetch, teamId: TEAM, channelId: "C0PAY00001", channelName: "payments", botUserId: BOT, rerun: "agentx init", write: () => undefined, ...clock(), reported }))
      .rejects.toThrow(`AgentX answered in #payments, but only with its fixed refusal "${SLACK_MODEL_WORDS.unavailable}": it made no model call.`);
    expect([...reported]).toEqual([String(refusal.eventId)]);
    // A real answer after it is the first reply.
    const real = turn({ subject: `${TEAM}/C0PAY00001/4.1`, receivedAt: new Date(T0 + 2000).toISOString(), disposition: "answered", responseText: "I can review code, fix bugs and open pull requests." });
    plane.turns = [refusal, real];
    await expect(waitForThreadedReply({ env: "staging", session, fetch: plane.fetch, teamId: TEAM, channelId: "C0PAY00001", channelName: "payments", botUserId: BOT, rerun: "agentx init", write: () => undefined, ...clock(), reported }))
      .resolves.toMatchObject({ eventId: real.eventId });
  });

  it("treats every fixed refusal the same way", async () => {
    for (const words of Object.values(SLACK_MODEL_WORDS)) {
      const plane = fakeControlPlane();
      plane.turns = [turn({ subject: `${TEAM}/C0PAY00001/5.1`, receivedAt: new Date(T0 + 1000).toISOString(), disposition: "answered", responseText: words })];
      await expect(waitForThreadedReply({ env: "staging", session, fetch: plane.fetch, teamId: TEAM, channelId: "C0PAY00001", channelName: "payments", botUserId: BOT, rerun: "agentx init", write: () => undefined, ...clock() }), words)
        .rejects.toThrow("only with its fixed refusal");
    }
  });

  it("skips turns already reported, and adds a newly failed one before it throws (spec 040 FR-051)", async () => {
    const plane = fakeControlPlane();
    const old = turn({ subject: `${TEAM}/C0PAY00001/1.1`, receivedAt: new Date(T0 + 1000).toISOString(), disposition: "error" });
    const fresh = turn({ subject: `${TEAM}/C0PAY00001/2.1`, receivedAt: new Date(T0 + 2000).toISOString(), disposition: "failed" });
    plane.turns = [old, fresh];
    const reported = new Set([String(old.eventId)]);
    await expect(waitForThreadedReply({ env: "staging", session, fetch: plane.fetch, teamId: TEAM, channelId: "C0PAY00001", channelName: "payments", botUserId: BOT, rerun: "agentx init", write: () => undefined, ...clock(), reported }))
      .rejects.toThrow("but the turn ended as failed;");
    expect([...reported]).toEqual([String(old.eventId), String(fresh.eventId)]);
    // With both reported, the watch waits for a new mention and gives up at the deadline instead.
    await expect(waitForThreadedReply({ env: "staging", session, fetch: plane.fetch, teamId: TEAM, channelId: "C0PAY00001", channelName: "payments", botUserId: BOT, rerun: "agentx init", write: () => undefined, ...clock(), timeoutMs: 60_000, reported }))
      .rejects.toThrow("no AgentX reply in #payments within 1 minute;");
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
  function context(plane = fakeControlPlane(), slack = fakeSlackChannels([{ id: "C0PAY00001", name: "payments", isPrivate: false, isMember: false }])) {
    const made = initContext({
      secrets: memoryInitSecrets({ "agentx/staging/slack": JSON.stringify({ botToken: BOT_TOKEN }) }),
      flags: { channel: "#payments" }, setup: setupServices({ fetch: plane.fetch, slackChannels: slack }),
    });
    (made.store as MemoryParameterStore).values.set("/agentx/staging/settings", JSON.stringify(STAGING_SETTINGS));
    return made;
  }

  it("says the Slack app step must finish first when progress has no Slack facts", async () => {
    const progress = progressHandle({ ...progressHandle().value(), project: PROJECT });
    await expect(firstProjectStep().run(context(), progress))
      .rejects.toThrow("install progress has no Slack app facts; the Slack app step must finish first, so run agentx init again");
  });
});

describe("the invite wait, told to the install page (spec 040 phase 3)", () => {
  it("calls onWaiting once, with the channel's name, when the bot cannot see it yet", async () => {
    const waited: string[] = [];
    const lines: string[] = [];
    const plane = fakeControlPlane();
    const bound = await addChannel({
      session, botToken: "xoxb-1", teamId: TEAM, botUserId: BOT, projectName: "payments-api",
      prompter: scriptedPrompter(["payments"]), write: (line) => { lines.push(line); }, ...clock(),
      services: { fetch: plane.fetch, slackChannels: fakeSlackChannels([{ id: "C0PAY00001", name: "payments", isPrivate: true, isMember: true }], { visibleAfterFinds: 3 }) },
      flags: {}, onWaiting: (name) => { waited.push(name); },
    });
    expect(bound).toEqual({ channelId: "C0PAY00001", channelName: "payments" });
    expect(waited).toEqual(["payments"]);
    // The terminal's line is unchanged.
    expect(lines).toContain(`The bot cannot see #payments yet. If #payments is private, type /invite <@${BOT}> in it; if it does not exist, create it. Waiting up to 10 minutes.`);
  });
});
