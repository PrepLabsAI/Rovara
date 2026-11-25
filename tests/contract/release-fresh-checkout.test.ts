// F3 cut 1, review B1: the beta and production release builds run `npm ci` and then `npm run release:prod` (tsx scripts/release-production.ts) on a fresh checkout, with NO `dist/` anywhere and no build
// before it (infra/lib/release-pipeline.ts). The script builds the repository itself, but only after its imports have loaded. Contracts source reaches workspace packages (the Code API package) through
// their built `dist/`, so the script must not load anything from `packages/` while it loads. Two tests keep that true: a static one over the script's import closure, and a run of the real script in a copy
// of the tree that has no `dist/`, with fake `git`, `aws` and `npm` programs, which must reach its own build step and get past it.
import { execFile } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const ENTRY = "scripts/release-production.ts";
const WORKSPACE_IMPORT = /^@(agentx|rovara|preplabsai)\//u;

/** The module specifiers a source loads when it loads: static `import` and `export ... from` (type-only ones are erased at build, so left out). Dynamic `import()` is a later load and is not followed. */
function staticImports(source: string): string[] {
  return [...source.matchAll(/^\s*(?:import|export)\s+(?!type\s)(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/gmu)].map((match) => match[1]!);
}

/** Every repository file the entry loads statically, following relative imports (`./x.js` is `./x.ts`), and every bare specifier met on the way. */
function closure(entry: string): { files: string[]; bare: string[] } {
  const files = new Set<string>();
  const bare = new Set<string>();
  const visit = (file: string): void => {
    if (files.has(file)) return;
    files.add(file);
    for (const specifier of staticImports(readFileSync(file, "utf8"))) {
      if (specifier.startsWith(".")) visit(resolve(dirname(file), specifier.replace(/\.js$/u, ".ts")));
      else if (!specifier.startsWith("node:")) bare.add(specifier);
    }
  };
  visit(resolve(entry));
  return { files: [...files].map((file) => file.slice(resolve(".").length + 1)).sort(), bare: [...bare].sort() };
}

const temporary: string[] = [];
afterAll(() => { for (const path of temporary) rmSync(path, { recursive: true, force: true }); });

/** A copy of what the release script needs, laid out like a fresh checkout after `npm ci`: sources and manifests, node_modules links, and no `dist/` or build info anywhere. */
function freshCheckout(): string {
  const root = mkdtempSync(join(tmpdir(), "fresh-checkout-"));
  temporary.push(root);
  const noBuildOutput = (path: string) => !/(^|\/)(dist|node_modules|[^/]*\.tsbuildinfo)(\/|$)/u.test(path);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fresh", private: true, type: "module" }));
  cpSync("scripts", join(root, "scripts"), { recursive: true });
  for (const name of ["contracts", "code-api"]) cpSync(join("packages", name), join(root, "packages", name), { recursive: true, filter: noBuildOutput });
  mkdirSync(join(root, "node_modules/@preplabsai"), { recursive: true });
  for (const entry of readdirSync("node_modules")) {
    if (entry.startsWith(".") || ["@agentx", "@rovara", "@preplabsai"].includes(entry)) continue;
    symlinkSync(resolve("node_modules", entry), join(root, "node_modules", entry));
  }
  symlinkSync("../../packages/code-api", join(root, "node_modules/@preplabsai/rovara-code-api"));
  return root;
}

describe("the release script on a fresh checkout", () => {
  it("loads nothing from the workspace while it loads: no bare workspace import in its static closure, and no import of packages/", () => {
    const { files, bare } = closure(ENTRY);
    expect(files).toContain("scripts/release-common.ts");
    expect(bare.filter((specifier) => WORKSPACE_IMPORT.test(specifier))).toEqual([]);
    const reaching = files.filter((file) => staticImports(readFileSync(file, "utf8")).some((specifier) => specifier.startsWith(".") && /(^|\/)packages\//u.test(resolve(dirname(file), specifier).slice(resolve(".").length + 1))));
    expect(reaching).toEqual([]);
  });

  it("notices a planted workspace import (the scan is not vacuous)", () => {
    expect(staticImports('import { x } from "@preplabsai/rovara-code-api";\nexport * from "@agentx/contracts";\nimport type { T } from "@agentx/contracts";\nimport "node:fs";')).toEqual(["@preplabsai/rovara-code-api", "@agentx/contracts", "node:fs"]);
  });

  it("starts, reaches its own build step and gets past it with no dist/ anywhere (fake git, aws and npm)", async () => {
    const root = freshCheckout();
    const bin = join(root, "fake-bin");
    mkdirSync(bin);
    const log = join(root, "calls.log");
    const tsc = resolve("node_modules/typescript/bin/tsc");
    const script = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };
    script("git", `echo git "$@" >> "${log}"; echo 0123456789abcdef0123456789abcdef01234567`);
    script("aws", `echo aws "$@" >> "${log}"
case "$*" in
  *get-caller-identity*) echo '{"Account":"123456789012"}' ;;
  *describe-stacks*) echo "Stack does not exist" >&2; exit 255 ;;
esac
exit 0`);
    // `npm run build` stands in for `tsc -b`: it builds the one package the script's contracts imports need.
    script("npm", `echo npm "$@" >> "${log}"
if [ "$1 $2" = "run build" ]; then exec "${process.execPath}" "${tsc}" -p packages/code-api/tsconfig.json; fi
exit 0`);
    expect(existsSync(join(root, "packages/code-api/dist"))).toBe(false);
    const image = `123456789012.dkr.ecr.us-east-1.amazonaws.com/agentx-worker-production@sha256:${"a".repeat(64)}`;
    const result = await run(resolve("node_modules/.bin/tsx"), [ENTRY, "--allow-dirty", "--skip-checks", "--region", "us-east-1", "--worker-image", image], { cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } }).then(
      (done) => ({ code: 0, stderr: done.stderr }),
      (failure: { code?: number; stderr?: string }) => ({ code: failure.code ?? 1, stderr: failure.stderr ?? "" }),
    );
    expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
    // It stops where the fake AWS has no control-plane stack, which is after the build and after the late contracts imports.
    expect(result.stderr).toContain("AgentXControlPlane must exist before the worker settings are released");
    expect(result.code).toBe(1);
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("npm run build");
    expect(calls.indexOf("npm run build")).toBeLessThan(calls.indexOf("describe-stacks"));
    expect(existsSync(join(root, "packages/code-api/dist/errors.js"))).toBe(true);
  }, 120_000);

  it("is a real reproduction: a static import of contracts in the same tree fails without dist/", async () => {
    const root = freshCheckout();
    writeFileSync(join(root, "probe.ts"), 'import { AGENTX_PROTOCOL_VERSION } from "./packages/contracts/src/protocol.js";\nconsole.log(AGENTX_PROTOCOL_VERSION);\n');
    const failure = await run(resolve("node_modules/.bin/tsx"), ["probe.ts"], { cwd: root }).then(() => undefined, (error: { stderr?: string }) => error.stderr ?? "");
    expect(failure).toContain("ERR_MODULE_NOT_FOUND");
  }, 120_000);
});
