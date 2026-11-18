// L4-EVP: the change tier asks for the eval when a change touches a prompt location the project confirmed (a prompt kept inside code), and says "AI code was touched" for a change that names a model SDK. Both are hints:
// they never raise the tier. A project with no locations gets the tier it always got.
import { describe, expect, it } from "vitest";
import type { PromptLocation } from "@agentx/contracts";
import { capReasons, tierFromDiff, type TierFile, type TierReason } from "../../packages/broker/src/core/decisions/change-tier.js";

const AT = "2026-11-18T12:00:00.000Z";
const PLAIN = "@@ -1,3 +1,3 @@\n a\n-b\n+c\n d";
const file = (path: string, patch = PLAIN, over: Partial<TierFile> = {}): TierFile => ({ path, status: "modified", additions: 1, deletions: 1, patch, ...over });
const tier = (files: TierFile[], promptLocations?: readonly PromptLocation[]) => tierFromDiff({ files, complete: true }, { at: AT, ...(promptLocations === undefined ? {} : { promptLocations }) });
const codes = (files: TierFile[], promptLocations?: readonly PromptLocation[]): string[] => tier(files, promptLocations).reasons.map((reason) => reason.code);
const hints = (files: TierFile[], promptLocations?: readonly PromptLocation[]): string[] => codes(files, promptLocations).filter((code) => code === "eval_hint" || code === "ai_code_touched");
const LOCATION: PromptLocation = { repo: "app", path: "deskbot/agent.py", kind: "function", symbol: "DeskAgent.build_contents" };
const SDK_PATCH = "@@ -60,4 +60,4 @@ class VertexClient:\n         host = \"aiplatform.googleapis.com\"\n-        self.timeout = 30\n+        self.timeout = 20";

describe("a confirmed prompt location asks for the eval", () => {
  it("a change to the file that holds one carries an eval_hint with that path, and the tier does not rise", () => {
    const result = tier([file("deskbot/agent.py", PLAIN, { repository: "app" })], [LOCATION]);
    expect(result.reasons).toEqual([{ code: "eval_hint", path: "deskbot/agent.py" }]);
    expect(result.level).toBe("small");
  });
  it("without the setting, the same change carries no hint (today's tier, byte for byte)", () => {
    const withNone = tier([file("deskbot/agent.py", PLAIN, { repository: "app" })]);
    expect(withNone.reasons).toEqual([]);
    expect(tier([file("deskbot/agent.py", PLAIN, { repository: "app" })], [])).toEqual(withNone);
  });
  it("an unrelated code change, a file of another repository, and a file that only has a similar name carry none", () => {
    expect(hints([file("deskbot/other.py", PLAIN, { repository: "app" })], [LOCATION])).toEqual([]);
    expect(hints([file("deskbot/agent.py", PLAIN, { repository: "elsewhere" })], [LOCATION])).toEqual([]);
    expect(hints([file("deskbot/agent.pyx", PLAIN, { repository: "app" }), file("x/deskbot/agent.py", PLAIN, { repository: "app" })], [LOCATION])).toEqual([]);
  });
  it("a change that names no repository is matched by path alone (more hints, never fewer)", () => {
    expect(codes([file("deskbot/agent.py")], [LOCATION])).toEqual(["eval_hint"]);
  });
  it("a renamed file counts under either name, and a removed file counts", () => {
    expect(codes([file("deskbot/persona.py", PLAIN, { repository: "app", status: "renamed", previousPath: "deskbot/agent.py" })], [LOCATION])).toContain("eval_hint");
    expect(codes([file("deskbot/agent.py", "", { repository: "app", status: "removed" })], [LOCATION])).toContain("eval_hint");
  });
  it("a location in an instruction-named file still asks (the file stays risky)", () => {
    const location: PromptLocation = { repo: "app", path: "config/agents.yaml", kind: "yaml_key", symbol: "support.system_prompt" };
    const result = tier([file("config/agents.yaml", PLAIN, { repository: "app" })], [location]);
    expect(result.reasons.map((reason) => reason.code)).toEqual(expect.arrayContaining(["instruction_file", "eval_hint"]));
    expect(result.level).toBe("risky");
  });
  it("a file already named like a prompt gets ONE hint, location or not", () => {
    const location: PromptLocation = { repo: "app", path: "deskbot/prompts/system.txt", kind: "file" };
    expect(hints([file("deskbot/prompts/system.txt", PLAIN, { repository: "app" })], [location])).toEqual(["eval_hint"]);
  });
  it("the hint survives a tier at the reasons cap", () => {
    const many = Array.from({ length: 70 }, (_unused, index) => file(`src/auth/area${index}/session.ts`, PLAIN, { repository: "app" }));
    const busy = tier([...many, file("deskbot/agent.py", PLAIN, { repository: "app" })], [LOCATION]);
    expect(busy.reasons.length).toBeLessThanOrEqual(50);
    expect(busy.reasons.map((reason) => reason.code)).toContain("eval_hint");
  });
});

describe("a change that names a model SDK says AI code was touched", () => {
  it("a patch that mentions a provider host is ai_code_touched with its path, and the tier does not rise", () => {
    const result = tier([file("deskbot/vertex_client.py", SDK_PATCH, { repository: "app" })]);
    expect(result.reasons).toEqual([{ code: "ai_code_touched", path: "deskbot/vertex_client.py" }]);
    expect(result.level).toBe("small");
  });
  it("code that names no SDK, a test, a document and a file with no patch say nothing", () => {
    expect(codes([file("deskbot/scoring.py")])).toEqual([]);
    expect(codes([file("tests/test_vertex_client.py", SDK_PATCH)])).toEqual([]);
    expect(codes([file("docs/guide.md", "@@ -1 +1 @@\n-a\n+use the openai API")])).not.toContain("ai_code_touched");
    expect(codes([file("deskbot/vertex_client.py", undefined)])).not.toContain("ai_code_touched");
  });
  it("a file that is already an eval_hint does not also say ai_code_touched (one hint per file)", () => {
    expect(codes([file("deskbot/agent.py", SDK_PATCH, { repository: "app" })], [LOCATION])).toEqual(["eval_hint"]);
  });
  it("a patch too long to scan whole counts as touching AI code, never as clean", () => {
    const huge = `@@ -1 +1 @@\n-a\n+${"x".repeat(400_001)}`;
    expect(codes([file("src/agent.py", huge)])).toContain("ai_code_touched");
  });
  it("never a hint on a changed file's old name only when the file is not code", () => {
    expect(codes([file("README.md", SDK_PATCH)])).not.toContain("ai_code_touched");
  });
});

describe("capReasons keeps both hints", () => {
  const reason = (code: string, path?: string): TierReason => (path === undefined ? { code } : { code, path });
  it("keeps eval_hint and ai_code_touched whatever the limit, the others in order", () => {
    const all = [reason("a"), reason("b"), reason("ai_code_touched", "x.py"), reason("c"), reason("eval_hint", "y.py")];
    expect(capReasons(all, 3).map((r) => r.code)).toEqual(["a", "eval_hint", "ai_code_touched"]);
    expect(capReasons(all, 2).map((r) => r.code)).toEqual(["eval_hint", "ai_code_touched"]);
    expect(capReasons([reason("a"), reason("b"), reason("eval_hint")], 2).map((r) => r.code)).toEqual(["a", "eval_hint"]);
    expect(capReasons([reason("a"), reason("b")], 1).map((r) => r.code)).toEqual(["a"]);
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

