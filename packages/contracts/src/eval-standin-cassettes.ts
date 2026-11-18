// Eval stand-ins, L4-E56 / R2: the repository's OWN recordings as stand-in answers. A team that already keeps cassettes (VCR, vcrpy), HAR files (Polly, a browser), nock fixtures or WireMock mappings has real
// examples it trusts; the stand-in uses them FIRST and counts them as "recorded", never as made up. Pure: the worker reads and parses the files (JSON or YAML, bounded, from the checkout) and hands the parsed values here.
//
// What is read: method, host, path, query, status, content type and body of each recorded answer. NEVER a header, a cookie or a credential (they are not stored, so none can be sent), and a body past 64 KiB, a status
// outside 200 to 299 or 400 to 599, a host that is not a plain name, or an entry past the limit is skipped (and counted as skipped). A mapping with no host (WireMock keeps only the path) is placed on the one host the
// plan names, or skipped when the plan names none or several. A handler written as code (MSW) is NOT read: Rovara never runs the repository's code to learn an answer.
import type { EvalStandInRecorded } from "./eval-standin-set.js";
import { EVAL_STAND_IN_BODY_MAX_BYTES, EVAL_STAND_IN_MAX_RECORDED, isEvalStandInHostName } from "./eval-standin-engine.js";

export interface EvalStandInCassetteRead { readonly recorded: readonly EvalStandInRecorded[]; readonly skipped: number }

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const METHODS = new Set(["GET", "PUT", "POST", "DELETE", "PATCH", "HEAD", "OPTIONS"]);
const byteLength = (text: string): number => new TextEncoder().encode(text).length;

function splitUrl(url: string): { host: string; path: string; query: string } | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    const host = parsed.hostname.toLowerCase();
    return isEvalStandInHostName(host) ? { host, path: parsed.pathname === "" ? "/" : parsed.pathname, query: parsed.search.startsWith("?") ? parsed.search.slice(1) : "" } : undefined;
  } catch { return undefined; }
}
function splitRelative(url: string, host: string): { host: string; path: string; query: string } | undefined {
  if (!url.startsWith("/")) return undefined;
  const [path, ...rest] = url.split("?");
  return { host, path: path!, query: rest.join("?") };
}

function bodyText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  if (typeof value === "number" || typeof value === "boolean" || Array.isArray(value) || object(value)) { try { return JSON.stringify(value); } catch { return undefined; } }
  return undefined;
}
const contentTypeOf = (headers: unknown, fallback: string | undefined, body: string): string => {
  let found: string | undefined;
  if (Array.isArray(headers)) {
    for (const header of headers) if (object(header) && typeof header.name === "string" && header.name.toLowerCase() === "content-type" && typeof header.value === "string") found = header.value;
  } else if (object(headers)) {
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() !== "content-type") continue;
      found = typeof value === "string" ? value : Array.isArray(value) && typeof value[0] === "string" ? value[0] : found;
    }
  }
  const type = found ?? fallback;
  if (typeof type === "string" && /^[\x21-\x7e ]{1,120}$/u.test(type)) return type;
  try { JSON.parse(body); return "application/json"; } catch { return "text/plain; charset=utf-8"; }
};

