// F2-B: the task standing's reader lives in the Code API package (`TaskStandingSchema`), which imports nothing of Code's, so the pill keys, tones, words, role words and action ids it inlines are proved equal to the ones Code computes
// with (`@agentx/contracts`). A word or an id changed on one side fails here. Contracts' own reader is the package's.
import { describe, expect, it } from "vitest";
import { NEEDS_ROLE_WORDS, PILLS, PILL_KEYS, PILL_TONES, ROLE_WORDS, TASK_ACTION_IDS, TaskStandingReaderSchema } from "@agentx/contracts";
import { ROUTES, STANDING_ACTION_IDS, STANDING_NEEDS_ROLE_WORDS, STANDING_PILLS, STANDING_PILL_KEYS, STANDING_PILL_TONES, STANDING_ROLE_WORDS, TaskStandingSchema, TaskStandingWireSchema, readLooseOffers } from "@preplabsai/rovara-code-api";

describe("the Code API package's inlined standing words equal Code's own", () => {
  it("pill keys, tones, words and icons", () => {
    expect([...STANDING_PILL_KEYS]).toEqual([...PILL_KEYS]);
    expect([...STANDING_PILL_TONES]).toEqual([...PILL_TONES]);
    expect(STANDING_PILLS).toEqual(PILLS);
  });
  it("the words of the needs-role pill and of each role", () => {
    for (const [role, words] of Object.entries(NEEDS_ROLE_WORDS)) expect(STANDING_NEEDS_ROLE_WORDS[role]).toBe(words);
    expect(STANDING_NEEDS_ROLE_WORDS).toEqual(NEEDS_ROLE_WORDS);
    expect(STANDING_ROLE_WORDS).toEqual(ROLE_WORDS);
  });
  it("action ids, in order", () => {
    expect([...STANDING_ACTION_IDS]).toEqual([...TASK_ACTION_IDS]);
  });
  it("contracts' reader is the package's, and an offer with a new id is skipped by the default list", () => {
    expect(TaskStandingReaderSchema).toBe(TaskStandingSchema);
    const offer = (id: string) => ({ id, label: "x", risk: "routine", needsDialog: false, binding: { revision: 1 } });
    expect(readLooseOffers([offer("task.stop"), offer("task.teleport")]).map((entry) => entry.id)).toEqual(["task.stop"]);
  });
  it("the task read row names `standing` and reads it tolerantly: other members pass, a standing that does not read is dropped", () => {
    const row = ROUTES.find((route) => route.id === "tasks.read")!;
    expect(row.requires).toBe("tasks:read");
    const standing = { pill: { key: "working", words: "Rovara is working", tone: "running" }, actions: [] };
    expect(row.response!.parse({ task: { standing, taskId: "x", anything: 1 }, more: true })).toMatchObject({ task: { standing, taskId: "x", anything: 1 }, more: true });
    expect(row.response!.parse({ task: { standing: "garbage" } })).toEqual({ task: {} });
    expect(TaskStandingWireSchema.safeParse(standing).success).toBe(true);
  });
});
