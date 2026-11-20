import { describe, expect, it } from "vitest";
import { classifyPath, languageOf } from "../../packages/broker/src/core/wiki/skip-rules.js";

describe("wiki file map: what is skipped", () => {


  it.each([["package-lock.json", "lockfile"], ["web/yarn.lock", "lockfile"], ["pnpm-lock.yaml", "lockfile"], ["Cargo.lock", "lockfile"], ["go.sum", "lockfile"], ["a/poetry.lock", "lockfile"],
    ["vendor/x/y.php", "vendored"], ["node_modules/a/index.js", "vendored"], ["web/node_modules/a/index.js", "vendored"], ["third_party/lib/a.c", "vendored"],
    ["dist/main.js", "generated"], ["packages/a/build/x.js", "generated"], [".next/server/a.js", "generated"], ["src/gen/api.pb.go", "generated"], ["static/app.min.js", "generated"], ["src/types.generated.ts", "generated"], ["x/foo_pb2.py", "generated"],
    ["logo.png", "asset"], ["fonts/a.woff2", "asset"], ["data/archive.zip", "asset"], ["src/index.ts", undefined], ["README.md", undefined]] as const)("classifies %s as %s", (path, expected) => { expect(classifyPath(path)).toBe(expected); });

  it("names languages from the extension and leaves data and docs out of the code mix", () => {
    expect(languageOf("a/b.ts")).toBe("TypeScript");
    expect(languageOf("a/b.tsx")).toBe("TypeScript");
    expect(languageOf("a/b.py")).toBe("Python");
    expect(languageOf("Dockerfile")).toBe("Dockerfile");
    expect(languageOf("a/b.md")).toBeUndefined();
    expect(languageOf("a/b.json")).toBeUndefined();
  });

});
