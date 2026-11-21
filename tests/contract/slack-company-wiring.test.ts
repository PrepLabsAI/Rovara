// L2-2 PR 18c (DEC 254o b): Slack company mode's one factory, the Slack Lambda's split and team reading, the broker's link-notice invoke, DeveloperIdentity's split and the
// token cache's removal. Off (either switch missing, or a half-configured Lambda), the factory builds nothing and every export is today's.
import { describe, expect, it, vi } from "vitest";
import { IMPLICIT_COMPANY_ID } from "@agentx/contracts";
import { slackTokens } from "../../packages/testing/src/channel/slack-world.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { answerSlackLinkNotice, isSlackLinkNoticeEvent, slackCompanyDependenciesFromEnvironment, slackCompanyModeRequested } from "../../packages/broker/src/aws/slack-company-wiring.js";
import { slackIngressTeam } from "../../packages/broker/src/aws/slack-company-split.js";
import { slackLinkNotice } from "../../packages/broker/src/aws/slack-person.js";
import { createSlackWorkspaceTokens } from "../../packages/broker/src/aws/slack-workspace-tokens.js";
import { createWorkspaceSlackDirectory } from "../../packages/broker/src/aws/developer-identity.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa", B = "org_bbbbbbbbbbbbbbbbbbbb";
const INSTALL = "T0INSTALL0", OTHER = "T0BBBBBBB", USER = "U0SHARED00";
const ON = { SLACK_COMPANY_WORKSPACES: "enabled", COMPANY_SIGNIN: "enabled", STATE_TABLE_NAME: "agentx-staging-state", AGENTX_ENV: "staging", SLACK_TEAM_ID: INSTALL };
const clients = (send: { (command: never): Promise<unknown> } = vi.fn(async (): Promise<unknown> => ({}))) => ({ documentClient: { send }, dynamo: { send }, secrets: { send } });

