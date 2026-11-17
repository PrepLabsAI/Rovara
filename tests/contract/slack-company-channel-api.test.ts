// DEC 254y(3), L2-2 PR 18e: Slack company mode in the channel API's Lambda. Off, every Slack piece is today's, made exactly as before; on, the install's team keeps today's
// piece and any other tenant (or one that cannot be read) goes to the company piece, which refuses what its binding does not allow.
import { describe, expect, it, vi } from "vitest";
import { builtInAdapterRecord, generateWebhookSecret, webhookHeaders, type ChannelAction, type InboundMessage } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import {
  channelApiSlackCompany, channelApiSlackPieces, createChannelApiLambda, splitChatGptFinishByTeam, type ChannelApiSlackMakers,
} from "../../packages/broker/src/aws/channel-api-lambda.js";
import { slackCompanyActionSurface, splitChannelActionSurfaceByTenant } from "../../packages/broker/src/aws/slack-channel-presses.js";
import { channelItemOnInstallTeam, splitChannelSurfaceByTenant } from "../../packages/broker/src/aws/slack-channel-router.js";
import type { SlackCompanyWiring } from "../../packages/broker/src/aws/slack-company-wiring.js";
import type { HandedOffChatGptFinish } from "../../packages/broker/src/aws/slack-chatgpt.js";
import { createChannelIngressHandler, type ChannelActionSurface, type ChannelSurface } from "../../packages/broker/src/aws/channel-ingress.js";

const INSTALL = "T0INSTALL0", OTHER = "T0OTHER000", UNKNOWN = "T0UNKNOWN0", USER = "U0PERSON00", CHANNEL = "C0CHANNEL0", TS = "1700000000.000001";
const A = "org_aaaaaaaaaaaaaaaaaaaa", B = "org_bbbbbbbbbbbbbbbbbbbb";
const REFUSED = "This Slack workspace is not available.";

function message(actorTenant: unknown = INSTALL, conversationTenant: unknown = actorTenant): InboundMessage {
  return {
    version: 2, channel: "slack", eventId: "Ev0001", text: "hello", receivedAt: "2026-11-17T12:00:00.000Z",
    conversation: { channel: "slack", tenant: conversationTenant, space: CHANNEL, thread: TS },
    actor: { channel: "slack", tenant: actorTenant, userId: USER },
  } as InboundMessage;
}
function action(actorTenant: unknown = INSTALL, conversationTenant: unknown = actorTenant, withConversation = true): ChannelAction {
  return {
    version: 1, channel: "slack", eventId: "action-1", actionId: "agentx_details", value: "details", receivedAt: "2026-11-17T12:00:00.000Z",
    actor: { channel: "slack", tenant: actorTenant, userId: USER },
    ...(withConversation ? { conversation: { channel: "slack", tenant: conversationTenant, space: CHANNEL, thread: TS } } : {}),
  } as ChannelAction;
}
function finishEvent(teamId: unknown = INSTALL): HandedOffChatGptFinish {
  return { source: "agentx.slack-interactivity", action: "chatgpt-finish", teamId, userId: USER, channel: CHANNEL, threadTs: TS, callbackUrl: "https://example.test/cb", viewId: "V0VIEW0001" } as HandedOffChatGptFinish;
}
const surfaces = () => {
  const legacy = vi.fn<ChannelSurface>(async () => ({ statusCode: 200, body: "legacy" }));
  const company = vi.fn<ChannelSurface>(async () => ({ statusCode: 200, body: "company" }));
  return { legacy, company };
};
const actionSurfaces = () => {
  const legacy = vi.fn<ChannelActionSurface>(async () => ({ statusCode: 200, body: "legacy" }));
  const company = vi.fn<ChannelActionSurface>(async () => ({ statusCode: 200, body: "company" }));
  return { legacy, company };
};
function wiring(): SlackCompanyWiring {
  const workspaces = {
    store: new MemoryDocumentStore(), getProject: async () => ({ companyId: A }), linkUrl: (code: string) => `https://example.test/review/link/${code}`,
    requireCompany: async (team: string): Promise<string> => { if (team !== INSTALL && team !== OTHER) throw new Error("private-directory-cause"); return team === INSTALL ? A : B; },
    tokenForEvent: async (team: string) => ({ companyId: team === INSTALL ? A : B, token: "token" }),
    tokenForCompany: async () => "token",
  };
  return { legacyTeamId: INSTALL, workspaces, companies: { companyOf: async () => A }, forget: vi.fn() };
}

