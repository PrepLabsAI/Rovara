// The pure proposal, the pointer, the pull request words and the status lines.
import { describe, expect, it } from "vitest";
import { LESSON_FILE_MAX_BYTES, LESSON_FILE_MAX_LESSONS } from "@rovara-code/contracts";
import { pointerTargets, withPointer } from "../../../packages/lessons/src/repo-file-pointer.js";
import { planRepoFile, removalReasonOf, renderLesson, sectionOf, REMOVAL_REASONS, type PlanInput } from "../../../packages/lessons/src/repo-file-plan.js";
import { noticesOf, prBody, prTitle, rowOf } from "../../../packages/lessons/src/repo-file-pr.js";
import { newRepoFileState } from "../../../packages/lessons/src/repo-file-state.js";
import { parseLessonsFile, renderLessonsFile } from "../../../packages/lessons/src/repo-file-format.js";
import { OTHER_PLACE, PLACE, repoLesson } from "./repo-file-helpers.js";

const NOW_T = 1_000_000;

const input = (over: Partial<PlanInput> = {}): PlanInput => ({ place: PLACE, repoName: "api", lessons: [], names: ["Ann Lee"], fileText: undefined, rendered: {}, declined: [], addsPaused: false, preset: "standard", ...over });

describe("sections", () => {
  it("are the whole repository, the sorted paths, or the languages; a scope that is not plain tokens is not rendered", () => {
    expect(sectionOf({})).toBe("Whole repository");
    expect(sectionOf({ paths: ["packages/ui/", "apps/web/"] })).toBe("apps/web/, packages/ui/");
    expect(sectionOf({ languages: ["typescript", "go"] })).toBe("Languages: go, typescript");
    expect(sectionOf({ paths: ["src/"], languages: ["go"] })).toBe("src/ (go)");
    expect(sectionOf({ paths: ["src/\n## injected"] })).toBeUndefined();
    expect(sectionOf({ paths: ["../etc"] })).toBeUndefined();
    expect(renderLesson(repoLesson("les_aaaa0001", { scope: { paths: ["x y"] } }), "api")).toBeUndefined();
    expect(renderLesson(repoLesson("les_aaaa0001", { scope: { repos: ["web"] } }), "api")).toBeUndefined();
    expect(renderLesson(repoLesson("les_aaaa0001", { body: "   " }), "api")).toBeUndefined();
  });
});