describe("the factory", () => {
  it("builds nothing unless both switches are on and the Lambda is fully configured", () => {
    expect(slackCompanyModeRequested(ON)).toBe(true);
    for (const off of [{ SLACK_COMPANY_WORKSPACES: "disabled" }, { SLACK_COMPANY_WORKSPACES: undefined }, { COMPANY_SIGNIN: "disabled" }, { COMPANY_SIGNIN: undefined },
      { STATE_TABLE_NAME: "" }, { AGENTX_ENV: "" }, { AGENTX_ENV: "Bad/Env" }, { SLACK_TEAM_ID: "" }, { SLACK_TEAM_ID: "E0GRID000" }, { SLACK_COMPANY_WORKSPACES: "on" }]) {
      const send = vi.fn();
      expect(slackCompanyDependenciesFromEnvironment({ ...ON, ...off }, clients(send)), JSON.stringify(off)).toBeUndefined();
      expect(send).not.toHaveBeenCalled();
    }
    const wiring = slackCompanyDependenciesFromEnvironment(ON, clients())!;
    expect(wiring.legacyTeamId).toBe(INSTALL);
    expect(wiring.companies).toBeUndefined();
    expect(slackCompanyDependenciesFromEnvironment({ ...ON, DEVELOPER_SIGNIN_TABLE_NAME: "signin" }, clients())!.companies).toBeDefined();
  });

  it("reads a project's company with exactly the projection 18a grants, and refuses odd names before any read", async () => {
    const send = vi.fn(async (): Promise<unknown> => ({ Items: [{ pk: "PROJECT#payments", sk: "REV#000000000002", companyId: B }] }));
    const wiring = slackCompanyDependenciesFromEnvironment(ON, clients(send))!;
    expect(await wiring.workspaces.getProject("payments")).toEqual({ pk: "PROJECT#payments", sk: "REV#000000000002", companyId: B });
    const input = (send.mock.calls[0] as unknown as [{ input: Record<string, unknown> }])[0].input;
    expect(input).toMatchObject({ TableName: "agentx-staging-state", ProjectionExpression: "pk, sk, companyId", ScanIndexForward: false, Limit: 1, ConsistentRead: true,
      ExpressionAttributeValues: { ":pk": "PROJECT#payments", ":revision": "REV#" } });
    send.mockClear();
    for (const bad of ["", "a#b", "x".repeat(201), 7 as unknown as string]) expect(await wiring.workspaces.getProject(bad)).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it("DEC 254zzz80 (R2-F1 lane 1 review M2): a NAMED company's project is read from its own revisions, keys plus companyId and candidate only (the IAM grant's exact attributes)", async () => {
    const rows: Record<string, unknown[]> = {
      [`ORG#${A}#PROJECT#payments`]: [{ pk: `ORG#${A}#PROJECT#payments`, sk: "REV#000000000003", candidate: true }, { pk: `ORG#${A}#PROJECT#payments`, sk: "REV#000000000002" }],
      [`ORG#${A}#PROJECT#drift`]: [{ pk: `ORG#${A}#PROJECT#drift`, sk: "REV#000000000001", companyId: B }],
      [`ORG#${A}#PROJECT#waiting`]: [{ pk: `ORG#${A}#PROJECT#waiting`, sk: "REV#000000000001", candidate: true }],
    };
    const send = vi.fn(async (command: never): Promise<unknown> => ({ Items: rows[String((command as { input: { ExpressionAttributeValues: Record<string, unknown> } }).input.ExpressionAttributeValues[":pk"])] ?? [] }));
    const wiring = slackCompanyDependenciesFromEnvironment(ON, clients(send))!;
    expect(await wiring.workspaces.getProject("payments", A)).toEqual({ companyId: A });
    const input = (send.mock.calls[0] as unknown as [{ input: Record<string, unknown> }])[0].input;
    expect(input).toMatchObject({ ProjectionExpression: "pk, sk, companyId, candidate", ScanIndexForward: false, ConsistentRead: true, ExpressionAttributeValues: { ":pk": `ORG#${A}#PROJECT#payments`, ":revision": "REV#" } });
    // Another company's partition holds nothing; a row naming another company and a project with only a waiting candidate are not the company's.
    expect(await wiring.workspaces.getProject("payments", B)).toBeUndefined();
    expect(await wiring.workspaces.getProject("drift", A)).toBeUndefined();
    expect(await wiring.workspaces.getProject("waiting", A)).toBeUndefined();
    // The built-in company and no company: the legacy read exactly as before.
    send.mockClear();
    await wiring.workspaces.getProject("payments", IMPLICIT_COMPANY_ID);
    expect((send.mock.calls[0] as unknown as [{ input: Record<string, unknown> }])[0].input).toMatchObject({ ProjectionExpression: "pk, sk, companyId", Limit: 1, ExpressionAttributeValues: { ":pk": "PROJECT#payments" } });
  });

  it("reads the token from this environment's per-company secret, through the team's binding, never the install token", async () => {
    const names: string[] = [];
    const send = vi.fn(async (command: { input: Record<string, unknown> }): Promise<unknown> => {
      const input = command.input;
      if (typeof input.SecretId === "string") {
        names.push(input.SecretId);
        if (input.SecretId === `agentx/staging/slack-workspaces/${B}/${OTHER}`) return { SecretString: JSON.stringify({ botToken: slackTokens("b").bot }) };
        throw Object.assign(new Error("missing"), { name: "ResourceNotFoundException" });
      }
      const key = input.Key as { pk: string } | undefined;
      if (key?.pk === `SLACK_TEAM#${OTHER}`) return { Item: { pk: `SLACK_TEAM#${OTHER}`, sk: "BINDING", entityType: "SLACK_WORKSPACE_BINDING", teamId: OTHER, companyId: B, boundAt: "2026-11-17T00:00:00.000Z", boundBy: "operator" } };
      return {};
    });
    const wiring = slackCompanyDependenciesFromEnvironment(ON, clients(send))!;
    expect(await wiring.workspaces.tokenForCompany(B, OTHER)).toBe(slackTokens("b").bot);
    expect(await wiring.workspaces.tokenForCompany(A, OTHER)).toBeUndefined();
    expect(names).toEqual([`agentx/staging/slack-workspaces/${B}/${OTHER}`]);
    // The install's team without a company secret gets no install-token fallback here (the split keeps it on the legacy path).
    expect(await wiring.workspaces.tokenForCompany(IMPLICIT_COMPANY_ID, INSTALL)).toBeUndefined();
    expect(names.at(-1)).toBe(`agentx/staging/slack-workspaces/${IMPLICIT_COMPANY_ID}/${INSTALL}`);
  });

  it("DEC 254zzz35: with installToken, the install's own team in the built-in company reads the install's Slack app secret; no other team or company ever does", async () => {
    const names: string[] = [];
    const binding = (team: string, companyId: string) => ({ Item: { pk: `SLACK_TEAM#${team}`, sk: "BINDING", entityType: "SLACK_WORKSPACE_BINDING", teamId: team, companyId, boundAt: "2026-11-17T00:00:00.000Z", boundBy: "operator" } });
    const send = vi.fn(async (command: { input: Record<string, unknown> }): Promise<unknown> => {
      const input = command.input;
      if (typeof input.SecretId === "string") {
        names.push(input.SecretId);
        if (input.SecretId === "agentx/staging/slack") return { SecretString: JSON.stringify({ signingSecret: "s", botToken: slackTokens("install").bot }) };
        throw Object.assign(new Error("missing"), { name: "ResourceNotFoundException" });
      }
      const key = input.Key as { pk: string } | undefined;
      if (key?.pk === `SLACK_TEAM#${INSTALL}`) return binding(INSTALL, IMPLICIT_COMPANY_ID);
      if (key?.pk === `SLACK_TEAM#${OTHER}`) return binding(OTHER, B);
      return {};
    });
    const wiring = slackCompanyDependenciesFromEnvironment(ON, { ...clients(send), installToken: true })!;
    expect(await wiring.workspaces.tokenForCompany(IMPLICIT_COMPANY_ID, INSTALL)).toBe(slackTokens("install").bot);
    expect(names).toEqual([`agentx/staging/slack-workspaces/${IMPLICIT_COMPANY_ID}/${INSTALL}`, "agentx/staging/slack"]);
    // Another company's team (no company secret here) never falls back to the install token; nor does a company asking for the install's team.
    names.length = 0;
    expect(await wiring.workspaces.tokenForCompany(B, OTHER)).toBeUndefined();
    expect(await wiring.workspaces.tokenForCompany(B, INSTALL)).toBeUndefined();
    expect(names).not.toContain("agentx/staging/slack");
    // Without installToken (every other consumer): no install-token read at all.
    names.length = 0;
    expect(await slackCompanyDependenciesFromEnvironment(ON, clients(send))!.workspaces.tokenForCompany(IMPLICIT_COMPANY_ID, INSTALL)).toBeUndefined();
    expect(names).not.toContain("agentx/staging/slack");
  });

  it("the broker's Slack company wiring asks for the install token (root wiring)", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("../../packages/broker/src/aws/broker.ts", import.meta.url), "utf8");
    const calls = source.match(/slackCompanyDependenciesFromEnvironment\(process\.env, \{[^}]*\}/gu) ?? [];
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("installToken: true");
  });

  it("builds link URLs only from the given origin, and hands a no-write consumer's notice to the broker", async () => {
    const linkNotice = vi.fn(async () => "link your account: Open in Rovara: https://x");
    const wiring = slackCompanyDependenciesFromEnvironment(ON, { ...clients(), linkOrigin: "https://api.example.test/v1/auth", linkNotice })!;
    expect(wiring.workspaces.linkUrl("ab/c")).toBe("https://api.example.test/review/link/ab%2Fc");
    expect(() => slackCompanyDependenciesFromEnvironment(ON, clients())!.workspaces.linkUrl("x")).toThrow();
    // A malformed issuer never stops the consumer from starting: it only has no link origin.
    expect(() => slackCompanyDependenciesFromEnvironment(ON, { ...clients(), linkOrigin: "not a url" })!.workspaces.linkUrl("x")).toThrow("no link origin");
    const store = new MemoryDocumentStore(); const put = vi.spyOn(store, "put");
    expect(await slackLinkNotice({ workspaces: { ...wiring.workspaces, store } }, OTHER, USER)).toBe("link your account: Open in Rovara: https://x");
    expect(linkNotice).toHaveBeenCalledWith(OTHER, USER);
    expect(put).not.toHaveBeenCalled();
  });
});

