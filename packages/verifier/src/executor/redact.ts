import { e2eScannableEmailLocalPart, e2eSecretSpellings, type E2EExecutorAccount } from "@agentx/contracts";

/**
 * Every spelling of a secret that an HTTP client, a JSON encoder, a URL builder or a base64, base64url or hex field could leave in an output file or a model prompt. It is the contracts'
 * one builder, the same the worker's model-channel scan uses (raw, JSON-escaped, percent-encoded once and twice, base64 and base64url at any alignment, hex), so the executor's scan and the
 * worker's cannot disagree about what a spelling of a secret is (MIDSTEP-2). Longest first, so a text replacement takes the longest form.
 */
function spellings(value: string): string[] {
  return e2eSecretSpellings(value).sort((a, b) => b.length - a.length);
}

const WRAP_GAP = /(?<=[A-Za-z0-9+/_=-])[\r\n\t ]+(?=[A-Za-z0-9+/_=-])/g;
/** The bytes with whitespace between two base64 characters removed, or null when there is none. Bytes are kept one for one (latin1), so nothing else changes. */
function unwrapBase64Lines(bytes: Buffer): Buffer | null {
  const text = bytes.toString("latin1");
  const unwrapped = text.replace(WRAP_GAP, "");
  return unwrapped.length === text.length ? null : Buffer.from(unwrapped, "latin1");
}

/** What replaces a session secret in text. */
export const SESSION_REDACTION_LABEL = "<session>";
/**
 * A session secret shorter than this is ignored altogether: not looked for in bytes, where a handful of characters would match almost anything, and not replaced in text, where a
 * value like `1`, `true` or `accepted` would rewrite numbers, booleans and words in a report and corrupt it.
 */
const MIN_SESSION_SECRET_LENGTH = 8;

/**
 * `model` is false for a value registered evidence-only: it is scrubbed from text and refused in evidence, but a prompt that shows it is not refused (a draft or a route is app data, not a credential).
 * `mask` is true for an evidence-only value that is also replaced by `<session>` in what the model is shown (a weak value); a scrub-only value (an ordinary sentence, path, URL...) has `mask` false.
 */
type Rule = { form: string; label: string; bytes: boolean; session: boolean; model: boolean; mask: boolean };

/** Mask-only values (weak values past the evidence cap) held in memory, in all, for the model's mask. Past it the model's view fails closed (see `maskOverflow`). */
export const MASK_ONLY_LIMIT = 20_000;
/** The mask finds a form by its first characters; the shortest spelling the contracts build is 6 characters long. */
const MASK_PREFIX = 6;
/**
 * The mask index is a prefix tree that only grows where values share a start (every JWT begins `eyJhbGci`): a bucket holds at most MASK_SPLIT forms before the ones long enough are split by their next
 * MASK_CHUNK characters, so a lookup compares against a handful of forms however many values are registered.
 */
const MASK_SPLIT = 16;
const MASK_CHUNK = 8;
interface MaskNode { at: number; list: Rule[]; kids?: Map<string, MaskNode> }
function maskInsert(node: MaskNode, rule: Rule): void {
  if (node.kids !== undefined && rule.form.length >= node.at + MASK_CHUNK) {
    const key = rule.form.slice(node.at, node.at + MASK_CHUNK);
    let kid = node.kids.get(key);
    if (kid === undefined) { kid = { at: node.at + MASK_CHUNK, list: [] }; node.kids.set(key, kid); }
    maskInsert(kid, rule);
    return;
  }
  node.list.push(rule);
  if (node.kids === undefined && node.list.length > MASK_SPLIT && node.list.some((item) => item.form.length >= node.at + MASK_CHUNK)) {
    const all = node.list;
    node.list = [];
    node.kids = new Map();
    for (const item of all) maskInsert(node, item);
  }
}
/** The longest registered form that starts at `start` in `value` and is maskable. */
function maskFind(node: MaskNode, value: string, start: number): Rule | undefined {
  let best: Rule | undefined;
  for (const rule of node.list) if (rule.mask && !rule.model && (best === undefined || rule.form.length > best.form.length) && value.startsWith(rule.form, start)) best = rule;
  const kid = node.kids?.get(value.slice(start + node.at, start + node.at + MASK_CHUNK));
  if (kid !== undefined) {
    const deeper = maskFind(kid, value, start);
    if (deeper !== undefined && (best === undefined || deeper.form.length > best.form.length)) best = deeper;
  }
  return best;
}

