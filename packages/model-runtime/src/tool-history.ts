// A model served through Bedrock's Converse (DEC 243c) needs a tool configuration whenever the conversation holds a tool call or a tool result; Rovara's AI refuses a turn that resends tool history with no tools declared (and so
// does Anthropic's own API). Every call to a routed model passes `toolBlocksWithoutTools` before it leaves: a call that would be refused there is refused here, free, in fixed words, and nothing is sent.

/** What a refused call says. Fixed: no tool name, argument or conversation text. */
export const TOOL_DECLARATIONS_MISSING_WORDS = "Model request refused: the conversation holds tool calls but declares no tools";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** The names of the tools declared at the end of the conversation (Pi records them as system messages that add or remove tools, in order). */
function declaredTools(messages: readonly unknown[]): Set<string> {
  const tools = new Set<string>();
  for (const message of messages) {
    if (!isRecord(message) || message["role"] !== "system") continue;
    for (const removed of Array.isArray(message["toolsRemoved"]) ? message["toolsRemoved"] : []) if (isRecord(removed) && typeof removed["name"] === "string") tools.delete(removed["name"]);
    for (const added of Array.isArray(message["toolsAdded"]) ? message["toolsAdded"] : []) if (isRecord(added) && typeof added["name"] === "string") tools.add(added["name"]);
  }
  return tools;
}

/** Whether the conversation holds a tool call (an assistant message's `toolCall` block) or a tool result, while no tool is declared. Total over untrusted shapes: it never throws. */
export function toolBlocksWithoutTools(context: { messages: readonly unknown[] }): boolean {
  const messages = Array.isArray(context?.messages) ? context.messages : [];
  const holdsToolBlocks = messages.some((message) => isRecord(message) && (message["role"] === "toolResult"
    || (message["role"] === "assistant" && Array.isArray(message["content"]) && message["content"].some((block) => isRecord(block) && block["type"] === "toolCall"))));
  return holdsToolBlocks && declaredTools(messages).size === 0;
}
