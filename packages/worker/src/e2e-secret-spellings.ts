/**
 * Every spelling of a secret that a prompt, a JSON encoder, a URL builder or an encoded field could carry it in, for the e2e model proxy's credential scan: raw, JSON-escaped, percent-encoded
 * (single, double, and lower-case hex digits), base64 and base64url (padded and not, and the pieces that stay the same wherever the value sits inside longer base64 text), and hex (both cases).
 * The caller has already refused a value too short to scan for safely, so every form here is long enough to be specific.
 */

/** Pieces of the base64 text of `value` that stay the same wherever it sits in a longer encoded string (base64 groups three bytes into four characters, so each alignment is spelled differently). */
function base64Fragments(value: string): string[] {
  const data = Buffer.from(value, "utf8");
  const forms: string[] = [];
  for (let shift = 0; shift < 3; shift += 1) {
    const encoded = Buffer.concat([Buffer.alloc(shift), data]).toString("base64").replace(/=+$/, "");
    const head = Math.ceil((shift * 8) / 6);
    const tail = (shift + data.byteLength) % 3 === 0 ? 0 : 1;
    const core = encoded.slice(head, encoded.length - tail);
    if (core.length >= 6) forms.push(core, core.replace(/\+/g, "-").replace(/\//g, "_"));
  }
  return forms;
}

export interface E2ESecretSpellingsResult {
  forms: string[];
  /** The spellings that could not be built for this value (the percent-encoded ones, for a value with a lone surrogate). The raw, JSON-escaped, base64 and hex forms are always built. */
  skipped: Array<"percent-encoded">;
}

/**
 * Never throws. A value that cannot be percent-encoded (`encodeURIComponent` throws on a lone surrogate) still gets every other spelling, and the result says which spelling was skipped
 * so the caller can record the gap. The raw form is always among the forms, so the value itself is always scanned for.
 */
export function e2eSecretSpellingsDetailed(value: string): E2ESecretSpellingsResult {
  if (value === "") return { forms: [], skipped: [] };
  const data = Buffer.from(value, "utf8");
  const standard = data.toString("base64");
  const url = standard.replace(/\+/g, "-").replace(/\//g, "_");
  let once: string | null = null;
  try { once = encodeURIComponent(value); } catch { once = null; }
  const twice = once === null ? null : encodeURIComponent(once);
  const lowerEscapes = (text: string) => text.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase());
  const forms = new Set<string>([
    value, JSON.stringify(value).slice(1, -1),
    ...(once === null || twice === null ? [] : [once, twice, lowerEscapes(once), lowerEscapes(twice)]),
    standard, standard.replace(/=+$/, ""), url, url.replace(/=+$/, ""),
    data.toString("hex"), data.toString("hex").toUpperCase(),
    ...base64Fragments(value),
  ]);
  return { forms: [...forms].filter((form) => form.length > 0), skipped: once === null ? ["percent-encoded"] : [] };
}

export function e2eSecretSpellings(value: string): string[] {
  return e2eSecretSpellingsDetailed(value).forms;
}
