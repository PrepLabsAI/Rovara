// A browser session's id IS its cookie credential (`authenticateDeveloperSessionId`, packages/broker/src/aws/developer-routes.ts: a slack/oidc session with a `reviewExpiresAt` is accepted from the
// cookie by id alone), so a log line that carries a session id can leak a usable credential. This ratchet scans every `packages/*/src` source for a log call whose arguments carry a session id and
// refuses any that is not in tests/fixtures/session-id-log-sites.json (file -> count, with a reason per file in the same fixture).
//
// What it counts as a log call: `log(...)` / `x.log(...)` / `x.log?.(...)` / `logger(...)` and any `logXxx(...)` helper, `brokerLogLine(...)`, `companyLog(...)(...)`, a name bound from `companyLog(...)`,
// `brokerLogLine(...)` or `logOf(...)`, either branch of `(a ?? b)(...)`, every `console.*` call, and `process.stdout.write` / `process.stderr.write`.
// What it counts as a carried session id: an object-literal key named like a session id (`sessionId`, `session_id`, `sessionID`, `agentSessionId`, a string or shorthand key), or a value that reads such a name
// (`sessionId`, `x.sessionId`, `x["sessionId"]`, inside a template or a call), anywhere in the arguments, including inside a spread of an object literal and an identifier that names a same-file object-literal variable.
// What it cannot see (stated, not guessed): an entry built in another function and passed in as an opaque value (`log(entry)` where `entry` is a parameter, an import or a call result), a spread of such a value
// (`{ ...entry }`), a session id renamed to a name that does not end in `sessionId` (`{ id: row.id }`), and a log helper reached by a name this file does not know. Those are the review's job: the allowlist is small on purpose.
// Forms it cannot classify fail closed with the word "unclassifiable": a parse error, `log.call/apply`, `x["log"](...)`, a budget overrun. An alias of `console` or of a process stream is a "sink escape" counted per file and held to the fixture's `escapes`.
import { expect, it } from "vitest";
import ts from "typescript";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
const MAX_FILES = 3600, MAX_BYTES = 56 * 1024 * 1024, MAX_MS = 60_000; // Code train 73 holds 3054 sources (38.6 MB); the byte/time bounds and the fail-closed scanning stay fixed.
const FAIL = "unclassifiable";
const SESSION_NAME = /session_?id$/i;
const LOG_HELPERS = new Set(["log", "logger", "brokerLogLine", "logEvent", "logLine", "stderrLog"]);
const LOG_FACTORIES = new Set(["companyLog", "brokerLogLine", "logOf"]);
type Hit = { path: string; line: number };
const unwrap = (node: ts.Expression): ts.Expression => { let n = node; while (ts.isParenthesizedExpression(n) || ts.isNonNullExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression(n)) n = n.expression; return n; };
const isLogName = (name: string, aliases: ReadonlySet<string>): boolean => LOG_HELPERS.has(name) || /^log[A-Z]/.test(name) || aliases.has(name);
const keyName = (name: ts.PropertyName): string | undefined => {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isComputedPropertyName(name)) { const inner = unwrap(name.expression); if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) return inner.text; }
  return undefined;
};
/** Is `callee` a log function? `process.stdout/stderr.write` and `console.*` are logs too. Throws "unclassifiable" for a form that cannot be classified. */
function isLogCallee(callee: ts.Expression, aliases: ReadonlySet<string>): boolean {
  const e = unwrap(callee);
  if (ts.isIdentifier(e)) return isLogName(e.text, aliases);
  if (ts.isBinaryExpression(e)) return [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(e.operatorToken.kind) && (isLogCallee(e.left, aliases) || isLogCallee(e.right, aliases));
  if (ts.isConditionalExpression(e)) return isLogCallee(e.whenTrue, aliases) || isLogCallee(e.whenFalse, aliases);
  if (ts.isCallExpression(e)) { const inner = unwrap(e.expression); return (ts.isIdentifier(inner) && LOG_FACTORIES.has(inner.text)) || (ts.isPropertyAccessExpression(inner) && LOG_FACTORIES.has(inner.name.text)); }
  if (ts.isElementAccessExpression(e)) {
    const key = unwrap(e.argumentExpression);
    if (ts.isStringLiteral(key) && isLogName(key.text, aliases)) throw new Error(FAIL);
    return false;
  }
  if (!ts.isPropertyAccessExpression(e)) return false;
  const object = unwrap(e.expression), name = e.name.text;
  if (ts.isIdentifier(object) && object.text === "console") return true;
  // `process.stdout.write(...)`, and `<anything>.stdout.write(...)` / `stderr.write(...)` for a stream a command received as a dependency.
  if (name === "write" && ((ts.isPropertyAccessExpression(object) && ["stdout", "stderr"].includes(object.name.text)) || (ts.isIdentifier(object) && ["stdout", "stderr"].includes(object.text)))) return true;
  if (["call", "apply"].includes(name) && isLogCallee(object, aliases)) throw new Error(FAIL);
  if (name === "bind") return false; // `x.log.bind(x)` only makes a log function: bound to a name it becomes an alias (declarations), handed on as `log: ...` it is called by that name.
  return isLogName(name, aliases);
}
/** Same-file object-literal variables (name -> initializers) and names bound from a log factory. A plain name map: a collision checks every declaration (fail toward reporting). */
function declarations(file: ts.SourceFile): { objects: Map<string, ts.ObjectLiteralExpression[]>; aliases: Set<string> } {
  const objects = new Map<string, ts.ObjectLiteralExpression[]>(), aliases = new Set<string>(), stack: ts.Node[] = [file];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      const init = unwrap(node.initializer);
      if (ts.isObjectLiteralExpression(init)) objects.set(node.name.text, [...(objects.get(node.name.text) ?? []), init]);
      else if (ts.isCallExpression(init)) {
        const callee = unwrap(init.expression);
        if ((ts.isIdentifier(callee) && LOG_FACTORIES.has(callee.text)) || (ts.isPropertyAccessExpression(callee) && (LOG_FACTORIES.has(callee.name.text) || (callee.name.text === "bind" && ts.isPropertyAccessExpression(unwrap(callee.expression)) && isLogName((unwrap(callee.expression) as ts.PropertyAccessExpression).name.text, aliases))))) aliases.add(node.name.text);
      }
    }
    ts.forEachChild(node, (child) => { stack.push(child); });
  }
  return { objects, aliases };
}
/** Does anything in a log call's arguments carry a session id? Function bodies are skipped (a callback is not the entry); a same-file object-literal variable is read two levels deep. */
function carriesSessionId(args: readonly ts.Node[], objects: ReadonlyMap<string, ts.ObjectLiteralExpression[]>): boolean {
  const stack: { node: ts.Node; depth: number; viaName: boolean }[] = args.map((node) => ({ node, depth: 0, viaName: true }));
  while (stack.length > 0) {
    const { node, depth, viaName } = stack.pop()!;
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isTypeNode(node)) continue;
    if (ts.isShorthandPropertyAssignment(node)) { if (SESSION_NAME.test(node.name.text)) return true; if (depth < 2) for (const init of objects.get(node.name.text) ?? []) stack.push({ node: init, depth: depth + 1, viaName: false }); continue; }
    if (ts.isPropertyAssignment(node)) { const key = keyName(node.name); if (key !== undefined && SESSION_NAME.test(key)) return true; stack.push({ node: node.initializer, depth, viaName: false }); continue; }
    if (ts.isIdentifier(node)) { if (SESSION_NAME.test(node.text)) return true; if (viaName && depth < 2) for (const init of objects.get(node.text) ?? []) stack.push({ node: init, depth: depth + 1, viaName: false }); continue; }
    if (ts.isSpreadAssignment(node)) { const inner = unwrap(node.expression); stack.push({ node: inner, depth, viaName: ts.isIdentifier(inner) }); continue; }
    if (ts.isPropertyAccessExpression(node)) { if (SESSION_NAME.test(node.name.text)) return true; stack.push({ node: node.expression, depth, viaName: false }); continue; }
    if (ts.isElementAccessExpression(node)) { const key = unwrap(node.argumentExpression); if ((ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) && SESSION_NAME.test(key.text)) return true; }
    ts.forEachChild(node, (child) => { stack.push({ node: child, depth, viaName: false }); });
  }
  return false;
}
/** `console` is a sink only as the head of a call (`console.log(...)`, also inside a parenthesised `??` fallback), and a process stream only as `process.stderr.write(...)`. Any other use (an alias, handed on as a
 * dependency, `console[method]`, `.on(...)`) is a "sink escape": its writes cannot be followed, so each one needs a reviewed entry in the fixture's `escapes`. */
