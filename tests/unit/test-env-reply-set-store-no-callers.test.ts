// TE-R1 part A is purely additive: NOTHING outside `packages/contracts`, `packages/broker/src/core/test-env` and `packages/testing` imports the new files or names until part B (so 7a may merge it before the tag).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const NAMES = [
  "model-reply-store", "createReplySetStore", "ReplySetStoreService", "reply-set-store", "resolveRoundSet", "joinTaskReplies", "replyStorePartition", "ReplySetHeadSchema", "putIndependentOverlay",
  "importFromRepoFile", "reconcileBaseDecisions", "unseenCandidateReplies", "REPLY_STORE_WORDS", "ReplyStoreRefusal",
];
const ALLOWED = [
  "packages/contracts/src/",
  "packages/broker/src/core/test-env/reply-set-store.ts",
  "packages/testing/src/ports/reply-set-store-conformance.ts",
  "packages/testing/src/ports/index.ts",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (/\.(ts|tsx|mts|js|json)$/u.test(entry.name)) out.push(path.slice(ROOT.length + 1));
  }
  return out;
}

describe("part A has no callers", () => {
  it("names no new file or export outside contracts, the broker's test-env service file and the testing package", () => {
    const offenders: string[] = [];
    for (const file of walk(join(ROOT, "packages"))) {
      if (ALLOWED.some((prefix) => file.startsWith(prefix))) continue;
      const text = readFileSync(join(ROOT, file), "utf8");
      const hit = NAMES.find((name) => text.includes(name));
      if (hit !== undefined) offenders.push(`${file}: ${hit}`);
    }
    expect(offenders).toEqual([]);
  });
  it("is found where expected (a positive control: the scan does see the lane's own files)", () => {
    const files = walk(join(ROOT, "packages"));
    expect(files).toContain("packages/contracts/src/model-reply-store.ts");
    expect(files).toContain("packages/broker/src/core/test-env/reply-set-store.ts");
  });
});
