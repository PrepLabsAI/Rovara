// R5 step 1 (DEC 254zzz444): the hosted Slack service reads a company's bot token through a session tagged with the company the BINDING names (packages/slack-service/src/slack-company-workspaces.ts).
// The fake Secrets Manager enforces what the reader role's policy does: a session may read only `slack-workspaces/<its tagged company>/*`, anything else is AccessDenied.
import { describe, expect, it } from "vitest";
import { slackTokens } from "../../packages/testing/src/channel/slack-world.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { createSlackWorkspaceBindings } from "../../packages/broker/src/aws/slack-workspace-binding.js";
import { serviceSlackWorkspacesFromEnvironment, type CompanySession, type ScopedSecrets } from "../../packages/slack-service/src/slack-company-workspaces.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa", B = "org_bbbbbbbbbbbbbbbbbbbb";
const INSTALL = "T0INSTALL0", TEAM_A = "T0AAAAAAA", TEAM_B = "T0BBBBBBB";
const ROLE = "arn:aws:iam::123456789012:role/agentx/staging/agentx-staging-slk";
const BASE = { SLACK_COMPANY_WORKSPACES: "enabled", COMPANY_SIGNIN: "enabled", STATE_TABLE_NAME: "state", AGENTX_ENV: "staging", SLACK_TEAM_ID: INSTALL };
const SECRETS = new Map([
  [`agentx/staging/slack-workspaces/${A}/${TEAM_A}`, JSON.stringify({ botToken: slackTokens("a").bot })],
  [`agentx/staging/slack-workspaces/${B}/${TEAM_B}`, JSON.stringify({ botToken: slackTokens("b").bot })],
]);
const denied = () => Object.assign(new Error("not authorized"), { name: "AccessDeniedException" });
const missing = () => Object.assign(new Error("missing"), { name: "ResourceNotFoundException" });

async function world(options: { now?: { t: number }; assumeFails?: boolean; scopedReadFails?: boolean } = {}) {
  const db = new FakeDynamoDb();
  const bindings = createSlackWorkspaceBindings({ client: db, tableName: "state", legacyTeamId: INSTALL });
  await bindings.backfill();
  await bindings.bind(A, TEAM_A, "operator");
  await bindings.bind(B, TEAM_B, "operator");
  const clock = options.now ?? { t: 1_000_000 };
  const reads: Array<{ via: string; id: string }> = [];
  const assumed: Array<{ roleArn: string; sessionName: string; tags: Array<{ Key: string; Value: string }>; durationSeconds: number }> = [];
  const logs: Array<[string, Record<string, unknown>]> = [];
  const read = (via: string, tag: string | undefined) => async (command: { input: { SecretId?: string } }) => {
    const id = command.input.SecretId ?? "";
    reads.push({ via, id });
    // The role's policy: a tagged session reads only its own company's path; the task role (no tag) reads the whole family (release 1).
    if (tag !== undefined && !id.startsWith(`agentx/staging/slack-workspaces/${tag}/`)) throw denied();
    if (tag !== undefined && options.scopedReadFails === true) throw denied();
    const value = SECRETS.get(id);
    if (value === undefined) throw missing();
    return { SecretString: value };
  };
  const scoped: ScopedSecrets = {
    async assumeRole(request) {
      assumed.push(request);
      if (options.assumeFails === true) throw denied();
      const company = request.tags.find((tag) => tag.Key === "rovara:org")?.Value ?? "";
      const session: CompanySession = { credentials: { accessKeyId: `AKIA-${company}`, secretAccessKey: "s", sessionToken: "t" }, expiresAt: clock.t + 900_000 };
      return session;
    },
    clientFrom: (credentials) => ({ send: read(`session:${credentials.accessKeyId.slice(5)}`, credentials.accessKeyId.slice(5)) }),
  };
  const make = (env: Record<string, string | undefined>, withScoped = true) => serviceSlackWorkspacesFromEnvironment({ ...BASE, ...env }, {
    documentClient: db, secrets: { send: read("task-role", undefined) }, now: () => clock.t, ...(withScoped ? { scoped } : {}), log: (event, fields) => logs.push([event, fields]),
  })!.workspaces;
  return { make, reads, assumed, logs, clock, db, scoped };
}

