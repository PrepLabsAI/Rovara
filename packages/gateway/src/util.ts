import { createHash } from "node:crypto";
import type { McpToolResult } from "./mcp-client.js";

export function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function resultText(result: McpToolResult): string {
  if (result.structuredContent !== undefined) return JSON.stringify(result.structuredContent);
  return (result.content ?? []).filter((entry) => entry.type === "text").map((entry) => entry.text ?? "").join("\n");
}

export async function withDeadline<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort: () => void = () => undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error("Connector request deadline exceeded"));
      signal.addEventListener("abort", onAbort, { once: true });
    })]);
  } finally { signal.removeEventListener("abort", onAbort); }
}
