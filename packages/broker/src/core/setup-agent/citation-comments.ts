// Which parts of a file are comments, for the setup citation re-read: a command or a name that is only in a comment is not a command or a name the project uses. The answer is per line, as the line's CODE text (the
// comment part cut off), or COMMENT_LINE for a line that is wholly comment (so a quote can never be matched across it). The rules are a small table by file type and are deliberately cautious: where a rule is
// unsure the text is treated as a comment, so the citation fails toward `unverified`, never toward `verified`. A marker counts at the start of a line or after whitespace, `;` or `@` (so `true;# x` and `f();// x` are comments, `https://x` is not).
//   shell, YAML, TOML, Python, Dockerfile, Containerfile, Makefile, CMake, just: `#`; a shell heredoc body and a Python docstring are data, not commands;  Ruby: `#` and `=begin ... =end`;
//   PowerShell: `#` and `<# ... #>`;  C-like (TypeScript, JavaScript, JSON, Java, Go, Rust, C, Kotlin, Gradle, Groovy, Jenkinsfile, CSS ...): `//`, `/* ... */` over any number of lines, and a line that starts with `*`;
//   PHP, Terraform: C-like and `#`;  SQL: `--` and `/* ... */`;  HTML, XML: `<!-- ... -->` over any number of lines;  Vue, Svelte: C-like and `<!-- -->`;
//   Markdown: `<!-- ... -->` over any number of lines, and, inside a code fence or in an indented (four spaces or a tab) code block, `#` as in a shell script (a `#` heading outside code is not a comment);
//   batch files: `REM` and `::`;  INI: `#` or `;` at the start of a line;
//   any other type: `//` and `#` after the start or whitespace, `/* ... */` and `<!-- ... -->` over any number of lines, and a line that starts with `;`, `--`, `*` or `REM` (a `--` in the middle of a line is a command
//   flag in most files, so it is not read as a comment there).
// A line over MAX_LINE_CHARS (a minified bundle, a data blob) is read as a comment: it is never a command a person wrote. The scan of a line is one left-to-right pass (cutComments), so the work per file is linear in its
// size, and a budget on the characters scanned in one verification makes a file past it read as comment from there on (fail closed). Pure.

/** What a line that is wholly a comment is replaced by. A control character: no quote (the proposal reader strips them) can contain it. */
export const COMMENT_LINE = "\u0001";

/** The longest line that is read at all; a longer one is read as a comment. */
export const MAX_LINE_CHARS = 16_384;

type Family = "hash" | "ruby" | "powershell" | "ini" | "c" | "chash" | "sql" | "markup" | "mixed" | "markdown" | "bat" | "other";
const BY_EXTENSION: Record<string, Family> = {
  yml: "hash", yaml: "hash", sh: "hash", bash: "hash", zsh: "hash", fish: "hash", toml: "hash", py: "hash", mk: "hash", cmake: "hash", rb: "ruby", ps1: "powershell",
  ini: "ini", cfg: "ini", conf: "ini",
  ts: "c", tsx: "c", js: "c", jsx: "c", mjs: "c", cjs: "c", json: "c", jsonc: "c", c: "c", h: "c", cpp: "c", hpp: "c", java: "c", go: "c", rs: "c", cs: "c", swift: "c", kt: "c", kts: "c", gradle: "c", groovy: "c", css: "c", scss: "c",
  php: "chash", tf: "chash", tfvars: "chash", hcl: "chash", vue: "mixed", svelte: "mixed",
  sql: "sql", html: "markup", htm: "markup", xml: "markup", md: "markdown", markdown: "markdown", bat: "bat", cmd: "bat",
};
const BY_NAME: Record<string, Family> = { dockerfile: "hash", containerfile: "hash", makefile: "hash", gnumakefile: "hash", justfile: "hash", "cmakelists.txt": "hash", jenkinsfile: "c" };
/** Code fence languages that are C-like; any other fence language is read as a shell script (a `#` is a comment). */
const C_FENCES: ReadonlySet<string> = new Set(["ts", "tsx", "typescript", "js", "jsx", "javascript", "json", "jsonc", "java", "go", "rust", "rs", "c", "cpp", "cs", "swift", "kotlin", "css", "scss"]);

function familyOf(path: string | undefined): Family {
  const name = path?.split("/").at(-1)?.toLowerCase() ?? "";
  if (name.startsWith("dockerfile.") || name.startsWith("containerfile.") || name.endsWith(".dockerfile")) return "hash";
  return BY_NAME[name] ?? BY_EXTENSION[name.split(".").at(-1) ?? ""] ?? "other";
}

