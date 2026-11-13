// `rovara record sagemaker --presidio-url <url>`: an OPTIONAL second scanner. Microsoft Presidio is a Python service, so the recorder does not bundle it. If the customer already runs a Presidio analyzer (the
// `presidio-analyzer` container or service), this adapter asks it to analyse each text and adds what it finds to what the built-in scanner finds; the recording is refused or redacted for the union.
// What is sent, and where: the text of the customer's own requests and answers, to the analyzer address the customer gives. That address must be this computer (loopback) unless the customer also says
// `--allow-remote-presidio`: a recorded answer holds data the customer has not yet judged, and the recorder never sends it to a remote service by default. Nothing is ever sent to Rovara.
// An analyzer that cannot be reached or answers something unexpected makes the scan FAIL (the recording stops): a scan that did not finish is never a clean one.
import { mergeFindings, type PiiFinding, type PiiKind, type PiiScanner } from "@rovara-code/contracts";

/** Presidio's entity types, by the kind they are reported as. A type that is not here is not asked for. */
export const PRESIDIO_ENTITY_KINDS: Readonly<Record<string, PiiKind>> = {
  EMAIL_ADDRESS: "email", PHONE_NUMBER: "phone", CREDIT_CARD: "card_number", IBAN_CODE: "bank_account", US_BANK_NUMBER: "bank_account", IP_ADDRESS: "ip_address", PERSON: "person_name",
  US_SSN: "national_id", US_ITIN: "national_id", US_PASSPORT: "national_id", US_DRIVER_LICENSE: "national_id", UK_NHS: "national_id", UK_NINO: "national_id", IN_AADHAAR: "national_id", IN_PAN: "national_id",
  IN_PASSPORT: "national_id", IN_VOTER: "national_id", IN_VEHICLE_REGISTRATION: "national_id", SG_NRIC_FIN: "national_id", AU_TFN: "national_id", AU_MEDICARE: "national_id", ES_NIF: "national_id",
  IT_FISCAL_CODE: "national_id", PL_PESEL: "national_id", MEDICAL_LICENSE: "national_id", CRYPTO: "secret",
};

/** The slice size sent to the analyzer: spaCy's default limit is one million characters, so a long answer is sent in parts split at whitespace. */
export const PRESIDIO_SLICE_CHARS = 100_000;
export const PRESIDIO_SCORE_THRESHOLD = 0.4;

export interface PresidioOptions {
  /** The analyzer's address, `http://localhost:5002` for the container's default. */
  url: string;
  fetch?: typeof fetch;
  language?: string;
  scoreThreshold?: number;
  /** Allow an address that is not this computer. */
  allowRemote?: boolean;
  timeoutMs?: number;
  /** The slice size and the overlap between slices, in characters (the defaults suit Presidio; tests make them small). */
  sliceChars?: number;
  overlapChars?: number;
}

export type PresidioUrlProblem = "not_a_url" | "not_http" | "remote_not_allowed" | "has_credentials";

/** The analyzer address, or why it is refused. Loopback only unless `allowRemote`. */
export function presidioUrl(value: string, allowRemote: boolean): { ok: true; url: URL } | { ok: false; problem: PresidioUrlProblem } {
  let url: URL;
  try { url = new URL(value); } catch { return { ok: false, problem: "not_a_url" }; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, problem: "not_http" };
  if (url.username !== "" || url.password !== "") return { ok: false, problem: "has_credentials" };
  const host = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  const loopback = host === "localhost" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(host) || host === "::1";
  return loopback || allowRemote ? { ok: true, url } : { ok: false, problem: "remote_not_allowed" };
}

export const PRESIDIO_URL_PROBLEM_WORDS: Record<PresidioUrlProblem, string> = {
  not_a_url: "The Presidio address is not a URL.",
  not_http: "The Presidio address must start with http:// or https://.",
  remote_not_allowed: "The Presidio analyzer is not on this computer. Your recorded data would leave it; add --allow-remote-presidio only if that is what you want.",
  has_credentials: "The Presidio address must not carry a user name or password.",
};

/** How much of the end of one slice the next one repeats, so a name (two or three words) that straddles a cut is whole in one of them. */
export const PRESIDIO_SLICE_OVERLAP = 200;

