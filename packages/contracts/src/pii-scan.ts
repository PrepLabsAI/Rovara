// A personal-data scanner for text a person is about to keep or send: a recorded SageMaker answer, a request. Two parts:
//   - `PiiScanner`, a pluggable interface: a scanner reads a text and returns the spans it takes for personal data, each with a fixed KIND. Microsoft Presidio is one such scanner (the CLI has an adapter for a Presidio
//     analyzer the customer runs themselves); the built-in scanner below is another, and the two can be combined.
//   - `builtinPiiScanner`, a scanner with no dependency: pattern and heuristic rules for the data that most often leaks into a recorded model answer. It is HEURISTIC. It finds what its rules cover, it will miss
//     free-text personal data its name list does not know, and it flags some harmless text (a version number that looks like an address). Its findings are the reason to look, not a promise that an unflagged text is clean;
//     that is why the recorder refuses by default, a person confirms samples, and Rovara scans again on upload.
// Why built in and not Presidio alone: Presidio is a Python service (spaCy models, hundreds of MB); a command that a customer must be able to read and run anywhere cannot require it. The adapter is optional.
//
// What the built-in scanner covers (kind in brackets):
//   emails [email]; phone numbers, international with a plus sign or formatted North American [phone]; card numbers of 13 to 19 digits that pass the Luhn check [card_number]; national ids: a US social security number,
//   a UK national insurance number, a grouped 12-digit Aadhaar-style number [national_id]; IBANs that pass the mod-97 check [bank_account]; IPv4 and IPv6 addresses [ip_address]; the account id inside an ARN
//   [aws_account]; people's names: a first name from a list of common ones followed by a capitalised word, `Last, First`, and the value of a key that names a person (`first_name`, `full_name`, ...) [person_name];
//   anything the product's redactor would change: provider keys, bearer tokens, JWTs, private keys, passwords in URLs or pairs [secret].
// Reserved and fictional values are NOT findings, so a synthetic fixture can pass: emails at exactly `example.com/.org/.net`, or one label under `.test`, `.invalid`, `.example`, `.localhost`; the 555-01xx telephone range; loopback and
// documentation addresses (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24, 2001:db8::/32).
// Pure, bounded and never throws on odd input; no regular expression here backtracks badly. A scan reads at most `PII_SCAN_MAX_CHARS` characters.
// Nothing here imports a Node module.
import { redactText } from "./redaction.js";

export const PII_KINDS = ["email", "phone", "card_number", "national_id", "bank_account", "ip_address", "aws_account", "person_name", "secret"] as const;
export type PiiKind = (typeof PII_KINDS)[number];

/** A span a scanner takes for personal data: the offsets are UTF-16 offsets into the scanned text. The matched text itself is never part of a finding. */
export interface PiiFinding { kind: PiiKind; start: number; end: number }

/** A scanner. `id` is a fixed word that names it in a report (`builtin-1`, `presidio`). */
export interface PiiScanner {
  readonly id: string;
  scan(text: string): PiiFinding[] | Promise<PiiFinding[]>;
}

/** The most text one scan reads; a longer text is refused (it throws) rather than half read. */
export const PII_SCAN_MAX_CHARS = 8 * 1_048_576;
export class PiiScanInputTooLarge extends RangeError {
  constructor() {
    super("the personal-data scan refuses a text over its size limit");
    this.name = "PiiScanInputTooLarge";
  }
}

/** The fixed words a finding is reported and redacted with. */
export const PII_KIND_WORDS: Record<PiiKind, string> = {
  email: "an email address", phone: "a phone number", card_number: "a card number", national_id: "a national id number", bank_account: "a bank account number", ip_address: "an IP address",
  aws_account: "an AWS account id", person_name: "a person's name", secret: "a secret or credential",
};
/** What replaces a redacted span. No quote, backslash or control character, so it is safe inside a JSON string. */
export const piiPlaceholder = (kind: PiiKind): string => `[REDACTED:${kind.toUpperCase()}]`;

// ---- rules

