// Slice 1, s1-sealed: source guards for the sealed check round (TS-SEAL-3) and for where the usage record may go (TS-SEAL-1 bandwidth). They scan every `packages/*/src` file, so a new importer fails here until someone
// names it on purpose. The scanner is a pure function over {path, text}, and the tests below feed it bad sources to show that it fails, so the guard is not passing on an empty search.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

export interface Source { path: string; text: string }

const W = "packages/worker/src/";
/** Identifiers that exist in one module only; ANY occurrence elsewhere (an aliased import included) fails. */
const INTERNALS: Array<[string, string[]]> = [
  ["startCheckSandbox", [`${W}check-sandbox.ts`]],
  ["sealedContainerExec", [`${W}check-round-runners.ts`]],
  ["createSealedCheckRunners", [`${W}check-round-runners.ts`]],
  ["assertSealedNetworkMembers", [`${W}check-round-runners.ts`]],
  ["ROUND_EXEC_INPUTS", [`${W}check-round-runners.ts`]],
  ["sandboxRunArgs", [`${W}check-sandbox.ts`]],
];
/** The only names a module outside check-round-runners.ts may import from it. */
export const PUBLIC_SEALED_ROUND_NAMES: readonly string[] = ["runSealedCheckRound", "withSealedCheckRound", "refuseTestServicesWithDevcontainer", "TEST_SERVICES_DEVCONTAINER_SENTENCE", "SealedCheckRoundInput"];
/**
 * THE ALLOWLIST. In packages/*\/src, only these files may name the sealed round (check-round-runners) or the worker's usage record builder (service-usage-record): the two modules themselves, and the worker's wiring
 * (s1-worker-round's test-services-run.ts, and the hunks in run-task.ts and prepare.ts). Nothing the agent, a model call or the setup agent reads is on it. Adding a file here is a decision: review it for what it does
 * with the record and the round's output (they carry what the sandbox's program chose to print or ask for).
 */
export const SEALED_ROUND_USERS: readonly string[] = [`${W}check-round-runners.ts`, `${W}service-usage-record.ts`, `${W}test-services-run.ts`, `${W}run-task.ts`, `${W}prepare.ts`];
/** The record's contract type and schema (`TestServicesUsageRecord`, ...): the contract itself, the worker that builds it, and the broker modules that turn it into evidence and Prove steps (s1-broker T4, T5). */
export const USAGE_RECORD_USERS: readonly string[] = [
  "packages/contracts/src/test-services-usage.ts", "packages/contracts/src/index.ts",
  // the evidence file the worker writes (EvidenceRawSchema) carries the record under `testServices`, so evidence.ts imports its schema (s1-broker T4)
  "packages/contracts/src/evidence.ts", `${W}service-usage-record.ts`, `${W}test-services-run.ts`, `${W}verification/evidence-raw.ts`,
  "packages/broker/src/rovara-code/evidence-pack.ts", "packages/broker/src/test-env/evidence-line.ts", "packages/broker/src/test-env/prove-from-setup-check.ts",
  "packages/broker/src/org/test-env-candidate.ts", "packages/broker/src/aws/developer-routes/test-environment-candidate.ts",
];

const SEALED_MODULES = /["'][^"']*\/(?:check-round-runners|service-usage-record)(?:\.js|\.ts)?["']/u;
const RECORD_NAMES = /\bTestServicesUsageRecord(?:Schema)?\b|\bTestServicesDependencyUsage(?:Schema)?\b|["'][^"']*\/test-services-usage(?:\.js|\.ts)?["']/u;
/** A `sealed` property in any spelling: `sealed:`, `"sealed":`, `{ sealed }`, `, sealed,`. */
const SEALED_KEY = /["']sealed["']\s*:|\bsealed\s*:(?!:)|[{,]\s*sealed\s*[,}]/u;

/** The names one import statement takes from the round module, aliases stripped; `*` for a namespace, dynamic or re-exported use. */
export function namesImportedFromRoundModule(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["'][^"']*\/check-round-runners(?:\.js|\.ts)?["']/gu)) {
    for (const part of match[1]!.split(",")) {
      const name = part.trim().replace(/^type\s+/u, "").split(/\s+as\s+/u)[0]!.trim();
      if (name !== "") names.push(name);
    }
  }
  if (/import\s+(?:type\s+)?\*\s*as\s+\w+\s+from\s*["'][^"']*\/check-round-runners|import\s*\(\s*["'][^"']*\/check-round-runners|require\(\s*["'][^"']*\/check-round-runners|export\s+(?:type\s+)?\*\s+from\s*["'][^"']*\/check-round-runners|import\s+\w+\s+from\s*["'][^"']*\/check-round-runners/u.test(text)) names.push("*");
  return names;
}

export function sealedSourceViolations(sources: readonly Source[]): string[] {
  const out: string[] = [];
  for (const { path, text } of sources) {
    for (const [name, allowed] of INTERNALS) if (new RegExp(`\\b${name}\\b`, "u").test(text) && !allowed.includes(path)) out.push(`${path}: names ${name}, which belongs to ${allowed.join(", ")}`);
    if (path.startsWith(W) && /\bcreateCheckRunners\b/u.test(text) && SEALED_KEY.test(text) && path !== `${W}verification/checks.ts`) out.push(`${path}: passes a sealed option to createCheckRunners`);
    if (path !== `${W}check-round-runners.ts`) {
      const bad = namesImportedFromRoundModule(text).filter((name) => !PUBLIC_SEALED_ROUND_NAMES.includes(name));
      if (bad.length > 0) out.push(`${path}: imports ${bad.join(", ")} from check-round-runners`);
    }
    if (SEALED_MODULES.test(text) && !SEALED_ROUND_USERS.includes(path)) out.push(`${path}: is not allowed to use the sealed round or the usage record builder`);
    if (RECORD_NAMES.test(text) && !USAGE_RECORD_USERS.includes(path)) out.push(`${path}: is not allowed to use the usage record type`);
  }
  return out;
}

async function sourcesOfAllPackages(): Promise<Source[]> {
  const repo = new URL("../../", import.meta.url).pathname;
  const sources: Source[] = [];
  const walk = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) { if (entry.name !== "node_modules") await walk(path); continue; }
      if (/\.tsx?$/u.test(entry.name) && !entry.name.endsWith(".d.ts")) sources.push({ path: path.slice(repo.length), text: await readFile(path, "utf8") });
    }
  };
  for (const pkg of await readdir(join(repo, "packages"))) {
    const src = join(repo, "packages", pkg, "src");
    if ((await readdir(join(repo, "packages", pkg))).includes("src")) await walk(src);
  }
  return sources;
}

