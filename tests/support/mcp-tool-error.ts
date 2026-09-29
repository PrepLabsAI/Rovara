// Ruling F3: a tool error carries no structuredContent (SDK 1.30.1 validates any structuredContent
// against the tool's output schema once the tools are listed). Its code, message and next step are
// in the text content as `CODE: message. Next step: step.`; this reads them back.
export interface ParsedToolError { code: string; message: string; next_step: string }

const SHAPE = /^([A-Z_]+): ([\s\S]*)\. Next step: ([\s\S]*)\.$/;

export function toolError(result: { isError?: unknown; structuredContent?: unknown; content?: unknown }): ParsedToolError {
  if (result.isError !== true) throw new Error(`expected a tool error, got ${JSON.stringify(result)}`);
  if (result.structuredContent !== undefined) throw new Error("a tool error must not carry structuredContent (ruling F3)");
  const text = (result.content as Array<{ type: string; text?: string }> | undefined)?.find((block) => block.type === "text")?.text ?? "";
  const match = SHAPE.exec(text);
  if (match === null) throw new Error(`the error text is not "CODE: message. Next step: step.": ${text}`);
  return { code: match[1]!, message: match[2]!, next_step: match[3]! };
}
