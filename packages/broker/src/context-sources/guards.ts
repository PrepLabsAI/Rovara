// E2: the checks on what a stage sends to a source, and the last gate before a call (design 3.6: "the only outbound channel is the query arguments").
//
//   - arguments are one small plain object (1 KiB);
//   - an argument that is an address must be on the source's own host, so a source's tool is never a fetcher for other sites;
//   - an argument may not carry a credential-shaped string;
//   - unless the source is allowed to receive code, an argument may not look like code. This is a heuristic: bounded, not a guarantee.
import { CONTEXT_SOURCE_LIMITS, redactText } from "@agentx/contracts";
import { annotationVerdict, nameSuggestsWrite, type DiscoveredTool } from "./settings.js";

export type ArgumentRefusal = "not_object" | "too_big" | "address_off_host" | "carries_secret" | "looks_like_code" | "too_deep";

export type ArgumentVerdict = { ok: true } | { ok: false; reason: ArgumentRefusal };

export const ARGUMENT_REFUSAL_TEXT: Readonly<Record<ArgumentRefusal, string>> = {
  not_object: "The arguments must be a plain object.",
  too_big: `The arguments are longer than ${CONTEXT_SOURCE_LIMITS.argumentBytes} bytes. Ask with a shorter query.`,
  address_off_host: "That tool takes an address, and only addresses on the source's own site are allowed.",
  carries_secret: "The arguments look like they hold a credential, so Rovara did not send them.",
  looks_like_code: "The arguments look like code, and this source is not allowed to receive code. Ask in words instead.",
  too_deep: "The arguments are nested too deeply.",
};

const ADDRESS_NAME = /(^|_|-)(url|uri|href|link|endpoint|webhook)s?($|_|-)/iu;
const MAX_STRINGS = 100;
const MAX_DEPTH = 6;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hostOfAddress(value: string): string | undefined {
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return undefined;
  return url.hostname.toLowerCase();
}

/** The property names of the schema that take an address (a uri format, or a name like `url`). */
function addressProperties(inputSchema: Record<string, unknown>): Set<string> {
  const found = new Set<string>();
  const properties = inputSchema.properties;
  if (typeof properties !== "object" || properties === null) return found;
  for (const [name, definition] of Object.entries(properties as Record<string, unknown>)) {
    const format = typeof definition === "object" && definition !== null ? (definition as { format?: unknown }).format : undefined;
    if (format === "uri" || format === "url" || ADDRESS_NAME.test(name)) found.add(name);
  }
  return found;
}

const CODE_SIGNS: readonly RegExp[] = [
  /=>/u,
  /\b(?:function|def|class|public|private|static)\b[^\n]*[({:]/u,
  /#include|\bimport\b[^\n]*\bfrom\b|^\s*import\s+[\w.]+/mu,
  /;\s*$/mu,
  /[{}]\s*$/mu,
  /\)\s*\{/u,
  /<\/\w+>/u,
  /\breturn\b[^\n]*[;)]/u,
];

/** A long unbroken run of base64 or URL-safe base64 characters: encoded code or data. */
const ENCODED_RUN = /[A-Za-z0-9+/_-]{60,}={0,2}/u;
/** A host name followed by a path, a query or a fragment, with no scheme: `evil.example.com/collect?d=…`. */
const BARE_HOST = /(?:^|[\s"'(=,;<>])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})(?::\d{1,5})?(?=[/?#])/giu;

/** Whether text looks like code: more than three lines, a fenced block, or at least two different marks of code. */
export function looksLikeCode(text: string): boolean {
  if (text.split("\n").length > 3 || text.includes("```")) return true;
  return CODE_SIGNS.filter((sign) => sign.test(text)).length >= 2;
}

export function checkArguments(input: { args: unknown; inputSchema: Record<string, unknown>; hosts: readonly string[]; sendCodeSnippets: boolean }): ArgumentVerdict {
  if (!isPlainObject(input.args)) return { ok: false, reason: "not_object" };
  let text: string;
  try { text = JSON.stringify(input.args); } catch { return { ok: false, reason: "not_object" }; }
  if (Buffer.byteLength(text, "utf8") > CONTEXT_SOURCE_LIMITS.argumentBytes) return { ok: false, reason: "too_big" };
  const hosts = new Set(input.hosts.map((host) => host.toLowerCase()));
  const addressNames = addressProperties(input.inputSchema);
  let count = 0;
  let refusal: ArgumentRefusal | undefined;
  const visit = (value: unknown, depth: number, key: string | undefined): void => {
    if (refusal !== undefined) return;
    if (depth > MAX_DEPTH) { refusal = "too_deep"; return; }
    if (Array.isArray(value)) { value.forEach((entry) => visit(entry, depth + 1, key)); return; }
    if (isPlainObject(value)) { Object.entries(value).forEach(([name, entry]) => visit(entry, depth + 1, name)); return; }
    const declaredAddress = key !== undefined && depth === 1 && addressNames.has(key);
    if (typeof value !== "string") {
      if (declaredAddress && value !== undefined && value !== null) refusal = "address_off_host";
      return;
    }
    count += 1;
    if (count > MAX_STRINGS) { refusal = "too_big"; return; }
    // Any value that is an address, declared as one or not, must be on the source's own host.
    const isAddress = declaredAddress || /^https?:\/\//iu.test(value.trim());
    if (isAddress) {
      const host = hostOfAddress(value.trim());
      if (host === undefined || !hosts.has(host)) { refusal = "address_off_host"; return; }
    }
    // A host written without a scheme is an address as much as one with it.
    for (const match of value.matchAll(BARE_HOST)) if (!hosts.has(match[1]!.toLowerCase())) { refusal = "address_off_host"; return; }
    if (redactText(value) !== value) { refusal = "carries_secret"; return; }
    if (!input.sendCodeSnippets && ENCODED_RUN.test(value)) { refusal = "looks_like_code"; return; }
    if (!input.sendCodeSnippets && looksLikeCode(value)) refusal = "looks_like_code";
  };
  visit(input.args, 0, undefined);
  return refusal === undefined ? { ok: true } : { ok: false, reason: refusal };
}

// ---------------------------------------------------------------------------------------------
// The write gate
// ---------------------------------------------------------------------------------------------

export type GateDecision = { decision: "run" } | { decision: "refuse"; message: string };

/**
 * Design 3.6, read-only enforced a fourth time: every call is classified, and the context route classifies anything it cannot show to be a read as a
 * write, which it always refuses. A tool runs only when its annotations say it only reads (or a second admin confirmed that) and its name has no word of
 * a change that nobody confirmed.
 */
export function contextWriteGate(input: { tool: Pick<DiscoveredTool, "name" | "annotations">; attestedReadOnly: boolean }): GateDecision {
  const verdict = annotationVerdict(input.tool);
  if (verdict === "unsafe") return { decision: "refuse", message: "That tool says it changes things, and context sources only read. Nothing was sent." };
  if ((verdict === "unannotated" || nameSuggestsWrite(input.tool.name)) && !input.attestedReadOnly) {
    return { decision: "refuse", message: "That tool has not been confirmed to only read, so Rovara did not call it. Nothing was sent." };
  }
  return { decision: "run" };
}
