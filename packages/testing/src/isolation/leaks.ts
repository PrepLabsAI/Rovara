// "Errors and logs stay clean": planted secret values must never appear in an error message, a log line or a result. `captureLogs` collects what the process printed while a body ran;
// `assertNoSecretLeaks` greps any text, object or error for the values the test planted.
import { expect } from "vitest";

const text = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}${value.stack === undefined ? "" : `\n${value.stack}`}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

/** Runs `body` and returns what it wrote with `console.log`, `console.info`, `console.warn` and `console.error`, and what it returned. */
export async function captureLogs<T>(body: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const methods = ["log", "info", "warn", "error"] as const;
  const originals = methods.map((method) => console[method].bind(console));
  for (const method of methods) console[method] = (...args: unknown[]) => { lines.push(args.map(text).join(" ")); };
  try {
    return { result: await body(), lines };
  } finally {
    methods.forEach((method, index) => { console[method] = originals[index]!; });
  }
}

/** Fails when any of `outputs` (strings, errors or plain data) holds any of `secrets`. The failure names the output's position, never the secret. */
export function assertNoSecretLeaks(outputs: readonly unknown[], secrets: readonly string[]): void {
  outputs.forEach((output, index) => {
    const printed = text(output);
    secrets.forEach((secret, which) => expect(printed.includes(secret), `output ${String(index)} holds planted secret number ${String(which)}`).toBe(false));
  });
}
