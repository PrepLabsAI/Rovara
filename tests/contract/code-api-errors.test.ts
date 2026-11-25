// F3 cut 1: the refusal codes moved to packages/code-api/src/errors.ts with no change. This pins every code and its status in order, as they were the day they moved: removing, reordering or changing
// the status of a code fails here, and a new code is appended to the list below in the same change (append-only: no code changes meaning). It also pins that every importer of the old place gets
// the very same values, and what a client reads of the envelope.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as contracts from "@agentx/contracts";
import * as codeApi from "@preplabsai/rovara-code-api";

const CODES_IN_ORDER: ReadonlyArray<readonly [string, number]> = [
  ["CONFIG_INVALID", 400], ["AUTH_REQUIRED", 401], ["CSRF_STALE", 403], ["REAUTH_REQUIRED", 403],
  ["FORBIDDEN", 403], ["NOT_FOUND", 404], ["PROJECT_REVISION_MISMATCH", 409], ["WORKSPACE_NOT_READY", 409],
  ["WORKSPACE_BUSY", 409], ["IDEMPOTENCY_CONFLICT", 409], ["RUNTIME_UNAVAILABLE", 503], ["SPENDING_APPROVAL_STALE", 409],
  ["TASK_STOP_ZERO", 409], ["TASK_STOP_REVIEW_TOO_LARGE", 409], ["TASK_STOP_CONFIG_MISSING", 409], ["TASK_STOP_CONFIG_INVALID", 409],
  ["TASK_STOP_APPROVAL_ABOVE_CEILING", 409], ["OPERATION_INTERRUPTED", 409], ["CONVERSATION_STATE_LOST", 409], ["CALLBACK_FORBIDDEN", 409],
  ["STALE_FENCE", 409], ["PROJECT_NOT_FOUND", 404], ["PROJECT_ACCESS_DENIED", 403], ["PROJECT_TASKS_DISABLED", 403],
  ["TASK_NOT_FOUND", 404], ["TASK_ACCESS_DENIED", 403], ["TASK_BUSY", 409], ["CHANNEL_REQUIRED", 409],
  ["WORKSPACE_LIMIT", 409], ["SLACK_UNAVAILABLE", 503], ["CHANNEL_AMBIGUOUS", 409], ["CONFIRMATION_UNAVAILABLE", 409],
  ["CONFIRMATION_DECLINED", 409], ["CONFIRMATION_EXPIRED", 409], ["CHANGE_STALE", 409], ["POLICY_STALE", 409],
  ["DRAFT_STALE", 409], ["ALREADY_IN_ORG", 409], ["INVITE_INVALID", 409], ["INVITE_ALREADY_ACCEPTED", 409],
  ["INVITE_ALREADY_REVOKED", 409], ["INVITE_EXPIRED", 409], ["INVITE_WRONG_EMAIL", 409], ["SLACK_TEAM_TAKEN", 409],
  ["REMOVED_FROM_ORG", 403], ["LAST_OWNER", 409], ["SUCCESSOR_INVALID", 409], ["MEMBER_ALREADY_REMOVED", 409],
  ["SLACK_TEAM_NOT_BOUND", 403], ["SLACK_ACCOUNT_NOT_LINKED", 403], ["MODEL_PROXY_UNAVAILABLE", 503], ["BUDGET_EXCEEDED", 402],
  ["ORG_BUDGET_EXCEEDED", 402], ["TRIAL_LOCKED", 403], ["TRIAL_GITHUB_USED", 409], ["MACHINE_TIME_EXCEEDED", 402],
  ["AGENT_REVISION_CONFLICT", 409], ["AGENT_UNAVAILABLE", 409], ["AGENT_NOT_ON_PROJECT", 403], ["AGENT_TOOL_NOT_GRANTED", 403],
  ["MODEL_NOT_ALLOWED", 403], ["WORKFLOW_MODE_UNMAPPED", 409], ["PROJECT_BUDGET_EXCEEDED", 402], ["AGENT_BUDGET_EXCEEDED", 402],
  ["AGENT_BUDGET_REQUIRED", 409], ["TEST_ALLOWANCE_USED", 402], ["APPROVAL_CLOSED", 409], ["AUDIT_RANGE_INVALID", 400],
  ["AUDIT_REASON_REQUIRED", 400], ["AUDIT_UNAVAILABLE", 503], ["AUDIT_FILTER_TOO_WIDE", 400], ["PROJECT_NAME_TAKEN", 409],
  ["PROJECT_ARCHIVED", 409], ["GITHUB_NOT_CONNECTED", 403], ["GITHUB_INSTALLATION_TAKEN", 409], ["TOO_MANY_REQUESTS", 429],
  ["CHAIN_REVISION_CONFLICT", 409], ["CHAIN_UNAVAILABLE", 409], ["CHAIN_BUDGET_REQUIRED", 409], ["CHAIN_BUDGET_EXCEEDED", 402],
  ["CHAIN_RUN_CLOSED", 409], ["SESSION_LEVEL_REQUIRED", 403], ["SESSION_ENDED", 409], ["SESSION_REVISION_CONFLICT", 409],
  ["SESSION_ON_MAC", 409], ["LOCAL_AGENT_NOT_ALLOWED", 403], ["INTENT_NOT_WAITING", 409], ["MERGE_NOT_READY", 409],
  ["TRASH_EXPIRED", 410], ["PROCESS_UNAVAILABLE", 400], ["PLAYBOOK_STALE", 409], ["PROCESS_SELF_CONFIRM", 403],
  ["PROCESS_IN_USE", 409], ["LEARNING_LAYER_BUSY", 409], ["LEARNING_RULES_FULL", 409], ["LEARNING_SOURCES_GONE", 409],
  ["LEARNING_SETTINGS_CHANGED", 409], ["LEARNING_SUGGESTIONS_OFF", 409], ["LEARNING_OFF", 404], ["LEARNING_LOCKED", 404],
  ["LESSONS_SWITCHED_OFF", 404], ["LESSON_BUSY", 409], ["NOT_AVAILABLE_HERE", 404], ["GITHUB_IN_USE", 409],
  ["SLACK_WORKSPACE_TAKEN", 409], ["SLACK_COMPANY_HAS_WORKSPACE", 409], ["SLACK_NOT_CONNECTED", 409], ["SLACK_CHANNEL_TAKEN", 409],
  ["SLACK_CHANNEL_REFUSED", 409], ["LINEAR_WORKSPACE_TAKEN", 409], ["LINEAR_NOT_CONNECTED", 409], ["GITHUB_ACCOUNT_TAKEN", 409],
  ["GITHUB_ACCOUNT_LINK_EXISTS", 409], ["LINK_START_AGAIN", 403], ["EXTERNAL_ACCOUNT_TAKEN", 409], ["EXTERNAL_ACCOUNT_OTHER_WORKSPACE", 409],
  ["EXTERNAL_ACCOUNT_LINK_EXISTS", 409], ["COMMITTED_REFRESH_NEEDED", 409],
  ["TASK_ACTION_NOT_OFFERED", 409], ["TASK_ACTION_STALE", 409], ["TASK_ACTION_NEEDS_INPUT", 400], ["TASK_ACTION_NEEDS_WEB", 403],
  ["LINEAR_TEAM_TAKEN", 409],
  // RD-2.0 (Code API 1.5).
  ["ROUTE_NOT_SERVED", 404],
];

