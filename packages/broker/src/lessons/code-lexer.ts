// The lexer behind `CodeFacts.identifiers`. A tier-0 lesson may only use words that really occur in the cited CODE, so a word that sits in a comment, a
// docstring, a string or a template (where a person or a model could have planted it) must never count. This lexer reads the WHOLE file from line 1, so the state at the cited
// lines is right (a block comment or a string that opened earlier), and returns the identifier tokens that START inside the cited range and are in code.
//
// Fail closed, on both sides:
//  - an unknown extension, a range over 80 lines, a file over 1 MB, a run over 3 seconds, anything still open at the end of the file (a block comment, a template, a triple quote, a
//    heredoc) or any error gives `undefined`: nothing is verified;
//  - when the lexer is unsure it takes the safe side: text it cannot place is dropped, never added (a nested template or interpolation is dropped with its string; a plain string
//    ends at the end of its line in the languages where that is the rule, so a stray quote cannot swallow or flip the rest of the file).
// Pure: text in, tokens out. No I/O.

export const LEX_MAX_RANGE_LINES = 80;
export const LEX_MAX_BYTES = 1_048_576;
export const LEX_BUDGET_MS = 3_000;

class LexFailure extends Error {}
const fail = (why: string): never => { throw new LexFailure(why); };

interface StrCfg { open: string; close: string; escape: boolean; multiline: boolean; /** The close doubled stands for itself (SQL). */ doubled?: boolean; interp?: { open: string; close: string } }
interface BlockCfg { open: string; close: string; nest: boolean }
interface Cfg {
  line: string[]; block: BlockCfg[]; strings: StrCfg[];
  /** `/` may open a regular expression literal (JavaScript and TypeScript). */
  regex?: boolean;
  /** An identifier of this shape right before a quote is a string prefix, not a word (Python `f`, `rb`; Rust `b`). */
  prefix?: RegExp;
  /** `$` is an identifier character. */
  dollar?: boolean;
  rustRaw?: boolean; lua?: boolean; cppRaw?: boolean; rustChars?: boolean;
  /** A line comment ends with its line unless the line ends in a backslash (C and C++). */
  continuation?: boolean;
  /** Unicode escapes are processed everywhere in the source (Java): a file that has one is not lexed. */
  unicodeEscapes?: boolean;
  /** JavaScript: a `<` where an expression starts is JSX (not lexed), and the HTML-style comments `<!--` / `-->` are not lexed. */
  jsx?: boolean;
  /** `$tag$ ... $tag$` quoting (PostgreSQL) is not lexed. */
  noDollarQuotes?: boolean;
}

const slashes = (nest: boolean): BlockCfg[] => [{ open: "/*", close: "*/", nest }];
const JS: Cfg = {
  line: ["//"], block: slashes(false), regex: true, dollar: true,
  strings: [
    { open: "`", close: "`", escape: true, multiline: true, interp: { open: "${", close: "}" } },
    { open: '"', close: '"', escape: true, multiline: false }, { open: "'", close: "'", escape: true, multiline: false },
  ],
};
// JSX and the HTML-style comments are not lexed: TypeScript (.ts) has no JSX, so its `<` is a generic or a comparison; .js/.mjs/.cjs may hold JSX, so an element where an expression starts fails.
const JS_PLAIN: Cfg = { ...JS, jsx: true };
const JAVA: Cfg = {
  line: ["//"], block: slashes(false), unicodeEscapes: true,
  strings: [{ open: '"""', close: '"""', escape: true, multiline: true }, { open: '"', close: '"', escape: true, multiline: false }, { open: "'", close: "'", escape: true, multiline: false }],
};
const C: Cfg = {
  line: ["//"], block: slashes(false), cppRaw: true, continuation: true,
  strings: [{ open: '"', close: '"', escape: true, multiline: false }, { open: "'", close: "'", escape: true, multiline: false }],
};
const GO: Cfg = {
  line: ["//"], block: slashes(false),
  strings: [{ open: "`", close: "`", escape: false, multiline: true }, { open: '"', close: '"', escape: true, multiline: false }, { open: "'", close: "'", escape: true, multiline: false }],
};
const RUST: Cfg = {
  line: ["//"], block: slashes(true), rustRaw: true, rustChars: true, prefix: /^b$/u,
  strings: [{ open: '"', close: '"', escape: true, multiline: true }],
};
const PYTHON: Cfg = {
  line: ["#"], block: [], prefix: /^(?:[rRbBuUfF]|[rR][bBfF]|[bBfF][rR])$/u,
  strings: [
    { open: '"""', close: '"""', escape: true, multiline: true }, { open: "'''", close: "'''", escape: true, multiline: true },
    { open: '"', close: '"', escape: true, multiline: false }, { open: "'", close: "'", escape: true, multiline: false },
  ],
};
const TOML: Cfg = {
  line: ["#"], block: [],
  strings: [
    { open: '"""', close: '"""', escape: true, multiline: true }, { open: "'''", close: "'''", escape: false, multiline: true },
    { open: '"', close: '"', escape: true, multiline: false }, { open: "'", close: "'", escape: false, multiline: false },
  ],
};
const LUA: Cfg = { line: ["--"], block: [], lua: true, strings: [{ open: '"', close: '"', escape: true, multiline: false }, { open: "'", close: "'", escape: true, multiline: false }] };
// `#` starts a comment in MySQL; in PostgreSQL it is an operator, and dropping what follows only loses tokens. Block comments nest (PostgreSQL).
const SQL: Cfg = {
  line: ["--", "#"], block: slashes(true), noDollarQuotes: true,
  strings: [{ open: "'", close: "'", escape: false, multiline: true, doubled: true }, { open: '"', close: '"', escape: false, multiline: true, doubled: true }, { open: "`", close: "`", escape: false, multiline: true, doubled: true }],
};

