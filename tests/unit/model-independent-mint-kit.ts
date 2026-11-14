// TE-R2 part A (M4): the guard behind `tests/unit/model-independent-mint-guard.test.ts`. It finds every mention of the two names that reach the `independent` mint (`createRovaraIndependentDecision`, `acceptAgentReply`) and of the
// module that carries them (`independent-channel`, `model-independent-channel`) in a source file, using the TypeScript parser: comments are never read as code and a string such as "/*" never hides anything. A mention is
// the bare identifier wherever it appears (an alias, a space before the paren, `.call`, a property access) or a string literal that contains it (`mod["createRovaraIndependentDecision"]`).
import ts from "typescript";

export const MINT_NAMES = ["createRovaraIndependentDecision", "acceptAgentReply"] as const;
export type MintName = (typeof MINT_NAMES)[number];
export interface MintFile {
  readonly path: string;
  readonly text: string;
}
export interface MintMention {
  readonly kind: "import" | "other" | "specifier";
  readonly name: MintName | "specifier";
  readonly line: number;
}

const SPECIFIER = /(?:^|\/)(?:model-)?independent-channel(?:\.[cm]?[jt]sx?)?$/u;
const NAME_IN_TEXT = new RegExp(`\\b(${MINT_NAMES.join("|")})\\b`, "u");

/** How many times a file may mention each name outside an import line (Infinity: any number), and whether it may import the module. */
export interface MintAllowance {
  readonly createRovaraIndependentDecision?: number;
  readonly acceptAgentReply?: number;
  readonly specifier?: boolean;
}
/** Exact files. Each must exist (a test reads them). */
export const MINT_ALLOW: Readonly<Record<string, MintAllowance>> = {
  // F2-A's definition: the declaration itself.
  "packages/contracts/src/model-reply-set.ts": { createRovaraIndependentDecision: 1 },
  // R1's `decisionForEntry`: the one call that stamps a store entry listed as independent.
  "packages/contracts/src/model-reply-store-rules.ts": { createRovaraIndependentDecision: 1 },
  // R2's channel: the one call that mints a decision for an agent reply, and the function that does it.
  "packages/contracts/src/model-independent-channel.ts": { createRovaraIndependentDecision: 1, acceptAgentReply: 1 },
  // The subpath entry: one re-export.
  "packages/contracts/src/independent-channel.ts": { createRovaraIndependentDecision: 1, specifier: true },
  // The store's shared conformance suite forges look-alikes on purpose.
  "packages/testing/src/ports/reply-set-store-conformance.ts": { createRovaraIndependentDecision: Number.POSITIVE_INFINITY, specifier: true },
};
/** Directories whose files may import the subpath and call `acceptAgentReply` (the broker's agent step). They may not mention the mint itself. */
export const MINT_ALLOW_PREFIXES: Readonly<Record<string, MintAllowance>> = {
  "packages/broker/src/": { acceptAgentReply: Number.POSITIVE_INFINITY, specifier: true },
  "packages/contracts/src/": { specifier: true },
};

/** Every mention in one file, found by parsing it. */
export function findMintMentions(path: string, text: string): MintMention[] {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const mentions: MintMention[] = [];
  const lineOf = (node: ts.Node): number => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  const visit = (node: ts.Node, inImport: boolean): void => {
    if (ts.isImportDeclaration(node)) {
      inImport = true;
      if (ts.isStringLiteral(node.moduleSpecifier) && SPECIFIER.test(node.moduleSpecifier.text)) mentions.push({ kind: "specifier", name: "specifier", line: lineOf(node) });
      if (node.importClause !== undefined) ts.forEachChild(node.importClause, (child) => visit(child, true));
      return;
    }
    if (ts.isIdentifier(node)) {
      const name = MINT_NAMES.find((candidate) => candidate === node.text);
      if (name !== undefined) mentions.push({ kind: inImport ? "import" : "other", name, line: lineOf(node) });
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      if (SPECIFIER.test(node.text)) mentions.push({ kind: "specifier", name: "specifier", line: lineOf(node) });
      const found = NAME_IN_TEXT.exec(node.text);
      if (found !== null) mentions.push({ kind: "other", name: found[1] as MintName, line: lineOf(node) });
    }
    ts.forEachChild(node, (child) => visit(child, inImport));
  };
  visit(file, false);
  return mentions;
}

const allowanceOf = (path: string): MintAllowance => {
  const exact = MINT_ALLOW[path];
  if (exact !== undefined) return exact;
  const prefix = Object.keys(MINT_ALLOW_PREFIXES).find((candidate) => path.startsWith(candidate));
  return prefix === undefined ? {} : (MINT_ALLOW_PREFIXES[prefix] ?? {});
};

/** The mentions that are not allowed, as `path:line name`. Import lines are ignored only in files whose allowance names that identifier or module. */
export function mintOffenders(files: readonly MintFile[]): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    const allowance = allowanceOf(file.path);
    const used = new Map<MintName, number>();
    for (const mention of findMintMentions(file.path, file.text)) {
      if (mention.kind === "specifier") {
        if (allowance.specifier !== true) offenders.push(`${file.path}:${mention.line} imports the independent channel`);
        continue;
      }
      const name = mention.name as MintName;
      if (mention.kind === "import") {
        if (allowance[name] === undefined) offenders.push(`${file.path}:${mention.line} imports ${name}`);
        continue;
      }
      const count = (used.get(name) ?? 0) + 1;
      used.set(name, count);
      if (count > (allowance[name] ?? 0)) offenders.push(`${file.path}:${mention.line} mentions ${name}`);
    }
  }
  return offenders;
}