describe("the tenant read", () => {
  it.each([
    ["message on the install", message(), true, true],
    ["message from another actor tenant", message(OTHER, INSTALL), true, false],
    ["message in another conversation tenant", message(INSTALL, OTHER), true, false],
    ["message with a non-string actor tenant", message(42, INSTALL), true, false],
    ["message with a non-string conversation tenant", message(INSTALL, { tenant: INSTALL }), true, false],
    ["message with no conversation", { ...message(), conversation: undefined }, true, false],
    ["press on the install", action(), false, true],
    ["press with no conversation on the install", action(INSTALL, INSTALL, false), false, true],
    ["press with no conversation from another team", action(OTHER, OTHER, false), false, false],
    ["press with another conversation tenant", action(INSTALL, OTHER), false, false],
    ["press with a null conversation", { ...action(), conversation: null }, false, false],
    ["press with no actor", { ...action(), actor: undefined }, false, false],
    ["null", null, false, false],
    ["a string", INSTALL, false, false],
  ])("%s", (_name, item, conversationRequired, expected) => {
    expect(channelItemOnInstallTeam(item, INSTALL, conversationRequired)).toBe(expected);
  });
});

describe("per-tenant routing of messages", () => {
  it("the install's team goes to today's surface with the same message and context", async () => {
    const { legacy, company } = surfaces(); const run = splitChannelSurfaceByTenant(legacy, company, INSTALL);
    const m = message();
    expect((await run(m, { projectName: "payments" })).body).toBe("legacy");
    expect(legacy).toHaveBeenCalledWith(m, { projectName: "payments" }); expect(company).not.toHaveBeenCalled();
  });
  it.each([
    ["a foreign team", message(OTHER)],
    ["an unknown team", message(UNKNOWN)],
    ["mixed tenants (actor foreign)", message(OTHER, INSTALL)],
    ["mixed tenants (conversation foreign)", message(INSTALL, OTHER)],
    ["an unreadable tenant", { ...message(), actor: { channel: "slack", tenant: undefined, userId: USER }, conversation: { channel: "slack", tenant: undefined, space: CHANNEL, thread: TS } } as unknown as InboundMessage],
  ])("%s goes to the company surface", async (_name, m) => {
    const { legacy, company } = surfaces(); const run = splitChannelSurfaceByTenant(legacy, company, INSTALL);
    expect((await run(m, { projectName: "payments" })).body).toBe("company");
    expect(company).toHaveBeenCalledWith(m, { projectName: "payments" }); expect(legacy).not.toHaveBeenCalled();
  });
  it("with no company surface, today's surface is returned as it is", () => {
    const { legacy } = surfaces();
    expect(splitChannelSurfaceByTenant(legacy, undefined, INSTALL)).toBe(legacy);
  });
});

describe("per-tenant routing of presses", () => {
  it.each([
    ["the install's team", action(), "legacy"],
    ["the install's team with no conversation", action(INSTALL, INSTALL, false), "legacy"],
    ["a foreign team", action(OTHER), "company"],
    ["a foreign presser in the install's conversation", action(OTHER, INSTALL), "company"],
    ["the install's presser in a foreign conversation", action(INSTALL, OTHER), "company"],
    ["an unknown team", action(UNKNOWN), "company"],
    ["an unreadable tenant", action(7, 7), "company"],
  ])("%s goes to %s", async (_name, a, expected) => {
    const { legacy, company } = actionSurfaces(); const run = splitChannelActionSurfaceByTenant(legacy, company, INSTALL);
    expect((await run(a, { projectName: "payments" }))?.body).toBe(expected);
    expect((expected === "legacy" ? company : legacy)).not.toHaveBeenCalled();
  });
  it("with no company surface, today's surface is returned as it is", () => {
    const { legacy } = actionSurfaces();
    expect(splitChannelActionSurfaceByTenant(legacy, undefined, INSTALL)).toBe(legacy);
  });
  it("an unknown team fails closed in the company surface: refused, today's handler never runs, no cause shown", async () => {
    const { legacy } = actionSurfaces(); const next = vi.fn<ChannelActionSurface>(async () => ({ statusCode: 200, body: "handled" }));
    const w = wiring();
    const run = splitChannelActionSurfaceByTenant(legacy, slackCompanyActionSurface({ workspaces: w.workspaces, companies: w.companies! }, next), INSTALL);
    const answer = await run(action(UNKNOWN), { projectName: "payments" });
    expect(answer?.body).toBe(JSON.stringify({ error: REFUSED }));
    expect(answer?.body).not.toContain("private-directory-cause"); expect(answer?.body).not.toContain(UNKNOWN);
    expect(legacy).not.toHaveBeenCalled(); expect(next).not.toHaveBeenCalled();
  });
});