type Kind = { kind: "cfg"; cfg: Cfg } | { kind: "markup" };
const BY_EXTENSION: Record<string, Kind> = {};
const register = (extensions: string[], kind: Kind): void => { for (const e of extensions) BY_EXTENSION[e] = kind; };
// .tsx and .jsx are not lexed at all: JSX text is prose between tags.
register(["ts", "mts", "cts"], { kind: "cfg", cfg: JS });
register(["js", "mjs", "cjs"], { kind: "cfg", cfg: JS_PLAIN });
register(["java"], { kind: "cfg", cfg: JAVA });
register(["c", "h", "cc", "cpp", "cxx", "hpp", "hh"], { kind: "cfg", cfg: C });
register(["go"], { kind: "cfg", cfg: GO });
register(["rs"], { kind: "cfg", cfg: RUST });
register(["py", "pyi"], { kind: "cfg", cfg: PYTHON });
register(["toml"], { kind: "cfg", cfg: TOML });
register(["lua"], { kind: "cfg", cfg: LUA });
register(["sql"], { kind: "cfg", cfg: SQL });
register(["html", "htm", "xml", "svg", "xhtml"], { kind: "markup" });
// Shell is not lexed at all: a bare word is code there, so any text in a script would count as an identifier. It is not verified (the lesson stays with a person).

const extensionOf = (path: string): string | undefined => {
  const name = path.split("/").at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? undefined : name.slice(dot + 1).toLowerCase();
};

const isIdStart = (ch: string, dollar: boolean): boolean => (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_" || ch > "\u007f" || (dollar && ch === "$");
const isIdPart = (ch: string, dollar: boolean): boolean => isIdStart(ch, dollar) || (ch >= "0" && ch <= "9");
const isDigit = (ch: string): boolean => ch >= "0" && ch <= "9";
const isSpace = (ch: string | undefined): boolean => ch === " " || ch === "\t" || ch === "\n" || ch === "\f" || ch === "\v";
const JS_REGEX_AFTER_WORD = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);

/** The identifier tokens (with their start offsets) that are in code. The caller picks the range. */
type Token = { at: number; text: string };

class Scanner {
  i = 0;
  readonly tokens: Token[] = [];
  constructor(readonly s: string, readonly deadline: number, readonly clock: () => number) {}
  tick(): void { if ((this.i & 0x3ff) === 0 && this.clock() > this.deadline) fail("time budget"); }
  startsWith(text: string, at = this.i): boolean { return this.s.startsWith(text, at); }
}

/** Skips a string whose opener is at `sc.i`; leaves `sc.i` after its closer. */
function skipString(sc: Scanner, cfg: Cfg, str: StrCfg, prefix: string): void {
  const s = sc.s;
  sc.i += str.open.length;
  const interp = str.interp ?? (prefix.toLowerCase().includes("f") && cfg === PYTHON ? { open: "{", close: "}" } : undefined);
  for (;;) {
    sc.tick();
    if (sc.i >= s.length) fail("string not closed");
    const ch = s[sc.i]!;
    if (ch === "\n" && !str.multiline) {
      // A backslash right before the newline (handled below) continues the string; otherwise a plain string ends with its line.
      sc.i += 1;
      return;
    }
    if (str.escape && ch === "\\") { sc.i += 2; continue; }
    if (sc.startsWith(str.close)) {
      if (str.doubled === true && sc.startsWith(str.close + str.close)) { sc.i += str.close.length * 2; continue; }
      sc.i += str.close.length;
      return;
    }
    if (interp !== undefined && sc.startsWith(interp.open)) {
      // Python `{{` is a literal brace.
      if (cfg === PYTHON && sc.startsWith("{{")) { sc.i += 2; continue; }
      skipBalanced(sc, cfg, interp.open, interp.close);
      continue;
    }
    sc.i += 1;
  }
}