describe("the proposal", () => {
  it("is the same whatever order the lessons come in", () => {
    const lessons = ["les_aaaa0003", "les_aaaa0001", "les_aaaa0002"].map((id, i) => repoLesson(id, { createdAt: 10 + i }));
    const a = planRepoFile(input({ lessons }));
    const b = planRepoFile(input({ lessons: [...lessons].reverse() }));
    expect(a.nextText).toBe(b.nextText);
    expect(a.digest).toBe(b.digest);
    expect(a.nextText).toBe(renderLessonsFile(lessons.map((l) => ({ id: l.id, heading: "Whole repository", text: l.body }))));
  });

  it("gives every removal a reason from the lesson's own state", () => {
    const base = repoLesson("les_aaaa0001");
    const cases: Array<[string, Parameters<typeof removalReasonOf>[0], string[], string]> = [
      ["gone from the store", undefined, [], "lesson_erased"],
      ["expired", { ...base, status: "expired" }, ["not_active"], "faded"],
      ["retired", { ...base, status: "retired" }, ["not_active"], "retired"],
      ["withdrawn", { ...base, status: "withdrawn" }, ["not_active"], "withdrawn"],
      ["retired by harm", { ...base, status: "retired", counters: { ...base.counters, harmful: 2 } }, ["not_active"], "harm"],
      ["thumbs-down while active", { ...base, counters: { ...base.counters, harmful: 1 } }, ["needs_review"], "harm"],
      ["retire proposed", { ...base, retireProposedAt: 5 }, ["needs_review"], "harm"],
      ["stale citation", { ...base, citationChecks: [{ index: 0, result: "stale", at: 1 }] }, ["needs_review"], "stale_citation"],
      ["names a person now", base, ["names_a_person"], "names_a_person"],
      ["not repo-only any more", base, ["not_repo_only"], "no_longer_repo_only"],
      ["audience narrowed", base, ["restricted_audience"], "no_longer_repo_only"],
      ["review needed", { ...base, reviewRequired: true }, ["needs_review"], "needs_review"],
      ["approval gone", base, ["not_stable_or_approved"], "no_longer_approved"],
    ];
    for (const [name, lesson, blockers, reason] of cases) expect(removalReasonOf(lesson, blockers as never), name).toBe(reason);
    expect(new Set(cases.map((c) => c[3]))).toEqual(new Set(REMOVAL_REASONS));
  });

  it("proposes a removal for a merged lesson that now names a person (the roster changed), taking the title from the file's own text", () => {
    const lesson = repoLesson("les_aaaa0001", { body: "Ask Bob Stone before you change retries." });
    const file = renderLessonsFile([{ id: lesson.id, heading: "Whole repository", text: lesson.body }]);
    const plan = planRepoFile(input({ lessons: [lesson], names: ["Bob Stone"], fileText: file, rendered: { les_aaaa0001: renderedOf(lesson) } }));
    expect(plan.removals).toEqual([{ id: "les_aaaa0001", reason: "names_a_person", title: "Ask Bob Stone before you change retries." }]);
    expect(plan.nextText).not.toContain("les_aaaa0001");
  });

  it("an id in the file that is not Rovara's (no stored lesson, never rendered) is never touched, and a duplicated id is skipped", () => {
    const file = `${renderLessonsFile([{ id: "les_zzzz9999", heading: "Whole repository", text: "Team text." }])}\n<!-- rovara:les_dupe0001 -->\n- one\n\n<!-- rovara:les_dupe0001 -->\n- two\n`;
    const plan = planRepoFile(input({ lessons: [repoLesson("les_dupe0001")], fileText: file }));
    expect(plan.removals).toEqual([]);
    expect(plan.edits).toEqual([]);
    expect(plan.skipped.ambiguous).toBe(1);
    expect(plan.nextText).toBeUndefined();
  });

  it("adopts a block that already holds exactly the text Rovara would render (a merge race), and holds one that differs", () => {
    const same = repoLesson("les_aaaa0001");
    const differs = repoLesson("les_aaaa0002");
    const file = renderLessonsFile([{ id: same.id, heading: "Whole repository", text: same.body }, { id: differs.id, heading: "Whole repository", text: "Somebody's other words." }]);
    const plan = planRepoFile(input({ lessons: [same, differs], fileText: file }));
    expect(Object.keys(plan.adopted)).toEqual(["les_aaaa0001"]);
    expect(plan.held).toEqual(["les_aaaa0002"]);
    expect(plan.nextText).toBeUndefined();
  });

  it("adds stop at the cap of lessons and at 64 KB; removals are never blocked by a cap", () => {
    const many = Array.from({ length: LESSON_FILE_MAX_LESSONS + 40 }, (_, i) => repoLesson(`les_cap${String(i).padStart(5, "0")}`, { createdAt: i }));
    const plan = planRepoFile(input({ lessons: many }));
    expect(parseLessonsFile(plan.nextText!).blocks).toHaveLength(LESSON_FILE_MAX_LESSONS);
    expect(plan.skipped.capped).toBe(40);
    // The oldest are kept: the order is by age then id, not by anything that changes daily.
    expect(plan.adds[0]!.id).toBe("les_cap00000");
    const big = Array.from({ length: 200 }, (_, i) => repoLesson(`les_big${String(i).padStart(5, "0")}`, { createdAt: i, body: `${"w".repeat(580)} ${String(i)}` }));
    const bytes = planRepoFile(input({ lessons: big }));
    expect(Buffer.byteLength(bytes.nextText!, "utf8")).toBeLessThanOrEqual(LESSON_FILE_MAX_BYTES);
    expect(bytes.skipped.capped).toBeGreaterThan(0);
    // A file already at the cap still gets its removal.
    const file = bytes.nextText!;
    const gone = bytes.adds[0]!.id;
    const withGone = planRepoFile(input({ lessons: big.filter((l) => l.id !== gone), fileText: file, rendered: Object.fromEntries(bytes.adds.map((a) => [a.id, a.fingerprint])) }));
    expect(withGone.removals.map((r) => r.id)).toContain(gone);
  });

  it("paused: no adds and no edits, removals still", () => {
    const keep = repoLesson("les_aaaa0001");
    const gone = repoLesson("les_aaaa0002", { status: "retired" });
    const file = renderLessonsFile([keep, gone].map((l) => ({ id: l.id, heading: "Whole repository", text: l.body })));
    const edited = { ...keep, body: "A changed wording." };
    const plan = planRepoFile(input({ lessons: [edited, gone, repoLesson("les_aaaa0003")], fileText: file, rendered: { les_aaaa0001: renderedOf(keep), les_aaaa0002: renderedOf(gone) }, addsPaused: true }));
    expect(plan.removals.map((r) => r.id)).toEqual(["les_aaaa0002"]);
    expect(plan.edits).toEqual([]);
    expect(plan.adds).toEqual([]);
    expect(plan.addsPaused).toBe(true);
    expect(OTHER_PLACE).not.toBe(PLACE);
  });
});
const renderedOf = (lesson: ReturnType<typeof repoLesson>): string => renderLesson(lesson, "api")!.fingerprint;