describe("the broker's link notice for the Slack Lambda", () => {
  const workspaces = () => ({ store: new MemoryDocumentStore(), getProject: async () => ({ companyId: B }), linkUrl: (code: string) => `https://example.test/review/link/${code}`,
    requireCompany: async (team: string): Promise<string> => { if (team === OTHER) return B; throw Error("private"); },
    tokenForEvent: async () => ({ companyId: B, token: slackTokens("b").bot }) });
  it("issues one notice per person per interval from the broker's own store", async () => {
    const deps = { workspaces: workspaces() };
    const first = await answerSlackLinkNotice(deps, { source: "agentx.slack-link-notice", teamId: OTHER, userId: USER });
    expect(first.text).toMatch(/^link your account: Open in Rovara: https:\/\/example\.test\/review\/link\/.+/u);
    expect(await answerSlackLinkNotice(deps, { source: "agentx.slack-link-notice", teamId: OTHER, userId: USER })).toEqual({});
  });
  it("gives one empty answer for anything wrong, and nothing without the company path", async () => {
    expect(await answerSlackLinkNotice({}, { source: "agentx.slack-link-notice", teamId: OTHER, userId: USER })).toEqual({});
    for (const bad of [{ teamId: "T0UNBOUND", userId: USER }, { teamId: OTHER, userId: "nope" }, { teamId: "E0GRID000", userId: USER }, { teamId: OTHER, userId: USER, extra: 1 }]) {
      expect(await answerSlackLinkNotice({ workspaces: workspaces() }, { source: "agentx.slack-link-notice", ...bad } as never), JSON.stringify(bad)).toEqual({});
    }
    // Never a delegate loop: the broker's own workspaces are used even if a linkNotice is attached.
    const delegate = vi.fn(async () => "loop");
    expect((await answerSlackLinkNotice({ workspaces: { ...workspaces(), linkNotice: delegate } }, { source: "agentx.slack-link-notice", teamId: OTHER, userId: USER })).text).toMatch(/^link your account/u);
    expect(delegate).not.toHaveBeenCalled();
    expect(isSlackLinkNoticeEvent({ source: "agentx.slack-link-notice", requestContext: {} })).toBe(false);
  });
});

