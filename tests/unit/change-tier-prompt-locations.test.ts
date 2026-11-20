// L4-EVP: the change tier asks for the eval when a change touches a prompt location the project confirmed (a prompt kept inside code), and says "AI code was touched" for a change that names a model SDK. Both are hints:
// they never raise the tier. A project with no locations gets the tier it always got.
import { describe, expect, it } from "vitest";
import type { PromptLocation } from "@agentx/contracts";
import { tierFromDiff, type TierFile } from "../../packages/broker/src/core/decisions/change-tier.js";

const AT = "2026-11-18T12:00:00.000Z";
const PLAIN = "@@ -1,3 +1,3 @@\n a\n-b\n+c\n d";
const file = (path: string, patch = PLAIN, over: Partial<TierFile> = {}): TierFile => ({ path, status: "modified", additions: 1, deletions: 1, patch, ...over });
const tier = (files: TierFile[], promptLocations?: readonly PromptLocation[]) => tierFromDiff({ files, complete: true }, { at: AT, ...(promptLocations === undefined ? {} : { promptLocations }) });
const codes = (files: TierFile[], promptLocations?: readonly PromptLocation[]): string[] => tier(files, promptLocations).reasons.map((reason) => reason.code);
const hints = (files: TierFile[], promptLocations?: readonly PromptLocation[]): string[] => codes(files, promptLocations).filter((code) => code === "eval_hint" || code === "ai_code_touched");
const SDK_PATCH = "@@ -60,4 +60,4 @@ class VertexClient:\n         host = \"aiplatform.googleapis.com\"\n-        self.timeout = 30\n+        self.timeout = 20";

describe("a confirmed prompt location asks for the eval", () => {
  it("a file already named like a prompt gets ONE hint, location or not", () => {
    const location: PromptLocation = { repo: "app", path: "deskbot/prompts/system.txt", kind: "file" };
    expect(hints([file("deskbot/prompts/system.txt", PLAIN, { repository: "app" })], [location])).toEqual(["eval_hint"]);
  });
});

describe("a change that names a model SDK says AI code was touched", () => {
  it("never a hint on a changed file's old name only when the file is not code", () => {
    expect(codes([file("README.md", SDK_PATCH)])).not.toContain("ai_code_touched");
  });
});

describe("hints and the reviewer outage Retry", () => {
  const OUTAGE = [{ code: "reviewer_unavailable" }];
  it("a tier raised by an outage still counts as outage-only with the hints beside it, and not without an outage reason", async () => {
    const { isOutageOnly } = await import("../../packages/broker/src/core/build-step/scope-question.js");
    expect(isOutageOnly(OUTAGE)).toBe(true);
    expect(isOutageOnly([...OUTAGE, { code: "ai_code_touched", path: "a.py" }, { code: "eval_hint", path: "b.py" }])).toBe(true);
    expect(isOutageOnly([{ code: "ai_code_touched", path: "a.py" }])).toBe(false);
    expect(isOutageOnly([])).toBe(false);
    expect(isOutageOnly([...OUTAGE, { code: "sensitive_path", path: "auth/x.ts" }])).toBe(false);
  });
});

