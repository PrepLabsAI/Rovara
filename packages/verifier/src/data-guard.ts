// Synthetic data guard (design proof-test-env, section 4.7): a fixture, a seed or an API sample is scanned for personal data and for anything that names production before it is stored or run. A hit blocks it
// and records a FIXED code and where it was found, never the matched text (the report is shown to people and logged).
//
// What counts as a finding, and what does not:
//   - email: any address whose domain is not a reserved one (`example.com/.org/.net`, `.test`, `.invalid`, `.example`, `.localhost`); the seeded generator makes only reserved ones;
//   - phone: an international number with a plus sign, or a formatted North American number (separators required, so a plain 10-digit id is not a phone); the fictional 555-01xx range is synthetic;
//   - government_id: a US social security number (not the never-issued 000, 666 and 9xx areas), a UK national insurance number, a formatted 12-digit Aadhaar-style number;
//   - card_number: 13 to 19 digits, spaces or dashes allowed, that pass the Luhn check. The well-known test card numbers pass it too and ARE blocked: a fixture has no need of one;
//   - secret: anything the product's redactor would change (AWS and other provider keys, bearer tokens, JWTs, private keys, passwords in URLs or pairs);
//   - prod_host, prod_arn, prod_account: a host, an ARN or an account id on the company's deny list (the same matchers the broker uses at approval).
// Fail closed: input over `DATA_GUARD_MAX_BYTES` is refused (it throws), a report holds at most 100 findings (more is still `ok: false`), and no regular expression here can backtrack badly.
import type {
  DATA_GUARD_SOURCES} from "@agentx/contracts";
import {
  DataGuardReportSchema,
  prodDenyMatchesAccount,
  prodDenyMatchesArn,
  prodDenyMatchesHost,
  redactText,
  type DataGuardReport,
  type ServiceMockFixtureSet,
  type TestEnvProdDeny,
} from "@agentx/contracts";

export type DataGuardFindingKind = DataGuardReport["findings"][number]["kind"];
export type DataGuardSource = (typeof DATA_GUARD_SOURCES)[number];

/** The most text one scan reads. A larger input is refused rather than half-read. */
export const DATA_GUARD_MAX_BYTES = 8 * 1_048_576;
const FINDINGS_MAX = 100;

export class DataGuardInputTooLarge extends RangeError {
  constructor() {
    super("the data guard refuses input over its size limit");
    this.name = "DataGuardInputTooLarge";
  }
}

const RESERVED_EMAIL_DOMAIN = /(?:^|\.)(?:example\.(?:com|org|net)|[a-z0-9-]+\.test|test|invalid|example|localhost)$/u;
const EMAIL = /[A-Za-z0-9._%+-]{1,64}@([A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8})/gu;
const PHONE_INTERNATIONAL = /(?<![\w+])\+[1-9](?:[ .()-]?\d){7,14}(?!\d)/gu;
const PHONE_NANP = /(?<![\d-])\(?([2-9]\d{2})\)?[ .-]([2-9]\d{2})[ .-](\d{4})(?![\d-])/gu;
const SSN = /(?<![\d-])(\d{3})-(\d{2})-(\d{4})(?![\d-])/gu;
const NINO = /(?<![A-Za-z0-9])[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D](?![A-Za-z0-9])/gu;
const AADHAAR = /(?<![\d-])(?<!\d )[2-9]\d{3} \d{4} \d{4}(?![\d-])(?! \d)/gu;
const UUID = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/gu;
const CARD = /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/gu;
const HOSTNAME = /(?<![A-Za-z0-9.-])((?:[A-Za-z0-9-]{1,63}\.){1,8}[A-Za-z]{2,24})(?![A-Za-z0-9-])/gu;
const ARN = /arn:aws[a-z-]*:[a-z0-9-]*:[a-z0-9-]*:\d{12}:[A-Za-z0-9:/_.+=,@*-]{0,200}/gu;
const ACCOUNT = /(?<!\d)\d{12}(?!\d)/gu;

