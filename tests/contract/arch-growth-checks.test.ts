// E1-0: the two dependency-free architecture checks (arch rules 1, 2 and 4), each a ratchet that only goes down.
//   1. scripts/copied-contracts-check.ts: no NEW copied contract file (a file under contracts/shared, a source file marked as a copy of Cloud's, a hash-pinned contract, a twin across packages).
//   2. scripts/settings-growth-check.ts: the stack parameters and the settings (BROKER_SETTINGS, CONFIG_KEYS, OPERATOR_PARAMETERS) may not grow without naming the new row in the baseline.
// Each passes on today's tree and fails on a planted example (a temporary tree written here, never the real one).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import * as copies from "../../scripts/copied-contracts-check.js";
import * as growth from "../../scripts/settings-growth-check.js";

const root = process.cwd();
const temporary: string[] = [];
function plant(files: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), "e1-0-"));
  temporary.push(directory);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), text);
  }
  return directory;
}
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

/** A body long enough to be a twin, with its own import lines. */
const body = (imports: string, name = "field"): string => `${imports}\nexport const FIELDS = [${Array.from({ length: copies.TWIN_MIN_LINES + 2 }, (_, i) => `"${name}${i}"`).join(",\n")}];\n`;

describe("check 1: no new copied contract file", () => {
  const scan = copies.scanRepository(root);
  const baseline = copies.readBaseline(root);

  it("passes on today's tree: every copy the scan finds is in the baseline", () => {
    expect(copies.compareToBaseline(scan, baseline).added).toEqual([]);
  });

  it("has a baseline that is today's scan, so it shrinks with every deletion and never grows", () => {
    expect(copies.compareToBaseline(scan, baseline).removed).toEqual([]);
    expect(copies.formatBaseline(baseline)).toBe(copies.formatBaseline(copies.shrunkBaseline(scan, baseline)));
  });

  it("finds the copies the specs name: the shared wire files, the marked contracts and the hash pins", () => {
    expect(scan["contracts/shared/task-money.v1.json"]).toContain("shared");
    expect(scan["packages/contracts/src/task-money.ts"]).toContain("marked");
    expect(scan["packages/contracts/src/task-words.ts"]).toContain("marked");
    expect(scan["packages/contracts/src/audit-record-v1.ts"]).toContain("pinned");
    expect(scan["packages/contracts/src/start-estimates.ts"]).toContain("pinned");
    expect(Object.keys(scan).length).toBeGreaterThanOrEqual(18);
  });

  it("does not take an ordinary contract, or a frozen-interface hash with no copy word near it, for a copy", () => {
    expect(scan["packages/contracts/src/ports/policy.ts"]).toBeUndefined();
    expect(scan["packages/contracts/src/index.ts"]).toBeUndefined();
  });

  it("fails a new file under contracts/shared", () => {
    const tree = plant({ "contracts/shared/new-thing.v1.json": "{}" });
    const added = copies.compareToBaseline(copies.scanRepository(tree), {}).added;
    expect(added).toEqual(["contracts/shared/new-thing.v1.json"]);
    expect(copies.describeAdded(copies.scanRepository(tree), added).join("\n")).toContain("new copied contract file");
  });

  it("fails a source file whose leading comment says it is a copy of Cloud's, in every wording used today", () => {
    for (const header of ["// Copied from Cloud's terminal-result.ts", "/** X: contracts/shared/x.json is canonical in Code and Cloud. */", "// a COPY of Cloud v0.5.11", "// copied to Cloud, which draws the words", "// Cloud's mirror of the shape"]) {
      const tree = plant({ "packages/contracts/src/x.ts": `${header}\nexport const X = 1;\n` });
      expect(Object.keys(copies.scanRepository(tree)), header).toEqual(["packages/contracts/src/x.ts"]);
    }
  });

  it("reads only the leading comment: the same words deep in the code, or in a test, are no marker", () => {
    const tree = plant({
      "packages/contracts/src/a.ts": "export const A = 1;\n// Copied from Cloud's old file, then rewritten.\n",
      "packages/contracts/src/b.test.ts": "// Copied from Cloud\n",
      "packages/contracts/src/c.ts": "// An ordinary contract.\nexport const C = 1;\n",
    });
    expect(copies.scanRepository(tree)).toEqual({});
  });

  it("fails a contract file whose bytes are pinned by sha256 in a shared pin file, or by a test that calls it mirrored", () => {
    const tree = plant({
      "packages/contracts/src/pinned-a.ts": "export const A = 1;\n",
      "packages/contracts/src/pinned-b.ts": "export const B = 1;\n",
      "packages/contracts/src/plain.ts": "export const P = 1;\n",
      "contracts/shared/a.sha256.json": JSON.stringify({ "packages/contracts/src/pinned-a.ts": "00" }),
      "tests/unit/b.test.ts": 'it("pins the mirrored contract", () => {\n  const bytes = readFileSync("packages/contracts/src/pinned-b.ts");\n  createHash("sha256").update(bytes);\n});\n',
      "tests/unit/plain.test.ts": 'it("freezes the interface", () => {\n  const bytes = readFileSync("packages/contracts/src/plain.ts");\n  createHash("sha256").update(bytes);\n});\n',
    });
    const found = copies.scanRepository(tree);
    expect(found["packages/contracts/src/pinned-a.ts"]).toContain("pinned");
    expect(found["packages/contracts/src/pinned-b.ts"]).toContain("pinned");
    expect(found["packages/contracts/src/plain.ts"]).toBeUndefined();
  });

  it("fails a contract module duplicated between two packages, even with its import paths changed, and not within one package or when short", () => {
    const tree = plant({
      "packages/contracts/src/shape.ts": `// the original\n${body('import { z } from "zod";')}`,
      "packages/broker/src/core/shape-copy.ts": `// a copy\n${body('import { z } from "../../zod-wrapper.js";')}`,
      "packages/worker/src/one.ts": body("", "other"),
      "packages/worker/src/two.ts": body("", "other"),
      "packages/cli/src/small-a.ts": "export const S = 1;\n",
      "packages/gateway/src/small-b.ts": "export const S = 1;\n",
    });
    const found = copies.scanRepository(tree);
    expect(Object.keys(found).sort()).toEqual(["packages/broker/src/core/shape-copy.ts", "packages/contracts/src/shape.ts"]);
    expect(found["packages/broker/src/core/shape-copy.ts"]).toContain("twin");
  });

  it("passes a path that was a copy and is gone, and shrink drops it without ever adding one", () => {
    const now = { "contracts/shared/a.json": ["shared" as const] };
    const old = { "contracts/shared/a.json": ["shared" as const], "packages/contracts/src/gone.ts": ["marked" as const] };
    expect(copies.compareToBaseline(now, old)).toEqual({ added: [], removed: ["packages/contracts/src/gone.ts"] });
    expect(copies.shrunkBaseline(now, old)).toEqual(now);
    expect(copies.shrunkBaseline({ ...now, "contracts/shared/new.json": ["shared" as const] }, old)).toEqual(now);
  });

  it("runs as a script: exit 0 with its own baseline, exit 1 and the file named when a copy is added", () => {
    const script = join(root, "scripts/copied-contracts-check.ts");
    const clean = spawnSync(process.execPath, [script, "check"], { cwd: root, encoding: "utf8" });
    expect(clean.status, clean.stderr).toBe(0);
    const tree = plant({ "scripts/copied-contracts-baseline.json": "{}\n", "contracts/shared/new-thing.v1.json": "{}" });
    const failed = spawnSync(process.execPath, [script, "check"], { cwd: tree, encoding: "utf8" });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("contracts/shared/new-thing.v1.json");
    const refused = spawnSync(process.execPath, [script, "shrink"], { cwd: tree, encoding: "utf8" });
    expect(refused.status).not.toBe(0);
    expect(readFileSync(join(tree, "scripts/copied-contracts-baseline.json"), "utf8")).toBe("{}\n");
  });
});

