import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildSync } from "esbuild";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

describe("runtime installation qualifier packaging", () => {
  it("includes the immutable oracle and qualifier in the worker image and source release", () => {
    const production = readFileSync("scripts/release-production.ts", "utf8");
    const baseImage = readFileSync("environments/base/Dockerfile", "utf8");
    expect(production).toContain('"packages/verifier"');
    expect(baseImage).toContain("COPY packages/verifier packages/verifier");
    expect(baseImage).toContain("COPY --from=build /opt/agentx/packages/verifier ./packages/verifier");
    expect(existsSync("packages/verifier/src/install-qualification-cli.ts")).toBe(true);
    expect(existsSync("packages/verifier/assets/runtime-installation/probe-oracle.json")).toBe(true);
    expect(readFileSync("packages/verifier/tsconfig.json", "utf8")).toContain('"src/**/*.ts"');
  });

  it("allows generic verifier imports from a host root with no verifier asset tree", () => {
    const emptyHostRoot = mkdtempSync(join(tmpdir(), "agentx-no-runtime-assets-"));
    const entry = resolve("packages/verifier/dist/index.js");
    try {
      const output = execFileSync(process.execPath, ["--input-type=module", "-e", "process.chdir(process.argv[1]); const {pathToFileURL}=await import('node:url'); await import(pathToFileURL(process.argv[2])); process.stdout.write('ready')", emptyHostRoot, entry], {
        cwd: resolve("."),
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp" },
      });
      expect(output).toBe("ready");
    } finally { rmSync(emptyHostRoot, { recursive: true, force: true }); }
  });

  it("loads pure verifier exports from a CommonJS bundle without starting the E2E runner", () => {
    const bundleDirectory = mkdtempSync(join(tmpdir(), "agentx-verifier-cjs-"));
    const bundlePath = join(bundleDirectory, "verifier.cjs");
    try {
      const bundled = buildSync({
        entryPoints: [resolve("packages/verifier/src/index.ts")],
        bundle: true,
        platform: "node",
        format: "cjs",
        target: "node22",
        outfile: bundlePath,
        write: false,
      });
      writeFileSync(bundlePath, bundled.outputFiles[0]!.contents);
      const verifier = createRequire(import.meta.url)(bundlePath) as { parseE2EReport?: unknown; qualifyE2EReport?: unknown };
      expect(typeof verifier.parseE2EReport).toBe("function");
      expect(typeof verifier.qualifyE2EReport).toBe("function");
    } finally { rmSync(bundleDirectory, { recursive: true, force: true }); }
  });
});