export type CredentialRedactor = Readonly<{
  /** Replaces every credential in text with `<account:profileId>` (an account) or `<session>` (a registered session secret). */
  text(value: string): string;
  /**
   * True when the bytes contain an account email or password, or a registered session secret, in any known spelling, including base64 and base64url at any alignment.
   * `scope` "accounts" leaves the session secrets out; "model" is what a model-bound payload is checked with: accounts and the session secrets that are credentials, not the ones
   * registered evidence-only.
   */
  contains(bytes: Uint8Array, scope?: "accounts" | "all" | "model"): boolean;
  /**
   * Replaces every registered EVIDENCE-ONLY (weak) session value in text with `<session>`, and nothing else: accounts and credentials are left as they are, so a model-bound payload that shows one is still
   * refused by `contains(..., "model")`. This is what the model is shown instead of a weak value (MIDSTEP-2 MASKMAYBE).
   */
  maskEvidenceOnly(value: string): string;
  /**
   * Registers a secret the run created (the session cookie) so `text` redacts it and `contains` finds it. It never throws: a short or odd value is still redacted. `evidenceOnly` values are
   * scrubbed and refused in evidence but not in a prompt; they are also masked for the model unless `scrubOnly` (an ordinary value that the model must be able to read).
   */
  addSessionSecret(value: string, options?: { evidenceOnly?: boolean; scrubOnly?: boolean }): void;
  /**
   * Registers a value for the model's mask ONLY: it is not scrubbed from evidence, not scanned for in evidence, nothing about it is written. This is where weak values go once the evidence cap is
   * reached. False when the bound (`MASK_ONLY_LIMIT`) is reached: the value is not registered, and the caller must fail the model's view closed.
   */
  addMaskOnly(value: string): boolean;
}>;

/**
 * Credentials live only in the read-only plan mount. Everything the executor writes under its out directory passes
 * through this: logs and diagnostics are redacted, evidence that carries a credential is refused.
 */