describe("the pointer", () => {
  it("goes to the files found, else AGENTS.md (created); a symbolic link stands in for its target", () => {
    expect(pointerTargets([], undefined)).toEqual(["AGENTS.md"]);
    expect(pointerTargets(["CLAUDE.md", "AGENTS.md"], undefined)).toEqual(["AGENTS.md", "CLAUDE.md"]);
    expect(pointerTargets(["CLAUDE.md"], undefined, ["AGENTS.md"])).toEqual(["CLAUDE.md"]);
    expect(pointerTargets([], undefined, ["AGENTS.md"])).toEqual([]);
    expect(pointerTargets(["CLAUDE.md"], ["AGENTS.md"])).toEqual(["AGENTS.md"]);
  });
  it("is appended once and never again", () => {
    const once = withPointer("AGENTS.md", "# Agents\n\nRules.\n")!;
    expect(once).toBe("# Agents\n\nRules.\n\n## Team lessons\n\nBefore you change code in this repository, read `.rovara/lessons.md`: it holds lessons this team has already learned from its own reviews and commits.\n");
    expect(withPointer("AGENTS.md", once)).toBeUndefined();
    expect(withPointer("CLAUDE.md", "Use @.rovara/lessons.md here\n")).toBeUndefined();
    expect(withPointer("AGENTS.md", undefined)).toMatch(/^# Agent instructions\n\n## Team lessons/u);
    expect(withPointer("CLAUDE.md", "a\r\nb\r\n")).toBe("a\r\nb\r\n\r\n@.rovara/lessons.md\r\n");
  });
});

describe("the pull request words and the status lines", () => {
  it("put removals first, show the paused line, keep titles in code spans (a mention does nothing) and cap long lists", () => {
    const plan = planRepoFile(input({ lessons: Array.from({ length: 130 }, (_, i) => repoLesson(`les_many${String(i).padStart(4, "0")}`, { title: "Use the retry helper `now`", createdAt: i })) }));
    const body = prBody({ ...plan, removals: [{ id: "les_old00001", reason: "faded", title: "Old @name text" }], addsPaused: true, pausedBy: "unmerged" }, { pointerFiles: ["AGENTS.md"], unmerged: 3 });
    expect(body.indexOf("Proposed removals (1)")).toBeLessThan(body.indexOf("Proposed new lessons"));
    expect(body).toContain("`Old @name text`");
    expect(body).toContain("`Use the retry helper 'now'`");
    expect(body).toContain("- and 30 more");
    expect(body).toContain("Rovara has paused new lessons until a lessons PR is merged; 1 removal is waiting.");
    expect(body).toContain("also adds one pointer line to `AGENTS.md`");
    expect(prTitle({ removals: [], edits: [], adds: plan.adds })).toBe("Rovara: weekly lessons update (130 new lessons)");
  });

  it("status lines: waiting removals, paused, held, deleted file, pointer missing and a problem, in fixed words", () => {
    const state = { ...newRepoFileState(PLACE, "api"), enabled: true, unmerged: 3, held: ["les_aaaa0001", "les_aaaa0002"], pointerProposed: true, pointerMissing: true, problem: "file_too_big" as const,
      open: { branch: "rovara/lessons-000000000001" as const, number: "7", url: "https://github.com/acme/api/pull/7", headRevision: "a".repeat(40), baseRevision: "b".repeat(40), digest: "d", openedAt: 1, removals: 4, edits: 0, adds: 0, added: {}, edited: {}, removed: [], pointer: false } };
    expect(noticesOf(state, NOW_T)).toEqual([
      ".rovara/lessons.md is over 64 KB, so Rovara left it alone",
      "Rovara has paused new lessons until a lessons PR is merged; 4 removals are waiting",
      "2 lessons your team edited are left as written",
      "Pointer missing: no agent file names .rovara/lessons.md",
    ]);
    expect(rowOf(state, NOW_T)).toMatchObject({ repo: "api", additionsPaused: true, removalsWaiting: 4, held: 2, pointer: "missing", pr: { number: "7", removals: 4 } });
    expect(noticesOf({ ...newRepoFileState(PLACE, "api"), fileDeleted: true }, NOW_T)).toEqual(["The lessons file was deleted, so Rovara stopped proposing. Resume to start again."]);
    expect(noticesOf({ ...newRepoFileState(PLACE, "api"), unmerged: 1, open: { ...state.open, removals: 2 } }, NOW_T)).toEqual(["2 removals waiting in your lessons PR"]);
  });
});

describe("bullets the team wrote", () => {
  const text = (lesson: string): string => `${renderLessonsFile([])}\n## Whole repository\n\n- ${lesson}\n`;
  it("a lesson whose text is already a bullet in the file gets an id line (a tag edit), not a second copy", () => {
    const lesson = repoLesson("les_aaaa0001", { body: "Use the shared helper." });
    const plan = planRepoFile(input({ lessons: [lesson], fileText: text("Use the shared helper.") }));
    expect(plan.adds).toEqual([]);
    expect(plan.edits).toMatchObject([{ id: "les_aaaa0001", tag: true, moved: false }]);
    expect(plan.nextText).toContain("<!-- rovara:les_aaaa0001 -->\n- Use the shared helper.");
    expect(plan.nextText!.match(/Use the shared helper\./gu)).toHaveLength(1);
  });
  it("an id Rovara merged whose line a tool stripped is not declined while its text is there: it is tagged; without the text it is declined", () => {
    const lesson = repoLesson("les_aaaa0001", { body: "Use the shared helper." });
    const other = repoLesson("les_aaaa0002", { body: "Another lesson." });
    const stripped = `${text("Use the shared helper.")}\n<!-- rovara:les_aaaa0002 -->\n- Another lesson.\n`;
    const plan = planRepoFile(input({ lessons: [lesson, other], fileText: stripped, rendered: { les_aaaa0001: "x:y", les_aaaa0002: "x:y" } }));
    expect(plan.newlyDeclined).toEqual([]);
    expect(plan.edits.filter((e) => e.tag === true).map((e) => e.id)).toEqual(["les_aaaa0001"]);
    expect(planRepoFile(input({ lessons: [lesson, other], fileText: `${text("Something else.")}\n<!-- rovara:les_aaaa0002 -->\n- Another lesson.\n`, rendered: { les_aaaa0001: "x:y", les_aaaa0002: "x:y" } })).newlyDeclined).toEqual(["les_aaaa0001"]);
  });
  it("a file with no marker at all declines nothing (it says nothing about who was removed)", () => {
    const lesson = repoLesson("les_aaaa0001");
    expect(planRepoFile(input({ lessons: [lesson], fileText: text("Unrelated."), rendered: { les_aaaa0001: "x:y" } })).newlyDeclined).toEqual([]);
  });
  it("while additions wait, nothing is tagged (and nothing declined for a stripped id)", () => {
    const lesson = repoLesson("les_aaaa0001", { body: "Use the shared helper." });
    const plan = planRepoFile(input({ lessons: [lesson], fileText: `${text("Use the shared helper.")}\n<!-- rovara:les_zzzz9999 -->\n- Other.\n`, rendered: { les_aaaa0001: "x:y" }, addsPaused: true }));
    expect(plan.edits).toEqual([]);
    expect(plan.newlyDeclined).toEqual([]);
  });
  it("a tag edit is worded in the pull request and counted as an edit", () => {
    const lesson = repoLesson("les_aaaa0001", { body: "Use the shared helper." });
    const plan = planRepoFile(input({ lessons: [lesson], fileText: text("Use the shared helper.") }));
    expect(prBody(plan, { pointerFiles: [], unmerged: 0 })).toContain("puts the id line before the bullet your team wrote");
    expect(prTitle(plan)).toContain("1 edit");
  });
});

describe("what the status says about read-back", () => {
  it("an unreadable file says what to do, a bulk disappearance says what Rovara will do, and a refused line is counted without its text", () => {
    const state = { ...newRepoFileState(PLACE, "api"), problem: "file_unreadable" as const, readBackHeld: { missing: 4, digest: "0123456789abcdef", at: 1 }, refused: { "0123456789abcdef": "names_a_person" as const } };
    const notices = noticesOf(state, NOW_T).join("\n");
    expect(notices).toContain("delete the file to pause Rovara here");
    expect(notices).toContain("4 lessons are missing from the lessons file; on or after");
    expect(notices).toContain("a person will be asked to confirm retiring them unless they are restored");
    expect(notices).toContain("1 line in the lessons file was not read as lessons");
  });
});
