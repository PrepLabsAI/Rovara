import type { E2EModelChannelRequest } from "@agentx/contracts";
import { e2eScannableEmailLocalPart, redactText } from "@agentx/contracts";

/**
 * The credential scan of the e2e model proxy (M1.4 Task 4.1). It runs on the prompt bytes before every provider call.
 *
 * - A seeded password, a `Set-Cookie` value the executor reported, or a credential-shaped string (`AKIA...`,
 *   `-----BEGIN`, an `sk-` key, a Slack token) anywhere in the prompt refuses the call.
 * - The account email and its local part are different. They are page text whenever the app shows who is signed in, and
 *   refusing every such call would make those apps untestable. So where the prompt shows them as text the agent did not
 *   write (the system prompt, the goal, the page observation, a tool result) they are replaced with a placeholder and
 *   the call goes ahead. Where the agent itself wrote them (its own text or a tool call input, such as typing the email
 *   into a field), the call is refused: the agent handles no credential.
 *
 * Nothing here returns or logs a matched value. A refusal names a category only.
 */

export interface E2ECredentialSet {
  /** Seeded account passwords. */
  passwords: readonly string[];
  /** Account emails, as seeded. */
  emails: readonly string[];
  /** `Set-Cookie` values (or whole `name=value` lines) the executor reported for the run. */
  cookieValues: readonly string[];
}

export const MIN_SCANNABLE_SECRET_LENGTH = 6;
const PLACEHOLDER_SECRET = "[REDACTED]";
const PLACEHOLDER_EMAIL = "[account-email]";
const PLACEHOLDER_USER = "[account-user]";

/** `sk-` alone would match `task-list` and `disk-usage`; a real key is long and does not follow a letter or digit. */
const SHAPES: readonly RegExp[] = [
  /(?:AKIA|ASIA)[0-9A-Z]{16}/g,
  /-----BEGIN/g,
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/g,
  /xox[abp]-[A-Za-z0-9-]/g,
];

type Call = E2EModelChannelRequest["call"];

export type CredentialInspection =
  | { refuse: true; category: "password" | "cookie" | "credential-shape" | "account-identity" | "unscannable-credential" }
  | { refuse: false; call: Call; redactions: number };

export interface E2ECredentialGuardOptions {
  /**
   * What to do with a value too short to scan for safely. `throw` is for the seeded set at start (the run cannot begin);
   * `latch` is for values reported during a run, where a throw would be an unhandled failure: the guard then refuses
   * every later call instead.
   */
  onUnscannable?: "throw" | "latch";
}

