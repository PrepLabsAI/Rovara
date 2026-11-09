// Knowledge resolver (K1, C3): the inline Pi extension that appends newly applicable rules to a read, edit or write result.
// The same mechanism as `agentx-verification`: it only watches tool results, and what it appends is framed as team guidance.
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { MidRunKnowledge } from "./session.js";

export const KNOWLEDGE_EXTENSION_NAME = "agentx-knowledge";

export function knowledgeExtension(session: MidRunKnowledge, onDiagnostic?: (message: string) => void): InlineExtension {
  return {
    name: KNOWLEDGE_EXTENSION_NAME,
    factory: (pi) => {
      pi.on("tool_result", async (event) => {
        if (event.toolName !== "read" && event.toolName !== "edit" && event.toolName !== "write") return undefined;
        if (event.isError) return undefined;
        const path = event.input.path;
        if (typeof path !== "string") return undefined;
        try {
          const extra = await session.onPathTouched(path);
          if (extra === undefined) return undefined;
          return { content: [...event.content, { type: "text" as const, text: `\n\n${extra}` }] };
        } catch {
          onDiagnostic?.("could not load the rules for a file the agent opened");
          return undefined;
        }
      });
    },
  };
}
