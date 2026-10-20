import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe(".dockerignore", () => {
  it("keeps host build output and installed dependencies out of every image build context (Ruling AI)", async () => {
    // The worker and slack Dockerfiles COPY whole package directories and then build them. A host
    // checkout that has already been built (the release workflow builds before the executor smoke)
    // would otherwise ship its own packages/*/dist, tsbuildinfo and node_modules into the context,
    // making the image depend on the machine that built it. The patterns must match at any depth.
    const lines = (await readFile(".dockerignore", "utf8")).split("\n").map((line) => line.trim());
    for (const pattern of ["**/dist", "**/*.tsbuildinfo", "**/node_modules"]) expect(lines, pattern).toContain(pattern);
  });
});
