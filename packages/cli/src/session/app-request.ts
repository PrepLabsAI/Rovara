// Lane L8: the small helpers the session commands share. One signed-in call to a `/v1/app/*` route of the broker, and the rules for showing what came back:
// every value that came from the broker (or a model through it) is untrusted text, and a terminal must never be moved, recoloured or reordered by one.
import { AgentXErrorCodeSchema, CLI_PACKAGE_NAME, agentXError } from "@rovara-code/contracts";
import { ReportedFailure, exitCodeForError } from "../output.js";
import { developerAccessToken, type DeveloperSessionDeps } from "../developer/session.js";

// Control, format, line and paragraph separators, surrogates, private use, and the invisible fillers that take up room without showing anything
// (combining grapheme joiner, Hangul fillers, braille blank).
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\p{Co}͏ᅟᅠ⠀ㅤﾠ]/gu;
const marker = (character: string): string => `[U+${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}]`;
/** The most characters of one value a terminal line shows. */
const MAX_SHOWN = 500;

export type Body = Record<string, unknown>;

/** One line of text for a terminal: line breaks become spaces, every unsafe character becomes its `[U+XXXX]` marker, and a very long value is cut. */
export function terminalSafe(value: unknown): string {
  const characters = [...String(value).replace(/[\r\n\t]+/g, " ")];
  const shown = characters.length > MAX_SHOWN ? characters.slice(0, MAX_SHOWN) : characters;
  return shown.join("").replace(UNSAFE, marker) + (characters.length > MAX_SHOWN ? "...[truncated]" : "");
}

/** A value for `--json` output: every string (and key) has its unsafe characters marked; JSON itself escapes the line breaks and tabs. */
export function jsonSafe(value: unknown): unknown {
  if (typeof value === "string") return value.replace(UNSAFE, (character) => (character === "\n" || character === "\r" || character === "\t" ? character : marker(character)));
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [jsonSafe(key) as string, jsonSafe(child)]));
  }
  return value;
}

/**
 * Server text made safe for a terminal line: anything shaped like a refresh token or authorization code is hidden first, then every unsafe
 * character is shown as its `[U+XXXX]` marker and a very long value is cut with a visible `...[truncated]`.
 */
export const clean = (text: string): string => terminalSafe(text.replace(/agx[rc]_[A-Za-z0-9_-]+/g, "[hidden]"));

/** What a command prints: its JSON data (with --json) and its text. */
export interface AppResult { env: string; url: string; data: Body; text: string }

/**
 * One signed-in call to a `/v1/app/*` route. A refusal that carries the broker's words is a `ReportedFailure` that prints them as they
 * are, under the broker's code (a 409 exits 1, as a conflict the person resolves by reloading); 2xx answers, 202 included, are returned.
 */
export async function appRequest(
  deps: DeveloperSessionDeps, env: string | undefined, path: string, options: { method?: "GET" | "POST" | "PUT" | "DELETE"; body?: unknown; headers?: Readonly<Record<string, string>> } = {},
): Promise<{ env: string; url: string; status: number; body: Body }> {
  const session = await developerAccessToken(deps, env);
  let response: Response;
  try {
    response = await deps.fetch(`${session.entry.url}${path}`, {
      method: options.method ?? "GET",
      headers: { ...options.headers, authorization: `Bearer ${session.accessToken}`, ...(options.body === undefined ? {} : { "content-type": "application/json" }) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw agentXError("RUNTIME_UNAVAILABLE", `could not reach AgentX at ${session.entry.url}; check your connection and try again`);
  }
  const value: unknown = await response.json().catch(() => undefined);
  if (response.status === 401) throw agentXError("AUTH_REQUIRED", `your AgentX sign-in for ${session.env} has ended; run npx ${CLI_PACKAGE_NAME} login ${session.entry.url}`);
  if (!response.ok) {
    const error = typeof value === "object" && value !== null ? (value as { error?: { code?: unknown; message?: unknown } }).error : undefined;
    const message = typeof error?.message === "string" ? clean(error.message).trim() : "";
    if (message === "") throw agentXError("RUNTIME_UNAVAILABLE", `AgentX answered HTTP ${response.status}; try again`);
    const code = AgentXErrorCodeSchema.safeParse(error?.code);
    throw new ReportedFailure(code.success ? code.data : "REFUSED", message, response.status === 409 || !code.success ? 1 : exitCodeForError(code.data));
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw agentXError("RUNTIME_UNAVAILABLE", `AgentX answered with something unexpected; try again, or upgrade: npx ${CLI_PACKAGE_NAME}@latest whoami`);
  }
  return { env: session.env, url: session.entry.url, status: response.status, body: value as Body };
}

export const result = (answer: { env: string; url: string }, data: Body, text: string): AppResult => ({ env: answer.env, url: answer.url, data: jsonSafe(data) as Body, text });
/** One path segment from an ID the person typed; `.` and `..` are refused, since a URL would read them as a step up the path. */
export const seg = (id: string): string => {
  if (id === "." || id === "..") throw agentXError("CONFIG_INVALID", "an ID cannot be . or ..");
  return encodeURIComponent(id);
};
export const str = (value: unknown, fallback = ""): string => (typeof value === "string" || typeof value === "number" ? clean(String(value)) : fallback);
export const list = (value: unknown): Body[] => (Array.isArray(value) ? value.filter((entry): entry is Body => typeof entry === "object" && entry !== null) : []);

const DEVELOPER_ID = /^[a-f0-9]{64}$/;

/**
 * The person a share names, as the `{ developerId }` the routes take. A Code install has no member directory (that is a Cloud feature behind the
 * identity port), so the person is named by their developer ID.
 */
export async function developerRef(_deps: DeveloperSessionDeps, _env: string | undefined, who: string): Promise<{ developerId: string; name: string }> {
  const id = who.trim().toLowerCase();
  if (!DEVELOPER_ID.test(id)) throw agentXError("CONFIG_INVALID", "--with takes a person's developer ID (64 hexadecimal characters), project:<name>, or company; Code has no member directory to look an email up in");
  return { developerId: id, name: `developer ${id.slice(0, 8)}` };
}
