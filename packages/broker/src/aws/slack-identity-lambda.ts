// Typed Lambda RPC client and forwarders for the DeveloperIdentity function (extracted from aws/developer-routes.ts).
import { z } from "zod";
import {
  SignInClientViewSchema,
  SlackWorkspaceScopeSchema,
  TaskChannelPeopleResponseSchema,
  TaskPeopleDisplayReadResponseSchema,
  TaskPersonProofResponseSchema,
  agentXError,
  type ChannelByNameRequest,
  type ChannelByNameResponse,
  type ChannelInfoRequest,
  type ChannelInfoResponse,
  type ChannelMembersRequest,
  type ChannelMembersResponse,
  type EndDeveloperSessionsRequest,
  type EndDeveloperSessionsResponse,
  type ListSignInClientsRequest,
  type PutSignInClientRequest,
  type RemoveSignInClientRequest,
  type SetDisplayNameRequest,
  type SetDisplayNameResponse,
  type SignInClientRecord,
  type SignInClientView,
  type SlackAuthCheckResponse,
  type SlackUserByEmailRequest,
  type SlackUserByEmailResponse,
  type SlackWorkspaceScope,
  type TaskChannelPeopleRequest,
  type TaskChannelPeopleResponse,
  type TaskPeopleDisplayReadRequest,
  type TaskPeopleDisplayReadResponse,
  type TaskPersonProofRequest,
  type TaskPersonProofResponse,
} from "@agentx/contracts";
import type { ServerKeyRead } from "./server-read-context.js";

/** What the broker needs from a Lambda invoke; `@aws-sdk/client-lambda`'s InvokeCommand output fits. */
export interface ChannelMembersInvokeResult {
  FunctionError?: string | undefined;
  Payload?: Uint8Array | undefined;
}

export interface SignInClientRegistry {
  /** `keepSecret`: keep the stored client's secret, which only the sign-in server can read. */
  put(client: SignInClientRecord, options?: { keepSecret?: true; companyId?: string }): Promise<void>;
  remove(clientId: string, companyId?: string): Promise<boolean>;
  list(companyId?: string): Promise<SignInClientView[]>;
}

export type DeveloperEventLogger = (entry: Record<string, string | number>) => void;

export const SLACK_UNAVAILABLE = { ok: false, error: "slack_unavailable" } as const;
/** A Slack or DeveloperIdentity error code: the only error text that may reach a log or an answer (R9). */
const SLACK_ERROR_CODE = /^[a-z_]{1,64}$/;
export type IdentityRefusal = typeof SLACK_UNAVAILABLE | { ok: false; error: "invalid_request" };

const errorName = (error: unknown) => (error instanceof Error ? error.name : "UnknownError");

/**
 * Shared transport decode for a direct DeveloperIdentity Lambda invoke: serializes the request,
 * rejects FunctionError / missing payload / unreadable JSON, and returns either the parsed value
 * or a structured transport failure reason.
 */
async function invokeAndDecodeJson(
  invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>,
  request: unknown,
): Promise<{ ok: true; decoded: unknown } | { ok: false; reason: string; detail?: Record<string, string> }> {
  let response: ChannelMembersInvokeResult;
  try {
    response = await invoke(Buffer.from(JSON.stringify(request)));
  } catch (error) {
    return { ok: false, reason: "invoke_error", detail: { error: errorName(error) } };
  }
  if (response.FunctionError !== undefined) return { ok: false, reason: "function_error", detail: { functionError: response.FunctionError } };
  if (response.Payload === undefined) return { ok: false, reason: "empty_reply" };
  try {
    return { ok: true, decoded: JSON.parse(Buffer.from(response.Payload).toString("utf8")) };
  } catch {
    return { ok: false, reason: "unreadable_reply" };
  }
}

/**
 * One direct invoke of the DeveloperIdentity function, which holds the Slack token (the broker
 * never reads the Slack secret). `readReply` returns the good answer from the decoded reply, or
 * undefined. Every failure fails closed as slack_unavailable with one `<event>_failed` log line;
 * an invalid_request reply is a broker bug, logged as `<event>_invalid_request`. Lines carry only
 * the reason, error name, FunctionError or reply error, never a payload.
 */