/** Work done by the comment scan, counted for a test: the characters the scanner went over. */
export interface ScanMeter { scanned: number }
/** The most characters of one file, or of all the files of one verification, that are scanned; past it every further line is read as a comment (fail closed). */
export interface ScanBudget { left: number }
interface State { block: boolean; block2: boolean; heredoc: string | undefined; docstring: string | undefined; fence: string | undefined; meter: ScanMeter | undefined }

/** What may stand before a line comment marker in the middle of a line. */
const BEFORE_MARKER = /[\s;@]/u;

/** The characters that can start a comment of one kind of file, as one pattern: the scan jumps from one of them to the next. Made once per kind. */
const TRIGGERS = new Map<string, RegExp>();
function triggerFor(open: string | undefined, markers: readonly string[]): RegExp {
  const key = `${open ?? ""}\u0000${markers.join("\u0000")}`;
  let trigger = TRIGGERS.get(key);
  if (trigger === undefined) {
    trigger = new RegExp([...(open === undefined ? [] : [open]), ...markers].map((text) => text.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&")).join("|"), "gu");
    TRIGGERS.set(key, trigger);
  }
  return trigger;
}

/** What a block comment is: which flag of the state it sets, what opens and closes it, and whether a line that starts with `*` is a comment line. */
interface BlockSpec { key: "block" | "block2"; open: string; close: string; starLines: boolean }

/** Inside a shell heredoc every line is data until the line that is the terminator. */
function heredocLine(line: string, state: State): string {
  if (line.trim() === state.heredoc) state.heredoc = undefined;
  return COMMENT_LINE;
}

/** A Python docstring: its lines are data. Returns undefined for a line that has nothing to do with one. */
function docstringLine(line: string, state: State): string | undefined {
  if (state.docstring !== undefined) {
    if (line.includes(state.docstring)) state.docstring = undefined;
    return COMMENT_LINE;
  }
  const quoted = /"""|'''/u.exec(line);
  if (quoted === null) return undefined;
  const delimiter = quoted[0];
  const opens = (line.split(delimiter).length - 1) % 2 === 1;
  if (opens) state.docstring = delimiter;
  if (line.trimStart().startsWith(delimiter)) return COMMENT_LINE;
  return opens ? line.slice(0, quoted.index) : undefined;
}

/** A line of a script that comments with `#`: heredoc bodies and Python docstrings are data. */
function hashLine(line: string, state: State, python: boolean): string {
  if (state.heredoc !== undefined) return heredocLine(line, state);
  const doc = python ? docstringLine(line, state) : undefined;
  if (doc !== undefined) return doc;
  const heredoc = /<<-?\s*(['"]?)([A-Za-z_][\w]*)\1/u.exec(line);
  if (heredoc !== null) state.heredoc = heredoc[2];
  return cutComments(line, state, undefined, ["#"]);
}

/** Ruby: `=begin` to `=end` is a comment; otherwise a `#` script. */
function rubyLine(line: string, state: State): string {
  if (state.block) { if (line.startsWith("=end")) state.block = false; return COMMENT_LINE; }
  if (line.startsWith("=begin")) { state.block = true; return COMMENT_LINE; }
  return hashLine(line, state, false);
}

/** The code before a comment that runs to the end of the line: a line with nothing but a comment is a comment line. */
const beforeComment = (code: string): string => (code.trim() === "" ? COMMENT_LINE : code);

/** The code left of a line once its comments are cut: nothing but what was cut (or a star line) is a comment line. */
function finishCode(code: string, line: string, starLines: boolean): string {
  if (starLines && code.trimStart().startsWith("*")) return COMMENT_LINE;
  return code.trim() === "" && code !== line ? COMMENT_LINE : code;
}

/** Adds to the count of characters the scan went over (only when a test counts). */
function count(state: State, scanned: number): void {
  if (state.meter !== undefined) state.meter.scanned += scanned;
}

const inBlock = (state: State, block: BlockSpec | undefined): boolean => block !== undefined && state[block.key];

/** Inside a block comment at `at`: the position after its close (the block ends), or -1 when the line stays inside it. The one look for the close starts where the block opened. */
function leaveBlock(line: string, at: number, block: BlockSpec, state: State): number {
  const end = line.indexOf(block.close, at);
  count(state, (end === -1 ? line.length : end + block.close.length) - at);
  if (end === -1) return -1;
  state[block.key] = false;
  return end + block.close.length;
}

/** Whether a line comment marker found at `index` is one: at the start of the line (or of the text after a block comment), or after whitespace, `;` or `@`. */
const startsComment = (line: string, index: number, from: number): boolean => index === from || BEFORE_MARKER.test(line[index - 1]!);

/**
 * The code of a line with its comments cut: block comments (`block`: its open and close, over any number of lines) and line comments (`markers`, to the end of the line). ONE left-to-right pass: a pattern jumps from one
 * possible comment start to the next, a close is looked for once from where the block opened, and each probe starts where the last one ended, so the work is linear in the line however many comments it holds. A line with
 * nothing left of it but comment is COMMENT_LINE.
 */
function cutComments(line: string, state: State, block: BlockSpec | undefined, markers: readonly string[]): string {
  const trigger = triggerFor(block?.open, markers);
  let code = "";
  let segment = 0;
  let from = 0;
  let at = 0;
  for (;;) {
    if (inBlock(state, block)) {
      const after = leaveBlock(line, at, block!, state);
      if (after === -1) return beforeComment(code);
      at = after;
      segment = after;
      from = after;
      continue;
    }
    trigger.lastIndex = at;
    const startedAt = trigger.lastIndex;
    const found = trigger.exec(line);
    count(state, (found === null ? line.length : found.index + found[0].length) - startedAt);
    if (found === null) break;
    if (found[0] === block?.open) {
      code += line.slice(segment, found.index);
      state[block.key] = true;
      at = found.index + block.open.length;
    } else if (startsComment(line, found.index, from)) {
      return beforeComment(code + line.slice(segment, found.index));
    } else {
      at = found.index + 1;
    }
  }
  return finishCode(code + line.slice(segment), line, block?.starLines === true);
}

const cLine = (line: string, state: State, markers: readonly string[] = ["//"]): string => cutComments(line, state, { key: "block", open: "/*", close: "*/", starLines: true }, markers);
const htmlLine = (line: string, state: State): string => cutComments(line, state, { key: "block2", open: "<!--", close: "-->", starLines: false }, []);

/** A C-like line, then HTML comments over it (Vue, Svelte and files of a type nobody listed). */
function mixedLine(line: string, state: State, markers: readonly string[]): string {
  const code = cLine(line, state, markers);
  return code === COMMENT_LINE ? code : htmlLine(code, state);
}

/** A file of a type nobody listed: every comment form read as one, and a line that starts with `;`, `--` or `REM`. */
function otherLine(line: string, state: State): string {
  const code = mixedLine(line, state, ["//", "#"]);
  return code === COMMENT_LINE || /^\s*(;|--|rem\s)/iu.test(code) ? COMMENT_LINE : code;
}

function markdownLine(line: string, state: State): string {
  const fence = /^\s*(```+|~~~+)\s*([\w+-]*)/u.exec(line);
  if (!state.block2 && fence !== null) {
    state.fence = state.fence === undefined ? (fence[2] ?? "").toLowerCase() : undefined;
    return "";
  }
  if (state.fence !== undefined) return C_FENCES.has(state.fence) ? cLine(line, state) : hashLine(line, state, false);
  if (!state.block2 && /^( {4}|\t)/u.test(line)) return hashLine(line, state, false);
  return htmlLine(line, state);
}

/** Each line's code text, in order: the line without its comment, or COMMENT_LINE when the whole line is comment. Not the line's whitespace: callers collapse it. */
export function codeLinesOf(lines: readonly string[], path: string | undefined, options: { budget?: ScanBudget; meter?: ScanMeter } = {}): string[] {
  const family = familyOf(path);
  const python = (path?.toLowerCase().endsWith(".py")) === true;
  const state: State = { block: false, block2: false, heredoc: undefined, docstring: undefined, fence: undefined, meter: options.meter };
  return lines.map((line) => {
    if (line.length > MAX_LINE_CHARS) return COMMENT_LINE;
    if (options.budget !== undefined) {
      options.budget.left -= line.length;
      if (options.budget.left < 0) return COMMENT_LINE;
    }
    switch (family) {
      case "hash": return hashLine(line, state, python);
      case "ruby": return rubyLine(line, state);
      case "powershell": return cutComments(line, state, { key: "block", open: "<#", close: "#>", starLines: false }, ["#"]);
      case "ini": return /^\s*[#;]/u.test(line) ? COMMENT_LINE : line;
      case "c": return cLine(line, state);
      case "chash": return cLine(line, state, ["//", "#"]);
      case "sql": return cutComments(line, state, { key: "block", open: "/*", close: "*/", starLines: true }, ["--"]);
      case "markup": return htmlLine(line, state);
      case "mixed": return mixedLine(line, state, ["//"]);
      case "markdown": return markdownLine(line, state);
      case "bat": return /^\s*(rem(\s|$)|::)/iu.test(line) ? COMMENT_LINE : line;
      default: return otherLine(line, state);
    }
  });
}
