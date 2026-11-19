// Design review stage: MCP items reach a packet only through the project's configured read-only sources.
import { describe, expect, it } from "vitest";
import type { ContextSource } from "@agentx/contracts";
import { PACKET_CHAT_SYSTEMS, packetMcpCall, parseMcpItemRef } from "../../packages/broker/src/core/design-review/mcp-allowlist.js";

const tool = (upstreamName: string, role: "read" | "search" | "status" = "read") => ({ upstreamName, role, schemaHash: "a".repeat(64) });
const source = (overrides: Partial<ContextSource> = {}): ContextSource => ({
  sourceId: "tracker", label: "Tracker", system: "jira", server: { kind: "connection", connectionId: "conn_1" }, tools: [tool("get_issue"), tool("search_issues", "search")],
  stages: ["PLAN", "PLAN_CRITIQUE"], quotes: "project_members", retention: "live_only", limits: { callsPerStage: 5, bytesPerResult: 4_096, bytesPerStage: 20_000 }, liveFacts: [], sendCodeSnippets: false, ...overrides,
});

describe("packetMcpCall", () => {
  it("builds the call from the configured source: its ticked read tool, and the item ref as the only argument", () => {
    expect(packetMcpCall([source()], { sourceId: "tracker", itemRef: "ABC-1" })).toEqual({ ok: true, sourceId: "tracker", tool: "src_tracker_get_issue", arguments: { id: "ABC-1" } });
  });

  it("uses a read tool only: a source with only search or status tools is not allowed", () => {
    expect(packetMcpCall([source({ tools: [tool("search_issues", "search"), tool("status", "status")] })], { sourceId: "tracker", itemRef: "A-1" })).toEqual({ ok: false, reason: "not_allowed" });
  });

  it("refuses an unknown source and a source not allowed in PLAN_CRITIQUE", () => {
    expect(packetMcpCall([source()], { sourceId: "other", itemRef: "A-1" })).toEqual({ ok: false, reason: "not_allowed" });
    expect(packetMcpCall([source({ stages: ["UNDERSTAND", "PLAN"] })], { sourceId: "tracker", itemRef: "A-1" })).toEqual({ ok: false, reason: "not_allowed" });
  });

  it("refuses every chat system, however it is spelled, and a Slack source by its label or id", () => {
    for (const system of PACKET_CHAT_SYSTEMS) expect(packetMcpCall([source({ system: system.toUpperCase() })], { sourceId: "tracker", itemRef: "A-1" }), system).toEqual({ ok: false, reason: "conversation" });
    expect(packetMcpCall([source({ system: undefined, label: "Engineering Slack" })], { sourceId: "tracker", itemRef: "A-1" })).toEqual({ ok: false, reason: "conversation" });
    expect(packetMcpCall([source({ system: undefined, sourceId: "slackeng" })], { sourceId: "slackeng", itemRef: "A-1" })).toEqual({ ok: false, reason: "conversation" });
  });

  it("refuses a thread, channel, history, conversation or message tool on an ordinary source", () => {
    for (const name of ["get_thread", "channel_history", "read_conversation", "get_message", "list_messages", "read_chat"]) {
      expect(packetMcpCall([source({ tools: [tool(name)] })], { sourceId: "tracker", itemRef: "C1" }), name).toEqual({ ok: false, reason: "conversation" });
    }
    // positive control: a plain tool name is allowed
    expect(packetMcpCall([source({ tools: [tool("get_page")] })], { sourceId: "tracker", itemRef: "P1" }).ok).toBe(true);
  });

  it("refuses an item ref with hidden characters, and lets the wiring refuse by its own argument rule", () => {
    expect(packetMcpCall([source()], { sourceId: "tracker", itemRef: "A‮-1" })).toEqual({ ok: false, reason: "not_allowed" });
    expect(packetMcpCall([source()], { sourceId: "tracker", itemRef: "A-1" }, { argumentsFor: () => undefined })).toEqual({ ok: false, reason: "not_allowed" });
    expect(packetMcpCall([source()], { sourceId: "tracker", itemRef: "A-1" }, { argumentsFor: ({ itemRef }) => ({ key: itemRef }) })).toMatchObject({ ok: true, arguments: { key: "A-1" } });
  });
});

describe("parseMcpItemRef", () => {
  it("reads sourceId:itemRef and nothing else", () => {
    expect(parseMcpItemRef("tracker:ABC-1")).toEqual({ sourceId: "tracker", itemRef: "ABC-1" });
    expect(parseMcpItemRef("tracker:a:b")).toEqual({ sourceId: "tracker", itemRef: "a:b" });
    for (const bad of ["ABC-1", ":x", "Tracker:x", "tracker:", "tracker:a\"b", "tracker:a​b"]) expect(parseMcpItemRef(bad), bad).toBeUndefined();
  });
});