/** Exactly the reserved names: `example.com`, `.org` and `.net`, and one label under a reserved top-level name (`svc.test`). A longer name that merely ENDS in one (`real.gmail.com.invalid`) is not exempt. */
const RESERVED_EMAIL_DOMAIN = /^(?:example\.(?:com|org|net)|[a-z0-9-]+\.(?:test|invalid|example|localhost))$/u;
const EMAIL = /[A-Za-z0-9._%+-]{1,64}@([A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8})/gu;
const PHONE_INTERNATIONAL = /(?<![\w+])\+[1-9](?:[ .()-]?\d){7,14}(?!\d)/gu;
const PHONE_NANP = /(?<![\d-])\(?([2-9]\d{2})\)?[ .-]([2-9]\d{2})[ .-](\d{4})(?![\d-])/gu;
const SSN = /(?<![\d-])(\d{3})-(\d{2})-(\d{4})(?![\d-])/gu;
const NINO = /(?<![A-Za-z0-9])[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D](?![A-Za-z0-9])/gu;
const AADHAAR = /(?<![\d-])(?<!\d )[2-9]\d{3} \d{4} \d{4}(?![\d-])(?! \d)/gu;
const UUID = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/gu;
const CARD = /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/gu;
const IBAN = /(?<![A-Za-z0-9])[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?(?![A-Za-z0-9])/gu;
const IPV4 = /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?!\.?\d)/gu;
const IPV6 = /(?<![\w:])(?:[0-9A-Fa-f]{1,4}:){1,6}:(?:[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4}){0,5})?(?![\w:])|(?<![\w:])(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}(?![\w:])/gu;
const ARN_ACCOUNT = /arn:aws[a-z-]*:[a-z0-9-]*:[a-z0-9-]*:(\d{12}):/gu;
/** A key that names a person; its string value is a name. */
const NAME_KEY = /["']?\b(?:first[_-]?name|last[_-]?name|full[_-]?name|given[_-]?name|family[_-]?name|middle[_-]?name|surname|customer[_-]?name|patient[_-]?name|person[_-]?name|cardholder[_-]?name|account[_-]?holder)\b["']?\s*[:=]\s*(["'])([^"'\\\n]{2,80})\1/giu;
const CAPITALISED_PAIR = /\b([A-Z][a-z]{1,20})(?:\s+[A-Z]\.)?\s+([A-Z][a-z]{1,24})\b/gu;
const LAST_FIRST = /\b([A-Z][a-z]{1,24}),\s+([A-Z][a-z]{1,20})\b/gu;

/** Common first names. A short list on purpose: it finds the usual cases and keeps false positives rare. A name not here is not found. */
const FIRST_NAMES: ReadonlySet<string> = new Set(
  ("james john robert michael william david richard joseph thomas charles christopher daniel matthew anthony donald steven paul andrew joshua kenneth kevin brian george timothy ronald edward jason jeffrey ryan jacob gary nicholas eric jonathan stephen larry justin scott brandon benjamin samuel gregory alexander patrick raymond jack dennis jerry tyler aaron jose adam nathan henry douglas zachary peter kyle noah ethan jeremy walter christian keith roger terry austin sean gerald carl harold dylan arthur lawrence jordan jesse bryan billy bruce gabriel joe logan albert willie alan eugene russell vincent philip bobby johnny bradley " +
    "mary patricia jennifer linda elizabeth barbara susan jessica sarah karen lisa nancy betty margaret sandra ashley kimberly emily donna michelle carol amanda melissa deborah stephanie rebecca laura sharon cynthia kathleen amy shirley angela helen anna brenda pamela nicole samantha katherine emma ruth christine catherine debra rachel carolyn janet virginia maria heather diane julie joyce victoria kelly christina lauren joan evelyn olivia judith megan cheryl andrea hannah jacqueline martha gloria teresa ann sara madison frances kathryn janice jean abigail alice judy sophia denise amber doris marilyn danielle beverly isabella theresa diana natalie brittany charlotte marie kayla alexis lori " +
    "wei li wang zhang chen liu yang huang priya rahul amit sanjay ravi anil sunil rajesh vijay arjun neha pooja anjali deepak mohammed muhammad ahmed ali omar fatima aisha hassan hussein yusuf carlos juan luis miguel pedro diego jorge pablo sofia lucia valentina camila mateo santiago sven lars olga ivan dmitri sergei natasha yuki hiroshi kenji takeshi sakura min joon seo")
    .split(" "),
);

function* matches(pattern: RegExp, text: string): Generator<RegExpExecArray> {
  pattern.lastIndex = 0;
  for (let found = pattern.exec(text); found !== null; found = pattern.exec(text)) {
    yield found;
    if (found[0].length === 0) pattern.lastIndex += 1;
  }
}

/** The Luhn check over a digit string of 13 to 19 digits. */
export function luhnValid(digits: string): boolean {
  if (!/^\d{13,19}$/u.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits.charCodeAt(index) - 48;
    if (double) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/** The ISO 7064 mod-97 check of an IBAN (spaces allowed). */
export function ibanValid(iban: string): boolean {
  const compact = iban.replace(/ /gu, "");
  if (compact.length < 15 || compact.length > 34 || !/^[A-Z]{2}\d{2}[A-Z0-9]+$/u.test(compact)) return false;
  let remainder = 0;
  for (const char of compact.slice(4) + compact.slice(0, 4)) {
    const value = /\d/u.test(char) ? char : String(char.charCodeAt(0) - 55);
    for (const digit of value) remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}

/** An IPv4 address that is loopback, unspecified or in a documentation range: not personal. */
function reservedIpv4(address: string): boolean {
  return /^(?:127\.|0\.0\.0\.0$|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/u.test(address);
}

function nameFindings(text: string, add: (kind: PiiKind, start: number, end: number) => void): void {
  for (const match of matches(NAME_KEY, text)) {
    const value = match[2] ?? "";
    if (!/^[\p{L}][\p{L} .'’-]{1,79}$/u.test(value)) continue;
    const start = match.index + match[0].lastIndexOf(value);
    add("person_name", start, start + value.length);
  }
  for (const match of matches(CAPITALISED_PAIR, text)) if (FIRST_NAMES.has((match[1] ?? "").toLowerCase())) add("person_name", match.index, match.index + match[0].length);
  for (const match of matches(LAST_FIRST, text)) if (FIRST_NAMES.has((match[2] ?? "").toLowerCase())) add("person_name", match.index, match.index + match[0].length);
}

/** The region of `text` that `redactText` changed (from the first byte that differs to the last), or undefined when it changed nothing. One coarse span per text, never the secret itself. */
function secretRegion(text: string): { start: number; end: number } | undefined {
  const redacted = redactText(text);
  if (redacted === text) return undefined;
  let start = 0;
  const shortest = Math.min(text.length, redacted.length);
  while (start < shortest && text.charCodeAt(start) === redacted.charCodeAt(start)) start += 1;
  let tail = 0;
  while (tail < shortest - start && text.charCodeAt(text.length - 1 - tail) === redacted.charCodeAt(redacted.length - 1 - tail)) tail += 1;
  return { start, end: Math.max(start + 1, text.length - tail) };
}

/** The spans of the built-in scanner, unsorted and possibly overlapping (`mergeFindings` orders and joins them). */
function scanBuiltin(text: string): PiiFinding[] {
  if (text.length > PII_SCAN_MAX_CHARS) throw new PiiScanInputTooLarge();
  const found: PiiFinding[] = [];
  const add = (kind: PiiKind, start: number, end: number): void => { if (found.length < 5_000) found.push({ kind, start, end }); };
  const secret = secretRegion(text);
  if (secret !== undefined) add("secret", secret.start, secret.end);
  // A UUID is digits and letters in a fixed shape; its digit runs are not numbers, so the numeric rules look at the text with each UUID blanked to spaces (same length, so offsets hold).
  const numeric = text.replace(UUID, (id) => " ".repeat(id.length));
  for (const match of matches(EMAIL, text)) if (!RESERVED_EMAIL_DOMAIN.test((match[1] ?? "").toLowerCase())) add("email", match.index, match.index + match[0].length);
  for (const match of matches(PHONE_INTERNATIONAL, numeric)) {
    const digits = match[0].replace(/\D/gu, "");
    if (!/^1\d{3}55501\d{2}$/u.test(digits) && !luhnValid(digits)) add("phone", match.index, match.index + match[0].length);
  }
  for (const match of matches(PHONE_NANP, numeric)) if (!(match[2] === "555" && /^01\d\d$/u.test(match[3] ?? ""))) add("phone", match.index, match.index + match[0].length);
  for (const match of matches(SSN, numeric)) {
    const area = match[1] ?? "";
    if (area !== "000" && area !== "666" && !area.startsWith("9") && match[2] !== "00" && match[3] !== "0000") add("national_id", match.index, match.index + match[0].length);
  }
  for (const pattern of [NINO, AADHAAR]) for (const match of matches(pattern, numeric)) add("national_id", match.index, match.index + match[0].length);
  for (const match of matches(CARD, numeric)) if (luhnValid(match[0].replace(/\D/gu, ""))) add("card_number", match.index, match.index + match[0].length);
  for (const match of matches(IBAN, text)) if (ibanValid(match[0])) add("bank_account", match.index, match.index + match[0].length);
  for (const match of matches(IPV4, numeric)) if (!reservedIpv4(match[0])) add("ip_address", match.index, match.index + match[0].length);
  for (const match of matches(IPV6, text)) if (!/^(?:2001:db8:|fe80::1$)/iu.test(match[0]) && match[0].toLowerCase() !== "::1") add("ip_address", match.index, match.index + match[0].length);
  for (const match of matches(ARN_ACCOUNT, text)) { const start = match.index + match[0].indexOf(match[1] ?? ""); add("aws_account", start, start + 12); }
  nameFindings(text, add);
  return found;
}

/** The built-in scanner (see the top of this file for what it covers and what it does not). */
export const builtinPiiScanner: PiiScanner = { id: "builtin-1", scan: scanBuiltin };

/** Findings in order, overlapping or touching spans joined into one (the kind of the one that starts first; a secret wins a tie). Pure. */
export function mergeFindings(findings: readonly PiiFinding[]): PiiFinding[] {
  const sorted = [...findings].filter((finding) => finding.end > finding.start && finding.start >= 0).sort((a, b) => a.start - b.start || b.end - a.end || (a.kind === "secret" ? -1 : b.kind === "secret" ? 1 : 0));
  const merged: PiiFinding[] = [];
  for (const finding of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && finding.start <= last.end) last.end = Math.max(last.end, finding.end);
    else merged.push({ ...finding });
  }
  return merged;
}

/** Several scanners as one: each runs on the text and the spans are joined. A scanner that throws makes the whole scan throw (a scan that could not finish is never a clean one). */
export function combinePiiScanners(scanners: readonly PiiScanner[]): PiiScanner {
  return {
    id: scanners.map((scanner) => scanner.id).join("+"),
    async scan(text: string): Promise<PiiFinding[]> {
      const all: PiiFinding[] = [];
      for (const scanner of scanners) all.push(...(await scanner.scan(text)));
      return mergeFindings(all);
    },
  };
}

/** The text with each finding's span replaced by its kind's placeholder. Findings are merged first, so spans never overlap. */
export function redactPii(text: string, findings: readonly PiiFinding[]): string {
  let out = "";
  let at = 0;
  for (const finding of mergeFindings(findings)) {
    if (finding.start < at || finding.start > text.length) continue;
    out += text.slice(at, finding.start) + piiPlaceholder(finding.kind);
    at = Math.min(finding.end, text.length);
  }
  return out + text.slice(at);
}

/** The distinct kinds of a list of findings, in the order of `PII_KINDS`. */
export const piiKindsOf = (findings: readonly PiiFinding[]): PiiKind[] => PII_KINDS.filter((kind) => findings.some((finding) => finding.kind === kind));

// ---- the deep scan: what a text says once it is decoded

/** Characters that carry no meaning to a reader and are used to break a pattern up: zero-width spaces and joiners, the word joiner, the byte-order mark and the soft hyphen. */
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF\u00AD]/gu;
/** The text as a reader sees it: compatibility forms folded (full-width digits become digits) and invisible characters removed. Offsets in it do not match the original, so what only it finds cannot be redacted by span. */
export const normaliseForScan = (text: string): string => text.normalize("NFKC").replace(INVISIBLE, "");

/** A key that names a person: the string under it is a name. */
const PERSON_KEY = /^(?:first[_-]?name|last[_-]?name|full[_-]?name|given[_-]?name|family[_-]?name|middle[_-]?name|surname|customer[_-]?name|patient[_-]?name|person[_-]?name|cardholder[_-]?name|account[_-]?holder)$/iu;
const JSON_STRINGS_MAX = 20_000;
const JSON_DEPTH_MAX = 64;

export interface DeepScan {
  /** Every kind found in the text as written, in the text as a reader sees it, and (for JSON) in each decoded string, the decoded document and all its strings together. */
  kinds: PiiKind[];
  /**
   * The text with what could be found replaced by placeholders, or undefined when nothing can be redacted. Spans are applied where they can be mapped: in the text itself, or, for JSON, in each decoded string (so an
   * escaped `\u0040` is redacted as the `@` it is). A finding that cannot be mapped (one only the normalised text shows, one across two values) stays: scan the result again, and refuse when a kind is still there.
   */
  redacted(): string;
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  const first = text.trimStart()[0];
  if (first !== "{" && first !== "[" && first !== "\"") return { ok: false };
  try { return { ok: true, value: JSON.parse(text) as unknown }; } catch { return { ok: false }; }
}

/** The strings of a JSON value (values, and the keys of objects), in order, with the container each value sits in so a person-named key can mark its value. Bounded. */
function jsonStrings(value: unknown): { strings: string[]; tooMany: boolean } | undefined {
  const strings: string[] = [];
  let tooMany = false;
  const visit = (item: unknown, depth: number): boolean => {
    if (depth > JSON_DEPTH_MAX) return false;
    if (typeof item === "string") { strings.push(item); if (strings.length > JSON_STRINGS_MAX) { tooMany = true; return false; } return true; }
    if (Array.isArray(item)) return (item as unknown[]).every((entry) => visit(entry, depth + 1));
    if (typeof item === "object" && item !== null) return Object.entries(item as Record<string, unknown>).every(([key, entry]) => visit(key, depth + 1) && visit(entry, depth + 1));
    return true;
  };
  return visit(value, 0) ? { strings, tooMany } : undefined;
}

/**
 * Scans a text the way a person reading it would: as written; as a reader sees it (NFKC, no invisible characters); and, when it is JSON, decoded: every string value, the keys, the document written without escapes (where a
 * `customer_name` key sits beside its value), and all the strings together (an email split across two values). A text that cannot be read as JSON or is too deep or too large is scanned as written and as seen only.
 * Never returns the text found.
 */
export async function deepScan(scanner: PiiScanner, text: string): Promise<DeepScan> {
  const found = new Set<PiiKind>();
  const spans = async (value: string): Promise<PiiFinding[]> => {
    const direct = await scanner.scan(value);
    const seen = normaliseForScan(value);
    if (seen !== value) for (const finding of await scanner.scan(seen)) found.add(finding.kind);
    for (const finding of direct) found.add(finding.kind);
    return direct;
  };
  const rawSpans = await spans(text);
  const parsed = parseJson(text);
  const listed = parsed.ok ? jsonStrings(parsed.value) : undefined;
  if (!parsed.ok || listed === undefined || listed.tooMany) {
    return { kinds: PII_KINDS.filter((kind) => found.has(kind)), redacted: () => redactPii(text, rawSpans) };
  }
  // The document as the strings say it, without escapes: key and value sit together again.
  await spans(JSON.stringify(parsed.value));
  await spans(listed.strings.join(""));
  const perString = new Map<string, PiiFinding[]>();
  for (const value of new Set(listed.strings)) perString.set(value, await spans(value));
  const walk = (item: unknown, key: string | undefined): unknown => {
    if (typeof item === "string") {
      if (key !== undefined && PERSON_KEY.test(key) && /^[\p{L}][\p{L} .'’-]{1,79}$/u.test(item)) { found.add("person_name"); return piiPlaceholder("person_name"); }
      return redactPii(item, perString.get(item) ?? []);
    }
    if (Array.isArray(item)) return (item as unknown[]).map((entry) => walk(entry, undefined));
    if (typeof item === "object" && item !== null) return Object.fromEntries(Object.entries(item as Record<string, unknown>).map(([name, entry]) => [name, walk(entry, name)]));
    return item;
  };
  // The person-key rule needs the walk (the value is only a name by its key), so it runs now, and the kinds are read after it.
  const redactedValue = walk(parsed.value, undefined);
  return { kinds: PII_KINDS.filter((kind) => found.has(kind)), redacted: () => JSON.stringify(redactedValue) };
}
