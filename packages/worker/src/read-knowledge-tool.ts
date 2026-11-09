import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { MidRunKnowledge } from "./knowledge/session.js";

/**
 * `read_knowledge`: how a model loads one of the team's manual or auto rules by name. The names come from the resolver's own catalog of the
 * repositories' rule files; the name is looked up in that catalog and is never a path, so it cannot read anything else. Judging stages are not
 * given this tool (their rules are fixed up front), and the tool refuses there too.
 */
export function readKnowledgeTool(session: MidRunKnowledge): ToolDefinition {
  return defineTool({
    name: "read_knowledge",
    label: "Read team rule",
    description: "Load one of the team's rules by its name, from the list of available rules.",
    parameters: Type.Object({ name: Type.String({ minLength: 1, maxLength: 256, description: "The rule's name, as listed." }) }),
    execute: async (_toolCallId, parameters) => {
      const result = session.readByName(parameters.name);
      return { content: [{ type: "text" as const, text: "text" in result ? result.text : result.error }], details: undefined };
    },
  });
}
