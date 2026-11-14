import { crc32 as zlibCrc32, deflateRawSync, inflateRawSync } from "node:zlib";
import { e2eSecretSpellings } from "@agentx/contracts";

/**
 * Proof and evidence B4 (and fix round 1, Opus review C2): a Playwright trace is a ZIP of JSON-lines files (`trace.trace`, `trace.network`, `trace.stacks`), screencast images and blobs (`resources/`: response
 * bodies, request bodies, the page source). It holds far more than headers: DOM snapshots, the login response with its tokens, URLs with tokens in the query, the page's own text. So the scrub is an ALLOW-LIST
 * over what it keeps, and it learns the round's secrets from the trace itself before it decides what to drop:
 *
 *   1. Headers: only an allow-list of benign names keeps its value (the B2 rule, a little wider for what a viewer shows); every other header value, `cookies` array value, and `set-cookie` is blanked.
 *   2. URLs: every value in a query string is blanked, the fragment and any userinfo are dropped, in every string of every line.
 *   3. Harvest: the values of sensitive headers, cookies, query parameters and token-named fields of JSON bodies are collected as round secrets (alongside the secrets the caller already knows: the run's account
 *      credentials, every cookie and localStorage value of the round). Every spelling of each is searched for (raw, JSON-escaped, percent-encoded, base64 and so on).
 *   4. A DOM snapshot (`frame-snapshot`) that contains a round secret is DROPPED. Any other string that contains one is blanked. A resource blob that contains one is replaced by a blank. If a secret is still in a
 *      line afterwards (it was split across strings: the check runs on the line's strings joined), the whole trace is refused.
 *   5. A snapshot dropped for a secret OTHER than the account's own credentials (a password input renders as dots) is positive evidence that the page rendered it, so the screencast frames of that page from the
 *      last clean snapshot on are dropped too (a frame is a picture no scan can read); a hit snapshot that names no page or time refuses the trace.
 *   6. Entries are an allow-list by name (`*.trace`, `*.network`, `*.stacks` at the top, `resources/*`, `screencast/*` images); any other entry is dropped, not kept raw.
 *
 * This is defence in depth: the accounts in a kept trace are already dead and their sessions ended (run-scoped, revoked and proved), and the page's own text on screen cannot be scrubbed at all (design 3.4,
 * and a screencast image is a picture). Fail closed: a zip that cannot be read whole (encryption, zip64, an unknown method, a bad or duplicate or overlapping entry, a size or checksum that disagrees, a bomb, a
 * line that is not JSON, too many secrets) is `null`, and the caller keeps no trace.
 */
export const TRACE_MAX_ENTRIES = 4_096;
export const TRACE_MAX_ENTRY_BYTES = 32 * 1024 * 1024;
export const TRACE_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
export const TRACE_BLANKED = "<blanked>";
/** The most round secrets one trace may harvest before it is refused outright (a trace of a page full of tokens is not one we scrub). */
export const TRACE_MAX_SECRETS = 300;
const MIN_SECRET_LENGTH = 8;
const MAX_SECRET_LENGTH = 2_048;

/** Header names whose value survives. Everything else is blanked (the name stays, so a reader sees a header was sent). */
export const TRACE_HEADER_ALLOW: ReadonlySet<string> = new Set([
  "content-type", "content-length", "content-encoding", "cache-control", "x-request-id", "x-amzn-requestid",
  "accept", "accept-encoding", "accept-language", "user-agent", "host", "date", "vary", "connection", "keep-alive", "transfer-encoding",
]);
const HEADER_CONTAINERS = new Set(["headers", "requestheaders", "responseheaders", "extrahttpheaders"]);
const PAIR_CONTAINERS = new Set(["querystring", "params"]);
/** A header whose value is a secret by its name: its value (and, for Authorization, the part after the scheme) is harvested. */
const SENSITIVE_HEADER = /auth|token|session|key|secret|cookie|csrf|xsrf|credential|jwt|bearer|signature|^x-(?!request-id$|amzn-requestid$|forwarded|frame|content-type|powered)/iu;
/** A field of a JSON body whose string value is harvested as a secret. */
const SENSITIVE_FIELD = /token|secret|password|passwd|session|credential|api[_-]?key|authorization|jwt|bearer|csrf|xsrf|signature|code$|^(?:refresh|access|otp|nonce|state|pin|assertion)$/iu;
const SNAPSHOT_TYPES = new Set(["frame-snapshot"]);
/** The entries a trace may hold, by name (everything else is dropped). The line files sit at the top of the archive. */
const LINE_FILES = /^[^/]*\.(?:trace|network|stacks)$|^(?:trace|network)$/u;
const RESOURCE = /^resources\/[^/]+$/u;
const SCREENCAST = /^screencast\/[^/]+\.(?:jpeg|jpg|png)$/u;
const ALLOWED_ENTRY = (name: string) => LINE_FILES.test(name) || RESOURCE.test(name) || SCREENCAST.test(name);

