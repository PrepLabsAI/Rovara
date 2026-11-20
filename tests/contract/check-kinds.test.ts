// TE-A2a: the check-kind registry and the trust classes. Pure data; every case fails when the rule it names is removed.
import { describe, expect, it } from "vitest";
import { CHECK_KIND_REGISTRY, CHECK_PARTS, checkKindInfo, checkKindWords, isRegisteredCheckKind, partsOutsideKind } from "../../packages/contracts/src/index.js";

describe("the registry", () => {

  it("has unique ids, words for each, and only known parts", () => {
    const ids = CHECK_KIND_REGISTRY.map((info) => info.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const info of CHECK_KIND_REGISTRY) {
      expect(info.words.length, info.id).toBeGreaterThan(0);
      for (const part of info.parts) expect(CHECK_PARTS).toContain(part);
    }
  });

  it("does not know an unregistered kind, and gives it generic words rather than failing", () => {
    expect(isRegisteredCheckKind("hologram")).toBe(false);
    expect(checkKindInfo("hologram")).toBeUndefined();
    expect(partsOutsideKind("hologram", ["tests"])).toEqual([]);
    expect(checkKindWords("hologram")).toBe("Newer check kind");
  });
});

it("keeps the owner-approved agent reply words exact", async () => {
  const words = await import("../../packages/contracts/src/check-kinds.js");
  expect(words.AGENT_REPLIES_UNCONFIRMED_WORDS).toBe("proven with scripted replies written in this task: check them");
  expect(words.AGENT_REPLIES_DISAGREED_WORDS).toBe("scripted replies written in this task: the real model did not agree");
});
