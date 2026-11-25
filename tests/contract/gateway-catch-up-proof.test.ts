// The gateway catch-up proof (scripts/gateway-catch-up-proof.ts): Code's copy of the model gateway equals Cloud's at the pinned commit,
// byte for byte, except for the replacements the manifest declares. It passes on today's tree and fails on one changed byte anywhere
// else (each case below plants a temporary copy of the proof's files, never the real tree).
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { blobId, readManifest, rebuildCloud, runProof, type Manifest } from "../../scripts/gateway-catch-up-proof.js";

const repo = process.cwd();
const manifest = readManifest();
const temporary: string[] = [];
afterAll(() => { for (const directory of temporary) rmSync(directory, { recursive: true, force: true }); });

/** Every file the proof reads, copied into a temporary tree. */
function plantTree(): string {
  const directory = mkdtempSync(join(tmpdir(), "gateway-proof-"));
  temporary.push(directory);
  const paths = [...Object.keys(manifest.exact), ...Object.keys(manifest.adapted), ...Object.keys(manifest.linePins), "infra/lib/model-gateway-switches.ts"];
  for (const path of paths) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    copyFileSync(join(repo, path), join(directory, path));
  }
  return directory;
}
const edit = (tree: string, path: string, change: (text: string) => string): void => writeFileSync(join(tree, path), change(readFileSync(join(tree, path), "utf8")));
const failures = async (tree: string, withManifest: Manifest = manifest): Promise<string[]> => (await runProof({ root: tree, manifest: withManifest })).failures;

