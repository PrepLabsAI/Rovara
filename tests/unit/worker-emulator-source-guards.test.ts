// Slice 2, s2-emulator-run: source guards for the emulator's control token and ledger. They scan every `packages/*/src` file, so a new user fails here until someone names it on purpose. The scanner is a pure function over
// {path, text}, and the tests below feed it bad sources to show that it fails, so the guard is not passing on an empty search.
//   1. WHO MAY NAME THE CONTROL TOKEN (or the SQS receipt secret): only the modules that make or use it. A sandbox, a command runner, the agent's tools, the setup agent, a model call, the broker and the web app never do.
//   2. WHO MAY USE THE CONTROL CALL, THE SEED AND THE LEDGER: the modules themselves, the usage record (the one ledger port, type only) and the worker's wiring. The ledger and the seed document hold what the program or the project
//      chose; nothing the agent, a model call or the setup agent reads may import them (TS-SEAL-1 bandwidth, as for the usage record).
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

interface Source { path: string; text: string }
const W = "packages/worker/src/";

/** Files that may name the control token / receipt secret (code, comments or strings). */
export const TOKEN_USERS: readonly string[] = [
  `${W}service-helpers.ts`, `${W}service-env.ts`, `${W}service-runner.ts`, `${W}service-reset.ts`, `${W}service-probe.ts`, `${W}emulator-control.ts`, `${W}test-services-run.ts`,
  // the fake server's own control token (slice 3), unrelated to the emulator's
  "packages/verifier/src/service-mocks/server.ts", "packages/verifier/src/service-mocks/fake-server.ts",
];
/** Files that may import the control call, the seed or the ledger. */
export const EMULATOR_USERS: readonly string[] = [`${W}emulator-control.ts`, `${W}emulator-ledger.ts`, `${W}service-seed-aws.ts`, `${W}service-usage-record.ts`, `${W}test-services-run.ts`];

const TOKEN_WORDS = /controlToken|x-rovara-control-token|ROVARA_CONTROL_TOKEN|ROVARA_AWS_CONTROL_TOKEN|sqsReceiptSecret|RECEIPT_HANDLE_SECRET/iu;
const EMULATOR_MODULES = /["'][^"']*\/(?:emulator-control|emulator-ledger|service-seed-aws)(?:\.js|\.ts)?["']/u;

export function emulatorSourceViolations(sources: readonly Source[]): string[] {
  const out: string[] = [];
  for (const { path, text } of sources) {
    if (TOKEN_WORDS.test(text) && !TOKEN_USERS.includes(path)) out.push(`${path}: names the emulator's control token or receipt secret`);
    if (EMULATOR_MODULES.test(text) && !EMULATOR_USERS.includes(path)) out.push(`${path}: is not allowed to use the emulator's control call, seed or ledger`);
  }
  return out;
}

async function sourcesOfAllPackages(): Promise<Source[]> {
  const repo = new URL("../../", import.meta.url).pathname;
  const sources: Source[] = [];
  const walk = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) { if (entry.name !== "node_modules" && entry.name !== "dist") await walk(path); continue; }
      if (/\.tsx?$/u.test(entry.name) && !entry.name.endsWith(".d.ts")) sources.push({ path: path.slice(repo.length), text: await readFile(path, "utf8") });
    }
  };
  for (const pkg of await readdir(join(repo, "packages"))) {
    const src = join(repo, "packages", pkg, "src");
    await walk(src).catch(() => undefined);
  }
  return sources;
}

describe("the emulator source guards", () => {
  it("nothing outside the allowlists names the token or uses the control call, the seed or the ledger", async () => {
    const sources = await sourcesOfAllPackages();
    expect(sources.length).toBeGreaterThan(500);
    expect(emulatorSourceViolations(sources)).toEqual([]);
  });
  it("the allowlisted files all exist (a rename must update the list)", async () => {
    const paths = new Set((await sourcesOfAllPackages()).map((source) => source.path));
    for (const path of [...TOKEN_USERS, ...EMULATOR_USERS]) expect(paths.has(path), path).toBe(true);
  });
  it("the guard fails on a sandbox, a command runner or a model-facing module that names the token or imports the control call", () => {
    const bad: Source[] = [
      { path: `${W}task-sandbox.ts`, text: 'const env = { ROVARA_CONTROL_TOKEN: token };' },
      { path: `${W}check-round-runners.ts`, text: "run({ controlToken })" },
      { path: `${W}check-sandbox.ts`, text: 'headers: { "x-rovara-control-token": t }' },
      { path: `${W}setup-agent.ts`, text: 'import { emulatorLedgerPort } from "./emulator-ledger.js";' },
      { path: "packages/broker/src/rovara-code/evidence-pack.ts", text: 'import { seedEmulator } from "../../../worker/src/service-seed-aws";' },
      { path: `${W}agent-tools.ts`, text: "const t = credentials.sqsReceiptSecret;" },
      { path: `${W}file-tools.ts`, text: "ROVARA_AWS_SERVICES_SQS_RECEIPT_HANDLE_SECRET" },
    ];
    const found = emulatorSourceViolations(bad);
    expect(found).toHaveLength(7);
    expect(emulatorSourceViolations([{ path: `${W}service-seed-aws.ts`, text: 'import { emulatorControlCall } from "./emulator-control.js";' }])).toEqual([]);
  });
});