export async function invokeIdentityLambda<T>(
  invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>,
  request: unknown,
  readReply: (reply: Record<string, unknown>) => T | undefined,
  event: string,
  log: DeveloperEventLogger,
): Promise<T | IdentityRefusal> {
  const failed = (entry: Record<string, string>) => {
    log({ event: `${event}_failed`, ...entry });
    return SLACK_UNAVAILABLE;
  };
  const transport = await invokeAndDecodeJson(invoke, request);
  if (!transport.ok) return failed({ reason: transport.reason, ...transport.detail });
  const reply = typeof transport.decoded === "object" && transport.decoded !== null ? transport.decoded as Record<string, unknown> : {};
  const good = readReply(reply);
  if (good !== undefined) return good;
  if (reply.ok === false && reply.error === "invalid_request") {
    log({ event: `${event}_invalid_request`, reason: "the identity function refused the broker's request; this is a broker bug" });
    return { ok: false, error: "invalid_request" };
  }
  const replyError = reply.ok === false && typeof reply.error === "string" && SLACK_ERROR_CODE.test(reply.error)
    ? reply.error
    : "malformed_reply";
  return failed({ reason: "reply_error", error: replyError });
}

function memberOfMatchesRequested(memberOf: readonly string[], requested: ReadonlySet<string>): boolean {
  return new Set(memberOf).size === memberOf.length && !memberOf.some((channelId) => !requested.has(channelId));
}

function directoryUsersMatchRequested(users: ReadonlyArray<{ id: string; memberOf: readonly string[] }>, requested: ReadonlySet<string>): boolean {
  if (new Set(users.map((user) => user.id)).size !== users.length) return false;
  return !users.some((user) => !memberOfMatchesRequested(user.memberOf, requested));
}

function validateTaskPeopleDisplayResult(
  request: TaskPeopleDisplayReadRequest,
  parsed: TaskPeopleDisplayReadResponse,
): boolean {
  if (parsed.operation !== request.operation || parsed.admission.slackCallsUsed > request.admission.slackCallsLimit) return false;
  if (parsed.operation === "proof") {
    if (!parsed.result.ok) return true;
    return request.operation === "proof"
      && parsed.result.user.id === request.request.slackUserId
      && memberOfMatchesRequested(parsed.result.memberOf, new Set(request.request.channelIds));
  }
  if (!parsed.result.ok) return true;
  return request.operation === "directory"
    && directoryUsersMatchRequested(parsed.result.users, new Set(request.request.channelIds));
}

type ChannelEntry = { channelId: string; name: string; isPrivate: boolean };
const isChannelEntry = (entry: unknown): entry is ChannelEntry => {
  const candidate = entry as Partial<Record<keyof ChannelEntry, unknown>> | null;
  return typeof candidate === "object" && candidate !== null
    && typeof candidate.channelId === "string"
    && typeof candidate.name === "string"
    && typeof candidate.isPrivate === "boolean";
};

function decodeJwksReply(
  response: ChannelMembersInvokeResult,
  failed: (reason: string, entry?: Record<string, string>) => Error,
): unknown[] {
  if (response.FunctionError !== undefined) throw failed("function_error", { functionError: response.FunctionError });
  if (response.Payload === undefined) throw failed("empty_reply");
  let keys: unknown;
  try {
    const reply = JSON.parse(Buffer.from(response.Payload).toString("utf8")) as { statusCode?: unknown; body?: unknown };
    if (reply.statusCode !== 200 || typeof reply.body !== "string") throw new Error("not 200");
    keys = (JSON.parse(reply.body) as { keys?: unknown }).keys;
  } catch {
    throw failed("unreadable_reply");
  }
  if (!Array.isArray(keys) || keys.length === 0) throw failed("no_keys");
  return keys as unknown[];
}

export function createChannelMembersForwarder(
  invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>,
  log: DeveloperEventLogger,
): (request: ChannelMembersRequest) => Promise<ChannelMembersResponse> {
  return (request) => invokeIdentityLambda(invoke, request, (reply) => (reply.ok === true && Array.isArray(reply.memberOf)
    ? { ok: true as const, memberOf: reply.memberOf.filter((entry): entry is string => typeof entry === "string") }
    : undefined), "developer.channel_members", log);
}

