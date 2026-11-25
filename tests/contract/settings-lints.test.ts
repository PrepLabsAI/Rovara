// F1 lane L0: the settings lints and their shrink-only baselines (scripts/settings-lints.ts). A hand-declared CfnParameter, a CDK context read or a direct environment read in the broker
// may not appear where the baseline has none, nor above its count; a lower count passes and the baseline can only be shrunk. The tombstone lint is exercised on fixtures: the tombstone
// list is empty until the first removal lane.
import { describe, expect, it } from "vitest";
import { SETTING_TOMBSTONES } from "@agentx/contracts";
import {
  RAISED_SINCE_BASE, compareToBaseline, countMatches, formatBaseline, readBaseline, scanRepository, shrunkBaseline, tombstoneKeyMayAppearIn, tombstoneProblems, type LintScan,
} from "../../scripts/settings-lints.js";

const scan = scanRepository(process.cwd());
const baseline = readBaseline(process.cwd());
const sum = (counts: Record<string, number>) => Object.values(counts).reduce((total, count) => total + count, 0);

describe("the settings lints hold today's counts (F1 L0)", () => {
  it("finds no hand-declared parameter, context read or direct broker environment read above the baseline", () => {
    expect(compareToBaseline(scan, baseline).raised).toEqual([]);
  });

  it("has a baseline that is today's scan, so it shrinks with every removal and never rises", () => {
    expect(compareToBaseline(scan, baseline).lowered).toEqual([]);
    expect(formatBaseline(baseline)).toBe(formatBaseline(shrunkBaseline(scan, baseline)));
  });

  it("explains every count that rose after the lane's base: each is a stated baseline entry with its commit and the reason it has no row", () => {
    for (const entry of RAISED_SINCE_BASE) {
      expect(baseline[entry.lint][entry.file], `${entry.lint}: ${entry.file}`).toBe(entry.count);
      expect(entry.reason.length, `${entry.file} reason`).toBeGreaterThan(40);
      expect(entry.commit, `${entry.file} commit`).toMatch(/^[0-9a-f]{9} \(/u);
    }
  });

  it("counts what the plan named: the hand-declared parameters, the context reads and the broker's environment reads", () => {
    expect(sum(scan.cfnParameter)).toBeGreaterThan(100);
    expect(sum(scan.tryGetContext)).toBeGreaterThanOrEqual(20);
    expect(sum(scan.processEnv)).toBeGreaterThan(300);
    expect(Object.keys(scan.tryGetContext)).toContain("infra/lib/app.ts");
  });
});

describe("the baseline comparison (F1 L0)", () => {
  const base: LintScan = { cfnParameter: { "infra/lib/a.ts": 2 }, tryGetContext: {}, processEnv: { "packages/broker/src/x.ts": 5 } };

  it("fails a count that went up, and a file that was not in the baseline, saying to add a row", () => {
    const worse: LintScan = { cfnParameter: { "infra/lib/a.ts": 3, "infra/lib/new.ts": 1 }, tryGetContext: { "infra/lib/app.ts": 1 }, processEnv: { "packages/broker/src/x.ts": 5 } };
    const { raised } = compareToBaseline(worse, base);
    expect(raised).toHaveLength(3);
    expect(raised.join("\n")).toContain("install row");
    expect(raised.join("\n")).toContain("infra/lib/new.ts has 1 (baseline 0)");
  });

  it("passes a lower count and a deleted file, and shrink writes only the lower numbers", () => {
    const better: LintScan = { cfnParameter: { "infra/lib/a.ts": 1 }, tryGetContext: {}, processEnv: {} };
    const { raised, lowered } = compareToBaseline(better, base);
    expect(raised).toEqual([]);
    expect(lowered).toHaveLength(2);
    expect(shrunkBaseline(better, base)).toEqual({ cfnParameter: { "infra/lib/a.ts": 1 }, tryGetContext: {}, processEnv: {} });
  });

  it("never writes a higher number, even when asked to shrink", () => {
    const worse: LintScan = { cfnParameter: { "infra/lib/a.ts": 9 }, tryGetContext: { "infra/lib/new.ts": 4 }, processEnv: { "packages/broker/src/x.ts": 5 } };
    expect(shrunkBaseline(worse, base)).toEqual(base);
  });

  it("counts a match once however many lines it spans", () => {
    expect(countMatches("new CfnParameter(this, \"A\")\nnew cdk.CfnParameter(\n  this, \"B\")\nnew Other()", /\bnew (?:\w+\.)?CfnParameter\(/gu)).toBe(2);
    expect(countMatches("process.env.A + process.env[\"B\"] + myprocess.environment", /\bprocess\.env\b/gu)).toBe(2);
  });
});

describe("the tombstone lint (F1 L0)", () => {
  const tombstones = [{ key: "limit.legacy.thing", storedAs: "legacyThing" }];

  it("has nothing to find today: no setting is retired", () => {
    expect(SETTING_TOMBSTONES).toEqual([]);
    expect(tombstoneProblems(SETTING_TOMBSTONES, new Map([["packages/x/src/a.ts", "anything"]]))).toEqual([]);
  });

  it("fails a retired key used outside the tombstone list, a tolerant read and the stored-document tests", () => {
    const files = new Map([
      ["packages/contracts/src/settings/tombstones.ts", "limit.legacy.thing"],
      ["packages/cloud/src/tolerant-read.ts", "legacyThing"],
      ["tests/unit/stored-company-document.test.ts", "legacyThing"],
      ["packages/broker/src/reader.ts", "const v = doc.legacyThing;"],
      ["packages/web/src/screen.ts", "show('limit.legacy.thing')"],
    ]);
    expect(tombstoneProblems(tombstones, files)).toEqual([
      "packages/broker/src/reader.ts names the retired setting limit.legacy.thing; only tombstones.ts, a tolerant read and the stored-document tests may",
      "packages/web/src/screen.ts names the retired setting limit.legacy.thing; only tombstones.ts, a tolerant read and the stored-document tests may",
    ]);
    expect(tombstoneKeyMayAppearIn("tests/unit/other.test.ts")).toBe(false);
  });
});