/** The Luhn check over a digit string. */
export function luhnValid(digits: string): boolean {
  if (!/^\d{13,19}$/u.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits.charCodeAt(index) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function* matches(pattern: RegExp, text: string): Generator<RegExpExecArray> {
  pattern.lastIndex = 0;
  for (let found = pattern.exec(text); found !== null; found = pattern.exec(text)) {
    yield found;
    if (found[0].length === 0) pattern.lastIndex += 1;
  }
}

/** The kinds of finding in a text, each once. Pure; the matched text is not returned. */
export function scanText(text: string, deny: TestEnvProdDeny): DataGuardFindingKind[] {
  if (Buffer.byteLength(text, "utf8") > DATA_GUARD_MAX_BYTES) throw new DataGuardInputTooLarge();
  const found = new Set<DataGuardFindingKind>();
  // A credential (a cloud key, a bearer token or JWT, a private key, a connection string with a password, a `password=` pair): the contracts' redactor is the one list of what a secret looks like, and a text it
  // would change holds one. A response that echoes a token must never be stored as a fixture, so this blocks like any other finding.
  if (redactText(text) !== text) found.add("secret");
  // A UUID is digits and letters in a fixed shape; its digit runs are not numbers, so the numeric patterns look at the text without them.
  const numeric = text.replace(UUID, " ");
  for (const match of matches(EMAIL, text)) if (!RESERVED_EMAIL_DOMAIN.test((match[1] ?? "").toLowerCase())) found.add("email");
  for (const match of matches(PHONE_INTERNATIONAL, numeric)) {
    const digits = match[0].replace(/\D/gu, "");
    // A "+1 555 01xx" number is the fictional range; a long run of digits that is a card is reported as a card.
    if (!/^1\d{3}55501\d{2}$/u.test(digits) && !luhnValid(digits)) found.add("phone");
  }
  for (const match of matches(PHONE_NANP, numeric)) if (!(match[2] === "555" && /^01\d\d$/u.test(match[3] ?? ""))) found.add("phone");
  for (const match of matches(SSN, numeric)) {
    const area = match[1] ?? "";
    if (area !== "000" && area !== "666" && !area.startsWith("9") && match[2] !== "00" && match[3] !== "0000") found.add("government_id");
  }
  if (matches(NINO, numeric).next().done !== true) found.add("government_id");
  if (matches(AADHAAR, numeric).next().done !== true) found.add("government_id");
  for (const match of matches(CARD, numeric)) if (luhnValid(match[0].replace(/\D/gu, ""))) found.add("card_number");
  for (const match of matches(HOSTNAME, text)) if (!/^\d+(?:\.\d+)+$/u.test(match[1] ?? "") && prodDenyMatchesHost(deny, match[1] ?? "")) found.add("prod_host");
  for (const match of matches(ARN, text)) {
    const kind = prodDenyMatchesArn(deny, match[0]);
    if (kind !== undefined) found.add(kind);
  }
  for (const match of matches(ACCOUNT, text)) if (prodDenyMatchesAccount(deny, match[0])) found.add("prod_account");
  return [...found];
}

/** An input to scan: where it came from, a short path that names it in the report, and its text. */
export interface GuardInput { source: DataGuardSource; path: string; text: string }

const safePath = (path: string): string => path.replace(/[\p{Cc}\p{Cf}]/gu, "?").slice(0, 300) || "input";

/** Scans each input and builds the report. A path names the input (a file, `entries[3].response`), never what was found in it. */
export function guardInputs(inputs: readonly GuardInput[], deny: TestEnvProdDeny): DataGuardReport {
  const findings: DataGuardReport["findings"] = [];
  let total = 0;
  for (const input of inputs) {
    total += Buffer.byteLength(input.text, "utf8");
    if (total > DATA_GUARD_MAX_BYTES) throw new DataGuardInputTooLarge();
    for (const kind of scanText(input.text, deny)) if (findings.length < FINDINGS_MAX) findings.push({ kind, source: input.source, path: safePath(input.path) });
  }
  return DataGuardReportSchema.parse({ ok: findings.length === 0, findings });
}

/** A recorded fixture set, request and response bodies of every entry. The recorder runs this before it stores a set; a hit means the set is not stored. */
export function guardFixtureSet(set: ServiceMockFixtureSet, deny: TestEnvProdDeny): DataGuardReport {
  const inputs: GuardInput[] = [];
  set.entries.forEach((entry, index) => {
    inputs.push({ source: "fixture", path: `entries[${String(index)}].request`, text: entry.request.body }, { source: "fixture", path: `entries[${String(index)}].response`, text: entry.response.body });
  });
  return guardInputs(inputs, deny);
}

/** A seed: a command (its executable and arguments are scanned) or a fixture file in the repository (read through `readFile`, which the caller bounds to the workspace). */
export async function guardSeeds(
  seeds: ReadonlyArray<{ command: { executable: string; args: readonly string[] } } | { fixturePath: string }>,
  deny: TestEnvProdDeny,
  readFile: (path: string) => Promise<string>,
): Promise<DataGuardReport> {
  const inputs: GuardInput[] = [];
  for (const [index, seed] of seeds.entries()) {
    if ("command" in seed) inputs.push({ source: "seed", path: `seeds[${String(index)}].command`, text: [seed.command.executable, ...seed.command.args].join(" ") });
    else inputs.push({ source: "seed", path: seed.fixturePath, text: await readFile(seed.fixturePath) });
  }
  return guardInputs(inputs, deny);
}

/** An API sample's request and response, as the evidence would show it. */
export function guardApiSample(sample: { name: string; request: string; response: string }, deny: TestEnvProdDeny): DataGuardReport {
  return guardInputs([{ source: "api_sample", path: `${sample.name}.request`, text: sample.request }, { source: "api_sample", path: `${sample.name}.response`, text: sample.response }], deny);
}

// ---- the seeded generator

export interface SyntheticGenerator {
  /** A fresh value each call, the same sequence for the same seed. */
  email(): string;
  phone(): string;
  name(): string;
  id(prefix?: string): string;
  uuid(): string;
  int(min: number, max: number): number;
  pick<T>(values: readonly T[]): T;
}

const FIRST = ["Ada", "Bao", "Cyra", "Dev", "Eli", "Fay", "Gus", "Hana", "Ivo", "Jun", "Kai", "Lea"];
const LAST = ["Alder", "Birch", "Cedar", "Dune", "Elm", "Fern", "Grove", "Heath", "Ivy", "Juniper", "Kelp", "Linden"];

/**
 * A repeatable generator (mulberry32): the same seed gives the same values in the same order, so a run repeats. Everything it makes is reserved or fictional (emails at `example.test`, phones in the
 * 555-01xx range), so what it makes passes the guard by construction (a test holds it to that).
 */
export function createSyntheticGenerator(seed: number): SyntheticGenerator {
  if (!Number.isInteger(seed) || seed < 0 || seed > 2_147_483_647) throw new RangeError("a seed is an integer from 0 to 2147483647");
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const int = (min: number, max: number): number => {
    if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) throw new RangeError("a range of integers, smallest first");
    return min + Math.floor(next() * (max - min + 1));
  };
  const hex = (length: number): string => Array.from({ length }, () => int(0, 15).toString(16)).join("");
  const pick = <T>(values: readonly T[]): T => {
    if (values.length === 0) throw new RangeError("nothing to pick from");
    return values[int(0, values.length - 1)] as T;
  };
  return {
    int,
    pick,
    email: () => `${pick(FIRST).toLowerCase()}.${pick(LAST).toLowerCase()}${String(int(1, 9_999))}@example.test`,
    phone: () => `+1 202 555 01${String(int(0, 99)).padStart(2, "0")}`,
    name: () => `${pick(FIRST)} ${pick(LAST)}`,
    id: (prefix = "id") => `${prefix}-${hex(8)}`,
    uuid: () => `${hex(8)}-${hex(4)}-4${hex(3)}-${pick(["8", "9", "a", "b"])}${hex(3)}-${hex(12)}`,
  };
}