const SIG_EOCD = 0x06054b50;
const SIG_CD = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

interface ZipEntry { name: string; method: number; crc: number; compressedSize: number; size: number; localOffset: number; time: number; date: number }

function readEntries(zip: Uint8Array): ZipEntry[] | null {
  const view = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  if (view.byteLength < 22) return null;
  let eocd = -1;
  for (let at = view.byteLength - 22; at >= Math.max(0, view.byteLength - 22 - 65_535); at -= 1) if (view.readUInt32LE(at) === SIG_EOCD) { eocd = at; break; }
  if (eocd < 0) return null;
  const count = view.readUInt16LE(eocd + 10);
  const cdSize = view.readUInt32LE(eocd + 12);
  const cdOffset = view.readUInt32LE(eocd + 16);
  // zip64 markers: not supported, so not scrubbed, so not kept.
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff || count === 0 || count > TRACE_MAX_ENTRIES) return null;
  const entries: ZipEntry[] = [];
  let at = cdOffset;
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > view.byteLength || view.readUInt32LE(at) !== SIG_CD) return null;
    const flags = view.readUInt16LE(at + 8);
    const nameLength = view.readUInt16LE(at + 28);
    const extraLength = view.readUInt16LE(at + 30);
    const commentLength = view.readUInt16LE(at + 32);
    const compressedSize = view.readUInt32LE(at + 20);
    const size = view.readUInt32LE(at + 24);
    if ((flags & 1) !== 0 || compressedSize === 0xffffffff || size === 0xffffffff || size > TRACE_MAX_ENTRY_BYTES) return null;
    const nameEnd = at + 46 + nameLength;
    if (nameEnd > view.byteLength) return null;
    const name = view.toString("utf8", at + 46, nameEnd);
    entries.push({ name, method: view.readUInt16LE(at + 10), time: view.readUInt16LE(at + 12), date: view.readUInt16LE(at + 14), crc: view.readUInt32LE(at + 16), compressedSize, size, localOffset: view.readUInt32LE(at + 42) });
    at = nameEnd + extraLength + commentLength;
  }
  return entries;
}

function crc32(bytes: Uint8Array): number {
  if (typeof zlibCrc32 === "function") return zlibCrc32(bytes) >>> 0;
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}

/** The entry's data and the byte range it occupies in the file (local header included), or null when the local header disagrees with the central directory or the data is not what it claims. */
function dataOf(zip: Uint8Array, entry: ZipEntry): { data: Buffer; start: number; end: number } | null {
  const view = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  const at = entry.localOffset;
  if (at + 30 > view.byteLength || view.readUInt32LE(at) !== SIG_LOCAL) return null;
  const nameLength = view.readUInt16LE(at + 26);
  // The name in the local header must be the one the central directory lists, or two readers would see two different archives.
  if (nameLength !== Buffer.byteLength(entry.name, "utf8") || at + 30 + nameLength > view.byteLength || view.toString("utf8", at + 30, at + 30 + nameLength) !== entry.name) return null;
  const start = at + 30 + nameLength + view.readUInt16LE(at + 28);
  const end = start + entry.compressedSize;
  if (end > view.byteLength) return null;
  const raw = view.subarray(start, end);
  try {
    // The inflated bytes must be exactly the size and checksum the archive claims: a trace that disagrees with itself is not one we scrubbed.
    const out = entry.method === 0 ? Buffer.from(raw) : entry.method === 8 ? inflateRawSync(raw, { maxOutputLength: TRACE_MAX_ENTRY_BYTES }) : null;
    return out !== null && out.byteLength === entry.size && crc32(out) === entry.crc ? { data: out, start: at, end } : null;
  } catch { /* a bomb or a broken stream */ }
  return null;
}

