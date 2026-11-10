// Port lane P6 (item L1): the company-instructions socket and Code's file adapter.
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  COMPANY_INSTRUCTIONS_FILE_NAME,
  COMPANY_RULE_LIMITS,
  CompanyInstructionsSnapshotSchema,
  IMPLICIT_COMPANY_ID,
  PLUGIN_POINTS,
  PLUGIN_POINT_CARDINALITY,
  isAllowedModuleSpecifier,
  type CompanyInstructionsSource,
} from "@agentx/contracts";
import { createAdapterRegistry, loadAdapters, parsePluginConfig, type ModuleImporter } from "../../packages/broker/src/ports/adapter-registry.js";
import { FileCompanyInstructions, companyInstructionsSnapshot, parseCompanyInstructionsText } from "../../packages/local-adapters/src/company-instructions-file.js";
import * as pluginModule from "../../packages/local-adapters/src/company-instructions-plugin.js";
import { fakeCompanyInstructionsSource } from "../support/company-instructions-fake.js";

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});
async function folder(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "company-instructions-"));
  folders.push(path);
  return path;
}
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("the company-instructions point", () => {
  it("is a registered plug-in point that holds one adapter", () => {
    expect(PLUGIN_POINTS).toContain("company-instructions");
    expect(PLUGIN_POINT_CARDINALITY["company-instructions"]).toBe("one");
    expect(COMPANY_INSTRUCTIONS_FILE_NAME).toBe("company-instructions.md");
    expect(isAllowedModuleSpecifier("@agentx/local-adapters/company-instructions")).toBe(true);
  });

  it("is the same snapshot shape as Cloud's port: a version and rules with a priority", () => {
    expect(CompanyInstructionsSnapshotSchema.safeParse({ version: "a".repeat(64), rules: [{ text: "x", priority: "required" }] }).success).toBe(true);
    expect(CompanyInstructionsSnapshotSchema.safeParse({ version: "1", rules: [{ text: "x", priority: "optional" }] }).success).toBe(false);
    expect(CompanyInstructionsSnapshotSchema.safeParse({ version: "1", rules: [], hash: "x" }).success).toBe(false);
  });

  it("is satisfied by the shared test fake (answers in turn, records the company key)", async () => {
    const fake = fakeCompanyInstructionsSource([{ version: "1", rules: [{ text: "a", priority: "required" }] }, undefined]);
    const source: CompanyInstructionsSource = fake;
    expect((await source.current("org_x"))?.version).toBe("1");
    expect(await source.current("org_y")).toBeUndefined();
    expect(fake.asked).toEqual(["org_x", "org_y"]);
  });
});

describe("the rules file format", () => {
  it("reads bullets under Required and Preferred headings, folds continuation lines, and ignores titles", () => {
    const rules = parseCompanyInstructionsText([
      "# Company rules", "", "## Required", "- Never push to main.", "- A rule that runs", "  past one line.", "",
      "## Preferred:", "* Small commits.", "+ Plain words.", "",
    ].join("\n"));
    expect(rules).toEqual([
      { text: "Never push to main.", priority: "required" },
      { text: "A rule that runs past one line.", priority: "required" },
      { text: "Small commits.", priority: "preferred" },
      { text: "Plain words.", priority: "preferred" },
    ]);
  });

  it("reads a bullet before any heading as Required, and CRLF and a byte order mark like LF", () => {
    expect(parseCompanyInstructionsText("﻿- First.\r\n- Second.\r\n")).toEqual([{ text: "First.", priority: "required" }, { text: "Second.", priority: "required" }]);
  });

  it("removes hidden characters and folds white space", () => {
    expect(parseCompanyInstructionsText("- Be​   careful\t here.")).toEqual([{ text: "Be careful here.", priority: "required" }]);
  });

  it("refuses a line it cannot place, naming the line number, rather than dropping a rule", () => {
    expect(() => parseCompanyInstructionsText("## Required\n- Fine.\nNever do this other thing.\n")).toThrow(/line 3/);
  });

  it("gives no snapshot for a file with no rule", () => {
    expect(companyInstructionsSnapshot(bytes("# Company rules\n\n"))).toBeUndefined();
  });

  it("holds the file to the shared limits and never cuts", () => {
    const many = Array.from({ length: COMPANY_RULE_LIMITS.maxRules + 1 }, (_, index) => `- Rule ${String(index)}.`).join("\n");
    expect(() => companyInstructionsSnapshot(bytes(many))).toThrow(/exceed the size budget/);
    expect(() => companyInstructionsSnapshot(bytes(`- ${"x".repeat(COMPANY_RULE_LIMITS.maxRuleCharacters + 1)}`))).toThrow(/exceed the size budget/);
    expect(() => companyInstructionsSnapshot(bytes("- \n"))).toThrow(/empty/);
    expect(() => companyInstructionsSnapshot(new Uint8Array([0xff, 0xfe, 0x00]))).toThrow();
  });

  it("uses the SHA-256 of the file's bytes as the version, so any edit is a new version", () => {
    const one = companyInstructionsSnapshot(bytes("- A.\n"));
    const same = companyInstructionsSnapshot(bytes("- A.\n"));
    const edited = companyInstructionsSnapshot(bytes("- A. \n"));
    expect(one?.version).toMatch(/^[a-f0-9]{64}$/);
    expect(same?.version).toBe(one?.version);
    expect(edited?.version).not.toBe(one?.version);
    expect(CompanyInstructionsSnapshotSchema.safeParse(one).success).toBe(true);
  });
});

