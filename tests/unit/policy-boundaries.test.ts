import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import ts from "typescript";
import { resolvePolicy } from "../../packages/contracts/src/policy.js";

// The approved git blob id for packages/contracts/src/ports/policy.ts. Hashing the file in-process (git's blob format) works in CI's shallow checkout, where the base commit is not fetched.
// Was a2e7075fe49e2436ef10476ee1abe356349a566c (base c93edabcb). Moved by PR #607 (owner decision 211, identity port gaps G1-G4): an additive Approvers port change only, optional fields and optional methods plus
// pure helpers; `outcome` now names the same union through `ApprovalAnswer`, and `ApprovalVerdict` gains optional fields. Any later change to the port moves this pin again, on purpose.
const BASE_POLICY_PORT_BLOB = "8900876620af844b7248fdf751e426d059e9d095";
it("keeps the existing policy port byte-identical to the approved base", () => {
  const bytes = readFileSync("packages/contracts/src/ports/policy.ts");
  const blob = createHash("sha1").update(`blob ${String(bytes.length)}\0`).update(bytes).digest("hex");
  expect(blob).toBe(BASE_POLICY_PORT_BLOB);
});
function policyCallers(root: string): string[] {
  const api = /\b(resolvePolicy|createDefaultPolicySource|createRowsPolicySource|PolicySource|PolicySourceScope|POLICY_PRESETS|POLICY_FIELDS|matchPolicyGlob|PolicyRowsSchema|DEFAULT_POLICY_PRESET)\b/u;
  const modulePath = /(?:^@agentx\/contracts(?:\/src)?|\/contracts\/src)(?:\/ports)?\/(?:policy|policy-source|policy-glob|presets)(?:\.[cm]?[jt]s)?$/u;
  const walk = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() && !["node_modules", "dist"].includes(entry.name) ? walk(join(directory, entry.name)) : entry.isFile() && /\.(?:tsx?|js|mjs)$/u.test(entry.name) ? [join(directory, entry.name)] : []);
  return ["packages", "scripts", "infra"].flatMap((directory) => walk(join(root, directory)))
    .filter((file) => !file.startsWith(join(root, "packages/contracts") + "/") && !file.startsWith(join(root, "packages/testing") + "/"))
    .filter((file) => {
      const text = readFileSync(file, "utf8");
      if (!api.test(text) && !/\/(?:policy|policy-source|policy-glob|presets)/u.test(text)) return false;
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      let found = false;
      const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
          const specifier = node.moduleSpecifier;
          if (specifier !== undefined && ts.isStringLiteral(specifier) && (api.test(node.getText(source)) || modulePath.test(specifier.text)
            || ts.isImportDeclaration(node) && node.importClause?.namedBindings !== undefined && ts.isNamespaceImport(node.importClause.namedBindings) && api.test(text))) found = true;
        }
        if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === "require")) {
          const specifier = node.arguments[0];
          if (specifier !== undefined && ts.isStringLiteral(specifier) && (modulePath.test(specifier.text) || specifier.text === "@agentx/contracts" && api.test(text))) found = true;
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      return found;
    });
}
it("has no production callers outside contracts/testing", () => {
  expect(policyCallers(process.cwd())).toEqual([]);
});
it("caller guard detects scripts, infra, JS and every public policy entry", () => {
  const root = mkdtempSync(join(tmpdir(), "d1-callers-"));
  try {
    for (const directory of ["packages/consumer", "packages/contracts", "packages/testing", "scripts", "infra"]) mkdirSync(join(root, directory), { recursive: true });
    for (const directory of ["packages/consumer", "scripts", "infra"]) {
      for (const extension of ["ts", "tsx", "js", "mjs"]) {
        for (const name of ["resolvePolicy", "createDefaultPolicySource", "createRowsPolicySource", "PolicySource", "PolicySourceScope", "POLICY_PRESETS", "POLICY_FIELDS", "matchPolicyGlob", "PolicyRowsSchema", "DEFAULT_POLICY_PRESET"]) {
          const file = join(root, directory, `caller.${extension}`);
          writeFileSync(file, `import { ${name} as chosen } from "@agentx/contracts";\nvoid chosen;\n`);
          expect(policyCallers(root), `${directory}/${extension}/${name}`).toEqual([file]);
          rmSync(file);
        }
      }
    }
    writeFileSync(join(root, "scripts/unrelated.ts"), "interface PolicySource { policyLogicalId: string }\n");
    expect(policyCallers(root)).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it("bounds all rule/path lists and refuses polluted arrays and duplicate branch overrides", () => {
  expect(resolvePolicy({ branchRules: Array(51).fill({ pattern: "*", values: {} }), pathRules: Array(50).fill({ pattern: "*", values: {} }) }).status).toBe("refused");
  for (const name of ["branchRules", "pathRules", "branchOverrides"]) expect(resolvePolicy({ [name]: Array(101).fill(name === "branchOverrides" ? { branch: "x", values: {} } : { pattern: "*", values: {} }) }).status).toBe("refused");
  const paths = ["x"]; Object.defineProperty(paths, "__proto__", { value: { polluted: true }, enumerable: true });
  expect(resolvePolicy({ changedPaths: paths }).status).toBe("refused");
  expect(resolvePolicy({ branch: "x", branchOverrides: [{ branch: "x", values: {} }, { branch: "x", values: {} }] }).status).toBe("refused");
});