/** No parent directories, no absolute or drive-lettered names, no backslashes, no control characters, no trailing slash. */
// eslint-disable-next-line no-control-regex -- refusing control characters in a name is the point
const SAFE_NAME = /^(?![A-Za-z]:)(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\/$)[^\\\0-\x1f\x7f]{1,255}$/u;

// ---- urls and headers

/** A URL with every query value blanked, no fragment, no userinfo; a string that only looks like a URL and does not parse is blanked whole. */
export function blankUrl(text: string): string {
  try {
    const url = new URL(text);
    url.username = ""; url.password = ""; url.hash = "";
    for (const key of [...new Set(url.searchParams.keys())]) url.searchParams.set(key, TRACE_BLANKED);
    return url.toString().replace(/%3Cblanked%3E/gu, TRACE_BLANKED);
  } catch {
    return TRACE_BLANKED;
  }
}
const looksLikeUrl = (text: string) => /^https?:\/\//iu.test(text);

/** A query or fragment run inside any text: from a `?` or `#` to the next space, quote or angle bracket. */
const RUN = /[?#][^\s"'<>]*/gu;
/**
 * Blanks the value of every `key=value` pair of every query or fragment run in a text, whatever its length, whatever the scheme (a relative `/reset?token=...`, a `wss://` address, a URL in the middle of a
 * console message), and drops userinfo in `scheme://user:pass@host`. A pair with an empty value stays as it is.
 */
export function blankQueryText(text: string): string {
  if (!text.includes("?") && !text.includes("#") && !text.includes("@")) return text;
  const noUserinfo = text.replace(/(\/\/)[^\s/@"'<>]+@/gu, "$1");
  return noUserinfo.replace(RUN, (run) => run.replace(/([^?#&;=]+)=([^&;#]*)/gu, (_pair, key: string, value: string) => (value === "" || value === TRACE_BLANKED ? `${key}=${value}` : `${key}=${TRACE_BLANKED}`)));
}
/** The values of every pair of every query or fragment run in a text. */
function queryValuesOf(text: string): string[] {
  const out: string[] = [];
  if (!text.includes("?") && !text.includes("#")) return out;
  for (const run of text.match(RUN) ?? []) for (const pair of run.matchAll(/([^?#&;=]+)=([^&;#]*)/gu)) if (pair[2] !== undefined && pair[2] !== "" && pair[2] !== TRACE_BLANKED) out.push(pair[2]);
  return out;
}
const FORM_BODY = /^[^\s=&]+=[^&\s]*(?:&[^\s=&]+=[^&\s]*)*$/u;

type Secrets = { add(value: unknown): void; size: number };

function harvestHeader(name: string, value: string, into: Secrets): void {
  const lower = name.toLowerCase();
  if (TRACE_HEADER_ALLOW.has(lower) || !SENSITIVE_HEADER.test(name)) return;
  into.add(value);
  const scheme = /^(?:bearer|basic|token|digest)\s+(.+)$/iu.exec(value);
  if (scheme?.[1] !== undefined) into.add(scheme[1]);
  if (lower === "cookie" || lower === "set-cookie") for (const piece of value.split(/;\s*/u)) { const eq = piece.indexOf("="); if (eq > 0) into.add(piece.slice(eq + 1)); }
}

function harvestUrl(text: string, into: Secrets): void {
  try { for (const value of new URL(text).searchParams.values()) into.add(value); } catch { /* not a URL */ }
}

/** Walks a parsed JSON line (or body) and collects the round's secrets. `body` means keys are judged as a JSON body's fields, not as trace structure. */
function harvest(node: unknown, into: Secrets, parentKey: string, body: boolean): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      if (item !== null && typeof item === "object" && !Array.isArray(item)) {
        const entry = item as Record<string, unknown>;
        if (typeof entry.name === "string" && typeof entry.value === "string") {
          if (parentKey === "cookies") into.add(entry.value);
          else if (HEADER_CONTAINERS.has(parentKey.toLowerCase())) harvestHeader(entry.name, entry.value, into);
        }
      }
      harvest(item, into, parentKey, body);
    }
    return;
  }
  if (node !== null && typeof node === "object") {
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (HEADER_CONTAINERS.has(parentKey.toLowerCase()) && typeof child === "string") harvestHeader(key, child, into);
      else if (body && typeof child === "string" && SENSITIVE_FIELD.test(key)) into.add(child);
      harvest(child, into, key, body);
    }
    return;
  }
  if (typeof node === "string") {
    if (looksLikeUrl(node)) harvestUrl(node, into);
    for (const value of queryValuesOf(node)) into.add(value);
    // JSON held inside a string (a console message, a stringified body) is read as the body it is.
    if ((node.startsWith("{") || node.startsWith("[")) && node.length <= 100_000) { try { harvest(JSON.parse(node), into, "", true); } catch { /* not JSON */ } }
  }
}

/** A form-encoded body (`refresh_token=...&grant_type=...`): the values of its sensitive fields. */
function harvestForm(text: string, into: Secrets): void {
  if (text.length > 100_000 || !FORM_BODY.test(text)) return;
  for (const [key, value] of new URLSearchParams(text)) if (SENSITIVE_FIELD.test(key)) into.add(value);
}

function newSecrets(known: readonly string[]): Secrets & { list(): string[] } {
  const set = new Set<string>();
  const add = (value: unknown) => { if (typeof value === "string" && value.length >= MIN_SECRET_LENGTH && value.length <= MAX_SECRET_LENGTH && value !== TRACE_BLANKED) set.add(value); };
  for (const value of known) add(value);
  return { add, get size() { return set.size; }, list: () => [...set] };
}

/** A search for the round's secrets, every spelling, in bytes or text. */
function searcher(secrets: readonly string[], contains: (bytes: Uint8Array) => boolean): (data: Uint8Array | string) => boolean {
  // Every spelling, plus the PHP/JavaScript habit of escaping the slash in JSON (`a\/b`).
  const needles = secrets.flatMap((secret) => [...e2eSecretSpellings(secret), secret.replace(/\//gu, "\\/")]).filter((form) => form.length >= MIN_SECRET_LENGTH).map((form) => Buffer.from(form, "utf8"));
  return (data) => {
    const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    return contains(bytes) || needles.some((needle) => bytes.includes(needle));
  };
}

// ---- rewriting a line

function blankNode(node: unknown, parentKey: string, hit: (text: string) => boolean, stats: ScrubStats): unknown {
  if (Array.isArray(node)) {
    const inHeaders = HEADER_CONTAINERS.has(parentKey.toLowerCase());
    // HAR `queryString` and `postData.params` hold the pairs themselves: every value goes, whatever its length.
    const inPairs = PAIR_CONTAINERS.has(parentKey.toLowerCase());
    return node.map((item) => {
      if (item !== null && typeof item === "object" && !Array.isArray(item) && typeof (item as Record<string, unknown>).name === "string" && typeof (item as Record<string, unknown>).value === "string") {
        const entry = item as Record<string, unknown>;
        const keep = inHeaders && TRACE_HEADER_ALLOW.has((entry.name as string).toLowerCase());
        const { value, ...rest } = entry;
        if (inPairs) { stats.blankedValues += 1; return { ...(blankNode(rest, "", hit, stats) as Record<string, unknown>), value: TRACE_BLANKED }; }
        if (parentKey === "cookies" || (inHeaders && !keep)) stats.blankedValues += 1;
        if (parentKey === "cookies" || inHeaders) return { ...(blankNode(rest, "", hit, stats) as Record<string, unknown>), value: keep ? blankString(value as string, hit, stats) : TRACE_BLANKED };
      }
      return blankNode(item, parentKey, hit, stats);
    });
  }
  if (node !== null && typeof node === "object") {
    const out: Record<string, unknown> = {};
    const inHeaders = HEADER_CONTAINERS.has(parentKey.toLowerCase());
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (child === undefined) continue;
      // A header held as an object key: the allow-list decides, whatever the value's shape.
      if (inHeaders && !TRACE_HEADER_ALLOW.has(key.toLowerCase())) { out[key] = child === null ? null : Array.isArray(child) ? child.map(() => TRACE_BLANKED) : TRACE_BLANKED; stats.blankedValues += 1; continue; }
      out[key] = blankNode(child, key, hit, stats);
    }
    return out;
  }
  return typeof node === "string" ? blankString(node, hit, stats) : node;
}

function blankString(text: string, hit: (text: string) => boolean, stats: ScrubStats): string {
  // An absolute http(s) URL is parsed; every string then gets the text pass (relative, ws/wss and in-text URLs, fragments, userinfo).
  const shown = blankQueryText(looksLikeUrl(text) ? blankUrl(text) : text);
  if (shown !== text) stats.blankedValues += 1;
  if (hit(shown)) { stats.blankedValues += 1; return TRACE_BLANKED; }
  return shown;
}

/** What was done to a trace, so a reviewer can see that it was altered. */
export interface ScrubStats { droppedSnapshots: number; droppedFrames: number; droppedEntries: number; blankedValues: number; blankedResources: number; secrets: number }
const newStats = (): ScrubStats => ({ droppedSnapshots: 0, droppedFrames: 0, droppedEntries: 0, blankedValues: 0, blankedResources: 0, secrets: 0 });
export interface ScrubOptions {
  /** Secrets the caller already knows beyond the redactor's account credentials: every cookie and localStorage value the round held. */
  secrets?: readonly string[];
  /**
   * The scan for the ACCOUNT's own credentials alone (the redactor's "accounts" scope). A snapshot that shows only those (a password input renders as dots) is dropped without dropping the screencast;
   * a snapshot that shows any other round secret drops the page's frames too. Absent: every hit counts as a round secret (the stricter reading).
   */
  accountContains?: (bytes: Uint8Array) => boolean;
}

/** What a pass over the lines decides about screencast frames: which to drop, and the files they name. */
export interface FramePlan { dropFrame(event: Record<string, unknown>): boolean; droppedFiles: Set<string> }

/** Every string VALUE of a parsed line, joined in order: a secret split across two strings is whole here. (A secret in a key is found by the search of the line itself, which holds the keys.) */
function joinedStrings(node: unknown, into: string[] = []): string {
  if (typeof node === "string") into.push(node);
  else if (Array.isArray(node)) for (const item of node) joinedStrings(item, into);
  else if (node !== null && typeof node === "object") for (const child of Object.values(node as Record<string, unknown>)) joinedStrings(child, into);
  return into.join("");
}

/**
 * The lines of a JSON-lines file, rewritten: header allow-list, every query value blanked, strings that contain a secret blanked, DOM snapshots that contain one dropped, screencast frames the plan drops
 * dropped. `null` when a line is not JSON or a secret survives (also split across strings). `hit` is the full scan.
 */
export function scrubTraceLinesWith(text: string, hit: (text: string) => boolean, stats: ScrubStats = newStats(), plan?: FramePlan): string | null {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") { out.push(line); continue; }
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { return null; }
    const record = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
    const type = record?.type;
    if (typeof type === "string" && SNAPSHOT_TYPES.has(type) && hit(line)) { stats.droppedSnapshots += 1; continue; }
    if (type === "screencast-frame" && record !== undefined && plan?.dropFrame(record) === true) {
      stats.droppedFrames += 1;
      if (typeof record.file === "string") plan.droppedFiles.add(record.file);
      continue;
    }
    const rewrittenNode = blankNode(parsed, "", hit, stats);
    const rewritten = JSON.stringify(rewrittenNode);
    // A secret that survives the string-level blanking (split across strings, or in a key) is not kept, and neither is the trace. The strings are searched joined, because JSON punctuation would break a needle.
    if (hit(rewritten) || hit(joinedStrings(rewrittenNode))) return null;
    out.push(rewritten);
  }
  return out.join("\n");
}

/** The same with no secrets known: the structural scrub only (headers, URLs). */
export function scrubTraceLines(text: string): string | null {
  return scrubTraceLinesWith(text, () => false);
}

const asText = (data: Buffer): string | null => { try { return new TextDecoder("utf-8", { fatal: true }).decode(data); } catch { return null; } };

interface SnapshotSeen { page: string | undefined; time: number | undefined; secret: boolean; any: boolean }

/**
 * The trace scrubbed and re-zipped, with what was done, or null when it cannot be made safe. `contains` is the run's credential scan (every spelling). The output zip writes no external attributes, so no mode
 * or symlink survives, and entries keep the archive's order.
 */
export function scrubTrace(zip: Uint8Array, contains: (bytes: Uint8Array) => boolean, options: ScrubOptions = {}): { zip: Uint8Array; stats: ScrubStats } | null {
  const entries = readEntries(zip);
  if (entries === null) return null;
  const names = new Set<string>();
  const inflated: Array<{ entry: ZipEntry; data: Buffer; text: string | null }> = [];
  const extents: Array<[number, number]> = [];
  const stats = newStats();
  let total = 0;
  for (const entry of entries) {
    if (!SAFE_NAME.test(entry.name) || names.has(entry.name) || (entry.method !== 0 && entry.method !== 8)) return null;
    names.add(entry.name);
    const found = dataOf(zip, entry);
    if (found === null) return null;
    total += found.data.byteLength;
    if (total > TRACE_MAX_TOTAL_BYTES) return null;
    extents.push([found.start, found.end]);
    // An entry whose name is not one a trace holds is dropped, not kept raw: it would get no header allow-list and no URL blanking.
    if (!ALLOWED_ENTRY(entry.name)) { stats.droppedEntries += 1; continue; }
    inflated.push({ entry, data: found.data, text: LINE_FILES.test(entry.name) || RESOURCE.test(entry.name) ? asText(found.data) : null });
  }
  // Entries may not overlap: several names over the same bytes would let one scan stand for many.
  extents.sort((a, b) => a[0] - b[0]);
  for (let index = 1; index < extents.length; index += 1) if (extents[index]![0] < extents[index - 1]![1]) return null;
  if (!inflated.some((item) => /\.trace$/u.test(item.entry.name))) return null;

  // Pass 1: learn the round's secrets from the trace itself.
  const secrets = newSecrets(options.secrets ?? []);
  for (const item of inflated) {
    if (LINE_FILES.test(item.entry.name)) {
      if (item.text === null) return null;
      for (const line of item.text.split("\n")) {
        if (line.trim() === "") continue;
        let parsed: unknown;
        try { parsed = JSON.parse(line); } catch { return null; }
        harvest(parsed, secrets, "", false);
      }
    } else if (RESOURCE.test(item.entry.name) && item.text !== null) {
      try { harvest(JSON.parse(item.text), secrets, "", true); } catch { harvestForm(item.text, secrets); }
    }
  }
  if (secrets.size > TRACE_MAX_SECRETS) return null;
  const known = secrets.list();
  stats.secrets = known.length;
  const hitBytes = searcher(known, contains);
  const needleOnly = searcher(known, () => false);
  // A hit that is NOT just the account's own credentials: a harvested or registered round secret.
  const secretHit = (text: string): boolean => {
    if (needleOnly(text)) return true;
    const bytes = Buffer.from(text, "utf8");
    return contains(bytes) && (options.accountContains === undefined || !options.accountContains(bytes));
  };

  // Pass 1b: which pages showed a round secret, and from when. A frame of that page after its last clean snapshot may show it as pixels.
  const seen: SnapshotSeen[] = [];
  for (const item of inflated) {
    if (!/\.trace$/u.test(item.entry.name) || item.text === null) continue;
    for (const line of item.text.split("\n")) {
      if (line.trim() === "") continue;
      const event = JSON.parse(line) as { type?: unknown; snapshot?: { pageId?: unknown; timestamp?: unknown } };
      if (event.type !== "frame-snapshot") continue;
      const page = typeof event.snapshot?.pageId === "string" ? event.snapshot.pageId : undefined;
      const time = typeof event.snapshot?.timestamp === "number" && Number.isFinite(event.snapshot.timestamp) ? event.snapshot.timestamp : undefined;
      seen.push({ page, time, secret: secretHit(line), any: hitBytes(Buffer.from(line, "utf8")) });
    }
  }
  // A snapshot that shows a round secret but names no page or time cannot be tied to the frames that show it: the trace is refused.
  if (seen.some((item) => item.secret && (item.page === undefined || item.time === undefined))) return null;
  const cleanSince = new Map<string, number>();
  for (const page of new Set(seen.filter((item) => item.secret).map((item) => item.page!))) {
    const ofPage = seen.filter((item) => item.page === page && item.time !== undefined).sort((a, b) => a.time! - b.time!);
    const firstHit = ofPage.findIndex((item) => item.secret);
    cleanSince.set(page, firstHit > 0 ? ofPage[firstHit - 1]!.time! : Number.NEGATIVE_INFINITY);
  }
  const plan: FramePlan = {
    droppedFiles: new Set<string>(),
    dropFrame(event) {
      if (typeof event.pageId !== "string" || !cleanSince.has(event.pageId)) return false;
      // A frame that names no time cannot be placed: it is dropped with the page's.
      return typeof event.timestamp !== "number" || event.timestamp > cleanSince.get(event.pageId)!;
    },
  };

  // Pass 2: rewrite.
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  let written = 0;
  const lineOutputs = new Map<string, Buffer>();
  for (const item of inflated) {
    if (LINE_FILES.test(item.entry.name)) {
      const scrubbed = scrubTraceLinesWith(item.text!, (text) => hitBytes(Buffer.from(text, "utf8")), stats, plan);
      if (scrubbed === null) return null;
      lineOutputs.set(item.entry.name, Buffer.from(scrubbed, "utf8"));
    }
  }
  for (const item of inflated) {
    // A screencast image a dropped frame named is gone with its frame.
    if (plan.droppedFiles.has(item.entry.name)) continue;
    let data = item.data;
    if (LINE_FILES.test(item.entry.name)) {
      data = lineOutputs.get(item.entry.name)!;
    } else if (RESOURCE.test(item.entry.name) && hitBytes(data)) {
      // A blob (a response body, the page source) that contains a round secret keeps its place and loses its content.
      data = Buffer.from(TRACE_BLANKED, "utf8");
      stats.blankedResources += 1;
    } else if (hitBytes(data)) {
      // Anything else (an image) that carries the run's credentials as bytes is not kept.
      return null;
    }
    const packed = deflateRawSync(data);
    const [stored, method] = packed.byteLength < data.byteLength ? [packed, 8] : [data, 0];
    const name = Buffer.from(item.entry.name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(method, 8);
    local.writeUInt16LE(item.entry.time, 10); local.writeUInt16LE(item.entry.date, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.byteLength, 18); local.writeUInt32LE(data.byteLength, 22); local.writeUInt16LE(name.byteLength, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(SIG_CD, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(0x0800, 8); header.writeUInt16LE(method, 10);
    header.writeUInt16LE(item.entry.time, 12); header.writeUInt16LE(item.entry.date, 14); header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(stored.byteLength, 20); header.writeUInt32LE(data.byteLength, 24); header.writeUInt16LE(name.byteLength, 28); header.writeUInt32LE(offset, 42);
    parts.push(local, name, stored);
    central.push(header, name);
    offset += local.byteLength + name.byteLength + stored.byteLength;
    written += 1;
  }
  stats.droppedEntries += plan.droppedFiles.size;
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIG_EOCD, 0); end.writeUInt16LE(written, 8); end.writeUInt16LE(written, 10); end.writeUInt32LE(directory.byteLength, 12); end.writeUInt32LE(offset, 16);
  return { zip: new Uint8Array(Buffer.concat([...parts, directory, end])), stats };
}

/** The scrubbed trace, or null when it cannot be made safe (see `scrubTrace`). */
export function scrubTraceZip(zip: Uint8Array, contains: (bytes: Uint8Array) => boolean, options: ScrubOptions = {}): Uint8Array | null {
  return scrubTrace(zip, contains, options)?.zip ?? null;
}