describe("the ChatGPT finish", () => {
  it.each([[INSTALL, "connected"], [OTHER, "refused"], [UNKNOWN, "refused"], ["(absent)", "refused"], [42, "refused"]])("team %s -> %s", async (team, expected) => {
    const legacy = vi.fn(async () => "connected" as const), company = vi.fn(async () => "refused" as const);
    const event = team === "(absent)" ? { ...finishEvent(), teamId: undefined } as unknown as HandedOffChatGptFinish : finishEvent(team);
    expect(await splitChatGptFinishByTeam(legacy, company, INSTALL)(event)).toBe(expected);
    expect((expected === "connected" ? company : legacy)).not.toHaveBeenCalled();
  });
  it("with no company finish, today's finish is returned as it is", () => {
    const legacy = vi.fn(async () => "connected" as const);
    expect(splitChatGptFinishByTeam(legacy, undefined, INSTALL)).toBe(legacy);
  });
});

function makers() {
  const made: Record<"router" | "presses" | "finish", unknown[][]> = { router: [], presses: [], finish: [] };
  const routers: ReturnType<typeof surfaces>["legacy"][] = [], presses: ReturnType<typeof actionSurfaces>["legacy"][] = [], finishes: Array<ReturnType<typeof vi.fn>> = [];
  const m: ChannelApiSlackMakers = {
    router: (...args: unknown[]) => { made.router.push(args); const i = routers.length; const s = vi.fn<ChannelSurface>(async () => ({ statusCode: 200, body: `router-${i}` })); routers.push(s); return s; },
    presses: (...args: unknown[]) => { made.presses.push(args); const i = presses.length; const s = vi.fn<ChannelActionSurface>(async () => ({ statusCode: 200, body: `presses-${i}` })); presses.push(s); return s; },
    finish: (...args: unknown[]) => { made.finish.push(args); const i = finishes.length; const f = vi.fn(async () => (i === 0 && args.length > 0 ? "connected" as const : "refused" as const)); finishes.push(f); return f; },
  };
  return { m, made, routers, presses, finishes };
}

describe("switch-off parity (golden)", () => {
  it("off, each piece is made with no argument and returned as it is", () => {
    const { m, made, routers, presses, finishes } = makers();
    const pieces = channelApiSlackPieces(m, undefined);
    expect(pieces.router()).toBe(routers[0]); expect(pieces.presses()).toBe(presses[0]); expect(pieces.finish()).toBe(finishes[0]);
    expect(made).toEqual({ router: [[]], presses: [[]], finish: [[]] });
  });
  it.each([
    ["no switches", {}],
    ["SLACK_COMPANY_WORKSPACES disabled", { SLACK_COMPANY_WORKSPACES: "disabled", COMPANY_SIGNIN: "enabled" }],
    ["COMPANY_SIGNIN missing", { SLACK_COMPANY_WORKSPACES: "enabled" }],
    ["no broker function", { SLACK_COMPANY_WORKSPACES: "enabled", COMPANY_SIGNIN: "enabled", BROKER_FUNCTION_NAME: "" }],
    ["no State table", { SLACK_COMPANY_WORKSPACES: "enabled", COMPANY_SIGNIN: "enabled", BROKER_FUNCTION_NAME: "broker" }],
  ])("%s: no company wiring", (_name, env) => {
    expect(channelApiSlackCompany({ AGENTX_ENV: "staging", SLACK_TEAM_ID: INSTALL, ...env })).toBeUndefined();
  });
  it("fully configured: wiring for the install's team", () => {
    const w = channelApiSlackCompany({ SLACK_COMPANY_WORKSPACES: "enabled", COMPANY_SIGNIN: "enabled", BROKER_FUNCTION_NAME: "broker", STATE_TABLE_NAME: "state", AGENTX_ENV: "staging", SLACK_TEAM_ID: INSTALL, AWS_REGION: "us-west-2" });
    expect(w?.legacyTeamId).toBe(INSTALL); expect(Object.keys(w?.workspaces ?? {})).toContain("linkNotice");
  });
  it("the Lambda, off: the finish is today's (made with no argument) and its answer is passed back unchanged; no company wiring is asked twice", async () => {
    const { m, made } = makers(); const companyOf = vi.fn(() => undefined);
    const run = createChannelApiLambda({ BUILT_IN_ADAPTER: "enabled" }, m, companyOf);
    expect(await run(finishEvent(OTHER))).toEqual({ outcome: "refused" });
    expect(await run(finishEvent(INSTALL))).toEqual({ outcome: "refused" });
    expect(made.finish).toEqual([[]]); expect(companyOf).toHaveBeenCalledTimes(1);
  });
  it("the Lambda, built-in adapter off: the finish throws today's error and nothing is made", async () => {
    const { m, made } = makers(); const companyOf = vi.fn(() => wiring());
    const run = createChannelApiLambda({}, m, companyOf);
    await expect(run(finishEvent())).rejects.toThrow("Slack does not go through the channel API here");
    expect(made).toEqual({ router: [], presses: [], finish: [] }); expect(companyOf).not.toHaveBeenCalled();
  });
});

