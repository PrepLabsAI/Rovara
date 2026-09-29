const REDACTED = "[REDACTED]";

// Every pattern here must run in linear time on any input: a start boundary (a lookbehind) keeps
// the engine from retrying inside a run, every repetition has an upper bound, and scanners that
// consume a value move past it. Never put two optional whitespace groups side by side.

/** Case-insensitive letters without the i flag. */
function ci(term: string): string {
  return term.replace(/[a-z]/g, (letter) => `[${letter}${letter.toUpperCase()}]`);
}

// ---------------------------------------------------------------------------------------------
// Credential key names
// ---------------------------------------------------------------------------------------------

// A key is split into words at separators and camelCase humps (DB_PASSWORD_PROD -> db password
// prod, passwordConfirm -> password confirm, APIKey -> api key). It names a credential when a
// word is a credential term and no later word marks it as metadata (tokenCount, passwordPolicy,
// accessTokenExpiry, SharedAccessKeyName). Look-alikes such as author, authority, tokenizer,
// secretary and max_tokens never contain a whole term word.
const TERM_WORDS = new Set([
  "password", "passwords", "passwd", "passphrase", "pass", "pwd", "secret", "secrets", "token", "credential", "credentials",
  "cookie", "cookies", "authorization", "auth", "bearer", "apikey", "accesskey", "privatekey", "secretkey", "accountkey",
  "sharedaccesskey", "sessionid", "sessiontoken", "sessionkey",
]);
// A word that ends with one of these (PGPASSWORD, csrftoken, xapikey) is a term too.
const GLUED_SUFFIX = /(?:password|passwd|passphrase|token|secret|apikey|accesskey|accountkey)$/;
// "<word> key" pairs (api key, access key, AccountKey, SharedAccessKey).
const KEY_PAIR_WORDS = new Set(["api", "access", "private", "secret", "account", "signing", "encryption", "master", "client"]);
// "session <word>" pairs.
const SESSION_PAIR_WORDS = new Set(["id", "key", "token", "cookie"]);
// Words after a term that make the key metadata rather than a credential.
const METADATA_WORDS = new Set([
  "count", "counts", "usage", "expiry", "expires", "expiration", "expire", "expired", "exp", "type", "types", "name", "names",
  "id", "ids", "length", "len", "url", "urls", "uri", "path", "file", "dir", "hint", "policy", "policies", "reset", "consent",
  "limit", "limits", "budget", "max", "min", "size", "enabled", "disabled", "required", "changed", "updated", "created", "at",
  "ttl", "rotation", "version", "field", "label", "format", "strength", "stdin", "prompt", "lifetime", "duration", "endpoint",
  "mode", "method", "scope", "scopes", "kind", "prefix", "index", "rule", "rules", "validation", "timeout", "age",
]);

function keyWords(key: string): string[] {
  return key
    .split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)
    .map((word) => word.toLowerCase().replace(/\d+$/, ""))
    .filter((word) => word.length > 0);
}

/** Whether a key (an object key, a KEY=value name, a --flag or an XML tag) names a credential. */
export function isCredentialKey(key: string): boolean {
  const words = keyWords(key.length > 256 ? key.slice(-256) : key);
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i] ?? "";
    const next = words[i + 1] ?? "";
    let last = -1;
    if (TERM_WORDS.has(word) || GLUED_SUFFIX.test(word)) last = i;
    else if ((next === "key" || next === "keys") && KEY_PAIR_WORDS.has(word)) last = i + 1;
    else if (word === "session" && SESSION_PAIR_WORDS.has(next)) last = i + 1;
    if (last >= 0 && !words.slice(last + 1).some((later) => METADATA_WORDS.has(later))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** Replace matches where `decide` returns a replacement and the index to resume from. A scanner
 * may consume past the regex match (a value to the end of the line, an indented block). */
function scan(text: string, pattern: RegExp, decide: (match: RegExpExecArray) => { end: number; replacement: string } | null): string {
  let out = "";
  let from = 0;
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const result = decide(match);
    if (result) {
      out += text.slice(from, match.index) + result.replacement;
      from = result.end;
      pattern.lastIndex = Math.max(result.end, match.index + 1);
    } else if (match[0].length === 0) {
      pattern.lastIndex += 1;
    }
  }
  return out + text.slice(from);
}

