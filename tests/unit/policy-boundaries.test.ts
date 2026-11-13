import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import ts from "typescript";
import { isolatedGitEnvironment } from "../../packages/worker/src/git.js";
import { resolvePolicy } from "../../packages/contracts/src/policy.js";

const BASE = "c93edabcba4b9ae45cc3e0390d55fca62105222b";
it("keeps the existing policy port byte-identical to the approved base", () => {
  const base = spawnSync("git", ["show", `${BASE}:packages/contracts/src/ports/policy.ts`], { env: isolatedGitEnvironment(process.cwd()), encoding: "utf8" });
  expect(base.status, base.stderr).toBe(0);
  expect(readFileSync("packages/contracts/src/ports/policy.ts", "utf8")).toBe(base.stdout);
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