/** A parsed cassette value (JSON or YAML) into recorded answers. `defaultHost`: the one host a host-less mapping belongs to. Never throws. */
export function evalStandInRecordedFromValue(value: unknown, defaultHost: string | undefined): EvalStandInCassetteRead {
  const out: EvalStandInRecorded[] = [];
  let skipped = 0;
  const add = (method: unknown, place: { host: string; path: string; query: string } | undefined, status: unknown, headers: unknown, mime: string | undefined, body: string | undefined): void => {
    const verb = typeof method === "string" ? method.toUpperCase() : "";
    if (!METHODS.has(verb) || place === undefined || typeof status !== "number" || !Number.isInteger(status) || !((status >= 200 && status <= 299) || (status >= 400 && status <= 599)) || body === undefined || byteLength(body) > EVAL_STAND_IN_BODY_MAX_BYTES || out.length >= EVAL_STAND_IN_MAX_RECORDED) { skipped += 1; return; }
    out.push({ method: verb as EvalStandInRecorded["method"], host: place.host, path: place.path.slice(0, 1_024), query: place.query.slice(0, 1_024), status, contentType: contentTypeOf(headers, mime, body), body });
  };
  try {
    const items: { kind: "har" | "vcr" | "wiremock" | "nock"; entry: Record<string, unknown> }[] = [];
    const log = object(value) && object(value.log) ? value.log : undefined;
    if (log !== undefined && Array.isArray(log.entries)) for (const entry of log.entries as unknown[]) if (object(entry)) items.push({ kind: "har", entry });
    if (object(value) && Array.isArray(value.interactions)) for (const entry of value.interactions as unknown[]) if (object(entry)) items.push({ kind: "vcr", entry });
    if (object(value) && Array.isArray(value.http_interactions)) for (const entry of value.http_interactions as unknown[]) if (object(entry)) items.push({ kind: "vcr", entry });
    if (object(value) && Array.isArray(value.mappings)) for (const entry of value.mappings as unknown[]) if (object(entry)) items.push({ kind: "wiremock", entry });
    if (object(value) && object(value.request) && object(value.response)) items.push({ kind: "wiremock", entry: value });
    if (Array.isArray(value)) for (const entry of value as unknown[]) if (object(entry)) items.push({ kind: object(entry.request) && object(entry.response) ? "wiremock" : "nock", entry });
    for (const { kind, entry } of items) {
      if (kind === "har") {
        const request = object(entry.request) ? entry.request : {};
        const response = object(entry.response) ? entry.response : {};
        const content = object(response.content) ? response.content : {};
        let text = typeof content.text === "string" ? content.text : "";
        if (content.encoding === "base64") { try { text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(text, "base64")); } catch { skipped += 1; continue; } }
        add(request.method, typeof request.url === "string" ? splitUrl(request.url) : undefined, response.status, response.headers, typeof content.mimeType === "string" ? content.mimeType : undefined, text);
      } else if (kind === "vcr") {
        const request = object(entry.request) ? entry.request : {};
        const response = object(entry.response) ? entry.response : {};
        const status = object(response.status) ? response.status.code : response.status;
        const body = object(response.body) ? response.body.string : response.body;
        add(request.method, typeof request.uri === "string" ? splitUrl(request.uri) : undefined, status, response.headers, undefined, bodyText(body));
      } else if (kind === "wiremock") {
        const request = object(entry.request) ? entry.request : {};
        const response = object(entry.response) ? entry.response : {};
        // A pattern is not an exact path: only `url` (path and query) and `urlPath` are read.
        const url = typeof request.url === "string" ? request.url : typeof request.urlPath === "string" ? request.urlPath : undefined;
        const absolute = url !== undefined && /^https?:\/\//iu.test(url);
        const place = url === undefined ? undefined : absolute ? splitUrl(url) : defaultHost === undefined ? undefined : splitRelative(url, defaultHost);
        const body = response.jsonBody !== undefined ? bodyText(response.jsonBody) : bodyText(response.body);
        add(request.method === undefined ? "GET" : request.method, place, response.status === undefined ? 200 : response.status, response.headers, undefined, body);
      } else {
        const scope = typeof entry.scope === "string" ? entry.scope : undefined;
        const path = typeof entry.path === "string" ? entry.path : undefined;
        const place = scope === undefined || path === undefined ? undefined : splitUrl(`${scope.replace(/\/+$/u, "")}${path.startsWith("/") ? "" : "/"}${path}`);
        add(entry.method === undefined ? "GET" : entry.method, place, entry.status, entry.rawHeaders ?? entry.headers, undefined, bodyText(entry.response));
      }
    }
  } catch { return { recorded: out, skipped: skipped + 1 }; }
  return { recorded: out, skipped };
}