export function createTaskPersonProofForwarder(
  invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>,
  log: DeveloperEventLogger,
): (request: TaskPersonProofRequest) => Promise<TaskPersonProofResponse> {
  return (request) => invokeIdentityLambda(invoke, request, (reply): TaskPersonProofResponse | undefined => {
    const parsed = TaskPersonProofResponseSchema.safeParse(reply);
    if (!parsed.success) return undefined;
    if (!parsed.data.ok) return parsed.data.error === "ineligible" ? parsed.data : undefined;
    const valid = parsed.data.user.id === request.slackUserId && memberOfMatchesRequested(parsed.data.memberOf, new Set(request.channelIds));
    return valid ? parsed.data : undefined;
  }, "developer.task_person_proof", log);
}

export function createTaskChannelPeopleForwarder(
  invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>,
  log: DeveloperEventLogger,
): (request: TaskChannelPeopleRequest) => Promise<TaskChannelPeopleResponse> {
  return (request) => invokeIdentityLambda(invoke, request, (reply): TaskChannelPeopleResponse | undefined => {
    const parsed = TaskChannelPeopleResponseSchema.safeParse(reply);
    if (!parsed.success) return undefined;
    if (!parsed.data.ok) return parsed.data.error === "capacity_exceeded" ? parsed.data : undefined;
    return directoryUsersMatchRequested(parsed.data.users, new Set(request.channelIds)) ? parsed.data : undefined;
  }, "developer.task_channel_people", log);
}

export function createTaskPeopleDisplayReadForwarder(
  invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>,
  log: DeveloperEventLogger,
): (request: TaskPeopleDisplayReadRequest) => Promise<TaskPeopleDisplayReadResponse> {
  return async (request) => {
    const failed = (reason: string): never => {
      log({ event: "developer.task_people_display_read_failed", reason });
      throw agentXError("SLACK_UNAVAILABLE", "the complete task People directory is unavailable");
    };
    const transport = await invokeAndDecodeJson(invoke, request);
    if (!transport.ok) {
      return failed(transport.reason === "invoke_error" ? `invoke_${transport.detail?.error ?? "UnknownError"}` : transport.reason);
    }
    const parsed = TaskPeopleDisplayReadResponseSchema.safeParse(transport.decoded);
    if (!parsed.success || !validateTaskPeopleDisplayResult(request, parsed.data)) return failed("malformed_reply");
    return parsed.data;
  };
}

export function createChannelInfoForwarder(
  invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>,
  log: DeveloperEventLogger,
): (request: ChannelInfoRequest) => Promise<ChannelInfoResponse> {
  return (request) => invokeIdentityLambda(invoke, request, (reply) => (reply.ok === true && Array.isArray(reply.channels)
    ? { ok: true as const, channels: reply.channels.filter(isChannelEntry).map(({ channelId, name, isPrivate }) => ({ channelId, name, isPrivate })) }
    : undefined), "developer.channel_info", log);
}

export function createSlackUserByEmailForwarder(
  invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>,
  log: DeveloperEventLogger,
): (request: SlackUserByEmailRequest) => Promise<SlackUserByEmailResponse> {
  return (request) => invokeIdentityLambda(invoke, request, (reply) => (reply.ok === true
    ? (typeof reply.userId === "string" ? { ok: true as const, userId: reply.userId } : { ok: true as const })
    : undefined), "developer.slack_user_by_email", log);
}

export function createSlackAuthCheckForwarder(
  invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>,
  log: DeveloperEventLogger,
): (workspace?: SlackWorkspaceScope) => Promise<SlackAuthCheckResponse> {
  return async (workspace) => {
    if (workspace !== undefined && !SlackWorkspaceScopeSchema.safeParse(workspace).success) return { ok: false, error: "slack_unavailable" };
    let refusal: string | undefined;
    const answer = await invokeIdentityLambda(invoke, { kind: "slack-auth-check", ...(workspace === undefined ? {} : { workspace }) }, (reply) => {
      if (reply.ok === true && typeof reply.teamId === "string") return { ok: true as const, teamId: reply.teamId };
      if (reply.ok === false && typeof reply.error === "string" && SLACK_ERROR_CODE.test(reply.error) && reply.error !== "invalid_request") refusal = reply.error;
      return undefined;
    }, "developer.slack_auth_check", log);
    return answer.ok ? answer : { ok: false, error: refusal ?? answer.error };
  };
}