describe("the Slack Lambda's team and split", () => {
  const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
  const http = (body: string, base64 = false) => ({ requestContext: { http: { method: "POST" } }, rawPath: "/v1/slack/events", body: base64 ? Buffer.from(body).toString("base64") : body, isBase64Encoded: base64 });
  it("reads Slack's own team field for each kind of request, and nothing else", () => {
    const named = (team: string | undefined) => ({ named: true, team });
    expect(slackIngressTeam(http(JSON.stringify({ type: "event_callback", team_id: OTHER })))).toEqual(named(OTHER));
    expect(slackIngressTeam(http(JSON.stringify({ type: "event_callback", team_id: OTHER }), true))).toEqual(named(OTHER));
    expect(slackIngressTeam(http(form({ payload: JSON.stringify({ type: "block_actions", team: { id: OTHER } }) })))).toEqual(named(OTHER));
    expect(slackIngressTeam(http(form({ payload: JSON.stringify({ type: "view_submission", user: { team_id: OTHER } }) })))).toEqual(named(OTHER));
    expect(slackIngressTeam(http(form({ command: "/rovara", team_id: OTHER })))).toEqual(named(OTHER));
    expect(slackIngressTeam({ source: "agentx.slack-interactivity", thread: { teamId: OTHER } })).toEqual(named(OTHER));
    expect(slackIngressTeam({ source: "agentx.slack-interactivity", teamId: OTHER })).toEqual(named(OTHER));
    expect(slackIngressTeam({ source: "agentx.slack-adapter", kind: "forward", message: { actor: { tenant: OTHER } } })).toEqual(named(OTHER));
    // Named but unknown or unreadable: still named, so never today's handler.
    expect(slackIngressTeam(http(JSON.stringify({ team_id: "E0GRID000" })))).toEqual(named("E0GRID000"));
    for (const unreadable of [http("{not json"), http(form({ payload: "{bad" })), { ...http(""), body: 7 }, { requestContext: {}, body: "x".repeat(1_048_577) },
      http(JSON.stringify({ team: null })), http(JSON.stringify([1])), { thread: null }, { teamId: 7 }, { message: { actor: null } }]) {
      expect(slackIngressTeam(unreadable), JSON.stringify(unreadable).slice(0, 80)).toEqual(named(undefined));
    }
    expect(slackIngressTeam({ source: "agentx.slack-rovara-handoff", event: { teamId: OTHER } })).toEqual(named(OTHER));
    // Every team field must agree (Slack Connect / shared channels): any mismatch is "named, unknown".
    expect(slackIngressTeam(http(JSON.stringify({ team_id: INSTALL, authorizations: [{ team_id: OTHER }] })))).toEqual(named(undefined));
    expect(slackIngressTeam(http(JSON.stringify({ team_id: INSTALL, context_team_id: OTHER })))).toEqual(named(undefined));
    expect(slackIngressTeam(http(JSON.stringify({ team_id: INSTALL, authorizations: [{ team_id: INSTALL }], context_team_id: INSTALL })))).toEqual(named(INSTALL));
    expect(slackIngressTeam(http(form({ payload: JSON.stringify({ team: { id: INSTALL }, user: { team_id: OTHER } }) })))).toEqual(named(undefined));
    expect(slackIngressTeam(http(JSON.stringify({ team_id: INSTALL, authorizations: "x" })))).toEqual(named(undefined));
    // The channel API's adapter paths name their tenant.
    expect(slackIngressTeam({ ...http(JSON.stringify({ conversation: { tenant: OTHER } })), rawPath: "/v1/slack/channel/events" })).toEqual(named(OTHER));
    expect(slackIngressTeam(http(JSON.stringify({ tenant: OTHER })))).toEqual(named(OTHER));
    expect(slackIngressTeam(http(JSON.stringify({ to: { tenant: OTHER } })))).toEqual(named(OTHER));
    expect(slackIngressTeam({ source: "agentx.slack-adapter", kind: "forward", message: { actor: { tenant: INSTALL }, conversation: { tenant: OTHER } } })).toEqual(named(undefined));
    for (const none of [http(JSON.stringify({ type: "url_verification", challenge: "x" })), http(form({ command: "/x" })), http(""), null, [], { source: "agentx.slack-rovara-handoff" }, { message: { text: "x" } }]) {
      expect(slackIngressTeam(none), JSON.stringify(none).slice(0, 80)).toEqual({ named: false });
    }
  });
});

