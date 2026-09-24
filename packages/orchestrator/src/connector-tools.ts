import { createHash } from "node:crypto";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ConnectorCallRequest, ConnectorCatalog } from "@agentx/contracts";

/** One bridge for every presented connector tool. No per-vendor tool implementations. */
export function createConnectorTools(
  catalogs: readonly ConnectorCatalog[],
  invoke: (input: ConnectorCallRequest & { workspaceId: string; connector: string }) => Promise<unknown>,
  context: { workspaceId: string; conversationId: string },
  options: { requestId?: () => string } = {},
): ToolDefinition[] {
  const requestIds = new Map<string, string>();
  return catalogs.flatMap((catalog) => catalog.tools.map((tool) => {
    const properties = tool.inputSchema.properties;
    const targeted = Boolean(properties && typeof properties === "object" && Object.hasOwn(properties, "target"));
    return defineTool({
      name: tool.name,
      label: `${catalog.connector} / ${tool.upstreamName}`,
      description: tool.description,
      parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
      execute: async (callId, parameters) => {
        const { target, ...rest } = parameters;
        const scope = targeted ? tool.scopes.find((entry) => entry.alias === target) : tool.scopes[0];
        if (!scope) {
          return text({ status: "FAILED", text: `target must be one of ${tool.scopes.map((entry) => entry.alias).join(", ")}.` });
        }
        const args = targeted ? rest : parameters;
        // Hosted redeliveries regenerate model call IDs; the Slack event's sequence keeps IDs stable.
        const key = JSON.stringify([catalog.connector, tool.name, scope.alias, callId]);
        const hash = createHash("sha256").update(JSON.stringify([context.workspaceId, context.conversationId, key])).digest("hex");
        const requestId = requestIds.get(key) ?? options.requestId?.()
          ?? `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
        requestIds.set(key, requestId);
        return text(await invoke({
          workspaceId: context.workspaceId, connector: catalog.connector, requestId,
          scope: scope.alias, tool: tool.upstreamName, schemaHash: scope.schemaHash, arguments: args,
        }));
      },
    });
  }));
}

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} };
}