describe("the sealed round's source guards", () => {
  it("every file under packages/*/src passes", async () => {
    const sources = await sourcesOfAllPackages();
    // Not an empty search: the modules themselves are there.
    for (const path of [`${W}check-sandbox.ts`, `${W}check-round-runners.ts`, `${W}service-usage-record.ts`, "packages/contracts/src/test-services-usage.ts"]) expect(sources.some((source) => source.path === path), path).toBe(true);
    expect(sealedSourceViolations(sources)).toEqual([]);
  });

  it("finds an internal under an alias, a sealed key in any spelling, and an import of the round's internals", () => {
    const bad = (path: string, text: string) => sealedSourceViolations([{ path, text }]);
    expect(bad(`${W}x.ts`, 'import { startCheckSandbox as go } from "./check-sandbox.js";\ngo();')).toHaveLength(1);
    expect(bad(`${W}x.ts`, 'import { sealedContainerExec as make } from "./check-round-runners.js";')).not.toEqual([]);
    expect(bad(`${W}x.ts`, 'import { runSealedCheckRound as run, type SealedCheckRoundInput } from "./check-round-runners.js";')).toEqual([`${W}x.ts: is not allowed to use the sealed round or the usage record builder`]);
    for (const spelling of ["createCheckRunners({ rootPath, sealed: x })", 'createCheckRunners({ rootPath, "sealed": x })', "createCheckRunners({ rootPath, sealed })", "const o = { rootPath, sealed, local }; createCheckRunners(o)"]) {
      expect(bad(`${W}x.ts`, spelling), spelling).toEqual([`${W}x.ts: passes a sealed option to createCheckRunners`]);
    }
    expect(bad(`${W}x.ts`, "const sealed: SealedDetail[] = [];")).toEqual([]);
    expect(bad(`${W}run-task.ts`, 'import * as round from "./check-round-runners.js";')).toEqual([`${W}run-task.ts: imports * from check-round-runners`]);
    expect(bad(`${W}run-task.ts`, 'const m = await import("./check-round-runners.js");')).toEqual([`${W}run-task.ts: imports * from check-round-runners`]);
    expect(bad(`${W}run-task.ts`, 'import { runSealedCheckRound } from "./check-round-runners.js";')).toEqual([]);
  });

  it("an agent-facing module, or any module not on the allowlist, cannot touch the usage record or the sealed round (all packages)", () => {
    const bad = (path: string, text: string) => sealedSourceViolations([{ path, text }]);
    for (const path of [`${W}pi-session.ts`, `${W}agent-run/loop.ts`, `${W}setup-agent-run.ts`, `${W}read-skill-tool.ts`, `${W}model-access.ts`, "packages/model-proxy/src/proxy.ts", "packages/orchestrator/src/x.ts", "packages/broker/src/org/prompt-builder.ts"]) {
      expect(bad(path, 'import { buildServiceUsageRecord } from "./service-usage-record.js";'), path).toEqual([`${path}: is not allowed to use the sealed round or the usage record builder`]);
      expect(bad(path, 'import { runSealedCheckRound } from "./check-round-runners.js";'), path).toHaveLength(1);
      expect(bad(path, 'import type { TestServicesUsageRecord } from "@agentx/contracts";'), path).toEqual([`${path}: is not allowed to use the usage record type`]);
    }
    // The allowed ones pass.
    expect(bad(`${W}test-services-run.ts`, 'import { buildServiceUsageRecord } from "./service-usage-record.js";\nimport { runSealedCheckRound } from "./check-round-runners.js";\nimport type { TestServicesUsageRecord } from "@agentx/contracts";')).toEqual([]);
    expect(bad("packages/broker/src/rovara-code/evidence-pack.ts", 'import type { TestServicesUsageRecord } from "@agentx/contracts";')).toEqual([]);
  });

  it("the allowlists name files that exist or are the planned wiring, and nothing agent-facing", () => {
    const agentFacing = /(?:^|\/)(?:agent-run\/|pi-session|agent-step|setup-agent|read-.*-tool|sandbox-file-tools|model-|understand|plan-|conversations|learned-|steer-invocation|diagnosis|context-)/u;
    for (const path of [...SEALED_ROUND_USERS, ...USAGE_RECORD_USERS]) expect(agentFacing.test(path.slice(path.lastIndexOf("/src/") + 5)), path).toBe(false);
  });
});