describe("the hosted Slack service's scoped token read", () => {
  it("mints one session tagged with the bound company (900 s, the one tag) and reads that company's token through it", async () => {
    const { make, reads, assumed } = await world();
    const workspaces = make({ SLACK_COMPANY_TOKEN_ROLE_ARN: ROLE });
    expect(await workspaces.tokenForCompany(A, TEAM_A)).toBe(slackTokens("a").bot);
    expect(assumed).toHaveLength(1);
    expect(assumed[0]).toMatchObject({ roleArn: ROLE, tags: [{ Key: "rovara:org", Value: A }], durationSeconds: 900 });
    expect(assumed[0]!.sessionName).toMatch(/^rovara-slack-org_a{20}-[0-9a-f]{16}$/u);
    expect(reads).toEqual([{ via: `session:${A}`, id: `agentx/staging/slack-workspaces/${A}/${TEAM_A}` }]);
  });

  it("never mints a session or reads for a company the binding does not name (the argument is checked against the binding first)", async () => {
    const { make, reads, assumed } = await world();
    const workspaces = make({ SLACK_COMPANY_TOKEN_ROLE_ARN: ROLE });
    expect(await workspaces.tokenForCompany(B, TEAM_A)).toBeUndefined();
    expect(await workspaces.tokenForCompany(A, TEAM_B)).toBeUndefined();
    expect(await workspaces.tokenForCompany(A, "T0NOBINDING")).toBeUndefined();
    expect(await workspaces.tokenForCompany("not-a-company", TEAM_A)).toBeUndefined();
    expect(assumed).toEqual([]);
    expect(reads).toEqual([]);
  });

  it("keeps companies apart: each gets its own session and tag, and a session for A is denied B's secret (the IAM fence)", async () => {
    const { make, assumed } = await world();
    const workspaces = make({ SLACK_COMPANY_TOKEN_ROLE_ARN: ROLE });
    expect(await workspaces.tokenForCompany(A, TEAM_A)).toBe(slackTokens("a").bot);
    expect(await workspaces.tokenForCompany(B, TEAM_B)).toBe(slackTokens("b").bot);
    expect(assumed.map((request) => request.tags[0]!.Value)).toEqual([A, B]);
    // The fake's own policy (the reader role's), shown directly: a session tagged A reads A's path and is denied B's.
    const { scoped } = await world();
    const session = scoped.clientFrom({ accessKeyId: `AKIA-${A}`, secretAccessKey: "s", sessionToken: "t" });
    await expect(session.send({ input: { SecretId: `agentx/staging/slack-workspaces/${A}/${TEAM_A}` } } as never)).resolves.toMatchObject({ SecretString: expect.any(String) as unknown });
    await expect(session.send({ input: { SecretId: `agentx/staging/slack-workspaces/${B}/${TEAM_B}` } } as never)).rejects.toMatchObject({ name: "AccessDeniedException" });
  });

  it("reuses a company's session until a minute before it expires, mints one for concurrent first reads, and re-mints after", async () => {
    const { make, assumed, clock } = await world();
    const workspaces = make({ SLACK_COMPANY_TOKEN_ROLE_ARN: ROLE });
    await Promise.all([workspaces.tokenForCompany(A, TEAM_A), workspaces.tokenForCompany(A, TEAM_A), workspaces.tokenForCompany(A, TEAM_A)]);
    expect(assumed).toHaveLength(1);
    clock.t += 400_000; // past the 5-minute token cache, inside the session
    await workspaces.tokenForCompany(A, TEAM_A);
    expect(assumed).toHaveLength(1);
    clock.t += 500_000; // within a minute of the session's expiry
    await workspaces.tokenForCompany(A, TEAM_A);
    expect(assumed).toHaveLength(2);
  });

  it("with no role variable, reads through the task role exactly as before and never calls STS", async () => {
    const { make, reads, assumed } = await world();
    for (const variable of [undefined, ""]) {
      const workspaces = make({ SLACK_COMPANY_TOKEN_ROLE_ARN: variable });
      expect(await workspaces.tokenForCompany(A, TEAM_A)).toBe(slackTokens("a").bot);
    }
    expect(assumed).toEqual([]);
    expect(reads.every((entry) => entry.via === "task-role")).toBe(true);
  });

  it("release 1 (fallback=shared): a failed assume or a denied scoped read falls back to the task role, logging only an error name", async () => {
    for (const options of [{ assumeFails: true }, { scopedReadFails: true }]) {
      const { make, reads, logs } = await world(options);
      const workspaces = make({ SLACK_COMPANY_TOKEN_ROLE_ARN: ROLE, SLACK_COMPANY_TOKEN_FALLBACK: "shared" });
      expect(await workspaces.tokenForCompany(A, TEAM_A), JSON.stringify(options)).toBe(slackTokens("a").bot);
      expect(reads.at(-1)!.via).toBe("task-role");
      expect(logs).toEqual([["slack.company_token_scoped_failed", { error: "AccessDeniedException" }]]);
      expect(JSON.stringify(logs)).not.toContain("xoxb");
    }
  });

  it("release 2 (no fallback): a failed assume or a denied scoped read is a refusal, and the task role is never used", async () => {
    for (const options of [{ assumeFails: true }, { scopedReadFails: true }]) {
      const { make, reads } = await world(options);
      for (const fallback of [undefined, "", "disabled"]) {
        const workspaces = make({ SLACK_COMPANY_TOKEN_ROLE_ARN: ROLE, SLACK_COMPANY_TOKEN_FALLBACK: fallback });
        expect(await workspaces.tokenForCompany(A, TEAM_A), `${JSON.stringify(options)} ${fallback}`).toBeUndefined();
      }
      expect(reads.some((entry) => entry.via === "task-role")).toBe(false);
    }
  });

  it("a missing secret is simply none (no fallback read, no throw), and a malformed role ARN or a host without STS counts as a failed session", async () => {
    const { make, reads } = await world();
    const workspaces = make({ SLACK_COMPANY_TOKEN_ROLE_ARN: ROLE, SLACK_COMPANY_TOKEN_FALLBACK: "shared" });
    SECRETS.delete(`agentx/staging/slack-workspaces/${B}/${TEAM_B}`);
    try { expect(await workspaces.tokenForCompany(B, TEAM_B)).toBeUndefined(); } finally { SECRETS.set(`agentx/staging/slack-workspaces/${B}/${TEAM_B}`, JSON.stringify({ botToken: slackTokens("b").bot })); }
    expect(reads.some((entry) => entry.via === "task-role")).toBe(false);
    for (const [env, withScoped] of [[{ SLACK_COMPANY_TOKEN_ROLE_ARN: "arn:aws:iam::1:role/x" }, true], [{ SLACK_COMPANY_TOKEN_ROLE_ARN: ROLE }, false]] as const) {
      const strict = await world();
      expect(await strict.make({ ...env }, withScoped).tokenForCompany(A, TEAM_A)).toBeUndefined();
      expect(strict.reads.some((entry) => entry.via === "task-role")).toBe(false);
    }
  });
});