describe("FileCompanyInstructions", () => {
  it("answers no rules when the file is missing, and the rules when it is there, whatever company key it is asked for", async () => {
    const dir = await folder();
    const path = join(dir, COMPANY_INSTRUCTIONS_FILE_NAME);
    const source = new FileCompanyInstructions({ path });
    expect(await source.current(IMPLICIT_COMPANY_ID)).toBeUndefined();
    await writeFile(path, "## Required\n- Keep secrets out of logs.\n", { mode: 0o600 });
    const snapshot = await source.current("anything");
    expect(snapshot?.rules).toEqual([{ text: "Keep secrets out of logs.", priority: "required" }]);
    await writeFile(path, "## Required\n- Keep secrets out of logs.\n- Review every migration.\n", { mode: 0o600 });
    expect((await source.current(IMPLICIT_COMPANY_ID))?.rules).toHaveLength(2);
  });

  it.skipIf(process.platform === "win32")("refuses a file other users can write, a link, and a file that is too large (a step must not run under rules anyone could change)", async () => {
    const dir = await folder();
    const path = join(dir, COMPANY_INSTRUCTIONS_FILE_NAME);
    await writeFile(path, "- Rule.\n", { mode: 0o600 });
    await chmod(path, 0o666);
    await expect(new FileCompanyInstructions({ path }).current(IMPLICIT_COMPANY_ID)).rejects.toThrow(/writable by other users/);
    await chmod(path, 0o600);
    const link = join(dir, "link.md");
    await symlink(path, link);
    await expect(new FileCompanyInstructions({ path: link }).current(IMPLICIT_COMPANY_ID)).rejects.toThrow(/plain file/);
    const big = join(dir, "big.md");
    await writeFile(big, `- ${"x".repeat(70_000)}\n`, { mode: 0o600 });
    await expect(new FileCompanyInstructions({ path: big }).current(IMPLICIT_COMPANY_ID)).rejects.toThrow(/larger than/);
    await mkdir(join(dir, "folder.md"));
    await expect(new FileCompanyInstructions({ path: join(dir, "folder.md") }).current(IMPLICIT_COMPANY_ID)).rejects.toThrow();
  });
});

describe("the file plug-in", () => {
  const importer: ModuleImporter = async (specifier) => {
    if (specifier !== "@agentx/local-adapters/company-instructions") throw new Error("no such module");
    return pluginModule;
  };

  it("loads from a config entry into the company-instructions point and reads its file", async () => {
    const dir = await folder();
    const path = join(dir, "rules.md");
    await writeFile(path, "- From the plug-in.\n", { mode: 0o600 });
    const registry = createAdapterRegistry();
    await loadAdapters(parsePluginConfig({ version: 1, plugins: [{ point: "company-instructions", name: "file", module: "@agentx/local-adapters/company-instructions", settings: { path } }] }), { registry, importModule: importer });
    const source = registry.require("company-instructions");
    expect((await source.current(IMPLICIT_COMPANY_ID))?.rules[0]?.text).toBe("From the plug-in.");
  });

  it("refuses a setting it does not know", async () => {
    const registry = createAdapterRegistry();
    await expect(loadAdapters(parsePluginConfig({ version: 1, plugins: [{ point: "company-instructions", name: "file", module: "@agentx/local-adapters/company-instructions", settings: { paht: "x" } }] }), { registry, importModule: importer })).rejects.toThrow();
  });
});