function lineEnd(text: string, from: number): number {
  const newline = text.indexOf("\n", from);
  const end = newline < 0 ? text.length : newline;
  return end > from && text[end - 1] === "\r" ? end - 1 : end;
}

function lineIndent(text: string, lineStart: number): number {
  let i = lineStart;
  while (text[i] === " " || text[i] === "\t") i += 1;
  return i - lineStart;
}

/** The end of the run of following lines indented deeper than `indent` (a YAML value or block). */
function indentedBlockEnd(text: string, from: number, indent: number): number {
  let end = from;
  let cursor = from;
  while (cursor < text.length && text[cursor] === "\n") {
    const start = cursor + 1;
    const stop = lineEnd(text, start);
    const depth = lineIndent(text, start);
    if (start + depth >= stop || depth <= indent) break;
    end = stop;
    cursor = text[stop] === "\r" ? stop + 1 : stop;
  }
  return end;
}

/** Whether a base64 string decodes to printable "user:password" text (HTTP Basic credentials). */
function isBasicPair(value: string): boolean {
  if (value.length < 8 || value.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  return /^[\x20-\x7e]{1,256}:[\x20-\x7e]{1,256}$/.test(Buffer.from(value, "base64").toString("latin1"));
}

// ---------------------------------------------------------------------------------------------
// Fixed shapes
// ---------------------------------------------------------------------------------------------

// Vendor-prefixed tokens mostly have no left boundary: a prefix glued to another word or an
// underscore (x_ghp_..., tokenghp_...) must still be caught.
const TOKEN_CHARS = "[A-Za-z0-9._~+/=-]";
const TEXT_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,4096}\.eyJ[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096}/g, REDACTED],
  [/(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, REDACTED],
  [/glpat-[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/xox[abeprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/xapp-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/lin_(?:api|oauth)_[A-Za-z0-9]{20,}/g, REDACTED],
  [/ATATT[A-Za-z0-9_=-]{20,}/g, REDACTED],
  [/(?:AKIA|ASIA)[0-9A-Z]{16}/g, REDACTED],
  // AWS session tokens start with a fixed base64 prefix.
  [/(?:FwoGZXIvYXdz|IQoJb3JpZ2lu)[A-Za-z0-9+/=]{16,}/g, REDACTED],
  [/AIza[0-9A-Za-z_-]{30,}/g, REDACTED],
  [/(?<![A-Za-z0-9])[sr]k_(?:live|test)_[A-Za-z0-9]{10,}/g, REDACTED],
  [/(?<![A-Za-z0-9])npm_[A-Za-z0-9]{30,}/g, REDACTED],
  [/(?<![A-Za-z0-9])hf_[A-Za-z0-9]{30,}/g, REDACTED],
  // AgentX's own refresh token (agxr_) and authorization code (agxc_), 43 base64url characters
  // (packages/broker/src/developer/tokens.ts); the minimum length keeps "agxr_" alone in prose
  // (no token after it) from being overmatched.
  [/(?<![A-Za-z0-9])agx[rc]_[A-Za-z0-9_-]{30,}/g, REDACTED],
  [/(?<![A-Za-z0-9])SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/(?<![A-Za-z0-9])SK[0-9a-f]{32}(?![A-Za-z0-9])/g, REDACTED],
  // A Twilio-style auth token: 32 hex characters after the word "auth" or "auth token".
  [/(?<![A-Za-z0-9])([Aa]uth(?:[ _-]?[Tt]oken)?[ \t]{1,8})[0-9a-f]{32}(?![A-Za-z0-9])/g, `$1${REDACTED}`],
  // An sk- key needs a run of 16 letters or digits, so "sk-learn-is-not-a-thing" is kept.
  [/(?<![A-Za-z0-9])sk-(?=[A-Za-z0-9_-]{0,64}?[A-Za-z0-9]{16})[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/https?:\/\/hooks\.slack\.com\/services\/\S+/gi, REDACTED],
  // Bare "bearer"/"basic" prose needs a digit or one of =+/ (8+ characters), or a lower-to-upper
  // case change (16+ characters), so "a basic understanding" and "bearer instrumentalities" are kept.
  [
    new RegExp(
      String.raw`(?<![A-Za-z0-9])(${ci("bearer")}|${ci("basic")})[ \t]{1,8}(?:(?=${TOKEN_CHARS}{0,4095}[0-9=+/])${TOKEN_CHARS}{8,4096}|(?=${TOKEN_CHARS}{0,4095}?[a-z][A-Z])${TOKEN_CHARS}{16,4096})`,
      "g",
    ),
    `$1 ${REDACTED}`,
  ],
  // curl -u user:password
  [/((?<!\S)(?:-u|--user)(?:[ \t]{1,8}|=)['"]?[^\s:'"]{1,256}:)[^\s'"]{1,512}/g, `$1${REDACTED}`],
  // Query and fragment parameters matched by precise name, so keyword, monkey and zip_code are kept.
  [
    /([?&#;](?:(?:[A-Za-z0-9]{1,32}[_-]){0,4}(?:token|secret|password|passwd|pwd|signature|credential|apikey|(?:api|access|private|secret|subscription)[_-]?key)|code|key|sig|pass|auth)=)[^&#\s]{1,4096}/gi,
    `$1${REDACTED}`,
  ],
];

// "Basic <base64 of user:password>" anywhere, even when it is all letters.
const BASIC_PAIR = new RegExp(String.raw`(?<![A-Za-z0-9])(${ci("basic")}[ \t]{1,8})([A-Za-z0-9+/]{4,4096}={0,2})(?![A-Za-z0-9+/=])`, "g");

// ---------------------------------------------------------------------------------------------
// Private keys
// ---------------------------------------------------------------------------------------------

const PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g;
const PRIVATE_KEY_END = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g;
const BLANK_LINE = /\r?\n[ \t]*\r?\n/g;
const PEM_HEADER_LINE = /\r?\n(?:Proc-Type|DEK-Info|Comment|Version|Hash):[^\n]{0,512}/y;

/** Private key blocks, BEGIN to END; a key with no END line (a cut-off paste) is redacted to the
 * next blank line after any PEM header lines, or to the end. A forward scan, so a run of BEGIN
 * lines stays linear. */
function redactPrivateKeys(text: string): string {
  let noEndAfter = Number.POSITIVE_INFINITY;
  return scan(text, PRIVATE_KEY_BEGIN, (begin) => {
    const bodyStart = begin.index + begin[0].length;
    if (begin.index < noEndAfter) {
      PRIVATE_KEY_END.lastIndex = bodyStart;
      const end = PRIVATE_KEY_END.exec(text);
      if (end) return { end: end.index + end[0].length, replacement: REDACTED };
      noEndAfter = begin.index;
    }
    let from = bodyStart;
    PEM_HEADER_LINE.lastIndex = from;
    let header = PEM_HEADER_LINE.exec(text);
    if (header) {
      while (header) {
        from = header.index + header[0].length;
        PEM_HEADER_LINE.lastIndex = from;
        header = PEM_HEADER_LINE.exec(text);
      }
      from = lineEnd(text, from + 1) + 1;
    }
    BLANK_LINE.lastIndex = Math.min(from, text.length);
    const blank = BLANK_LINE.exec(text);
    return { end: blank ? blank.index : text.length, replacement: REDACTED };
  });
}

// ---------------------------------------------------------------------------------------------
// URL user-info
// ---------------------------------------------------------------------------------------------

const URL_USER_PASSWORD = /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/)[^\s@/:]{0,128}:(?!\d{1,5}(?:[/?#\s]|$))/g;
const URL_USER_ONLY = /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/)([A-Za-z0-9+/=]{8,512})@/g;
const BARE_USER_PASSWORD = /(?<![\w.:/@%+-])(?!mailto:)([A-Za-z0-9._-]{1,64}):([^\s@:/]{1,256})@(?=[A-Za-z0-9-]{1,63}\.[A-Za-z0-9.-]{1,253})/g;

/** Any scheme's user-info (postgres://, redis://, https://, ...), an empty user included, up to
 * the last @ before the host: the password may hold /, @, ?, # or up to two spaces. An @ after the
 * host's first / (an e-mail address in the query) does not count. A port (host:8080/...) is not a
 * password. */
function redactUrlUserInfo(text: string): string {
  let atCache = -2;
  const nextAt = (from: number) => {
    if (atCache === -1 || atCache >= from) return atCache;
    atCache = text.indexOf("@", from);
    return atCache;
  };
  const withPassword = scan(text, URL_USER_PASSWORD, (match) => {
    const start = match.index + match[0].length;
    const firstAt = nextAt(start);
    if (firstAt < 0 || firstAt - start > 256) return null;
    const password = text.slice(start, firstAt);
    if (/[\r\n]/.test(password) || (password.match(/ /g)?.length ?? 0) > 2) return null;
    let stop = firstAt + 1;
    while (stop < text.length && stop - firstAt <= 256 && !/[\s/]/.test(text[stop] ?? "")) stop += 1;
    const lastAt = text.lastIndexOf("@", stop - 1);
    if (!/[A-Za-z0-9[]/.test(text[lastAt + 1] ?? "")) return null;
    return { end: lastAt, replacement: `${match[1]}${REDACTED}` };
  });
  return withPassword
    .replace(URL_USER_ONLY, (whole: string, scheme: string, user: string) => (isBasicPair(user) ? `${scheme}${REDACTED}@` : whole))
    .replace(BARE_USER_PASSWORD, `$1:${REDACTED}@`);
}

// ---------------------------------------------------------------------------------------------
// Key/value pairs
// ---------------------------------------------------------------------------------------------

// A key, an optional closing quote (escaped, backtick or a trailing space inside the quotes),
// then one of : = => := or | (the last only in a Markdown table row).
const KEY_VALUE = /(?<![A-Za-z0-9_.$-])([A-Za-z_$][A-Za-z0-9_.$-]{0,255})[ \t]{0,64}(?:\\{0,8}["'`][ \t]{0,64})?(=>|:=|[:=|])/g;
const AUTH_SCHEME = /^(?:bearer|basic|token|digest|negotiate)[ \t]{1,8}(?=\S)/i;

function redactKeyValues(text: string): string {
  // Newline lookups are cached and move forward only, so a line with many candidates is still
  // scanned once.
  let nextNewline = -2;
  const lineStop = (from: number) => {
    if (nextNewline !== -1 && nextNewline < from) nextNewline = text.indexOf("\n", from);
    const end = nextNewline < 0 ? text.length : nextNewline;
    return end > from && text[end - 1] === "\r" ? end - 1 : end;
  };
  let knownLineStart = 0;
  let knownPosition = 0;
  const lineStartOf = (position: number) => {
    for (; knownPosition < position; knownPosition += 1) if (text[knownPosition] === "\n") knownLineStart = knownPosition + 1;
    return knownLineStart;
  };
  return scan(text, KEY_VALUE, (match) => {
    const key = match[1] ?? "";
    const separator = match[2] ?? "";
    if (!isCredentialKey(key)) return null;
    const keyStart = match.index;
    const before = text[keyStart - 1] ?? "";
    let lineStart = lineStartOf(keyStart);
    if (separator === "|" && !/\|[ \t]*$/.test(text.slice(Math.max(lineStart, keyStart - 64), keyStart))) return null;
    if (separator === ":" && text.startsWith("//", match.index + match[0].length)) return null;
    const prefixEnd = match.index + match[0].length;
    let cursor = prefixEnd;
    while ((text[cursor] === " " || text[cursor] === "\t") && cursor - prefixEnd < 64) cursor += 1;
    const head = text.slice(match.index, cursor);
    const stopLine = lineStop(cursor);
    const indent = lineIndent(text, lineStart);

    // Value on the following indented lines (YAML), or a YAML block scalar: | or >.
    const blockIndicator = /^[|>][+-]?\d?[ \t]*$/.test(text.slice(cursor, stopLine));
    if (cursor === stopLine || blockIndicator) {
      const blockEnd = indentedBlockEnd(text, stopLine, indent);
      if (blockEnd === stopLine) return null;
      lineStart = text.indexOf("\n", stopLine) + 1;
      const pad = text.slice(lineStart, lineStart + lineIndent(text, lineStart));
      return { end: blockEnd, replacement: `${head}${text.slice(cursor, stopLine)}\n${pad}${REDACTED}` };
    }

    // Quoted values: double, single or backtick, with escapes; to the end of the line when the
    // closing quote is missing. A value opened by an escaped quote (JSON inside a JSON string)
    // ends at the next quote, minus its escaping backslashes.
    const escaped = /^\\+"/.exec(text.slice(cursor, cursor + 16));
    if (escaped) {
      const open = escaped[0];
      let end = cursor + open.length;
      while (end < stopLine && text[end] !== '"') end += 1;
      while (end > cursor + open.length && text[end - 1] === "\\") end -= 1;
      return { end, replacement: `${head}${open}${REDACTED}` };
    }
    const quote = text[cursor] ?? "";
    if (quote === '"' || quote === "'" || quote === "`") {
      let i = cursor + 1;
      while (i < stopLine && text[i] !== quote) i += text[i] === "\\" ? 2 : 1;
      return i < stopLine ? { end: i + 1, replacement: `${head}${quote}${REDACTED}${quote}` } : { end: stopLine, replacement: `${head}${quote}${REDACTED}` };
    }

    // Bare values. In a URL or a connection string the value ends at & ; # or a space; in JSON at
    // , } or ]; in a table at |; otherwise at the end of the line, so a tail after a comma or a
    // space cannot leak.
    let stops: RegExp | null = null;
    if (/[?&#;]/.test(before)) stops = /[&;#\s]/;
    else if (separator === "|") stops = /\|/;
    else if (before === '"' || text[match.index + key.length] === '"') stops = /[,}\]\s]/;
    let end = cursor;
    while (end < stopLine && !(stops?.test(text[end] ?? "") ?? false)) end += 1;
    if (end === cursor) return null;
    const value = text.slice(cursor, end);
    const scheme = AUTH_SCHEME.exec(value)?.[0] ?? "";
    const trailing = stops === null ? (/[ \t]*$/.exec(value)?.[0] ?? "") : "";
    return { end, replacement: `${head}${scheme}${REDACTED}${trailing}` };
  });
}

// ---------------------------------------------------------------------------------------------
// XML and command lines
// ---------------------------------------------------------------------------------------------

const XML_ELEMENT = /<([A-Za-z_][\w.:-]{0,64})(?:\s[^<>]{0,512})?>([^<]{1,8192})<\/\1[ \t]*>/g;
const XML_TAG = /<[A-Za-z_][\w.:-]{0,64}\s[^<>]{0,1024}>/g;
const XML_ATTRIBUTE = /([A-Za-z_][\w.:-]{0,64})[ \t]{0,8}=[ \t]{0,8}(["'])([^"'<>]{0,4096})\2/g;

function redactXml(text: string): string {
  const elements = text.replace(XML_ELEMENT, (whole: string, tag: string, inner: string) =>
    isCredentialKey(tag) && inner.trim() ? whole.replace(`>${inner}<`, `>${REDACTED}<`) : whole,
  );
  // <add key="ApiKey" value="..."/>: a value attribute after a credential-named key or name.
  return elements.replace(XML_TAG, (tag: string) => {
    const attributes = [...tag.matchAll(XML_ATTRIBUTE)];
    const named = attributes.some((attribute) => /^(?:key|name)$/i.test(attribute[1] ?? "") && isCredentialKey(attribute[3] ?? ""));
    if (!named) return tag;
    return tag.replace(XML_ATTRIBUTE, (whole: string, name: string, quote: string) => (/^value$/i.test(name) ? `${name}=${quote}${REDACTED}${quote}` : whole));
  });
}

// --password value, --token=value, --api-key value: any long flag whose name is credential-named.
const LONG_FLAG = /(?<!\S)(--?[A-Za-z][A-Za-z0-9_-]{0,64})(=|[ \t]{1,8})(?!-)(?:"[^"\r\n]{0,4096}"|'[^'\r\n]{0,4096}'|\S{1,4096})/g;
// Short password flags only after a client that uses them: mysql -pSECRET, docker login -p SECRET,
// redis-cli -a SECRET, sqlcmd -P SECRET. psql and docker run use -p for a port.
const SHORT_FLAG_CLIENT =
  /(?<![\w/.-])(?:(mysql|mysqldump|mysqladmin|mariadb|mongo|mongosh|mongodump|mongorestore|sshpass)|(?:docker|podman|nerdctl|oras|helm registry)[ \t]{1,8}login|(redis-cli)|(sqlcmd|bcp))(?![\w-])[^\r\n]{0,2048}/g;

function redactFlags(text: string): string {
  const long = text.replace(LONG_FLAG, (whole: string, flag: string, separator: string) => {
    if (flag.length < 3 || !isCredentialKey(flag.replace(/^-+/, ""))) return whole;
    return `${flag}${separator}${REDACTED}`;
  });
  return long.replace(SHORT_FLAG_CLIENT, (line: string, _mysql: string | undefined, redis: string | undefined, sqlcmd: string | undefined) => {
    const flag = redis ? "a" : sqlcmd ? "P" : "p";
    return line.replace(new RegExp(String.raw`(?<!\S)(-${flag})(?:([ \t]{1,8})(?!-)\S{1,512}|(?=[^\s-])\S{1,512})`, "g"), (_whole, name: string, space: string | undefined) =>
      `${name}${space ?? ""}${REDACTED}`,
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

export function redactText(text: string): string {
  let current = redactPrivateKeys(text);
  for (const [pattern, replacement] of TEXT_PATTERNS) current = current.replace(pattern, replacement);
  current = current.replace(BASIC_PAIR, (whole: string, prefix: string, value: string) => (isBasicPair(value) ? `${prefix}${REDACTED}` : whole));
  current = redactUrlUserInfo(current);
  current = redactXml(current);
  current = redactFlags(current);
  return redactKeyValues(current);
}

const SHORT_PASSWORD_FLAG_CLIENT = /^(?:.*\/)?(?:mysql|mysqldump|mysqladmin|mariadb|mongo|mongosh|mongodump|mongorestore|sshpass|login)$/;

function isCredentialFlag(value: unknown, shortPasswordFlag: boolean): boolean {
  if (typeof value !== "string") return false;
  const flag = /^--?([A-Za-z][\w-]{0,64})$/.exec(value)?.[1];
  if (!flag) return false;
  if (flag === "p") return shortPasswordFlag;
  return flag.length > 1 && isCredentialKey(flag);
}

function redactArray(items: readonly unknown[]): unknown[] {
  // A ["Authorization", "Bearer ..."] header tuple.
  if (items.length === 2 && typeof items[0] === "string" && isCredentialKey(items[0]) && items[1] != null) return [items[0], REDACTED];
  // An argv array: ["--password", "x"] or ["mysql", "-p", "x"] (-p only after a client that uses it).
  const shortPasswordFlag = items.some((item) => typeof item === "string" && SHORT_PASSWORD_FLAG_CLIENT.test(item));
  return items.map((item, index) => (index > 0 && isCredentialFlag(items[index - 1], shortPasswordFlag) && item != null ? REDACTED : redactSecrets(item)));
}

/** A copy with every value under a credential-named key (string, number, array or object)
 * replaced, name/value pairs ({name: "DB_PASSWORD", value}) and argv flags handled, and
 * credential-shaped strings elsewhere, keys included, redacted; never mutates. */
export function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return redactArray(value);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const pairName = [record.name, record.key, record.Name, record.Key].find((name) => typeof name === "string");
    const pairSecret = typeof pairName === "string" && isCredentialKey(pairName);
    return Object.fromEntries(
      Object.entries(record).map(([key, child]) => {
        const secret = isCredentialKey(key) || (pairSecret && /^value$/i.test(key));
        return [redactText(key), secret && child !== null && child !== undefined ? REDACTED : redactSecrets(child)];
      }),
    );
  }
  return value;
}