export function createEndDeveloperSessionsForwarder(
  invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>,
  log: DeveloperEventLogger,
): (request: EndDeveloperSessionsRequest) => Promise<EndDeveloperSessionsResponse> {
  return async (request) => {
    const answer = await invokeIdentityLambda(invoke, request, (reply): EndDeveloperSessionsResponse | undefined => {
      if (reply.ok === true) return { ok: true };
      if (reply.ok === false && reply.error === "not_found") return { ok: false, error: "not_found" };
      return undefined;
    }, "developer.end_sessions", log);
    return answer.ok || answer.error === "not_found" || answer.error === "invalid_request" ? answer : { ok: false, error: "unavailable" };
  };
}

export function createSetDisplayNameForwarder(
  invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>,
  log: DeveloperEventLogger,
): (request: SetDisplayNameRequest) => Promise<SetDisplayNameResponse> {
  return async (request) => {
    const answer = await invokeIdentityLambda(invoke, request, (reply): SetDisplayNameResponse | undefined => {
      if (reply.ok === true && typeof reply.name === "string") return { ok: true, name: reply.name };
      if (reply.ok === false && (reply.error === "not_found" || reply.error === "invalid_request")) return { ok: false, error: reply.error };
      return undefined;
    }, "developer.set_display_name", log);
    return answer.ok || answer.error === "not_found" || answer.error === "invalid_request" ? answer : { ok: false, error: "unavailable" };
  };
}

export function createSignInClientsForwarder(
  invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>,
  log: DeveloperEventLogger,
): SignInClientRegistry {
  const ask = async <T>(
    request: PutSignInClientRequest | RemoveSignInClientRequest | ListSignInClientsRequest,
    read: (reply: Record<string, unknown>) => T | undefined,
  ): Promise<T> => {
    const answer = await invokeIdentityLambda(invoke, request, (reply) => (reply.ok === true ? read(reply) : undefined), "developer.sign_in_clients", log);
    if (typeof answer === "object" && answer !== null && "ok" in answer && (answer as { ok: unknown }).ok === false) {
      throw agentXError("RUNTIME_UNAVAILABLE", "AgentX could not reach its sign-in service; try again");
    }
    return answer as T;
  };
  return {
    async put(client, options) {
      await ask({
        kind: "put-sign-in-client", client,
        ...(options?.companyId === undefined ? {} : { companyId: options.companyId }),
        ...(options?.keepSecret === true ? { keepSecret: true as const } : {}),
      }, () => true);
    },
    remove: (clientId, companyId) => ask({ kind: "remove-sign-in-client", clientId, ...(companyId === undefined ? {} : { companyId }) }, (reply) => reply.removed === true),
    list: (companyId) => ask({ kind: "list-sign-in-clients", ...(companyId === undefined ? {} : { companyId }) }, (reply) => {
      const parsed = z.array(SignInClientViewSchema).safeParse(reply.clients);
      return parsed.success ? parsed.data : undefined;
    }),
  };
}

export function createChannelByNameForwarder(
  invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>,
  log: DeveloperEventLogger,
): (request: ChannelByNameRequest) => Promise<ChannelByNameResponse> {
  return (request) => invokeIdentityLambda(invoke, request, (reply) => {
    if (reply.ok !== true) return undefined;
    const channel = reply.channel as { channelId?: unknown; name?: unknown } | undefined;
    return typeof channel?.channelId === "string" && typeof channel.name === "string"
      ? { ok: true as const, channel: { channelId: channel.channelId, name: channel.name } }
      : { ok: true as const };
  }, "developer.channel_by_name", log);
}

export function createDeveloperKeysForwarder(
  invoke: (payload: Uint8Array, options?: { abortSignal: AbortSignal }) => Promise<ChannelMembersInvokeResult>,
  log: DeveloperEventLogger,
): (read?: ServerKeyRead) => Promise<unknown[]> {
  const request = { version: "2.0", rawPath: "/v1/auth/.well-known/jwks.json", requestContext: { requestId: "broker-jwks", http: { method: "GET" } } };
  const failed = (reason: string, entry: Record<string, string> = {}) => {
    log({ event: "developer.jwks_failed", reason, ...entry });
    return new Error(`the developer sign-in keys could not be read (${reason})`);
  };
  return async (read) => {
    const work = async () => {
      try { return await invoke(Buffer.from(JSON.stringify(request)), read === undefined ? undefined : { abortSignal: read.abortSignal }); }
      catch (error) { throw failed("invoke_error", { error: errorName(error) }); }
    };
    const response = read === undefined ? await work() : await read.readCounted(work, (res) => decodeJwksReply(res, failed).length);
    return decodeJwksReply(response, failed);
  };
}
