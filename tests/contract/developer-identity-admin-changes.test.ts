// tests/contract/developer-identity-admin-changes.test.ts
// Spec 025 E8, E9, E12: the email index, an admin ending a developer's sessions, a channel by name.
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { channelByNameThroughLambda, endDeveloperSessionsThroughLambda } from "../../packages/broker/src/aws/developer-routes.js";
import { slackDirectory } from "../../packages/broker/src/developer/slack-directory.js";
import { emailIndexKey } from "../../packages/broker/src/developer/store.js";
import { createDeveloperTaskBroker, MAYA } from "../support/developer-task-broker.js";
import { BOT_TOKEN, TEAM, identityHarness, routeFetch } from "../support/developer-fakes.js";

/** upsertDeveloper keeps the developer ID in the key only, so it is read from there. */
const developerIdOf = (db: { find(predicate: (item: Record<string, unknown>) => boolean): Array<Record<string, unknown>> }) =>
  String(db.find((item) => item.entityType === "DEVELOPER")[0]?.pk).replace(/^DEVELOPER#/, "");
const reply = (value: unknown) => ({ Payload: Buffer.from(JSON.stringify(value)) });

describe("the email index (E8, Q4)", () => {
  it("is written at each sign-in with a verified email, keyed by the email's hash, never the email", async () => {
    const harness = identityHarness({ slackUsers: [{ userId: "U0ADA00001", teamId: TEAM, name: "Ada", email: "Ada@Example.com", emailVerified: true }] });
    await harness.signIn("slack", "U0ADA00001");
    const key = emailIndexKey(" ada@example.com ");
    const item = harness.db.get(key.pk, key.sk);
    expect(item).toMatchObject({ entityType: "DEVELOPER_EMAIL", developerId: expect.stringMatching(/^[a-f0-9]{64}$/) as unknown });
    expect(JSON.stringify(item)).not.toContain("example.com");
  });

  it("keys by the SHA-256 of the trimmed, lowercased email, and never logs the email", async () => {
    const hash = createHash("sha256").update("ada@example.com").digest("hex");
    expect(emailIndexKey(" Ada@Example.com ")).toEqual({ pk: `EMAIL#${hash}`, sk: "META" });
    const harness = identityHarness({ slackUsers: [{ userId: "U0ADA00001", teamId: TEAM, name: "Ada", email: "ada@example.com" }] });
    await harness.signIn("slack", "U0ADA00001");
    expect(JSON.stringify(harness.logs)).not.toContain("example.com");
  });

  it("is not written for a sign-in without a verified email", async () => {
    const harness = identityHarness({ slackUsers: [{ userId: "U0ADA00001", teamId: TEAM, name: "Ada", email: "ada@example.com", emailVerified: false }] });
    await harness.signIn("slack", "U0ADA00001");
    expect(harness.db.find((item) => item.entityType === "DEVELOPER_EMAIL")).toEqual([]);
  });
});

describe("ending a developer's sessions (E9, Q3)", () => {
  it("ends every session that started before, and still lets them sign in again", async () => {
    const harness = identityHarness({ slackUsers: [{ userId: "U0ADA00001", teamId: TEAM, name: "Ada" }] });
    const callback = await harness.signIn("slack", "U0ADA00001");
    const tokens = await harness.exchange(callback.searchParams.get("code")!);
    const developerId = developerIdOf(harness.db);
    harness.tick(1_000);
    expect(await harness.handler({ kind: "end-developer-sessions", developerId, at: new Date(harness.now()).toISOString() } as never)).toEqual({ ok: true });
    const refresh = await harness.refresh(String(tokens.body.refresh_token));
    expect(refresh).toMatchObject({ status: 400, body: { error: "invalid_grant", error_description: "an AgentX admin ended your sign-in; sign in again with agentx login" } });
    harness.tick(1_000);
    const again = await harness.signIn("slack", "U0ADA00001");
    expect((await harness.exchange(again.searchParams.get("code")!)).status).toBe(200);
  });

  it("revokes the ended session at its refresh, keeps the developer's revoked flag false, and keeps the end across a later sign-in", async () => {
    const harness = identityHarness({ slackUsers: [{ userId: "U0ADA00001", teamId: TEAM, name: "Ada" }] });
    const callback = await harness.signIn("slack", "U0ADA00001");
    const tokens = await harness.exchange(callback.searchParams.get("code")!);
    const developerId = developerIdOf(harness.db);
    harness.tick(1_000);
    const at = new Date(harness.now()).toISOString();
    await harness.handler({ kind: "end-developer-sessions", developerId, at } as never);
    expect(harness.logs).toContainEqual({ event: "signin.sessions_ended_by_admin", developerId, result: "ended" });
    await harness.refresh(String(tokens.body.refresh_token));
    expect(harness.db.find((item) => item.entityType === "SESSION")[0]).toMatchObject({ revokedReason: "ended_by_admin" });
    harness.tick(1_000);
    const again = await harness.signIn("slack", "U0ADA00001");
    const fresh = await harness.exchange(again.searchParams.get("code")!);
    expect(harness.db.get(`DEVELOPER#${developerId}`, "META")).toMatchObject({ revoked: false, sessionsEndedAt: at });
    harness.tick(1_000);
    expect((await harness.refresh(String(fresh.body.refresh_token))).status).toBe(200);
  });

  it("never moves the end backwards: an older time after a newer one keeps the newer and still answers ended", async () => {
    const harness = identityHarness({ slackUsers: [{ userId: "U0ADA00001", teamId: TEAM, name: "Ada" }] });
    await harness.signIn("slack", "U0ADA00001");
    const developerId = developerIdOf(harness.db);
    const newer = "2026-09-27T13:00:00.000Z";
    expect(await harness.handler({ kind: "end-developer-sessions", developerId, at: newer } as never)).toEqual({ ok: true });
    expect(await harness.handler({ kind: "end-developer-sessions", developerId, at: "2026-09-27T12:30:00.000Z" } as never)).toEqual({ ok: true });
    expect(await harness.handler({ kind: "end-developer-sessions", developerId, at: newer } as never)).toEqual({ ok: true });
    // Without milliseconds the text sorts differently; the time is compared, not the text.
    expect(await harness.handler({ kind: "end-developer-sessions", developerId, at: "2026-09-27T12:59:59Z" } as never)).toEqual({ ok: true });
    expect(harness.db.get(`DEVELOPER#${developerId}`, "META")).toMatchObject({ sessionsEndedAt: newer });
    expect(harness.logs.filter((entry) => entry.event === "signin.sessions_ended_by_admin").map((entry) => entry.result)).toEqual(["ended", "ended", "ended", "ended"]);
  });

  it("answers not_found for a developer who never signed in", async () => {
    const harness = identityHarness({});
    expect(await harness.handler({ kind: "end-developer-sessions", developerId: "f".repeat(64), at: new Date().toISOString() } as never)).toEqual({ ok: false, error: "not_found" });
    expect(harness.db.get(`DEVELOPER#${"f".repeat(64)}`, "META")).toBeUndefined();
  });

  it("refuses a malformed request", async () => {
    const harness = identityHarness({});
    expect(await harness.handler({ kind: "end-developer-sessions", developerId: "not-an-id", at: new Date().toISOString() } as never)).toEqual({ ok: false, error: "invalid_request" });
    expect(await harness.handler({ kind: "end-developer-sessions", developerId: "f".repeat(64), at: "yesterday" } as never)).toEqual({ ok: false, error: "invalid_request" });
  });

  it("makes the broker refuse a session that started before the end, at once (D16)", async () => {
    const harness = await createDeveloperTaskBroker();
    expect((await harness.dev(MAYA, "GET", "/v1/dev/projects")).status).toBe(200);
    const developer = harness.db.get(`DEVELOPER#${MAYA.developerId}`, "META")!;
    harness.db.set({ ...developer, sessionsEndedAt: new Date(Date.now() + 1_000).toISOString() });
    expect((await harness.dev(MAYA, "GET", "/v1/dev/projects")).body.error).toEqual({ code: "AUTH_REQUIRED", message: "an AgentX admin ended your sign-in; run agentx login <url> again" });
  });

  it("lets the broker accept a session that started after the end", async () => {
    const harness = await createDeveloperTaskBroker();
    const developer = harness.db.get(`DEVELOPER#${MAYA.developerId}`, "META")!;
    harness.db.set({ ...developer, sessionsEndedAt: new Date(Date.now() - 3_600_000).toISOString() });
    expect((await harness.dev(MAYA, "GET", "/v1/dev/projects")).status).toBe(200);
  });

  it("goes through the broker's invoke helper; not_found is an answer, not a logged failure (C15)", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => { lines.push(String(line)); });
    try {
      const request = { kind: "end-developer-sessions" as const, developerId: "f".repeat(64), at: new Date().toISOString() };
      expect(await endDeveloperSessionsThroughLambda(vi.fn(async () => reply({ ok: true })))(request)).toEqual({ ok: true });
      expect(await endDeveloperSessionsThroughLambda(vi.fn(async () => reply({ ok: false, error: "not_found" })))(request)).toEqual({ ok: false, error: "not_found" });
      expect(lines.filter((line) => line.includes("developer.end_sessions"))).toEqual([]);
      expect(await endDeveloperSessionsThroughLambda(vi.fn(async () => reply({ ok: false, error: "invalid_request" })))(request)).toEqual({ ok: false, error: "invalid_request" });
      expect(await endDeveloperSessionsThroughLambda(vi.fn(async () => ({ FunctionError: "Unhandled" })))(request)).toEqual({ ok: false, error: "unavailable" });
      expect(await endDeveloperSessionsThroughLambda(vi.fn(async () => { throw new Error("boom"); }))(request)).toEqual({ ok: false, error: "unavailable" });
      expect(lines.map((line) => (JSON.parse(line) as { event?: string }).event)).toEqual([
        "developer.end_sessions_invalid_request", "developer.end_sessions_failed", "developer.end_sessions_failed",
      ]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("a channel by name (E12, Q8)", () => {
  it("finds a public channel by name, with or without #, and nothing for an unknown one", async () => {
    const harness = identityHarness({ channelInfo: { C0LEDGER001: { name: "ledger-dev" }, C0SECRET001: { name: "secret-launch", isPrivate: true } } });
    expect(await harness.handler({ kind: "channel-by-name", name: "ledger-dev" } as never)).toEqual({ ok: true, channel: { channelId: "C0LEDGER001", name: "ledger-dev" } });
    expect(await harness.handler({ kind: "channel-by-name", name: "secret-launch" } as never)).toEqual({ ok: true });
    expect(await harness.handler({ kind: "channel-by-name", name: "nope" } as never)).toEqual({ ok: true });
    expect(await harness.handler({ kind: "channel-by-name", name: "Not A Name!" } as never)).toEqual({ ok: false, error: "invalid_request" });
    // The contract takes the bare name; the caller strips a leading # (Task 5).
    expect(await harness.handler({ kind: "channel-by-name", name: "#ledger-dev" } as never)).toEqual({ ok: false, error: "invalid_request" });
  });

  it("asks Slack for public channels only, follows pages, and never resolves a channel Slack does not call public", async () => {
    const queries: URLSearchParams[] = [];
    const pages: Record<string, unknown> = {
      "": { ok: true, channels: [{ id: "C0ONE000001", name: "one", is_private: false }, { id: "C0HIDDEN001", name: "hidden" }], response_metadata: { next_cursor: "p2" } },
      p2: { ok: true, channels: [{ id: "C0TWO000001", name: "two", is_private: false }, { id: "C0PRIV00001", name: "priv", is_private: true }], response_metadata: { next_cursor: "" } },
    };
    const fetch = routeFetch(async (url, init) => {
      if (url.pathname !== "/api/conversations.list") return undefined;
      if (new Headers(init?.headers).get("authorization") !== `Bearer ${BOT_TOKEN}`) return Response.json({ ok: false, error: "invalid_auth" });
      queries.push(url.searchParams);
      return Response.json(pages[url.searchParams.get("cursor") ?? ""]);
    });
    const directory = slackDirectory({ teamId: TEAM, botToken: async () => BOT_TOKEN, fetch, now: Date.now });
    expect(await directory.channelByName("two")).toEqual({ ok: true, channel: { channelId: "C0TWO000001", name: "two" } });
    expect(queries.map((query) => query.get("types"))).toEqual(["public_channel", "public_channel"]);
    expect(queries.every((query) => query.get("exclude_archived") === "true")).toBe(true);
    expect(await directory.channelByName("hidden")).toEqual({ ok: true });
    expect(await directory.channelByName("priv")).toEqual({ ok: true });
  });

  it("answers slack_unavailable when Slack cannot answer, or the environment has no team", async () => {
    const harness = identityHarness({ channelInfo: { C0LEDGER001: { name: "ledger-dev" } } });
    harness.slack.state.down = true;
    expect(await harness.handler({ kind: "channel-by-name", name: "ledger-dev" } as never)).toEqual({ ok: false, error: "slack_unavailable" });
    harness.slack.state.down = false;
    harness.slack.state.botError = "missing_scope";
    expect(await harness.handler({ kind: "channel-by-name", name: "ledger-dev" } as never)).toEqual({ ok: false, error: "slack_unavailable" });
    const noTeam = identityHarness({ teamId: undefined, channelInfo: { C0LEDGER001: { name: "ledger-dev" } } });
    expect(await noTeam.handler({ kind: "channel-by-name", name: "ledger-dev" } as never)).toEqual({ ok: false, error: "slack_unavailable" });
  });

  it("goes through the broker's invoke helper, failing closed as slack_unavailable", async () => {
    const request = { kind: "channel-by-name" as const, name: "ledger-dev" };
    expect(await channelByNameThroughLambda(vi.fn(async () => reply({ ok: true, channel: { channelId: "C0LEDGER001", name: "ledger-dev" } })))(request)).toEqual({ ok: true, channel: { channelId: "C0LEDGER001", name: "ledger-dev" } });
    expect(await channelByNameThroughLambda(vi.fn(async () => reply({ ok: true })))(request)).toEqual({ ok: true });
    expect(await channelByNameThroughLambda(vi.fn(async () => ({ FunctionError: "Unhandled" })))(request)).toEqual({ ok: false, error: "slack_unavailable" });
    expect(await channelByNameThroughLambda(vi.fn(async () => reply({ ok: false, error: "slack_unavailable" })))(request)).toEqual({ ok: false, error: "slack_unavailable" });
  });
});