function checkSinkUse(node: ts.Identifier): boolean {
  if (node.text === "console") {
    const access = node.parent;
    return !ts.isPropertyAccessExpression(access) || access.expression !== node || !isCallHead(access);
  }
  if (node.text === "process" && ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node && ["stderr", "stdout"].includes(node.parent.name.text)) {
    const write = node.parent.parent;
    return !ts.isPropertyAccessExpression(write) || write.expression !== node.parent || write.name.text !== "write" || !isCallHead(write);
  }
  return false;
}
function isCallHead(node: ts.Expression): boolean {
  let head: ts.Node = node;
  while (ts.isParenthesizedExpression(head.parent) || (ts.isBinaryExpression(head.parent) && head.parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) head = head.parent;
  return ts.isCallExpression(head.parent) && head.parent.expression === head;
}
function scan(sources: readonly { path: string; source: string }[], clock = () => performance.now(), began = clock()): { counts: Record<string, number>; hits: Hit[]; escapes: Record<string, number> } {
  let bytes = 0;
  if (sources.length > MAX_FILES) throw new Error(FAIL);
  const counts: Record<string, number> = Object.create(null) as Record<string, number>, escapes: Record<string, number> = Object.create(null) as Record<string, number>, hits: Hit[] = [];
  for (const { path, source } of sources) {
    bytes += Buffer.byteLength(source);
    if (bytes > MAX_BYTES || clock() - began > MAX_MS) throw new Error(FAIL);
    let file: ts.SourceFile;
    try { file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true); } catch { throw new Error(FAIL); }
    if ((file as ts.SourceFile & { parseDiagnostics: readonly unknown[] }).parseDiagnostics.length > 0) throw new Error(FAIL);
    const { objects, aliases } = declarations(file);
    let count = 0, escaped = 0, visited = 0; const stack: ts.Node[] = [file];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (++visited % 1024 === 0 && clock() - began > MAX_MS) throw new Error(FAIL);
      try {
        if (ts.isIdentifier(node) && (node.text === "console" || node.text === "process") && checkSinkUse(node)) escaped++;
        if (ts.isCallExpression(node) && isLogCallee(node.expression, aliases) && carriesSessionId(node.arguments, objects)) { count++; hits.push({ path, line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1 }); }
      } catch (error) { if (error instanceof Error && error.message === FAIL) throw new Error(`${FAIL}: ${path}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`, { cause: error }); throw error; }
      ts.forEachChild(node, (child) => { stack.push(child); });
    }
    if (count > 0) Object.defineProperty(counts, path, { value: count, enumerable: true });
    if (escaped > 0) Object.defineProperty(escapes, path, { value: escaped, enumerable: true });
  }
  if (clock() - began > MAX_MS) throw new Error(FAIL);
  return { counts, hits, escapes };
}
type Allowlist = { sites: Record<string, number>; reasons: Record<string, string>; escapes: Record<string, number>; escapeReasons: Record<string, string> };
function ratchet(counts: Record<string, number>, allowed: Record<string, number>, what = "Session id logging"): void {
  for (const [file, count] of Object.entries(counts)) if (count > (Object.hasOwn(allowed, file) ? allowed[file]! : 0)) throw new Error(`${what} needs review: ${file}`);
}
function sources(began: number): { path: string; source: string }[] {
  const paths: string[] = []; const pending: string[] = []; let bytes = 0;
  for (const pkg of readdirSync("packages", { withFileTypes: true })) if (pkg.isDirectory() && statSync(join("packages", pkg.name, "src"), { throwIfNoEntry: false })?.isDirectory() === true) pending.push(join("packages", pkg.name, "src"));
  while (pending.length > 0) {
    if (performance.now() - began > MAX_MS) throw new Error(FAIL);
    const folder = pending.pop()!;
    for (const file of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, file.name);
      if (file.isSymbolicLink()) throw new Error(FAIL);
      if (file.isDirectory()) pending.push(path);
      else if (path.endsWith(".ts")) { paths.push(path); bytes += statSync(path).size; }
      if (paths.length > MAX_FILES || bytes > MAX_BYTES || pending.length > MAX_FILES) throw new Error(FAIL);
    }
  }
  return paths.sort().map((path) => ({ path, source: readFileSync(path, "utf8") }));
}
const hit = (source: string): Record<string, number> => scan([{ path: "t.ts", source }]).counts;
it("ratchets every log call that carries a session id in the scoped source inventory", () => {
  const allowed = JSON.parse(readFileSync(new URL("../fixtures/session-id-log-sites.json", import.meta.url), "utf8")) as Allowlist;
  expect(Object.keys(allowed.sites).sort()).toEqual(Object.keys(allowed.reasons).sort());
  expect(Object.keys(allowed.escapes).sort()).toEqual(Object.keys(allowed.escapeReasons).sort());
  for (const reason of [...Object.values(allowed.reasons), ...Object.values(allowed.escapeReasons)]) expect(reason.length).toBeGreaterThan(20);
  const began = performance.now();
  const { counts, hits, escapes } = scan(sources(began), () => performance.now(), began);
  // SESSION_ID_LOG_REPORT=1 prints every file:line this scan counted (to find the line a "needs review" refusal means); it changes nothing else.
  if (process.env["SESSION_ID_LOG_REPORT"] === "1") process.stderr.write(`${hits.map((h) => `${h.path}:${h.line}`).join("\n")}\nESCAPES ${JSON.stringify(escapes)}\n`);
  ratchet(counts, allowed.sites);
  ratchet(escapes, allowed.escapes, "Session id log stream");
}, 120_000);
it("refuses an unlisted log call with fixed file words", () => {
  expect(() => ratchet(hit('deps.log({ event: "x", sessionId: "secret-canary" })'), {})).toThrow("Session id logging needs review: t.ts");
  expect(() => ratchet(hit('deps.log({ event: "x", sessionId: "secret-canary" })'), { "t.ts": 1 })).not.toThrow();
  expect(() => ratchet(hit('deps.log({ event: "x", sessionId: "a" }); deps.log({ sessionId: "b" })'), { "t.ts": 1 })).toThrow("Session id logging needs review: t.ts");
});
it("catches every key and value form a session id takes in a log entry", () => {
  for (const source of [
    'log({ sessionId: "a" })', 'log({ session_id: "a" })', 'log({ sessionID: "a" })', 'log({ "sessionId": "a" })', 'log({ ["sessionId"]: "a" })', 'log({ agentSessionId: a })',
    "log({ event: 'x', sessionId })", "log({ session_id })", "log({ sessionID })", "log({ id: session.sessionId })", 'log({ id: row["sessionId"] })', "log({ event: `x ${sessionId}` })", "log(JSON.stringify({ sessionId }))",
    "log({ ...{ sessionId } })", "log({ ...(ok ? { sessionId } : {}) })", "log({ nested: { deeper: { sessionId } } })", 'log("event", sessionId)', "log?.({ sessionId })", "deps.log?.({ sessionId })",
    "(deps.log ?? (() => undefined))({ sessionId })", "(deps.log ?? ((line) => console.log(JSON.stringify(line))))({ sessionId })", "const entry = { event: 'x', sessionId }; log(entry)", "const entry = { sessionId }; log({ ...entry })",
    "const inner = { sessionId }; const entry = { ...inner }; log(entry)", "logger.log({ sessionId })", "brokerLogLine({ sessionId })", "companyLog(c, sink)({ sessionId })", "const own = companyLog(c, sink); own({ sessionId })",
    "const l = logOf(deps); l({ sessionId })", "const bound = deps.log.bind(deps); bound({ sessionId })", "logChangeStep({ sessionId })", "logger({ sessionId })", "console.log({ sessionId })", "console.error('x', sessionId)", "console.warn(JSON.stringify({ sessionId }))",
    "process.stderr.write(JSON.stringify({ sessionId }))", "process.stdout.write(`x ${sessionId}`)", "deps.stderr.write(`x ${sessionId}`)", "stdout.write(sessionId)", "const log = (entry) => deps.log({ ...entry, sessionId });", "wiring.log({ ...base, sessionId: s.sessionId })",
  ]) { try { expect(hit(source), source).toEqual({ "t.ts": 1 }); } catch (error) { throw new Error(`not caught: ${source}`, { cause: error }); } }
});
it("does not count a call that is not a log, or an entry without a session id", () => {
  for (const source of [
    "log({ event: 'x', orgId })", "log({ sessionIds })", "log({ sessionKey: 'a' })", "store.get({ sessionId })", "readTaskLog(deps, sessionId)", "catalog({ sessionId })", "login({ sessionId })", "const entry = { sessionId }; log({ event: 'x' })",
    "log(() => ({ sessionId }))", "log({ event: 'x', on: (sessionId) => sessionId })", "const sessionId = 1; log({ event: 'x' })", "const l = (e) => e; l({ sessionId })", "log(entry)", "log({ ...entry })", "return { sessionId }",
  ]) expect(hit(source), source).toEqual({});
});
it("counts a console or process stream that is aliased, handed on or listened to as an escape that needs its own review", () => {
  for (const source of [
    "const err = process.stderr; err.write(x)", "const write = process.stderr.write;", "process.stderr.on('error', () => undefined)", "run({ out: process.stdout })", "const w = process.stdout.write.bind(x);",
    "const logger = console; logger.log({ sessionId })", "const { log } = console;", "const log = console.log;", "console[method] = noop;",
  ]) {
    expect(scan([{ path: "e.ts", source }]).escapes, source).toEqual({ "e.ts": 1 });
    expect(() => ratchet(scan([{ path: "e.ts", source }]).escapes, {}, "Session id log stream"), source).toThrow("Session id log stream needs review: e.ts");
  }
  expect(scan([{ path: "e.ts", source: "process.stderr.write(x); console.log(y)" }]).escapes).toEqual({});
});
it("states what it cannot see: an opaque entry or a spread of one is not detected", () => {
  expect(hit("function f(entry) { log(entry); log({ ...entry }); }")).toEqual({});
});
it("unparsable syntax and forms it cannot classify fail as unclassifiable", () => {
  for (const source of [
    "const broken = {", 'console["log"]("x")', "log.call(null, { sessionId })", "deps.log.apply(deps, [{ sessionId }])", 'deps["log"]({ sessionId })',
  ]) expect(() => scan([{ path: "x.ts", source }]), source).toThrow(FAIL);
});
it("one total byte/file/time budget; a large input remains bounded", () => {
  const source = 'log({ sessionId });\n'.repeat(20_000);
  expect(scan([{ path: "large.ts", source }]).counts).toEqual({ "large.ts": 20_000 });
  expect(() => scan(Array.from({ length: MAX_FILES + 1 }, () => ({ path: "x.ts", source: "" })))).toThrow(FAIL);
  expect(() => scan([{ path: "x.ts", source: " ".repeat(MAX_BYTES / 2 + 1) }, { path: "y.ts", source: " ".repeat(MAX_BYTES / 2 + 1) }])).toThrow(FAIL);
  let now = 0; expect(() => scan([{ path: "x.ts", source: "" }], () => { now += MAX_MS + 1; return now; })).toThrow(FAIL);
  const chunk = Math.floor(MAX_BYTES / MAX_FILES);
  expect(scan(Array.from({ length: MAX_FILES }, (_, i) => ({ path: `file-${i}.ts`, source: " ".repeat(i === 0 ? MAX_BYTES - chunk * (MAX_FILES - 1) : chunk) }))).counts).toEqual({});
}, 60_000);