/**
 * Cuts a text into parts of at most `size` characters, at whitespace where there is one near the end, each part repeating the last `overlap` characters of the one before. Returns each part with its offset in the text.
 * Findings in the repeated part are found twice; the caller joins them.
 */
export function sliceText(text: string, size: number = PRESIDIO_SLICE_CHARS, overlap: number = PRESIDIO_SLICE_OVERLAP): Array<{ offset: number; text: string }> {
  const parts: Array<{ offset: number; text: string }> = [];
  const back = Math.min(Math.max(0, overlap), Math.floor(size / 2));
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(text.length, offset + size);
    if (end < text.length) {
      const cut = Math.max(text.lastIndexOf(" ", end), text.lastIndexOf("\n", end));
      if (cut > offset + size / 2) end = cut + 1;
    }
    // never cut between the two halves of a character outside the basic plane
    if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end -= 1;
    parts.push({ offset, text: text.slice(offset, end) });
    if (end >= text.length) break;
    offset = Math.max(offset + 1, end - back);
    if (text.charCodeAt(offset) >= 0xdc00 && text.charCodeAt(offset) <= 0xdfff) offset += 1;
  }
  return parts;
}

/**
 * The analyzer's reply as findings, or undefined when it is not what the analyzer answers. Presidio is Python, so its offsets count code points; they are turned into JavaScript's UTF-16 offsets here (a character
 * outside the basic plane, such as an emoji, is one code point and two units), checked against the sliced text, and shifted by the slice's offset.
 */
export function presidioFindings(reply: unknown, slice: string, offset: number): PiiFinding[] | undefined {
  if (!Array.isArray(reply) || reply.length > 10_000) return undefined;
  const points = Array.from(slice);
  // The UTF-16 offset of each code point, and of the end. Without a character outside the basic plane the two counts are the same.
  const astral = points.length !== slice.length;
  const units: number[] = [];
  if (astral) { let at = 0; for (const point of points) { units.push(at); at += point.length; } units.push(at); }
  const out: PiiFinding[] = [];
  for (const item of reply as unknown[]) {
    if (typeof item !== "object" || item === null) return undefined;
    const { entity_type: type, start, end, score } = item as Record<string, unknown>;
    if (typeof type !== "string" || !Number.isInteger(start) || !Number.isInteger(end) || typeof score !== "number") return undefined;
    const s = start as number;
    const e = end as number;
    if (s < 0 || e <= s || e > points.length) return undefined;
    const kind = Object.hasOwn(PRESIDIO_ENTITY_KINDS, type) ? PRESIDIO_ENTITY_KINDS[type] : undefined;
    if (kind !== undefined) out.push({ kind, start: offset + (astral ? units[s]! : s), end: offset + (astral ? units[e]! : e) });
  }
  return out;
}

/** A scanner that asks a Presidio analyzer the customer runs. Throws when the analyzer cannot be reached or answers something unexpected, so the recorder stops. */
export function presidioScanner(options: PresidioOptions): PiiScanner {
  const checked = presidioUrl(options.url, options.allowRemote === true);
  if (!checked.ok) throw new RangeError(PRESIDIO_URL_PROBLEM_WORDS[checked.problem]);
  const target = new URL("/analyze", checked.url);
  const send = options.fetch ?? fetch;
  const language = options.language ?? "en";
  const entities = Object.keys(PRESIDIO_ENTITY_KINDS);
  return {
    id: "presidio",
    async scan(text: string): Promise<PiiFinding[]> {
      const found: PiiFinding[] = [];
      for (const part of sliceText(text, options.sliceChars, options.overlapChars)) {
        if (part.text.trim() === "") continue;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
        let reply: unknown;
        try {
          const response = await send(target, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: part.text, language, entities, score_threshold: options.scoreThreshold ?? PRESIDIO_SCORE_THRESHOLD }), signal: controller.signal, redirect: "error" });
          if (!response.ok) throw new Error("the Presidio analyzer answered with an error");
          reply = await response.json();
        } catch {
          throw new Error("the Presidio analyzer could not be reached or did not answer as expected");
        } finally {
          clearTimeout(timer);
        }
        const findings = presidioFindings(reply, part.text, part.offset);
        if (findings === undefined) throw new Error("the Presidio analyzer did not answer as expected");
        found.push(...findings);
      }
      return mergeFindings(found);
    },
  };
}