export function createCredentialRedactor(accounts: readonly E2EExecutorAccount[], limits: { maskOnlyLimit?: number } = {}): CredentialRedactor {
  // The part of an email before the `@` is a credential too: an app that shows only that part must not leak it either. Which local parts are looked for on their own is the
  // contracts' one rule (`e2eScannableEmailLocalPart`), shared with the worker's model-channel credential scan; a short one would be redacted from everything.
  const rules: Rule[] = accounts.flatMap((account) => [account.password, account.email, e2eScannableEmailLocalPart(account.email)]
    .flatMap((secret) => (secret === null ? [] : [secret]))
    .flatMap((secret) => spellings(secret).map((form) => ({ form, label: `<account:${account.profileId}>`, bytes: true, session: false, model: true, mask: false }))));
  rules.sort((a, b) => b.form.length - a.form.length);
  // Registration is O(1) per form (a Map index; the longest-first order is rebuilt on the first read after a change), because the mid-step sync feeds this thousands of values.
  const byForm = new Map<string, Rule>(rules.map((rule) => [rule.form, rule]));
  let sorted = true;
  const ordered = (): Rule[] => { if (!sorted) { rules.sort((a, b) => b.form.length - a.form.length); sorted = true; } return rules; };
  // The model's mask: one index of every maskable form by its first characters, so a text is read once whatever the number of registered values (a lookup per position, not a pass per value).
  const maskIndex = new Map<string, MaskNode>();
  const maskFirst = new Set<number>();
  const maskOnly = new Map<string, Rule>();
  const maskOnlyValues = new Set<string>();
  const maskOnlyLimit = limits.maskOnlyLimit ?? MASK_ONLY_LIMIT;
  const indexMask = (rule: Rule): void => {
    const prefix = rule.form.slice(0, MASK_PREFIX);
    let node = maskIndex.get(prefix);
    if (node === undefined) { node = { at: MASK_PREFIX, list: [] }; maskIndex.set(prefix, node); }
    maskInsert(node, rule);
    maskFirst.add(rule.form.charCodeAt(0));
  };
  return Object.freeze({
    text(value: string): string {
      let result = value;
      for (const rule of ordered()) result = result.split(rule.form).join(rule.label);
      return result;
    },
    maskEvidenceOnly(value: string): string {
      if (maskIndex.size === 0) return value;
      const parts: string[] = [];
      let last = 0;
      let at = 0;
      const end = value.length - MASK_PREFIX;
      while (at <= end) {
        if (maskFirst.has(value.charCodeAt(at))) {
          const bucket = maskIndex.get(value.slice(at, at + MASK_PREFIX));
          const hit = bucket === undefined ? undefined : maskFind(bucket, value, at);
          if (hit !== undefined) { parts.push(value.slice(last, at), hit.label); at += hit.form.length; last = at; continue; }
        }
        at += 1;
      }
      if (last === 0) return value;
      parts.push(value.slice(last));
      return parts.join("");
    },
    contains(bytes: Uint8Array, scope: "accounts" | "all" | "model" = "all"): boolean {
      const haystack = Buffer.from(bytes);
      const active = ordered().filter((rule) => rule.bytes && (scope === "all" ? true : scope === "model" ? rule.model : !rule.session));
      if (active.some((rule) => haystack.includes(rule.form))) return true;
      // Base64 is often wrapped into lines (MIME, PEM-style bodies, a 20, 64 or 76 column wrap), which cuts a credential's spelling in two. The same bytes with the
      // whitespace between two base64 characters removed are looked at too.
      const unwrapped = unwrapBase64Lines(haystack);
      return unwrapped !== null && active.some((rule) => unwrapped.includes(rule.form));
    },
    addSessionSecret(value: string, options: { evidenceOnly?: boolean; scrubOnly?: boolean } = {}): void {
      if (typeof value !== "string" || value.length < MIN_SESSION_SECRET_LENGTH) return;
      const model = options.evidenceOnly !== true;
      const mask = !model && options.scrubOnly !== true;
      for (const form of spellings(value)) {
        let existing = byForm.get(form);
        if (existing === undefined) {
          // A value held for the mask only becomes a full rule: it is the same object, so the index keeps pointing at it.
          const held = maskOnly.get(form);
          if (held !== undefined) {
            maskOnly.delete(form);
            held.model = model;
            held.mask = held.mask || mask;
            rules.push(held);
            byForm.set(form, held);
            sorted = false;
            continue;
          }
          existing = { form, label: SESSION_REDACTION_LABEL, bytes: true, session: true, model, mask };
          rules.push(existing);
          byForm.set(form, existing);
          sorted = false;
          if (mask) indexMask(existing);
          continue;
        }
        // A value first registered evidence-only becomes a credential if it is registered as one later (the other way round it stays one), and a scrub-only value becomes maskable if it is
        // registered as a weak one later (the other way round it stays maskable).
        if (model) existing.model = true;
        else if (mask && !existing.mask) { existing.mask = true; indexMask(existing); }
      }
    },
    addMaskOnly(value: string): boolean {
      if (typeof value !== "string" || value.length < MIN_SESSION_SECRET_LENGTH) return true;
      if (!maskOnlyValues.has(value)) {
        if (maskOnlyValues.size >= maskOnlyLimit) return false;
        maskOnlyValues.add(value);
      }
      for (const form of spellings(value)) {
        const existing = byForm.get(form);
        if (existing !== undefined) { if (!existing.mask) { existing.mask = true; indexMask(existing); } continue; }
        if (maskOnly.has(form)) continue;
        const rule: Rule = { form, label: SESSION_REDACTION_LABEL, bytes: true, session: true, model: false, mask: true };
        maskOnly.set(form, rule);
        indexMask(rule);
      }
      return true;
    },
  });
}