describe("switch on", () => {
  it("each piece is two: today's with the install-only rule, and the company's with the binding", async () => {
    const { m, made, routers, presses } = makers(); const w = wiring(); const forget = vi.spyOn(w, "forget");
    const pieces = channelApiSlackPieces(m, w);
    const router = pieces.router(), press = pieces.presses(), finish = pieces.finish();
    expect(made.router).toEqual([[{ slackInstallTeamOnly: INSTALL }], [expect.objectContaining({ workspaces: w.workspaces, companies: w.companies })]]);
    expect(made.presses).toEqual([[{ slackInstallTeamOnly: INSTALL }], [expect.objectContaining({ workspaces: w.workspaces, companies: w.companies })]]);
    expect(made.finish).toEqual([[{ slackInstallTeamOnly: INSTALL }], [expect.objectContaining({ workspaces: w.workspaces })]]);
    (made.router[1]![0] as { onWorkspaceRemoved: (team: string) => void }).onWorkspaceRemoved(OTHER);
    expect(forget).toHaveBeenCalledWith(OTHER);
    expect((await router(message(), { projectName: "p" })).body).toBe("router-0");
    expect((await router(message(OTHER), { projectName: "p" })).body).toBe("router-1");
    expect((await press(action(), {}))?.body).toBe("presses-0");
    expect((await press(action(UNKNOWN), {}))?.body).toBe("presses-1");
    expect(routers[0]).toHaveBeenCalledTimes(1); expect(routers[1]).toHaveBeenCalledTimes(1);
    expect(presses[0]).toHaveBeenCalledTimes(1); expect(presses[1]).toHaveBeenCalledTimes(1);
    expect(await finish(finishEvent(INSTALL))).toBe("connected");
    expect(await finish(finishEvent(OTHER))).toBe("refused");
  });
  it("the Lambda, on: a foreign team's finish goes to the company finish", async () => {
    const { m, finishes } = makers();
    const run = createChannelApiLambda({ BUILT_IN_ADAPTER: "enabled" }, m, () => wiring());
    expect(await run(finishEvent(OTHER))).toEqual({ outcome: "refused" });
    expect(await run(finishEvent(INSTALL))).toEqual({ outcome: "connected" });
    expect(finishes[0]).toHaveBeenCalledTimes(1); expect(finishes[1]).toHaveBeenCalledTimes(1);
  });
});

describe("through the signed channel ingress", () => {
  const SECRET = generateWebhookSecret(), NOW = Date.parse("2026-11-17T12:00:00.000Z");
  const builtIn = builtInAdapterRecord({ channel: "slack", callbackUrl: "https://api.example.com/v1/slack/channel-events", secretName: "agentx/test/channel-adapter/slack" });
  function post(m: InboundMessage, surface: ChannelSurface, id: string) {
    const handler = createChannelIngressHandler({
      getAdapter: async (channel) => (channel === "slack" ? builtIn : undefined), getSecret: async () => SECRET,
      getBinding: async (ref) => ({ ...ref, projectName: "web", updatedAt: "2026-11-01T00:00:00.000Z" }),
      linkedDeveloper: vi.fn(), issueLinkCode: vi.fn(), linkUrl: (code) => code, claim: async () => true, release: async () => undefined,
      enqueue: async () => undefined, sendEvent: vi.fn(), surfaces: { slack: surface }, now: () => NOW, log: () => undefined,
    });
    const body = JSON.stringify({ ...m, receivedAt: new Date(NOW).toISOString() });
    return handler({ rawPath: "/v1/channels/slack/messages", body, headers: webhookHeaders({ secret: SECRET, id, timestamp: NOW / 1000, body }), requestContext: { http: { method: "POST" } } });
  }
  it.each([[INSTALL, "legacy"], [OTHER, "company"]])("a signed message from %s reaches the %s surface only", async (team, expected) => {
    const { legacy, company } = surfaces();
    expect((await post(message(team), splitChannelSurfaceByTenant(legacy, company, INSTALL), `m-${team}`)).statusCode).toBe(200);
    expect((expected === "legacy" ? legacy : company)).toHaveBeenCalledTimes(1);
    expect((expected === "legacy" ? company : legacy)).not.toHaveBeenCalled();
  });
});
