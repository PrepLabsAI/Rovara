// tests/contract/developer-identity-admin-invokes.test.ts
// Spec 025 A11 to A13: the broker asks DeveloperIdentity who owns an email, and whether the bot token works.
import { describe, expect, it, vi } from "vitest";
import { slackAuthCheckThroughLambda, slackUserByEmailThroughLambda } from "../../packages/broker/src/aws/developer-routes.js";
import { slackDirectory, type SlackProblem } from "../../packages/broker/src/developer/slack-directory.js";
import { BOT_TOKEN, TEAM, fakeSlack, httpEvent, identityHarness, routeFetch } from "../support/developer-fakes.js";

const reply = (value: unknown) => ({ Payload: Buffer.from(JSON.stringify(value)) });

describe("DeveloperIdentity's email lookup and auth check (A12, A13)", () => {
  it("answers the Slack user of a verified email, nothing for an unknown one, and refuses a malformed request", async () => {
    const harness = identityHarness({ slackUsers: [{ userId: "U0ADA00001", teamId: TEAM, name: "Ada", email: "ada@example.com" }] });
    expect(await harness.handler({ kind: "slack-user-by-email", email: "ada@example.com" } as never)).toEqual({ ok: true, userId: "U0ADA00001" });
    expect(await harness.handler({ kind: "slack-user-by-email", email: "nobody@example.com" } as never)).toEqual({ ok: true });
    expect(await harness.handler({ kind: "slack-user-by-email", email: "not an email" } as never)).toEqual({ ok: false, error: "invalid_request" });
  });

  it("answers slack_unavailable when Slack cannot answer the email lookup", async () => {
    const harness = identityHarness({ slackUsers: [{ userId: "U0ADA00001", teamId: TEAM, name: "Ada", email: "ada@example.com" }] });
    harness.slack.state.down = true;
    expect(await harness.handler({ kind: "slack-user-by-email", email: "ada@example.com" } as never)).toEqual({ ok: false, error: "slack_unavailable" });
  });

  it("checks the bot token with auth.test, and says when Slack refuses it, never naming the token", async () => {
    const slack = fakeSlack({ users: [] });
    const directory = slackDirectory({ teamId: TEAM, botToken: async () => BOT_TOKEN, fetch: routeFetch(slack.handler), now: Date.now });
    expect(await directory.authTest()).toEqual({ ok: true, teamId: TEAM });
    const problems: SlackProblem[] = [];
    const refused = slackDirectory({ teamId: TEAM, botToken: async () => "xoxb-revoked", fetch: routeFetch(slack.handler), now: Date.now, report: (problem) => problems.push(problem) });
    const answer = await refused.authTest();
    expect(answer).toEqual({ ok: false, error: "invalid_auth" });
    expect(JSON.stringify(answer)).not.toContain("xoxb-");
    expect(problems).toEqual([{ method: "auth.test", status: 200, error: "invalid_auth" }]);
  });

  it("answers no_error_code for a Slack error that is not code-shaped, rejecting it rather than stripping it", async () => {
    const slack = fakeSlack({ users: [] });
    const directory = slackDirectory({ teamId: TEAM, botToken: async () => BOT_TOKEN, fetch: routeFetch(slack.handler), now: Date.now });
    slack.state.botError = "Token-Revoked";
    expect(await directory.authTest()).toEqual({ ok: false, error: "no_error_code" });
    slack.state.botError = "token_revoked";
    expect(await directory.authTest()).toEqual({ ok: false, error: "token_revoked" });
  });

  it("serves the auth check invoke, and refuses a malformed one", async () => {
    const harness = identityHarness({});
    expect(await harness.handler({ kind: "slack-auth-check" } as never)).toEqual({ ok: true, teamId: TEAM });
    expect(await harness.handler({ kind: "slack-auth-check", token: BOT_TOKEN } as never)).toEqual({ ok: false, error: "invalid_request" });
    expect(JSON.stringify(harness.logs)).not.toContain(BOT_TOKEN);
  });

  it("reports the environment's admin API version beside the developer one (A1)", async () => {
    const harness = identityHarness({});
    const answer = await harness.http(httpEvent("GET", "/v1/auth/.well-known/agentx-configuration"));
    expect(JSON.parse(answer.body)).toMatchObject({ apiVersion: "1.2", adminApiVersion: "1.1" });
  });

  it("goes through the broker's invoke helpers, failing closed as slack_unavailable", async () => {
    const byEmail = slackUserByEmailThroughLambda(vi.fn(async () => reply({ ok: true, userId: "U0ADA00001" })));
    expect(await byEmail({ kind: "slack-user-by-email", email: "ada@example.com" })).toEqual({ ok: true, userId: "U0ADA00001" });
    const broken = slackUserByEmailThroughLambda(vi.fn(async () => ({ FunctionError: "Unhandled" })));
    expect(await broken({ kind: "slack-user-by-email", email: "ada@example.com" })).toEqual({ ok: false, error: "slack_unavailable" });
    const check = slackAuthCheckThroughLambda(vi.fn(async () => reply({ ok: false, error: "token_revoked" })));
    expect(await check()).toEqual({ ok: false, error: "token_revoked" });
    const crashed = slackAuthCheckThroughLambda(vi.fn(async () => ({ FunctionError: "Unhandled" })));
    expect(await crashed()).toEqual({ ok: false, error: "slack_unavailable" });
    const unavailable = slackAuthCheckThroughLambda(vi.fn(async () => reply({ ok: false, error: "slack_unavailable" })));
    expect(await unavailable()).toEqual({ ok: false, error: "slack_unavailable" });
  });

  it("passes only a code-shaped Slack error through the auth check, never free text or a token (R9)", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => { lines.push(String(line)); });
    try {
      const leaky = slackAuthCheckThroughLambda(vi.fn(async () => reply({ ok: false, error: `invalid token ${BOT_TOKEN}` })));
      const answer = await leaky();
      expect(answer).toEqual({ ok: false, error: "slack_unavailable" });
      expect(JSON.stringify(answer)).not.toContain(BOT_TOKEN);
      expect(lines.join("\n")).not.toContain(BOT_TOKEN);
      const good = slackAuthCheckThroughLambda(vi.fn(async () => reply({ ok: true, teamId: TEAM, token: BOT_TOKEN })));
      const ok = await good();
      expect(ok).toEqual({ ok: true, teamId: TEAM });
      expect(JSON.stringify(ok)).not.toContain(BOT_TOKEN);
      const revoked = slackAuthCheckThroughLambda(vi.fn(async () => reply({ ok: false, error: "token_revoked" })));
      expect(await revoked()).toEqual({ ok: false, error: "token_revoked" });
      const failures = lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((entry) => entry.event === "developer.slack_auth_check_failed");
      expect(failures.at(-1)).toMatchObject({ reason: "reply_error", error: "token_revoked" });
      expect(failures[0]).toMatchObject({ reason: "reply_error", error: "malformed_reply" });
      expect(lines.join("\n")).not.toContain(BOT_TOKEN);
      expect(lines.join("\n")).not.toContain("xoxb-");
    } finally {
      spy.mockRestore();
    }
  });
});