describe("the broker side", () => {
  it("answers the link-notice invoke only where the company path exists (off: today's answer), and keeps company membership out of the legacy view", async () => {
    const { loadSlackBroker, createBroker } = await import("../support/slack-broker.js");
    const { withoutSlackCompanyMode } = await import("../../packages/broker/src/aws/slack-company-split.js");
    await loadSlackBroker();
    const h = createBroker();
    const answer = await h.handler({ source: "agentx.slack-link-notice", teamId: OTHER, userId: USER });
    // The gated branch would answer 200 with the "slack-link-notice" request id; off, the event is not served by it at all.
    expect(answer.body).not.toContain("slack-link-notice");
    expect(withoutSlackCompanyMode({ workspaces: {}, slackCompanies: {}, companies: { a: 1 }, tableName: "t" }, INSTALL)).toStrictEqual({ companies: { a: 1 }, tableName: "t", slackInstallTeamOnly: INSTALL });
  });
});

describe("the Slack Lambda's export", () => {
  it("is today's handler alone when off, and when on adds the company handler with the token cache's removal hook", async () => {
    const { createAwsSlackHandlerFromEnvironment } = await import("../../packages/broker/src/aws/slack-ingress.js");
    const made: Array<Record<string, unknown>> = [];
    const make = (company: Record<string, unknown>) => { made.push(company); const body = "workspaces" in company ? "company" : "legacy"; const handler = async () => ({ statusCode: 200, headers: {}, body }); return handler as never; };
    const off = createAwsSlackHandlerFromEnvironment({ ...ON, COMPANY_SIGNIN: undefined, BROKER_FUNCTION_NAME: "broker" }, make as never);
    expect(made).toEqual([{}]);
    expect(await (off as (event: unknown) => Promise<{ body: string }>)({})).toMatchObject({ body: "legacy" });
    made.length = 0;
    const on = createAwsSlackHandlerFromEnvironment({ ...ON, BROKER_FUNCTION_NAME: "broker" }, make as never) as (event: unknown) => Promise<{ body: string }>;
    expect(made).toHaveLength(2);
    // DEC 254zzz80 (R2-F1): the install team's legacy view also knows the install team's company (its operator binding), to pick where its channel bindings are read.
    expect(made[0]).toEqual({ slackInstallTeamOnly: INSTALL, installTeamCompany: expect.any(Function) as unknown });
    expect(Object.keys(made[1]!).sort()).toEqual(["onWorkspaceRemoved", "workspaces"]);
    expect((await on({ requestContext: {}, body: JSON.stringify({ team_id: OTHER }) })).body).toBe("company");
    // #1300: the install's team takes today's handler only while its binding names the built-in company. This Lambda has no table to read here, so the binding is
    // unreadable and the install's team fails closed to the company handler (slack-company-split.test.ts covers both bindings).
    expect((await on({ requestContext: {}, body: JSON.stringify({ team_id: INSTALL }) })).body).toBe("company");
    expect((await on({ requestContext: {}, body: "" })).body).toBe("legacy");
    made.length = 0;
    // No broker to issue notices: stays today's handler.
    createAwsSlackHandlerFromEnvironment({ ...ON, BROKER_FUNCTION_NAME: "" }, make as never);
    expect(made).toEqual([{}]);
  });

  it("drops the cached token only after the broker accepted the removal", async () => {
    const { brokerWorkspaceRemoved } = await import("../../packages/broker/src/aws/slack-ingress.js");
    vi.stubEnv("BROKER_FUNCTION_NAME", "broker");
    const forget = vi.fn();
    const reply = (statusCode: number) => ({ Payload: Buffer.from(JSON.stringify({ statusCode, body: "{}" })) });
    const removal = { source: "agentx.slack-workspace-removed", teamId: OTHER, reason: "app_uninstalled", eventTime: 1 } as const;
    await expect(brokerWorkspaceRemoved(forget, { send: async () => reply(500) }).workspaceRemoved!(removal)).rejects.toThrow();
    expect(forget).not.toHaveBeenCalled();
    await brokerWorkspaceRemoved(forget, { send: async () => reply(200) }).workspaceRemoved!(removal);
    expect(forget).toHaveBeenCalledWith(OTHER);
    vi.unstubAllEnvs();
  });
});