/** Skips `open ... close` (an interpolation) with nesting and the strings inside it; leaves `sc.i` after the closer. `close` is one character and the last character of `open` is the nesting one. */
function skipBalanced(sc: Scanner, cfg: Cfg, open: string, close: string): void {
  const s = sc.s;
  const nesting = open[open.length - 1]!;
  sc.i += open.length;
  let depth = 1;
  while (depth > 0) {
    sc.tick();
    if (sc.i >= s.length) fail("interpolation not closed");
    const nested = cfg.strings.find((x) => sc.startsWith(x.open));
    if (nested !== undefined) { skipString(sc, cfg, nested, ""); continue; }
    const ch = s[sc.i]!;
    if (ch === close) depth -= 1;
    else if (ch === nesting) depth += 1;
    sc.i += 1;
  }
}

function skipBlockComment(sc: Scanner, block: BlockCfg): void {
  let depth = 1;
  sc.i += block.open.length;
  while (depth > 0) {
    sc.tick();
    if (sc.i >= sc.s.length) fail("block comment not closed");
    if (block.nest && sc.startsWith(block.open)) { depth += 1; sc.i += block.open.length; continue; }
    if (sc.startsWith(block.close)) { depth -= 1; sc.i += block.close.length; continue; }
    sc.i += 1;
  }
}

function skipToLineEnd(sc: Scanner, continuation = false): void {
  while (sc.i < sc.s.length && sc.s[sc.i] !== "\n") {
    // A backslash right before the newline continues the comment on the next line.
    // (gcc and clang also take a backslash followed by blanks before the newline as a continuation.)
    if (continuation && sc.s[sc.i] === "\\") {
      let j = sc.i + 1;
      while (sc.s[j] === " " || sc.s[j] === "\t" || sc.s[j] === "\f" || sc.s[j] === "\v") j += 1;
      if (sc.s[j] === "\n") sc.i = j;
    }
    sc.i += 1;
  }
}

/** A regular expression literal at `sc.i` (which holds `/`): skipped with its flags, or left alone when this line is not one. */
function regexCouldClose(sc: Scanner): boolean {
  const saved = sc.i;
  const closes = trySkipRegex(sc);
  sc.i = saved;
  return closes;
}

function trySkipRegex(sc: Scanner): boolean {
  const s = sc.s;
  let j = sc.i + 1;
  let inClass = false;
  for (; j < s.length; j += 1) {
    const ch = s[j]!;
    if (ch === "\n") return false;
    if (ch === "\\") { j += 1; continue; }
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (ch === "/" && !inClass) break;
  }
  if (j >= s.length) return false;
  j += 1;
  while (j < s.length && /[a-z]/u.test(s[j]!)) j += 1;
  sc.i = j;
  return true;
}

