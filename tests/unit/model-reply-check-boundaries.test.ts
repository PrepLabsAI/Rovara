import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "../..");
function files(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    if (["node_modules", "dist", ".git"].includes(entry.name)) return [];
    const file = join(path, entry.name);
    return entry.isDirectory() ? files(file) : /\.(?:ts|tsx|js|mjs|cjs)$/u.test(file) ? [file] : [];
  });
}
describe("F11 has no production callers", () => {
  it("all imports and export usages are contained in contracts and tests", () => {
    const names = /model-reply-check|checkReplySetAgainstReal|createReplyProbeStore|ReplyCheckReport|ReplyProbeSource/u;
    const scanned = ["packages", "scripts", "infra"].flatMap((dir) => files(join(root, dir)));
    expect(scanned.length).toBeGreaterThan(100);
    expect(scanned.filter((file) => !relative(root, file).startsWith("packages/contracts/") && names.test(readFileSync(file, "utf8"))).map((file) => relative(root, file))).toEqual([]);
    expect(names.test(readFileSync(join(root, "packages/contracts/src/model-reply-check.ts"), "utf8"))).toBe(true);
  });
});
