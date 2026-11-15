// TE-F2 part B test support (L3): walks the import graph of a TypeScript entry with the TypeScript parser (not a text search), so a renamed default import, a namespace import, `export ... from`, a dynamic `import()`, `require()`
// and a call to `fetch` or `.connect()` are all seen. It follows relative imports and the contracts package's narrow model-helper entry; any other package is a leaf (its name is judged by the rules below, not walked).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";

export interface GraphViolation {
  readonly file: string;
  readonly rule: string;
}
export interface GraphResult {
  readonly files: string[];
  readonly violations: GraphViolation[];
}

const FORBIDDEN_MODULES = new Set(["dns", "dns/promises", "tls", "https", "http2", "dgram", "child_process", "cluster", "worker_threads", "vm", "inspector", "repl", "undici", "node-fetch", "axios", "got", "ws", "cross-fetch", "isomorphic-fetch"]);
/** Server-only modules: only these named imports. */
const SERVER_ONLY: Record<string, ReadonlySet<string>> = {
  net: new Set(["createServer", "Server", "Socket", "isIP", "isIPv4", "isIPv6"]),
  http: new Set(["createServer", "Server", "IncomingMessage", "ServerResponse", "IncomingHttpHeaders"]),
};
const FORBIDDEN_CALLS = new Set(["fetch", "connect", "createConnection", "XMLHttpRequest", "WebSocket", "EventSource", "createRequire", "require"]);
const bare = (specifier: string): string => specifier.replace(/^node:/u, "");

export function walkImportGraph(entry: string, resolveSpecifier: (from: string, specifier: string) => string | undefined): GraphResult {
  const seen = new Set<string>();
  const violations: GraphViolation[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const flag = (rule: string): void => {
      violations.push({ file, rule });
    };
    const consider = (specifier: string, clause: ts.ImportClause | undefined, typeOnly: boolean): void => {
      const name = bare(specifier);
      if (FORBIDDEN_MODULES.has(name) || name.startsWith("@aws-sdk/")) return flag(`imports ${specifier}`);
      const only = SERVER_ONLY[name];
      if (only !== undefined && !typeOnly) {
        if (clause === undefined) return flag(`bare import of ${specifier}`);
        if (clause.name !== undefined) return flag(`default import of ${specifier}`);
        const bindings = clause.namedBindings;
        if (bindings === undefined || ts.isNamespaceImport(bindings)) return flag(`namespace import of ${specifier}`);
        for (const element of bindings.elements) if (!element.isTypeOnly && !only.has((element.propertyName ?? element.name).text)) flag(`imports ${(element.propertyName ?? element.name).text} from ${specifier}`);
      }
      const next = resolveSpecifier(file, specifier);
      if (next !== undefined) queue.push(next);
    };
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) consider(node.moduleSpecifier.text, node.importClause, node.importClause?.isTypeOnly === true);
      else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) consider(node.moduleSpecifier.text, undefined, node.isTypeOnly);
      else if (ts.isImportEqualsDeclaration(node)) flag("import = require");
      else if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) flag("dynamic import()");
        const callee = node.expression;
        const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
        if (name !== undefined && FORBIDDEN_CALLS.has(name)) flag(`calls ${name}()`);
      } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && FORBIDDEN_CALLS.has(node.expression.text)) flag(`new ${node.expression.text}`);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { files: [...seen].sort(), violations };
}

/** Resolves `./x.js` (to `x.ts`) and the contracts package's narrow entry to files; other packages are leaves. */
export function repoResolver(root: string): (from: string, specifier: string) => string | undefined {
  return (from, specifier) => {
    if (specifier === "@agentx/contracts/model-helper") return join(root, "packages/contracts/src/model-helper-entry.ts");
    if (specifier === "@agentx/contracts") return join(root, "packages/contracts/src/index.ts");
    if (!specifier.startsWith(".")) return undefined;
    const target = resolve(dirname(from), specifier.replace(/\.js$/u, ".ts"));
    return existsSync(target) ? target : undefined;
  };
}