export interface E2ECredentialGuard {
  /** True once a value that cannot be scanned was supplied (latch mode): every inspection refuses. */
  readonly unscannable: boolean;
  /** Decides whether the call may go to the provider, and returns the call with page-text emails replaced. */
  inspect(call: Call): CredentialInspection;
  /** Whether any string in a JSON value (or any key) carries a seeded secret or credential-shaped text. The last scan, on a provider payload. */
  containsSecret(value: unknown): boolean;
  /** A copy of any JSON value with every credential, email and credential-shaped string replaced, for evidence. */
  scrubValue<T>(value: T): T;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function secretVariants(values: readonly string[], label: string): string[] {
  const out = new Set<string>();
  for (const value of values) {
    if (value === "") continue;
    if (value.length < MIN_SCANNABLE_SECRET_LENGTH) throw new Error(`a ${label} is too short to scan for safely (under ${MIN_SCANNABLE_SECRET_LENGTH} characters)`);
    out.add(value);
    out.add(encodeURIComponent(value));
    out.add(Buffer.from(value, "utf8").toString("base64"));
  }
  return [...out];
}

export function createE2ECredentialGuard(set: E2ECredentialSet, guardOptions: E2ECredentialGuardOptions = {}): E2ECredentialGuard {
  let unscannable = false;
  const latch = guardOptions.onUnscannable === "latch";
  const scanned = (values: readonly string[], label: string): string[] => {
    // A value that cannot be scanned is dropped here and, in latch mode, refuses every call; in throw mode it fails the start.
    const kept = latch ? values.filter((value) => value === "" || value.length >= MIN_SCANNABLE_SECRET_LENGTH) : values;
    if (latch && kept.length !== values.length) unscannable = true;
    return secretVariants(kept, label);
  };
  const passwords = scanned(set.passwords, "password");
  const cookieSeeds = set.cookieValues.flatMap((line) => {
    const afterName = /^[^=;\s]+=([^;]+)/.exec(line)?.[1];
    return afterName !== undefined && afterName.length >= MIN_SCANNABLE_SECRET_LENGTH ? [line, afterName] : [line];
  });
  const cookies = scanned(cookieSeeds, "cookie value");
  const emails = [...new Set(set.emails.filter((email) => email !== ""))];
  // The same rule as the executor's redactor (`e2eScannableEmailLocalPart`): a short or word-like local part is ordinary page text and is not looked for on its own.
  const localParts = [...new Set(emails.flatMap((email) => e2eScannableEmailLocalPart(email) ?? []))];
  const emailPattern = emails.length === 0 ? undefined : new RegExp(emails.map(escapeRegExp).join("|"), "gi");
  const localPattern = localParts.length === 0 ? undefined : new RegExp(`(?<![A-Za-z0-9])(?:${localParts.map(escapeRegExp).join("|")})(?![A-Za-z0-9])`, "gi");

  const matches = (text: string, needles: readonly string[]) => needles.some((needle) => text.includes(needle));
  const shaped = (text: string) => SHAPES.some((shape) => { shape.lastIndex = 0; return shape.test(text); });
  const identity = (text: string) => [emailPattern, localPattern].some((pattern) => { if (pattern === undefined) return false; pattern.lastIndex = 0; return pattern.test(text); });

  function secretCategory(text: string): "password" | "cookie" | "credential-shape" | undefined {
    if (matches(text, passwords)) return "password";
    if (matches(text, cookies)) return "cookie";
    if (shaped(text)) return "credential-shape";
    return undefined;
  }

  function redactIdentity(text: string): { text: string; count: number } {
    let count = 0;
    let out = text;
    if (emailPattern !== undefined) out = out.replace(emailPattern, () => { count += 1; return PLACEHOLDER_EMAIL; });
    if (localPattern !== undefined) out = out.replace(localPattern, () => { count += 1; return PLACEHOLDER_USER; });
    return { text: out, count };
  }

  function scrubText(text: string): string {
    let out = text;
    for (const needle of [...passwords, ...cookies]) out = out.split(needle).join(PLACEHOLDER_SECRET);
    for (const shape of SHAPES) out = out.replace(shape, PLACEHOLDER_SECRET);
    return redactText(redactIdentity(out).text);
  }

  function scrubValue<T>(value: T): T {
    if (typeof value === "string") return scrubText(value) as T;
    if (Array.isArray(value)) return (value as unknown[]).map((item) => scrubValue(item)) as T;
    if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, item]) => [scrubText(key), scrubValue(item)])) as T;
    return value;
  }

  function containsSecret(value: unknown): boolean {
    if (unscannable) return true;
    if (typeof value === "string") return secretCategory(value) !== undefined;
    if (Array.isArray(value)) return (value as unknown[]).some(containsSecret);
    if (typeof value === "object" && value !== null) return Object.entries(value).some(([key, item]) => secretCategory(key) !== undefined || containsSecret(item));
    return false;
  }

  function inspect(call: Call): CredentialInspection {
    if (unscannable) return { refuse: true, category: "unscannable-credential" };
    let refusal: Extract<CredentialInspection, { refuse: true }>["category"] | undefined;
    let redactions = 0;
    /** Text Rovara or the page wrote: secrets refuse, identity is replaced. */
    const shown = (text: string): string => {
      refusal ??= secretCategory(text);
      const redacted = redactIdentity(text);
      redactions += redacted.count;
      return redacted.text;
    };
    /** Text the agent wrote: anything refuses. */
    const typed = (text: string): string => {
      refusal ??= secretCategory(text) ?? (identity(text) ? "account-identity" : undefined);
      return text;
    };
    /** Every string inside a JSON value, so an escape in the encoded form cannot hide a credential. */
    const typedJson = (value: unknown): void => {
      if (typeof value === "string") typed(value);
      else if (Array.isArray(value)) value.forEach(typedJson);
      else if (typeof value === "object" && value !== null) Object.entries(value).forEach(([key, item]) => { typed(key); typedJson(item); });
    };
    const prompt = call.prompt.map((message): Call["prompt"][number] => {
      if (message.role === "system") return { ...message, content: shown(message.content) };
      if (message.role === "user") return { ...message, content: message.content.map((part) => ({ ...part, text: shown(part.text) })) };
      if (message.role === "assistant") {
        return { ...message, content: message.content.map((part) => {
          if (part.type === "text") return { ...part, text: typed(part.text) };
          typed(part.toolCallId);
          typedJson(part.input);
          return part;
        }) };
      }
      return { ...message, content: message.content.map((part) => {
        typed(part.toolCallId);
        const output = part.output;
        if (output.type === "content") return { ...part, output: { ...output, value: output.value.map((item) => ({ ...item, text: shown(item.text) })) } };
        return { ...part, output: { ...output, value: shown(output.value) } };
      }) };
    });
    for (const tool of call.tools ?? []) { typed(tool.description ?? ""); typedJson(tool.inputSchema); }
    if (refusal !== undefined) return { refuse: true, category: refusal };
    const cleaned: Call = { ...call, prompt };
    // A last look at the bytes that would be sent, for a place the walk above did not think of.
    const bytes = JSON.stringify(cleaned);
    const leftover = secretCategory(bytes);
    if (leftover !== undefined) return { refuse: true, category: leftover };
    return { refuse: false, call: cleaned, redactions };
  }

  return { get unscannable() { return unscannable; }, inspect, containsSecret, scrubValue };
}
