import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildSync } from "esbuild";
import { describe, expect, it } from "vitest";

const inputsOf = (entry: string, packages: "bundle" | "external" = "bundle") => Object.keys(buildSync({ entryPoints: [resolve(entry)], bundle: true,
  platform: "node", format: "cjs", target: "node22", write: false, metafile: true, logLevel: "silent", packages }).metafile.inputs);

describe("verifier entry points", () => {
  it("keeps Playwright and the web engine out of the main barrel that broker and worker bundles import", () => {
    const inputs = inputsOf("packages/verifier/src/index.ts");
    expect(inputs.filter((path) => /node_modules\/(playwright-core|@e2e-dev\/web)\//.test(path))).toEqual([]);
    expect(inputs.some((path) => path.includes("packages/verifier/src/executor/run.ts") || path.includes("packages/verifier/src/executor/local-browser.ts")
      || path.includes("packages/verifier/src/web-runtime.ts"))).toBe(false);
  });

  it("serves the executor through its own subpath, which does load the browser stack", () => {
    const pkg = JSON.parse(readFileSync("packages/verifier/package.json", "utf8")) as { exports: Record<string, { default: string }> };
    expect(pkg.exports["."]!.default).toBe("./dist/index.js");
    expect(pkg.exports["./executor"]!.default).toBe("./dist/executor/index.js");
    // Playwright cannot be bundled at all, which is why nothing that is bundled for Lambda may reach it; here it stays external.
    const inputs = inputsOf("packages/verifier/src/executor/index.ts", "external");
    expect(inputs.some((path) => path.endsWith("packages/verifier/src/executor/run.ts"))).toBe(true);
    expect(inputs.some((path) => path.endsWith("packages/verifier/src/web-runtime.ts"))).toBe(true);
  });
});