function lexCfg(sc: Scanner, cfg: Cfg): void {
  const s = sc.s;
  const dollar = cfg.dollar === true;
  // For the JavaScript regex rule: whether a `/` here would be a division.
  let operand = false;
  let lastWasParen = false;
  // A hashbang line is not code.
  if (cfg.regex === true && s.startsWith("#!")) skipToLineEnd(sc);
  while (sc.i < s.length) {
    sc.tick();
    const ch = s[sc.i]!;
    if (isSpace(ch)) { sc.i += 1; continue; }
    const wasParen: boolean = lastWasParen;
    lastWasParen = false;
    if (cfg.noDollarQuotes === true && ch === "$" && /^\$[A-Za-z_\u0080-\uffff]*\$/u.test(s.slice(sc.i, sc.i + 80))) fail("dollar quoting");
    if (cfg.regex === true) {
      // JavaScript's HTML-style comments (`<!--` anywhere, `-->` first on a line) are not lexed.
      if (sc.startsWith("<!--")) fail("HTML-style comment");
      if (sc.startsWith("-->") && /^[ \t]*$/u.test(s.slice(s.lastIndexOf("\n", sc.i - 1) + 1, sc.i))) fail("HTML-style comment");
    }
    // A `<` where an expression starts is JSX.
    if (cfg.jsx === true && ch === "<" && !operand && !wasParen && /[A-Za-z_$>]/u.test(s[sc.i + 1] ?? "")) fail("JSX");
    // Comments.
    if (cfg.lua === true && sc.startsWith("--")) {
      const long = /^--\[(=*)\[/u.exec(s.slice(sc.i, sc.i + 40));
      if (long !== null) {
        const closer = `]${long[1]}]`;
        const end = s.indexOf(closer, sc.i + long[0].length);
        if (end === -1) fail("long comment not closed");
        sc.i = end + closer.length;
      } else skipToLineEnd(sc);
      lastWasParen = wasParen;
      continue;
    }
    const lineComment = cfg.line.find((x) => sc.startsWith(x));
    if (lineComment !== undefined) { skipToLineEnd(sc, cfg.continuation === true); lastWasParen = wasParen; continue; }
    const block = cfg.block.find((x) => sc.startsWith(x.open));
    if (block !== undefined) { skipBlockComment(sc, block); lastWasParen = wasParen; continue; }
    // Lua long strings.
    if (cfg.lua === true && ch === "[") {
      const long = /^\[(=*)\[/u.exec(s.slice(sc.i, sc.i + 40));
      if (long !== null) {
        const closer = `]${long[1]}]`;
        const end = s.indexOf(closer, sc.i + long[0].length);
        if (end === -1) fail("long string not closed");
        sc.i = end + closer.length;
        operand = true;
        continue;
      }
    }
    // Rust raw strings (r"..", r#".."#, br"..") and char literals (a lifetime is not one).
    if (cfg.rustRaw === true && (ch === "r" || ch === "b")) {
      const raw = /^b?r(#*)"/u.exec(s.slice(sc.i, sc.i + 40));
      if (raw !== null && (sc.i === 0 || !isIdPart(s[sc.i - 1]!, false))) {
        const closer = `"${raw[1]}`;
        const end = s.indexOf(closer, sc.i + raw[0].length);
        if (end === -1) fail("raw string not closed");
        sc.i = end + closer.length;
        continue;
      }
    }
    if (cfg.rustChars === true && ch === "'") {
      const char = /^'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F_]{1,6}\}|.)|[^\\'\n])'/u.exec(s.slice(sc.i, sc.i + 14));
      if (char !== null) { sc.i += char[0].length; continue; }
      sc.i += 1;
      continue;
    }
    if (cfg.cppRaw === true && ch === "R" && s[sc.i + 1] === '"' && !(sc.i > 0 && isIdPart(s[sc.i - 1]!, false))) fail("C++ raw string");
    // Strings.
    const str = cfg.strings.find((x) => sc.startsWith(x.open));
    if (str !== undefined) {
      skipString(sc, cfg, str, "");
      operand = true;
      continue;
    }
    if (isDigit(ch)) {
      sc.i += 1;
      while (sc.i < s.length && (isIdPart(s[sc.i]!, false) || s[sc.i] === ".")) sc.i += 1;
      operand = true;
      continue;
    }
    if (isIdStart(ch, dollar)) {
      const at = sc.i;
      sc.i += 1;
      while (sc.i < s.length && isIdPart(s[sc.i]!, dollar)) sc.i += 1;
      const word = s.slice(at, sc.i);
      const next = s[sc.i];
      if (cfg.prefix !== undefined && cfg.prefix.test(word) && (next === '"' || next === "'")) {
        const opener = cfg.strings.find((x) => sc.startsWith(x.open));
        if (opener !== undefined) { skipString(sc, cfg, opener, word); operand = true; continue; }
      }
      sc.tokens.push({ at, text: word });
      operand = !JS_REGEX_AFTER_WORD.has(word);
      continue;
    }
    if (cfg.regex === true && ch === "/" && !operand && trySkipRegex(sc)) { operand = true; continue; }
    // After `)` a `/` is a division (`(a) / b`) or the start of a regex (`if (x) /re/.test(y)`); the lexer cannot tell, so a `/` there that could close a regex on its line is a failure.
    if (cfg.regex === true && ch === "/" && wasParen && s[sc.i + 1] !== "/" && s[sc.i + 1] !== "*" && regexCouldClose(sc)) fail("division or regex");
    lastWasParen = ch === ")";
    operand = ch === ")" || ch === "]";
    sc.i += 1;
  }
}

// ---- markup (HTML, XML): comments, CDATA, processing instructions, script and style bodies, text nodes and attribute values are dropped; tag and attribute names are kept.
function lexMarkup(sc: Scanner): void {
  const s = sc.s;
  const lower = s.toLowerCase();
  while (sc.i < s.length) {
    sc.tick();
    if (s[sc.i] !== "<") { sc.i += 1; continue; }
    if (sc.startsWith("<!--")) {
      const end = s.indexOf("-->", sc.i + 4);
      if (end === -1) fail("comment not closed");
      sc.i = end + 3;
      continue;
    }
    if (sc.startsWith("<![CDATA[")) {
      const end = s.indexOf("]]>", sc.i);
      if (end === -1) fail("CDATA not closed");
      sc.i = end + 3;
      continue;
    }
    if (sc.startsWith("<?") || sc.startsWith("<!")) {
      const end = s.indexOf(">", sc.i);
      if (end === -1) fail("declaration not closed");
      sc.i = end + 1;
      continue;
    }
    const next = s[sc.i + 1];
    if (next === undefined || !(isIdStart(next, false) || next === "/")) { sc.i += 1; continue; }
    // A tag: names are tokens, values are dropped.
    sc.i += next === "/" ? 2 : 1;
    let tagName = "";
    for (;;) {
      sc.tick();
      if (sc.i >= s.length) fail("tag not closed");
      const ch = s[sc.i]!;
      if (ch === ">") { sc.i += 1; break; }
      if (ch === '"' || ch === "'") {
        const end = s.indexOf(ch, sc.i + 1);
        if (end === -1) fail("attribute value not closed");
        sc.i = end + 1;
        continue;
      }
      if (ch === "=") {
        sc.i += 1;
        while (isSpace(s[sc.i])) sc.i += 1;
        const q = s[sc.i];
        if (q === '"' || q === "'") continue;
        while (sc.i < s.length && !isSpace(s[sc.i]) && s[sc.i] !== ">") sc.i += 1;
        continue;
      }
      if (isIdStart(ch, false)) {
        const at = sc.i;
        sc.i += 1;
        while (sc.i < s.length && isIdPart(s[sc.i]!, false)) sc.i += 1;
        const word = s.slice(at, sc.i);
        if (tagName === "") tagName = word.toLowerCase();
        sc.tokens.push({ at, text: word });
        continue;
      }
      sc.i += 1;
    }
    // The body of script and style is code of another language: dropped, not read.
    if ((tagName === "script" || tagName === "style") && s[sc.i - 2] !== "/" && !s.slice(Math.max(0, sc.i - 40), sc.i).startsWith("</")) {
      const end = lower.indexOf(`</${tagName}`, sc.i);
      if (end === -1) fail("script not closed");
      sc.i = end;
    }
  }
}

/**
 * Identifier tokens of lines `startLine..endLine` (1-based, inclusive) of `text`, in code only. `undefined` when the file cannot be lexed with certainty (see the head of this file).
 * The same token may appear twice; callers that want a set make one.
 */
export function lexIdentifiers(path: string, text: string, startLine: number, endLine: number, options: { now?: () => number } = {}): string[] | undefined {
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine || endLine - startLine + 1 > LEX_MAX_RANGE_LINES) return undefined;
  const extension = extensionOf(path);
  const kind = extension === undefined ? undefined : BY_EXTENSION[extension];
  if (kind === undefined || text.length > LEX_MAX_BYTES || Buffer.byteLength(text, "utf8") > LEX_MAX_BYTES) return undefined;
  if (kind.kind === "cfg" && kind.cfg.unicodeEscapes === true && /\\u+[0-9a-fA-F]{4}/u.test(text)) return undefined;
  const source = text.replace(/\r\n?/gu, "\n");
  const lineStarts = [0];
  for (let i = source.indexOf("\n"); i !== -1; i = source.indexOf("\n", i + 1)) lineStarts.push(i + 1);
  // A final newline ends the last line; it does not start another.
  const lineCount = source.endsWith("\n") ? lineStarts.length - 1 : lineStarts.length;
  if (endLine > lineCount) return undefined;
  const clock = options.now ?? Date.now;
  const sc = new Scanner(source, clock() + LEX_BUDGET_MS, clock);
  try {
    if (kind.kind === "cfg") lexCfg(sc, kind.cfg);
    else lexMarkup(sc);
  } catch (error) {
    if (error instanceof LexFailure) return undefined;
    return undefined;
  }
  const from = lineStarts[startLine - 1]!;
  const to = endLine < lineStarts.length ? lineStarts[endLine]! : source.length;
  return sc.tokens.filter((t) => t.at >= from && t.at < to).map((t) => t.text);
}