describe("the Code API's refusal codes (moved from contracts, no change)", () => {
  it("lists every code in its order, with the status it has always had", () => {
    expect(codeApi.AgentXErrorCodeSchema.options).toEqual(CODES_IN_ORDER.map(([code]) => code));
    expect(codeApi.AgentXErrorCodeSchema.options.map((code) => [code, codeApi.errorStatus(code)])).toEqual(CODES_IN_ORDER);
  });

  it("is the same enum, schema and values through @agentx/contracts (one source, re-exported)", () => {
    expect(contracts.AgentXErrorCodeSchema).toBe(codeApi.AgentXErrorCodeSchema);
    expect(contracts.errorStatus).toBe(codeApi.errorStatus);
    expect(contracts.AgentXError).toBe(codeApi.AgentXError);
    expect(contracts.agentXError).toBe(codeApi.agentXError);
    expect(contracts.ON_THE_WEBSITE_MESSAGE).toBe(codeApi.ON_THE_WEBSITE_MESSAGE);
    expect(contracts.DEVELOPER_API_VERSION).toBe(codeApi.CODE_API_VERSION);
    expect(contracts.CLIENT_SCOPES).toBe(codeApi.CLIENT_SCOPES);
  });

  it("keeps the code list's JSON schema as it was", () => {
    expect(z.toJSONSchema(codeApi.AgentXErrorCodeSchema)).toEqual({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "string", enum: CODES_IN_ORDER.map(([code]) => code) });
  });

  it("builds an error the way it always did", () => {
    const error = codeApi.agentXError("FORBIDDEN", "No.");
    expect(error).toBeInstanceOf(codeApi.AgentXError);
    expect([error.name, error.code, error.statusCode, error.message]).toEqual(["AgentXError", "FORBIDDEN", 403, "FORBIDDEN: No."]);
    expect(error.detail).toEqual({});
    expect(codeApi.agentXError("TASK_ACTION_STALE", "Old.", { reason: "stale", writes: "none" }).detail).toEqual({ reason: "stale", writes: "none" });
  });
});

describe("what a client reads of a refusal", () => {
  it("reads a code it does not know as a value, and narrows it with isKnownCode", () => {
    const answer = codeApi.ErrorEnvelopeSchema.parse({ error: { code: "A_CODE_FROM_A_NEWER_CODE", message: "x", extra: 1 } });
    expect(answer.error.code).toBe("A_CODE_FROM_A_NEWER_CODE");
    expect(codeApi.isKnownCode(answer.error.code)).toBe(false);
    expect(codeApi.isKnownCode("FORBIDDEN")).toBe(true);
  });

  it("reads reason and writes when sent, and reads their absence (an older Code sends neither)", () => {
    expect(codeApi.ErrorEnvelopeSchema.parse({ error: { code: "FORBIDDEN", message: "x" } }).error.writes).toBeUndefined();
    expect(codeApi.ErrorEnvelopeSchema.parse({ error: { code: "FORBIDDEN", message: "x", reason: "why", writes: "none" } }).error).toEqual({ code: "FORBIDDEN", message: "x", reason: "why", writes: "none" });
    expect(codeApi.ErrorEnvelopeSchema.safeParse({ error: { code: "FORBIDDEN", message: "x", writes: "sometimes" } }).success).toBe(false);
    expect(codeApi.ErrorWritesSchema.options).toEqual(["none", "maybe", "done"]);
  });
});
