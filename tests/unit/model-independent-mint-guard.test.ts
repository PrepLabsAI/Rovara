// TE-R2 part A (M4): who may reach the independent-decision mint. `createRovaraIndependentDecision` and `acceptAgentReply` are not in the public `@agentx/contracts` index; they live behind the subpath
// `@agentx/contracts/independent-channel`, which only the broker (and the store's test kit) may import. The guard reads every .ts, .mts, .cts, .tsx, .js, .mjs and .cjs file with the TypeScript parser (never a regex over
// the text), flags the bare identifier wherever it appears (an alias, a space before the paren, `.call`, a string key) and ignores only import lines in allow-listed files. Each bypass the review found is a test.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as publicContracts from "@agentx/contracts";
import * as subpath from "@agentx/contracts/independent-channel";
import { MINT_ALLOW, findMintMentions, mintOffenders, type MintFile } from "../support/independent-mint-guard.js";

const ROOT = join(__dirname, "..", "..");
const ID = "createRovaraIndependentDecision";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (/\.(?:ts|mts|cts|tsx|js|mjs|cjs)$/u.test(entry.name)) out.push(path.slice(ROOT.length + 1));
  }
  return out;
}
const fake = (path: string, text: string): MintFile => ({ path, text });

describe("the public index does not carry the mint", () => {
  it("@agentx/contracts exports neither createRovaraIndependentDecision nor acceptAgentReply, and still exports the rest of F2-A's reply set", () => {
    const names = Object.keys(publicContracts);
    expect(names).not.toContain(ID);
    expect(names).not.toContain("acceptAgentReply");
    expect(names).toEqual(expect.arrayContaining(["stampReplyProvenance", "selectModelReply", "modelReplyEntrySha256", "decideFromBase", "ModelReplySetSchema"]));
  });
  it("the subpath carries both", () => {
    expect(typeof subpath.createRovaraIndependentDecision).toBe("function");
    expect(typeof subpath.acceptAgentReply).toBe("function");
  });
});

describe("the repository today", () => {
  it("only the allow-listed files mention the mint, and each as often as expected (packages, scripts, infra)", () => {
    const files: MintFile[] = [];
    for (const top of ["packages", "scripts", "infra"]) for (const path of walk(join(ROOT, top))) files.push({ path, text: readFileSync(join(ROOT, path), "utf8") });
    expect(files.length).toBeGreaterThan(500); // the walk really looked
    expect(mintOffenders(files)).toEqual([]);
    for (const allowed of Object.keys(MINT_ALLOW)) expect(files.map((file) => file.path), `${allowed} is read`).toContain(allowed);
  });
  it("nothing in packages/worker/src can reach it", () => {
    const files = walk(join(ROOT, "packages", "worker", "src")).map((path) => ({ path, text: readFileSync(join(ROOT, path), "utf8") }));
    expect(files.length).toBeGreaterThan(5);
    expect(files.flatMap((file) => findMintMentions(file.path, file.text))).toEqual([]);
  });
});

describe("the guard fails on each bypass the review found", () => {
  const WORKER = "packages/worker/src/sneaky.ts";
  it("an alias", () => {
    const text = `import { ${ID} as mk } from "@agentx/contracts/independent-channel";\nexport const d = mk("a".repeat(64));\n`;
    expect(mintOffenders([fake(WORKER, text)]).length).toBeGreaterThan(0);
  });
  it("a space before the paren", () => {
    expect(mintOffenders([fake(WORKER, `const d = ${ID} ("a".repeat(64));\n`)]).length).toBeGreaterThan(0);
  });
  it(".call (and .apply, and a property access)", () => {
    expect(mintOffenders([fake(WORKER, `const d = ${ID}.call(null, "a".repeat(64));\n`)]).length).toBeGreaterThan(0);
    expect(mintOffenders([fake(WORKER, `const d = mod.${ID}("a".repeat(64));\n`)]).length).toBeGreaterThan(0);
    expect(mintOffenders([fake(WORKER, `const d = mod["${ID}"]("a".repeat(64));\n`)]).length).toBeGreaterThan(0);
  });
  it("a .mts file whose strings look like comment markers (what a regex comment stripper gets wrong)", () => {
    const text = `const open = "/*";\nconst d = ${ID}("a".repeat(64));\nconst close = "*/";\n`;
    expect(mintOffenders([fake("packages/worker/src/sneaky.mts", text)]).length).toBeGreaterThan(0);
    expect(mintOffenders([fake("packages/worker/src/sneaky.cts", text)]).length).toBeGreaterThan(0);
    expect(mintOffenders([fake("packages/worker/src/sneaky.mjs", text)]).length).toBeGreaterThan(0);
  });
  it("a template-literal and a regex-literal before the call do not hide it", () => {
    const text = "const t = `${1}/*`;\nconst r = /\\/\\*/;\nconst d = " + ID + "(\"a\".repeat(64));\nconst e = `*/`;\n";
    expect(mintOffenders([fake(WORKER, text)]).length).toBeGreaterThan(0);
  });
  it("acceptAgentReply and the subpath module specifier, however it is imported (static, dynamic, require, export-from)", () => {
    for (const text of [
      `import { acceptAgentReply } from "@agentx/contracts/independent-channel";\n`,
      `const m = await import("@agentx/contracts/independent-channel");\n`,
      `const m = require("@agentx/contracts/independent-channel");\n`,
      `export * from "../../contracts/src/model-independent-channel.js";\n`,
      `const f = acceptAgentReply;\n`,
    ]) expect(mintOffenders([fake(WORKER, text)]).length, text).toBeGreaterThan(0);
  });
  it("a broker file may import the subpath; a worker file may not; a comment or a string mention in the broker is not a problem for imports but any mention outside the allow-list is", () => {
    const importLine = `import { acceptAgentReply } from "@agentx/contracts/independent-channel";\n`;
    expect(mintOffenders([fake("packages/broker/src/core/test-env/independent-reply-agent.ts", importLine + "export const x = acceptAgentReply;\n")])).toEqual([]);
    expect(mintOffenders([fake(WORKER, importLine)]).length).toBeGreaterThan(0);
    expect(mintOffenders([fake(WORKER, `// ${ID}(h) is not allowed here\n/* acceptAgentReply */\nexport const ok = 1;\n`)])).toEqual([]);
  });
  it("an allow-listed file may not mint more often than expected", () => {
    const channel = "packages/contracts/src/model-independent-channel.ts";
    expect(mintOffenders([fake(channel, `import { ${ID} } from "./model-reply-set.js";\nexport const a = () => ${ID}("x");\n`)])).toEqual([]);
    expect(mintOffenders([fake(channel, `import { ${ID} } from "./model-reply-set.js";\nexport const a = () => ${ID}("x");\nexport const b = () => ${ID}("y");\n`)]).length).toBeGreaterThan(0);
  });
  it("the guard sees ordinary code (positive control)", () => {
    expect(findMintMentions("x.ts", `const a = ${ID}("h");`).length).toBe(1);
    expect(findMintMentions("x.ts", `// ${ID}\nconst s = "nothing";`)).toEqual([]);
  });
});