describe("gateway catch-up proof", () => {
  it("passes on today's tree", async () => {
    const report = await runProof({ root: repo });
    expect(report.failures).toEqual([]);
    expect(report.summary.join("\n")).toMatch(/exact: \d+ of \d+ files equal Cloud blob for blob/u);
  });

  it("names the tests one by one: the 19 gateway tests Cloud changed since the copy point, 16 carried and 3 left in Cloud", () => {
    const carried = [...Object.keys(manifest.exact), ...Object.keys(manifest.adapted)].filter((path) => path.startsWith("tests/") && !path.startsWith("tests/fixtures/"));
    const left = Object.keys(manifest.declaredNotPorted).filter((path) => path.startsWith("tests/"));
    expect(carried.sort()).toEqual([
      "tests/contract/model-gateway-bedrock-byo-infra.test.ts",
      "tests/contract/model-gateway-product-infra.test.ts",
      "tests/contract/model-gateway-rovara-ai-infra.test.ts",
      "tests/unit/agent-own-key-backfill.test.ts",
      "tests/unit/model-gateway-bedrock-byo-route.test.ts",
      "tests/unit/model-gateway-byo-money.test.ts",
      "tests/unit/model-gateway-cut-call-actual.test.ts",
      "tests/unit/model-gateway-deployed-product.test.ts",
      "tests/unit/model-gateway-openrouter-reviewed-v3-review.test.ts",
      "tests/unit/model-gateway-product-bedrock-deployed.test.ts",
      "tests/unit/model-gateway-product-bedrock-eval-hold.test.ts",
      "tests/unit/model-gateway-reviewer-grants.test.ts",
      "tests/unit/model-gateway-round2.test.ts",
      "tests/unit/model-gateway-rovara-default.test.ts",
      "tests/unit/model-gateway-run-charges-read.test.ts",
      "tests/unit/model-gateway-task-ended-notice.test.ts",
    ]);
    expect(left.sort()).toEqual([
      "tests/contract/model-gateway-agent-ai-default.test.ts",
      "tests/unit/agent-own-key-backfill-cli.test.ts",
      "tests/unit/ai-source-switch.test.ts",
    ]);
  });

  it("covers every file under packages/model-gateway, the image files, the base tsconfig, the shared contracts and the gateway's scripts", () => {
    const listed = Object.keys(manifest.exact);
    for (const path of ["packages/model-gateway/package.json", "packages/model-gateway/tsconfig.json", "environments/model-gateway/Dockerfile", "environments/model-gateway/toolchain/package.json", "environments/model-gateway/toolchain/package-lock.json", "tsconfig.base.json", "scripts/model-gateway-image.ts", "contracts/shared/model-gateway-token.v1.json"]) expect(listed).toContain(path);
    for (const path of ["packages/model-gateway/src/run-charges-read.ts", "packages/model-gateway/src/task-ended-notice.ts", "packages/model-gateway/src/server.ts"]) expect(listed).toContain(path);
    expect(Object.keys(manifest.declaredNotPorted).filter((path) => path.startsWith("scripts/")).sort()).toEqual(["scripts/agent-own-key-backfill.mjs", "scripts/model-gateway-measure.ts", "scripts/model-gateway-prices-live-check.ts", "scripts/model-gateway-rovara-ai-stop.mjs", "scripts/model-gateway-source-stop-clear.mjs"]);
  });

  it("fails on one changed byte in a copied source file", async () => {
    const tree = plantTree();
    edit(tree, "packages/model-gateway/src/server.ts", (text) => `${text} `);
    expect(await failures(tree)).toEqual(["exact: packages/model-gateway/src/server.ts differs from Cloud at afb494e75"]);
  });

  it("fails on one changed byte in a copied test, a fixture, the image files and the base tsconfig", async () => {
    for (const path of ["tests/unit/model-gateway-cut-call-actual.test.ts", "tests/fixtures/model-gateway/pi-ai-1.5.2-multiturn.json", "environments/model-gateway/Dockerfile", "environments/model-gateway/toolchain/package-lock.json", "tsconfig.base.json", "packages/model-gateway/tsconfig.json"]) {
      const tree = plantTree();
      edit(tree, path, (text) => `${text}\n`);
      expect(await failures(tree), path).toEqual([`exact: ${path} differs from Cloud at afb494e75`]);
    }
  });

  it("fails on a file that is missing and on a file added to the gateway package", async () => {
    const tree = plantTree();
    rmSync(join(tree, "packages/model-gateway/src/ended.ts"));
    writeFileSync(join(tree, "packages/model-gateway/src/extra.ts"), "export {};\n");
    expect((await failures(tree)).sort()).toEqual(["exact: packages/model-gateway/src/ended.ts is missing", "exact: packages/model-gateway/src/extra.ts is in Code's gateway package but not in the manifest"]);
  });

  it("an adapted file may differ only in its declared replacements", async () => {
    const outside = plantTree();
    edit(outside, "infra/lib/model-gateway.ts", (text) => text.replace("const bedrockByo = product === undefined", "const bedrockByo = product !== undefined"));
    expect(await failures(outside)).toEqual(["adapted: infra/lib/model-gateway.ts differs from Cloud outside its declared replacements"]);

    const inside = plantTree();
    edit(inside, "infra/lib/model-gateway.ts", (text) => text.replace('from "./model-gateway-boundary.js"', 'from "./model-gateway-boundary2.js"'));
    expect(await failures(inside)).toContain("adapted: infra/lib/model-gateway.ts no longer holds its declared replacement at line 25");

    const helper = plantTree();
    edit(helper, "infra/lib/model-gateway-boundary.ts", (text) => `${text}// more\n`);
    expect(await failures(helper)).toEqual(["adapted: infra/lib/model-gateway-boundary.ts differs from Cloud outside its declared replacements"]);
  });

  it("an adapted test whose Cloud side is not written down is held by the blob id of Code's file", async () => {
    for (const path of ["tests/contract/model-gateway-product-infra.test.ts", "tests/unit/model-gateway-rovara-default.test.ts"]) {
      const tree = plantTree();
      edit(tree, path, (text) => `${text}\n`);
      expect(await failures(tree), path).toEqual([`adapted: ${path} differs from the pinned adapted file`]);
    }
  });

  it("holds the hand-written files to Cloud's lines: bedrock allowed for production, the named refusal, and no Bedrock context key", async () => {
    const kinds = plantTree();
    edit(kinds, "infra/lib/model-gateway-contracts.ts", (text) => text.replace('["openai", "bedrock"]', '["openai"]'));
    expect((await failures(kinds))[0]).toMatch(/^linePins: infra\/lib\/model-gateway-contracts\.ts lacks a line it repeats from Cloud's packages\/contracts\/src\/model-sources\.ts: export const PRODUCTION_SOURCE_KINDS/u);

    // The bodies of the two functions that decide what production may name are held too, not only the constants.
    for (const [from, to] of [
      ['  return kinds as CustomSourceKind[];', '  return kinds.slice(1) as CustomSourceKind[];'],
      ['  return parseSourceKindsSwitch(value).every((kind) => PRODUCTION_SOURCE_KINDS.includes(kind));', '  return parseSourceKindsSwitch(value).some((kind) => PRODUCTION_SOURCE_KINDS.includes(kind));'],
      ['if (kinds.length > CUSTOM_SOURCE_KINDS.length ||', 'if (kinds.length > CUSTOM_SOURCE_KINDS.length + 1 ||'],
    ] as const) {
      const body = plantTree();
      edit(body, "infra/lib/model-gateway-contracts.ts", (text) => { expect(text).toContain(from); return text.replace(from, to); });
      expect((await failures(body))[0], from).toMatch(/^linePins: infra\/lib\/model-gateway-contracts\.ts lacks a line it repeats from Cloud's packages\/contracts\/src\/model-sources\.ts: /u);
    }

    const key = plantTree();
    edit(key, "infra/lib/model-gateway-app.ts", (text) => `${text}// MODEL_GATEWAY_BEDROCK_BYO_CONTEXT_KEY\n`);
    expect(await failures(key)).toEqual(["linePins: infra/lib/model-gateway-app.ts still carries MODEL_GATEWAY_BEDROCK_BYO_CONTEXT_KEY, which Cloud's infra/lib/app.ts dropped"]);
  });

  it("holds the beta source kinds to Cloud's row: openai,bedrock", async () => {
    const tree = plantTree();
    edit(tree, "infra/lib/model-gateway-switches.ts", (text) => text.replace('beta: Object.freeze({ aiSourceKinds: "openai,bedrock" })', 'beta: Object.freeze({ aiSourceKinds: "openai" })'));
    expect(await failures(tree)).toEqual(["switches: beta aiSourceKinds is openai, Cloud's row is openai,bedrock"]);
  });

  it("fails when a Cloud file the manifest says stays in Cloud appears in Code", async () => {
    const tree = plantTree();
    mkdirSync(join(tree, "scripts"), { recursive: true });
    writeFileSync(join(tree, "scripts/model-gateway-measure.ts"), "export {};\n");
    expect(await failures(tree)).toEqual(["declaredNotPorted: scripts/model-gateway-measure.ts exists in Code but the manifest says it stays in Cloud"]);
  });

  it("a later deliberate change passes only when it is recorded with the new blob id and a reason", async () => {
    const tree = plantTree();
    edit(tree, "packages/model-gateway/src/guard.ts", (text) => `${text}\n// a later change\n`);
    expect(await failures(tree)).toHaveLength(1);
    const changed = readFileSync(join(tree, "packages/model-gateway/src/guard.ts"));
    const recorded: Manifest = { ...manifest, divergedFromCloud: { "packages/model-gateway/src/guard.ts": { blob: blobId(changed), reason: "test" } } };
    expect(await failures(tree, recorded)).toEqual([]);
    edit(tree, "packages/model-gateway/src/guard.ts", (text) => `${text} `);
    expect(await failures(tree, recorded)).toEqual(["exact: packages/model-gateway/src/guard.ts differs from its recorded divergence"]);
  });

  it("puts a hunk's Cloud lines back where Code's numbering has moved", () => {
    const hunks = [
      { cloudStart: 2, cloudCount: 1, cloudSha256: "", code: [], cloud: ["b"] },
      { cloudStart: 4, cloudCount: 1, cloudSha256: "", code: ["D", "D2"], cloud: ["d"] },
    ];
    expect(rebuildCloud("a\nc\nD\nD2\ne", hunks).text).toBe("a\nb\nc\nd\ne");
    expect(rebuildCloud("a\nc\nX\nD2\ne", hunks).misplaced).toEqual(["line 4"]);
  });

  it("exits 0 on today's tree and 1 on a planted one-byte change, as CI runs it", () => {
    const script = join(repo, "scripts/gateway-catch-up-proof.ts");
    const clean = spawnSync(process.execPath, [script, "check"], { cwd: repo, encoding: "utf8" });
    expect([clean.status, clean.stdout.trim().split("\n").pop()]).toEqual([0, "gateway catch-up proof: PASS"]);
    const tree = plantTree();
    edit(tree, "packages/model-gateway/src/process.ts", (text) => text.replace("a", "b"));
    const broken = spawnSync(process.execPath, [script, "check", "--root", tree], { cwd: repo, encoding: "utf8" });
    expect(broken.status).toBe(1);
    expect(broken.stdout).toContain("FAIL exact: packages/model-gateway/src/process.ts differs from Cloud at afb494e75");
  });
});
