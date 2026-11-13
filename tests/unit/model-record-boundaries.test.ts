// TE-F8: no callers yet (additive), pure contract files, and the worker store names no port or adapter type (F1-a's no-callers guard keeps `ModelEgress*` inside contracts and testing).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..", "..");
const CONTRACT_FILES = ["model-record-key", "model-record-policy", "model-recording-store", "model-record-replay"].map((name) => `packages/contracts/src/${name}.ts`);
const WORKER_FILE = "packages/worker/src/model-record-store-task.ts";
const OWN = new Set([...CONTRACT_FILES, WORKER_FILE, "packages/contracts/src/index.ts"]);
const MODULES = ["model-record-key", "model-record-policy", "model-recording-store", "model-record-replay", "model-record-store-task"];
const NAMES = /\b(?:createRecordReplay|modelRecordKey|modelRecordKeyOfView|readModelRequest|modelPromptSegments|planRecording|matchChangedItems|decideRecording|createMemoryRecordingStore|createTaskRecordingStore|recordedDependencyFor|recordingPlacement|RECORDING_STORE_TASK_CACHE)\b/u;

function walk(directory: string, found: string[] = []): string[] {
  for (const name of readdirSync(directory)) {
    if (name === "node_modules" || name === "dist" || name === ".git") continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) walk(path, found);
    else if (/\.(?:ts|tsx|js|mjs|cjs)$/u.test(name)) found.push(path);
  }
  return found;
}
const rel = (path: string): string => path.slice(root.length + 1);

describe("TE-F8 has no callers yet", () => {
  it("nothing in packages, scripts, infra, local or vendor imports its modules or names its exports, apart from its own files and the contracts barrel", () => {
    const outside: string[] = [];
    for (const directory of ["packages", "scripts", "infra", "local", "vendor"]) {
      let files: string[];
      try {
        files = walk(join(root, directory));
      } catch {
        continue;
      }
      for (const file of files) {
        const name = rel(file);
        if (OWN.has(name) || name.endsWith(".d.ts")) continue;
        const text = readFileSync(file, "utf8");
        const imports = MODULES.some((module) => new RegExp(`(?:from|import\\()\\s*["'][^"']*\\/${module}\\.js["']`, "u").test(text));
        // `packages/testing` and the other contracts files may name their own things; only F8's names matter here.
        if (imports || NAMES.test(text)) outside.push(name);
      }
    }
    expect(outside).toEqual([]);
  });

  it("only F8's own tests under tests/ use the modules", () => {
    const users = walk(join(root, "tests")).map(rel).filter((name) => NAMES.test(readFileSync(join(root, name), "utf8")));
    expect(users.filter((name) => !/^tests\/unit\/model-record-[a-z-]+\.(?:test\.)?ts$/u.test(name))).toEqual([]);
  });
});

describe("the contract files are pure", () => {
  it.each(CONTRACT_FILES)("%s: no Node module, no socket, no ambient clock, no randomness, no environment, no logging", (file) => {
    const text = readFileSync(join(root, file), "utf8");
    expect(text).not.toMatch(/from\s+["']node:/u);
    expect(text).not.toMatch(/\bDate\.now\b|Math\.random|performance\.now|randomUUID|randomBytes|process\.|setTimeout|\bfetch\(|console\./u);
  });
  it("the contract files import F4's helpers inside contracts only (prompt-change-internal is not exported to anyone else)", () => {
    for (const file of CONTRACT_FILES) {
      const imports = readFileSync(join(root, file), "utf8").match(/from\s+["'](\.[^"']*)["']/gu) ?? [];
      for (const found of imports) expect(found, file).toMatch(/\.\/(?:model-egress\/|ports\/|prompt-change|service-catalog-verify|model-record|model-recording)/u);
    }
  });
});

describe("the worker store names no port or adapter type", () => {
  it("has none of F1-a's names, so its no-callers guard needs no new path", () => {
    const text = readFileSync(join(root, WORKER_FILE), "utf8");
    expect(text).not.toMatch(/model-egress|buildOutboundRequest|routeEgressRequest|ModelEgress[A-Z]|MODEL_EGRESS|evidenceLinesFor|parseModelEgress|createFakeEgress|scrubResponseBody|createKeyEchoScanner|planConnection|runModelEgress/u);
  });
  it("writes only below the root it is given: every path it builds starts from `root`", () => {
    const text = readFileSync(join(root, WORKER_FILE), "utf8");
    expect(text).not.toMatch(/tmpdir|homedir|process\.cwd|process\.env|\.\.\//u);
  });
});