describe("check 2: the stack parameters and the settings may not grow", () => {
  const now = growth.currentCounts(root);
  const baseline = growth.readBaseline(root);
  const sum = (counts: Record<string, number>) => Object.values(counts).reduce((total, count) => total + count, 0);
  // The planted examples below add to (or remove from) whatever the tree and the baseline already differ by, so none of them hard-codes today's totals: they count only what each one plants.
  const already = growth.compareToBaseline(now, baseline);
  // Decision lines of the baseline rows added after E1-0: brokerSettings coreOutboxStreamRelay = "G1 / Opus money PASS 4f7ef0856" (CORE-RUN-STOP-RELAY, #1446).
  // operatorParameters, 19 names (control-plane: DeveloperGithubClientId, DeveloperGithubSince, DeveloperOidcClientId, DeveloperOidcDisplayName, DeveloperOidcIssuer, DeveloperOidcRequiredClaim, DeveloperOidcRequiredValues,
  // DeveloperOidcSince, DeveloperSignInGithub, DeveloperSignInSlack, DeveloperSignInSlackSince, OpenRouterSecretArn, SlackTeamId; runtime: OpenRouterSecretArn; slack: ChannelEventQueueUrl, ChannelRequestQueueUrl,
  // OpenRouterSecretArn, SlackAdapterCommandsUrl, SlackAdapterSecretName) = "F1 L1a-1 kept-on-upgrade set (+19: existing parameters an upgrade used to reset), Opus PASS ac76bd063" (owner DEC 254zzz507 beta snapshot).
  // Not new settings: a one-time, deliberate step in the ratchet.
  // stackParameters, four names (infra/lib/canary-session.ts: CanarySessionPlacementEnvironment, CanarySessionPerson, CanarySessionCompany, CanarySessionStepRoleName) = "kind: operator placement (which environment a
  // resource exists in), not a customer or company setting, never shown in any screen; who asked: the owner (beta canary person for real-call proofs, CANARY-SESSION plan, arch ruling bbff6b7dd); why not a default: the values
  // are beta-only identities that must stay EMPTY in every other install; a default would place a canary everywhere; removal: with the canary itself." They stay CloudFormation parameters (arch ruling: lock 1 is a template
  // condition, which can only test a whole parameter), and each has an install row (control-plane, declaredIn legacy), so none is a kept-on-upgrade name.

  it("passes on today's tree: nothing above the baseline", () => {
    expect(growth.compareToBaseline(now, baseline).raised).toEqual([]);
  });

  it("has a baseline that is today's counts, so it shrinks with every removal and never grows", () => {
    expect(growth.compareToBaseline(now, baseline).lowered).toEqual([]);
    expect(growth.formatBaseline(baseline)).toBe(growth.formatBaseline(growth.shrunkBaseline(now, baseline)));
  });

  it("counts what the rule names: the stack parameters, BROKER_SETTINGS, CONFIG_KEYS and the kept-on-upgrade parameters", () => {
    expect(sum(now.stackParameters)).toBeGreaterThan(100);
    expect(now.stackParameters["infra/lib/access.ts::OperatorPrincipalArn"]).toBe(1);
    expect(now.brokerSettings).toContain("coreTaskCap");
    expect(now.configKeys).toContain("models.orchestrator");
    expect(now.operatorParameters).toContain("runtime:E2eAgentModelId");
  });

  it("counts a CDK core parameter and leaves an SSM parameter (a resource, not a stack parameter) out", () => {
    const text = [
      'const a = new CfnParameter(this, "Alpha", { type: "String" });',
      'const b = new cdk.CfnParameter(stack, `Beta`, { type: "String" });',
      "const c = new CfnParameter(stack, ID_CONSTANT, {});",
      'new ssm.CfnParameter(this, "Settings", {});',
      'new aws_ssm.CfnParameter(this, "Other", {});',
      'const d = new CfnParameter(this, "Alpha", {});',
    ].join("\n");
    expect(growth.stackParametersIn(text)).toEqual({ Alpha: 2, Beta: 1, ID_CONSTANT: 1 });
  });

  it("fails a new stack parameter and names the file and the parameter", () => {
    const tree = plant({ "infra/lib/new-thing.ts": 'const p = new CfnParameter(this, "BrandNewSwitch", { type: "String", default: "off" });\n' });
    const planted = { ...now, stackParameters: { ...now.stackParameters, ...growth.scanStackParameters(tree) } };
    const { raised } = growth.compareToBaseline(planted, baseline);
    expect(raised).toHaveLength(already.raised.length + 1);
    const planted1 = raised.filter((line) => line.includes("infra/lib/new-thing.ts::BrandNewSwitch"));
    expect(planted1).toHaveLength(1);
    expect(planted1[0]).toContain("rule 2");
  });

  it("fails a second declaration of a parameter the baseline holds once", () => {
    const [name] = Object.keys(baseline.stackParameters);
    const planted = { ...now, stackParameters: { ...now.stackParameters, [name!]: baseline.stackParameters[name!]! + 1 } };
    expect(growth.compareToBaseline(planted, baseline).raised.join("\n")).toContain(name);
  });

  it("fails a new broker setting, a new config key and a new kept-on-upgrade parameter, each by name", () => {
    const planted = { ...now, brokerSettings: [...now.brokerSettings, "freshSetting"], configKeys: [...now.configKeys, "fresh.key"], operatorParameters: [...now.operatorParameters, "runtime:FreshParameter"] };
    const { raised } = growth.compareToBaseline(planted, baseline);
    expect(raised).toHaveLength(already.raised.length + 3);
    expect(raised.join("\n")).toContain("brokerSettings: freshSetting");
    expect(raised.join("\n")).toContain("configKeys: fresh.key");
    expect(raised.join("\n")).toContain("operatorParameters: runtime:FreshParameter");
  });

  it("passes a removal, and shrink writes only the lower entries and never a new one", () => {
    const fewer = { ...now, brokerSettings: now.brokerSettings.slice(1), stackParameters: { ...now.stackParameters } };
    delete fewer.stackParameters["infra/lib/access.ts::OperatorPrincipalArn"];
    const { raised, lowered } = growth.compareToBaseline(fewer, baseline);
    expect(raised).toEqual([]);
    expect(lowered).toHaveLength(already.lowered.length + 2);
    const shrunk = growth.shrunkBaseline(fewer, baseline);
    expect(shrunk.brokerSettings).toEqual(baseline.brokerSettings.filter((name) => fewer.brokerSettings.includes(name)));
    expect(shrunk.stackParameters["infra/lib/access.ts::OperatorPrincipalArn"]).toBeUndefined();
    const grown = growth.shrunkBaseline({ ...now, configKeys: [...now.configKeys, "fresh.key"] }, baseline);
    expect(grown.configKeys).not.toContain("fresh.key");
  });

  it("runs as a script: exit 0 on today's tree, exit 1 naming the parameter when one is added, and shrink refuses to write it", () => {
    const tsx = join(root, "node_modules/tsx/dist/cli.mjs");
    const script = join(root, "scripts/settings-growth-check.ts");
    const clean = spawnSync(process.execPath, [tsx, script, "check"], { cwd: root, encoding: "utf8" });
    expect(clean.status, clean.stderr).toBe(0);
    const tree = plant({
      "scripts/settings-growth-baseline.json": readFileSync(join(root, growth.BASELINE_PATH), "utf8"),
      "infra/lib/new-thing.ts": 'const p = new CfnParameter(this, "BrandNewSwitch", { type: "String" });\n',
    });
    const failed = spawnSync(process.execPath, [tsx, script, "check"], { cwd: tree, encoding: "utf8" });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("infra/lib/new-thing.ts::BrandNewSwitch");
    expect(spawnSync(process.execPath, [tsx, script, "shrink"], { cwd: tree, encoding: "utf8" }).status).not.toBe(0);
  }, 60_000);
});