describe("DeveloperIdentity's directory split", () => {
  const legacyDirectory = {} as never;
  const workspaces = { requireCompany: async (team: string) => (team === OTHER ? B : IMPLICIT_COMPANY_ID), tokenForCompany: async () => slackTokens("b").bot };
  it("answers the install's team and an unscoped read as today (refused: company sign-in has no install directory), another team with its own directory", async () => {
    const directory = createWorkspaceSlackDirectory({ legacy: legacyDirectory, workspaces, legacyTeamId: INSTALL, fetch: vi.fn() as never, now: Date.now });
    await expect(directory(undefined)).rejects.toThrow("This Slack workspace is not available.");
    await expect(directory({ companyId: IMPLICIT_COMPANY_ID, teamId: INSTALL })).rejects.toThrow("This Slack workspace is not available.");
    const own = await directory({ companyId: B, teamId: OTHER });
    expect(own).not.toBe(legacyDirectory);
    await expect(directory({ companyId: A, teamId: OTHER })).rejects.toThrow("This Slack workspace is not available.");
  });
  it("is unchanged without a legacy team (the existing callers)", async () => {
    const directory = createWorkspaceSlackDirectory({ legacy: legacyDirectory, fetch: vi.fn() as never, now: Date.now });
    expect(await directory(undefined)).toBe(legacyDirectory);
  });
});

describe("the token cache on removal", () => {
  it("forgets only the removed team, so the next call reads the binding and secret again", async () => {
    const readSecret = vi.fn(async () => JSON.stringify({ botToken: slackTokens("b").bot }));
    const company = { [OTHER]: B, T0CCCCCCC: A } as Record<string, string>;
    const tokens = createSlackWorkspaceTokens({ bindings: { requireCompany: async (team) => company[team]! }, environment: "staging", readSecret });
    await tokens.tokenForEvent(OTHER); await tokens.tokenForEvent("T0CCCCCCC");
    await tokens.tokenForEvent(OTHER); await tokens.tokenForEvent("T0CCCCCCC");
    expect(readSecret).toHaveBeenCalledTimes(2);
    tokens.forget!(OTHER);
    await tokens.tokenForEvent(OTHER); await tokens.tokenForEvent("T0CCCCCCC");
    expect(readSecret).toHaveBeenCalledTimes(3);
    tokens.forget!("not a team");
    expect(readSecret).toHaveBeenCalledTimes(3);
  });
});
