// Lessons in the repo, lane R3 (decisions 50, 50a, 50b; design rev 2 section 6): read-back, file -> Rovara, one way, by id. The team's edits of the merged `.rovara/lessons.md` are taken into Rovara by the weekly pass:
// changed text = a correction, a removed id = retired by the team, a bullet with no id = a new person-approved lesson. Nothing is ever retired or changed on a read that failed, and an erased id is never brought back.
// The mutation checks (retire on a parse failure, resurrect a gone id, let formatter churn make edits) are recorded in the lane report.
import { afterEach, describe, expect, it } from "vitest";
import { setLearnedLessonsGate } from "../../../packages/broker/src/lessons/policy.js";
import { applyFileChanges, bodyHashOf, parseLessonsFile } from "../../../packages/broker/src/lessons/repo-file-format.js";
import { readBackFile, scopeOfHeading } from "../../../packages/broker/src/lessons/repo-file-readback.js";
import { lessonDeletionPort } from "../../../packages/broker/src/lessons/deletion.js";
import { noticesOf, rowOf } from "../../../packages/broker/src/lessons/repo-file-pr.js";
import { settings } from "./lesson-helpers.js";
import { DAY, FILE, passSetup, repoLesson } from "./repo-file-helpers.js";
import { lessonsRepoFileJob, type RepoFileRuntime } from "../../../packages/broker/src/lessons/repo-file-job.js";
import { sweepProject } from "../../../packages/broker/src/lessons/repo-file-sweep.js";
import { newRepoFileState } from "../../../packages/broker/src/lessons/repo-file-state.js";

afterEach(() => { setLearnedLessonsGate(undefined); });
type W = ReturnType<typeof passSetup>;
const FIRST = "Lesson text for les_aaaa0001: use the shared helper.";
const idsIn = (text: string | undefined): string[] => (text === undefined ? [] : parseLessonsFile(text).blocks.map((b) => b.id));
const lesson = async (w: W, id: string) => (await w.store.listAllHeads(w.key)).find((l) => l.id === id);

/** A repository with two merged lessons (ids les_aaaa0001 and les_aaaa0002) and Rovara's record of them. */
async function merged(over: Parameters<typeof passSetup>[0] = {}): Promise<W> {
  const w = passSetup(over);
  await w.seedLessons(repoLesson("les_aaaa0001"), repoLesson("les_aaaa0002"));
  await w.enable();
  const result = await w.run();
  expect(result.status).toBe("opened");
  w.host.merge(Number((result as { number: string }).number));
  return w;
}
const changeFile = (w: W, edit: (text: string) => string): void => { w.host.setFile("main", FILE, edit(w.host.file("main", FILE)!)); };
const pass = async (w: W) => { w.week(); return w.run(); };
const actions = (w: W): string[] => w.audit.actions();

describe("a changed block under a known id is the team's correction", () => {
  it("takes the team's wording as the lesson's text, as a person edit by 'repository edit', audited; repo-only stays, the hold is released and nothing is proposed back", async () => {
    const w = await merged();
    const before = (await lesson(w, "les_aaaa0001"))!;
    changeFile(w, (t) => t.replace(FIRST, "The team's own wording: call the shared helper."));
    expect(await pass(w)).toEqual({ status: "no_changes" });
    const after = (await lesson(w, "les_aaaa0001"))!;
    expect(after.body).toBe("The team's own wording: call the shared helper.");
    expect(after.version).toBeGreaterThan(before.version);
    expect(after.status).toBe("active");
    expect(after.provenance.repoOnly).toEqual(before.provenance.repoOnly);
    expect(after.trial).toBeUndefined();
    expect(after.approvals).toHaveLength(1);
    expect(after.approvals[0]).toMatchObject({ mode: "one", by: "system:repository-edit" });
    const state = await w.current();
    expect(state.held).toEqual([]);
    expect(state.readBack).toMatchObject({ edited: 1, retired: 0, imported: 0 });
    const event = w.audit.events.find((e) => e.action === "lesson.updated")!;
    expect(event).toMatchObject({ lessonId: "les_aaaa0001", actor: "repository edit", facts: { cause: "repository_edit" } });
    // Rovara never overwrites it, even though its own store disagreed a moment ago: no edit, no PR.
    expect(w.host.open).toHaveLength(0);
    // The other lesson is untouched.
    expect((await lesson(w, "les_aaaa0002"))!.version).toBe(1);
  });

  it("a SUBSTANTIAL rewrite clears the thumbs-down and the pending removal from before it; help counts are kept (decision 76.2)", async () => {
    const w = await merged();
    await w.store.mutate(w.key, "les_aaaa0001", (l) => ({ counters: { ...l.counters, helpful: 3, harmful: 1 }, retireProposedAt: 5 }));
    changeFile(w, (t) => t.replace(FIRST, "Prefer the retry wrapper in the http client and give up after three tries."));
    expect(await pass(w)).toEqual({ status: "no_changes" });
    const after = (await lesson(w, "les_aaaa0001"))!;
    expect(after.counters).toMatchObject({ helpful: 3, harmful: 0 });
    expect(after.retireProposedAt).toBeUndefined();
  });

  it("a SMALL edit (one word) keeps the thumbs-down and the pending removal: a tiny change does not reset a lesson's record", async () => {
    const w = await merged();
    await w.store.mutate(w.key, "les_aaaa0001", (l) => ({ counters: { ...l.counters, helpful: 3, harmful: 4 }, retireProposedAt: 5 }));
    changeFile(w, (t) => t.replace(FIRST, `${FIRST.replace(/\.$/u, "")} now.`));
    await pass(w);
    const after = (await lesson(w, "les_aaaa0001"))!;
    expect(after.body).toContain("now.");
    expect(after.counters).toMatchObject({ helpful: 3, harmful: 4 });
    expect(after.retireProposedAt).toBe(5);
  });

  it("the approval a read-back gives is honest: its approver is the repository edit, not a person", async () => {
    const w = await merged();
    changeFile(w, (t) => t.replace(FIRST, "Reworded by someone who can write to the repository."));
    await pass(w);
    expect((await lesson(w, "les_aaaa0001"))!.approvals).toMatchObject([{ by: "system:repository-edit", mode: "one" }]);
  });

  it("a team rewording that names a person, or asks for more access, is not taken in: recorded once with a fixed reason, the block stays held", async () => {
    const w = await merged({ names: ["Ann Lee"] });
    changeFile(w, (t) => t.replace(FIRST, "Ask Ann Lee before you touch the helper."));
    await pass(w);
    expect((await lesson(w, "les_aaaa0001"))!.body).toBe(FIRST);
    const state = await w.current();
    expect(Object.values(state.refused ?? {})).toEqual(["names_a_person"]);
    expect(state.held).toEqual(["les_aaaa0001"]);
    expect(actions(w).filter((a) => a === "lesson.updated")).toHaveLength(0);
    const refusals = () => actions(w).filter((a) => a === "lesson.refused").length;
    expect(refusals()).toBe(1);
    await pass(w);
    expect(refusals()).toBe(1);
    // Asking for a capability change.
    const c = await merged();
    changeFile(c, (t) => t.replace(FIRST, "Grant the agent access to the shell and all credentials."));
    await pass(c);
    expect((await lesson(c, "les_aaaa0001"))!.body).toBe(FIRST);
    expect(Object.values((await c.current()).refused ?? {})).toEqual(["capability_request"]);
  });

  it("a text with words about tests (tier 2) is the team's own: Rovara does not propose its removal for its tier", async () => {
    const w = await merged();
    changeFile(w, (t) => t.replace(FIRST, "Always run the unit tests and the security checks before you push."));
    expect(await pass(w)).toEqual({ status: "no_changes" });
    expect((await lesson(w, "les_aaaa0001"))!.tier).toBe(2);
    expect(w.host.open).toHaveLength(0);
    expect((await w.current()).held).toEqual([]);
  });
});

describe("formatter churn is not an edit", () => {
  const variants: Array<[string, (t: string) => string]> = [
    ["bullet marker and spaces", (t) => t.replace(`- ${FIRST}`, `*   ${FIRST}`)],
    ["wrapping", (t) => t.replace(`- ${FIRST}`, `- Lesson text for les_aaaa0001:\n  use the shared\n  helper.`)],
    ["CRLF line endings", (t) => t.replace(/\n/gu, "\r\n")],
    ["decomposed accents", (t) => t.replace(`- ${FIRST}`, `- ${FIRST.replace("helper", "hélper").replace("hélper", "helper")}`)],
    ["extra blank lines between blocks", (t) => t.replace(/\n\n/gu, "\n\n\n")],
  ];
  it.each(variants)("%s: no new version, no audit line, nothing proposed", async (_name, change) => {
    const w = await merged();
    changeFile(w, change);
    const versions = (await lesson(w, "les_aaaa0001"))!.version;
    expect(await pass(w)).toEqual({ status: "no_changes" });
    expect((await lesson(w, "les_aaaa0001"))!.version).toBe(versions);
    expect(actions(w).filter((a) => a === "lesson.updated" || a === "lesson.retired")).toEqual([]);
    expect((await w.current()).readBack).toBeUndefined();
  });

  it("NFD against NFC composition of the same text is the same text", async () => {
    const w = passSetup();
    await w.seedLessons(repoLesson("les_aaaa0001", { body: "Use the café helper, not the old one." }));
    await w.enable();
    const result = await w.run();
    w.host.merge(Number((result as { number: string }).number));
    changeFile(w, (t) => t.replace("café", "café"));
    expect(await pass(w)).toEqual({ status: "no_changes" });
    expect(actions(w).filter((a) => a === "lesson.updated")).toEqual([]);
  });
});

describe("a known id missing from the file is retired by the team", () => {
  it("retires it with the reason 'removed in the repository', audited, and never proposes it back", async () => {
    const w = await merged();
    changeFile(w, (t) => t.replace(/<!-- rovara:les_aaaa0001 -->\n- [^\n]*\n\n?/u, ""));
    expect(await pass(w)).toEqual({ status: "no_changes" });
    expect((await lesson(w, "les_aaaa0001"))!.status).toBe("retired");
    expect((await lesson(w, "les_aaaa0002"))!.status).toBe("active");
    const event = w.audit.events.find((e) => e.action === "lesson.retired")!;
    expect(event).toMatchObject({ lessonId: "les_aaaa0001", actor: "repository edit", facts: { cause: "removed_in_repository" } });
    const state = await w.current();
    expect(state.declined).toContain("les_aaaa0001");
    expect(state.readBack).toMatchObject({ retired: 1, edited: 0 });
    await w.seedLessons(repoLesson("les_aaaa0003"));
    await pass(w);
    expect(idsIn(w.host.file((await w.current()).open!.branch, FILE))).toEqual(["les_aaaa0002", "les_aaaa0003"]);
  });

  it("a lesson Rovara never merged is not 'removed' just because the file does not have it", async () => {
    const w = await merged();
    await w.seedLessons(repoLesson("les_aaaa0009", { status: "active" }));
    changeFile(w, (t) => t.replace(/<!-- rovara:les_aaaa0001 -->\n- [^\n]*\n\n?/u, ""));
    await pass(w);
    expect((await lesson(w, "les_aaaa0009"))!.status).toBe("active");
  });

  it("a lesson Rovara's own open pull request would add is not retired either", async () => {
    const w = await merged();
    await w.seedLessons(repoLesson("les_aaaa0004"));
    w.week();
    const opened = await w.run();
    expect(opened).toMatchObject({ status: "opened", adds: 1 });
    changeFile(w, (t) => t.replace(/<!-- rovara:les_aaaa0001 -->\n- [^\n]*\n\n?/u, ""));
    await pass(w);
    expect((await lesson(w, "les_aaaa0004"))!.status).toBe("active");
  });
});

describe("a bullet with no id line is a new person-approved lesson", () => {
  const TEAM = "Never read the config file before the logger is ready.";
  async function withBullet(extra = `\n- ${TEAM}\n`): Promise<W> {
    const w = await merged();
    changeFile(w, (t) => `${t.trimEnd()}\n${extra}`);
    return w;
  }

  it("creates the lesson from the text: active, person-approved, repo-only for this repository, audited, scoped from its section; the next pull request adds the id line and leaves the bullet", async () => {
    const w = await withBullet();
    const result = await pass(w);
    expect(result).toMatchObject({ status: "opened", edits: 1, adds: 0, removals: 0 });
    const made = (await w.store.listAllHeads(w.key)).filter((l) => l.body === TEAM);
    expect(made).toHaveLength(1);
    const [created] = made;
    expect(created).toMatchObject({ status: "active", scope: { repos: ["api"] }, type: "convention" });
    expect(created!.provenance.repoOnly).toEqual({ place: "github:repo/1001" });
    expect(created!.trial).toBeUndefined();
    expect(created!.approvals).toMatchObject([{ mode: "one" }]);
    expect(w.audit.events.find((e) => e.action === "lesson.activated" && e.lessonId === created!.id)).toMatchObject({ actor: "repository edit", facts: { cause: "repository_edit" } });
    expect((await w.current()).readBack).toMatchObject({ imported: 1 });
    const branchText = w.host.file((await w.current()).open!.branch, FILE)!;
    expect(branchText).toContain(`<!-- rovara:${created!.id} -->\n- ${TEAM}`);
    expect(w.host.open[0]!.body).toContain("puts the id line before the bullet your team wrote");
    // Only the id line is new in the file: the bullet's own bytes are as the team wrote them.
    expect(branchText.replace(`<!-- rovara:${created!.id} -->\n`, "")).toBe(w.host.file("main", FILE));
    // Merged: the next pass has nothing left to read, change or add, and no second lesson.
    w.host.merge(w.host.open[0]!.number);
    expect(await pass(w)).toEqual({ status: "no_changes" });
    expect((await w.store.listAllHeads(w.key)).filter((l) => l.body === TEAM)).toHaveLength(1);
    expect(idsIn(w.host.file("main", FILE))).toContain(created!.id);
  });

  it("is idempotent while the id line is not merged yet: the same bullet is never made into a second lesson", async () => {
    const w = await withBullet();
    await pass(w);
    await pass(w);
    await pass(w);
    expect((await w.store.listAllHeads(w.key)).filter((l) => l.body === TEAM)).toHaveLength(1);
    expect(actions(w).filter((a) => a === "lesson.activated")).toHaveLength(1);
  });

  it("a bullet in a section named for paths is scoped to those paths", async () => {
    const w = await withBullet("\n## src/api/**\n\n- Handlers return problem+json for every error.\n");
    await pass(w);
    const created = (await w.store.listAllHeads(w.key)).find((l) => l.body === "Handlers return problem+json for every error.")!;
    expect(created.scope).toEqual({ repos: ["api"], paths: ["src/api/**"] });
  });

  it("a bullet that names a person is not imported: nothing is made, the reason is recorded once, and the file is not touched", async () => {
    const w = await withBullet("\n- Ask Ann Lee before you change the retry helper.\n");
    const before = (await w.store.listAllHeads(w.key)).length;
    const result = await pass(w);
    expect(result).toEqual({ status: "no_changes" });
    expect((await w.store.listAllHeads(w.key)).length).toBe(before);
    const state = await w.current();
    expect(Object.values(state.refused ?? {})).toEqual(["names_a_person"]);
    expect(actions(w).filter((a) => a === "lesson.refused")).toHaveLength(1);
    await pass(w);
    expect(actions(w).filter((a) => a === "lesson.refused")).toHaveLength(1);
    expect(w.host.open).toHaveLength(0);
  });

  it("an @handle or an e-mail address names a person too", async () => {
    const w = await withBullet("\n- Ping @octocat about the helper.\n- Mail ops@example.com when the queue stalls.\n");
    await pass(w);
    expect(Object.values((await w.current()).refused ?? {})).toEqual(["names_a_person", "names_a_person"]);
  });

  it("bullets inside a code fence, header text and free paragraphs are not lessons", async () => {
    const w = await withBullet("\nFree paragraph the team wrote.\n\n```\n- not a lesson, just an example\n```\n");
    const before = (await w.store.listAllHeads(w.key)).length;
    expect(await pass(w)).toEqual({ status: "no_changes" });
    expect((await w.store.listAllHeads(w.key)).length).toBe(before);
  });

  it("at most 50 new lessons a pass; the rest wait for the next one", async () => {
    const w = await withBullet(`\n${Array.from({ length: 55 }, (_, i) => `- Convention number ${String(i)} of the team.`).join("\n\n")}\n`);
    await pass(w);
    expect((await w.store.listAllHeads(w.key)).filter((l) => l.provenance.reflectorRun === "repo_file")).toHaveLength(50);
    await pass(w);
    expect((await w.store.listAllHeads(w.key)).filter((l) => l.provenance.reflectorRun === "repo_file")).toHaveLength(55);
  });

  it("a bullet that is already the text of an active lesson is that lesson, not a new one (no second copy)", async () => {
    const w = await withBullet(`\n- ${FIRST}\n`);
    await pass(w);
    expect((await w.store.listAllHeads(w.key)).filter((l) => l.body === FIRST)).toHaveLength(1);
  });
});

describe("an erased or gone id is never resurrected", () => {
  it("a block carrying the id of a purged lesson is left to the erasure sweep: not edited, not imported, not retired", async () => {
    const w = await merged();
    await w.store.markGone(w.key, "les_aaaa0001", "purged");
    await w.store.purge(w.key, "les_aaaa0001");
    changeFile(w, (t) => t.replace(FIRST, "Text the team put under the erased lesson's id."));
    const before = actions(w).length;
    await pass(w);
    expect(await lesson(w, "les_aaaa0001")).toBeUndefined();
    expect((await w.store.listAllHeads(w.key)).filter((l) => l.body.includes("erased lesson's id"))).toEqual([]);
    expect(actions(w).slice(before).filter((a) => a === "lesson.updated" || a === "lesson.activated" || a === "lesson.retired")).toEqual([]);
  });

  it("a withdrawn lesson's block edited by the team is not taken in", async () => {
    const w = await merged();
    const head = (await lesson(w, "les_aaaa0001"))!;
    await w.store.commit(w.key, await w.store.setVersion(w.key), [{ ...head, version: head.version + 1, status: "withdrawn" }], 9);
    await w.store.markGone(w.key, "les_aaaa0001", "withdrawn");
    changeFile(w, (t) => t.replace(FIRST, "Reworded under a withdrawn id."));
    await pass(w);
    expect((await lesson(w, "les_aaaa0001"))!.body).toBe(FIRST);
    expect(actions(w).filter((a) => a === "lesson.updated")).toEqual([]);
  });

  it("a gone marker alone (the lesson still active in the store, as in the moment between the tombstone and the scrub) keeps read-back away: no edit, and no retirement when the block is removed", async () => {
    const w = await merged();
    await w.store.markGone(w.key, "les_aaaa0001", "withdrawn");
    await w.store.markGone(w.key, "les_aaaa0002", "purged");
    changeFile(w, (t) => t.replace(FIRST, "Reworded under a tombstoned id.").replace(/<!-- rovara:les_aaaa0002 -->\n- [^\n]*\n\n?/u, ""));
    await pass(w);
    expect((await lesson(w, "les_aaaa0001"))!.body).toBe(FIRST);
    expect((await lesson(w, "les_aaaa0002"))!.status).toBe("active");
    expect(actions(w).filter((a) => a === "lesson.updated" || a === "lesson.retired")).toEqual([]);
  });

  it("an erased id missing from the file is not 'retired by the team': the lesson is gone, the sweep owns it, and read-back writes nothing about it", async () => {
    const w = await merged();
    await w.store.markGone(w.key, "les_aaaa0001", "purged");
    await w.store.purge(w.key, "les_aaaa0001");
    changeFile(w, (t) => t.replace(/<!-- rovara:les_aaaa0001 -->\n- [^\n]*\n\n?/u, ""));
    await pass(w);
    expect(actions(w).filter((a) => a === "lesson.retired")).toEqual([]);
    expect((await w.current()).readBack).toBeUndefined();
  });

  it("the erasure sweep still removes the block whatever the team wrote under the erased id (read-back does not stand in its way)", async () => {
    const w = await merged();
    await w.store.markGone(w.key, "les_aaaa0001", "purged");
    await w.store.purge(w.key, "les_aaaa0001");
    changeFile(w, (t) => t.replace(FIRST, "Team text under an erased id."));
    await pass(w);
    await w.sweep();
    const removal = w.host.open.find((pr) => pr.source.startsWith("rovara/lessons-"));
    expect(removal).toBeDefined();
    expect(idsIn(w.host.file(removal!.source, FILE))).not.toContain("les_aaaa0001");
  });
});

describe("a failed or untrustworthy read changes nothing", () => {
  it("a read that fails (host error) is a problem on the row: nothing retired, edited or made", async () => {
    const w = await merged();
    changeFile(w, (t) => t.replace(/<!-- rovara:les_aaaa0001 -->\n- [^\n]*\n\n?/u, ""));
    w.host.failCalls.add("fileAtRevision");
    expect(await pass(w)).toEqual({ status: "problem", problem: "file_unreadable" });
    expect((await lesson(w, "les_aaaa0001"))!.status).toBe("active");
    expect(actions(w).filter((a) => a === "lesson.retired")).toEqual([]);
    // The file read works again: now the removal is read back.
    w.host.failCalls.delete("fileAtRevision");
    await pass(w);
    expect((await lesson(w, "les_aaaa0001"))!.status).toBe("retired");
  });

  it("a file that is not valid text (a replacement character, a NUL) is unreadable: no retirement, no import, no edit", async () => {
    for (const bad of ["�", "\u0000"]) {
      const w = await merged();
      changeFile(w, (t) => `${t.replace(/<!-- rovara:les_aaaa0001 -->\n- [^\n]*\n\n?/u, "")}\n- A bullet ${bad} beside it.\n`);
      expect(await pass(w)).toEqual({ status: "problem", problem: "file_unreadable" });
      expect((await lesson(w, "les_aaaa0001"))!.status).toBe("active");
      expect((await w.store.listAllHeads(w.key)).length).toBe(2);
    }
  });

  it("a file that lost EVERY marker (emptied but for its header) is unreadable, not 'the team retired everything'", async () => {
    const w = await merged();
    changeFile(w, (t) => t.split("\n## ")[0]!.trimEnd().concat("\n"));
    expect(await pass(w)).toEqual({ status: "problem", problem: "file_unreadable" });
    expect((await lesson(w, "les_aaaa0001"))!.status).toBe("active");
    expect((await lesson(w, "les_aaaa0002"))!.status).toBe("active");
    expect((await w.current()).declined).toEqual([]);
    expect(actions(w).filter((a) => a === "lesson.retired")).toEqual([]);
  });

  it("markers stripped by a tool that drops HTML comments, texts kept: nothing is retired or declined, and the next pull request puts the id lines back", async () => {
    const w = await merged();
    changeFile(w, (t) => t.replace(/<!--[^>]*-->\n/gu, ""));
    const result = await pass(w);
    expect(result).toMatchObject({ status: "opened", edits: 2, adds: 0, removals: 0 });
    expect((await lesson(w, "les_aaaa0001"))!.status).toBe("active");
    expect((await lesson(w, "les_aaaa0002"))!.status).toBe("active");
    const state = await w.current();
    expect(state.declined).toEqual([]);
    expect(idsIn(w.host.file(state.open!.branch, FILE))).toEqual(["les_aaaa0001", "les_aaaa0002"]);
    expect((await w.store.listAllHeads(w.key)).length).toBe(2);
    // Merged: back to normal, no duplicates.
    w.host.merge(w.host.open[0]!.number);
    expect(await pass(w)).toEqual({ status: "no_changes" });
    expect((await w.store.listAllHeads(w.key)).length).toBe(2);
  });

  it("some markers stripped, texts kept: those lessons are not retired", async () => {
    const w = await merged();
    changeFile(w, (t) => t.replace("<!-- rovara:les_aaaa0001 -->\n", ""));
    const result = await pass(w);
    expect(result).toMatchObject({ status: "opened", edits: 1 });
    expect((await lesson(w, "les_aaaa0001"))!.status).toBe("active");
  });

  it("an audit ledger that is down stops the pass before a lesson is changed", async () => {
    const w = await merged();
    changeFile(w, (t) => t.replace(FIRST, "Reworded while the ledger is down."));
    w.failAudit.on = true;
    expect(await pass(w)).toEqual({ status: "problem", problem: "audit_down" });
    expect((await lesson(w, "les_aaaa0001"))!.body).toBe(FIRST);
  });

  it("read-back needs no host call but the file read the pass already made, and no model: it is text only", async () => {
    const w = await merged();
    changeFile(w, (t) => t.replace(FIRST, "Reworded for the call count."));
    w.host.calls.length = 0;
    await pass(w);
    expect(w.host.calls.filter((c) => c === "fileAtRevision").length).toBeLessThanOrEqual(4);
    expect(w.spyModel.calls).toBe(0);
  });
});

describe("idempotent, one way, and only where the file is switched on", () => {
  it("running the pass again changes nothing more: same versions, no second audit line", async () => {
    const w = await merged();
    changeFile(w, (t) => t.replace(FIRST, "Reworded once.").replace(/<!-- rovara:les_aaaa0002 -->\n- [^\n]*\n\n?/u, ""));
    await pass(w);
    const versions = (await w.store.listAllHeads(w.key)).map((l) => [l.id, l.version]);
    const count = actions(w).length;
    await pass(w);
    await pass(w);
    expect((await w.store.listAllHeads(w.key)).map((l) => [l.id, l.version])).toEqual(versions);
    expect(actions(w).length).toBe(count);
  });

  it("Rovara's store never writes the file back from read-back: the file on the default branch is untouched", async () => {
    const w = await merged();
    const text = FIRST.replace("helper", "tool");
    changeFile(w, (t) => t.replace(FIRST, text));
    const main = w.host.file("main", FILE);
    await pass(w);
    expect(w.host.file("main", FILE)).toBe(main);
    expect(w.host.writes.filter((write) => write.op === "commit" && write.branch === "main")).toEqual([]);
  });

  it("a repository that is not switched on is not read back", async () => {
    const w = await merged();
    const state = await w.current();
    await w.state.put(w.key, { ...state, enabled: false }, state.revision);
    changeFile(w, (t) => t.replace(FIRST, "Reworded with the switch off."));
    expect(await pass(w)).toEqual({ status: "skipped", reason: "not_enabled" });
    expect((await lesson(w, "les_aaaa0001"))!.body).toBe(FIRST);
  });

  it("while lessons are off nothing is read back", async () => {
    const w = await merged();
    changeFile(w, (t) => t.replace(FIRST, "Reworded while lessons are off."));
    w.deps.settings = settings({ preset: "standard", mode: "Off" });
    expect(await pass(w)).toEqual({ status: "skipped", reason: "lessons_off" });
    expect((await lesson(w, "les_aaaa0001"))!.body).toBe(FIRST);
  });

  it("a duplicated id is the team's: neither block is read back", async () => {
    const w = await merged();
    changeFile(w, (t) => `${t.trimEnd()}\n\n<!-- rovara:les_aaaa0001 -->\n- A second block under the same id.\n`);
    await pass(w);
    expect((await lesson(w, "les_aaaa0001"))!.body).toBe(FIRST);
  });

  it("a block the team only moved to another section is not an edit", async () => {
    const w = await merged();
    changeFile(w, (t) => t.replace("## Whole repository", "## Our retry rules"));
    await pass(w);
    expect(actions(w).filter((a) => a === "lesson.updated")).toEqual([]);
    expect((await w.current()).held.sort()).toEqual(["les_aaaa0001", "les_aaaa0002"]);
  });
});

describe("review round 1 (rr3b)", () => {
  const TEAM = "Never read the config file before the logger is ready.";
  const strip = (id: string) => (t: string) => t.replace(new RegExp(`<!-- rovara:${id} -->\\n- [^\\n]*\\n\\n?`, "u"), "");
  const active = async (w: W, body: string) => (await w.store.listAllHeads(w.key)).filter((l) => l.body === body && l.status === "active");

  describe("H1: an imported bullet is tracked from the moment it is imported", () => {
    it("A: deleted before the id-line pull request merges: retired, never proposed back, no live copy", async () => {
      const w = await merged();
      changeFile(w, (t) => `${t.trimEnd()}\n\n- ${TEAM}\n`);
      expect(await pass(w)).toMatchObject({ status: "opened", edits: 1 });
      changeFile(w, (t) => t.replace(`\n- ${TEAM}\n`, ""));
      const result = await pass(w);
      expect(await active(w, TEAM)).toEqual([]);
      const state = await w.current();
      expect(state.readBack).toMatchObject({ retired: 1 });
      expect(result.status).not.toBe("opened");
      expect(w.host.open.map((pr) => pr.body).join("\n")).not.toContain("new lesson");
    });
    it("A2: reworded before the id-line pull request merges: the old lesson is retired and exactly one live lesson has the new text", async () => {
      const w = await merged();
      changeFile(w, (t) => `${t.trimEnd()}\n\n- ${TEAM}\n`);
      await pass(w);
      changeFile(w, (t) => t.replace(TEAM, "Read the config file only after the logger is ready."));
      await pass(w);
      expect(await active(w, TEAM)).toEqual([]);
      expect(await active(w, "Read the config file only after the logger is ready.")).toHaveLength(1);
      expect((await w.store.listAllHeads(w.key)).filter((l) => l.provenance.reflectorRun === "repo_file" && l.status === "active")).toHaveLength(1);
    });
    it("records the imported bullet's fingerprint as rendered, and a bullet whose cleaned text differs from the line is not retired or imported twice", async () => {
      const w = await merged();
      const messy = "Call the helper <b>twice</b> before the first retry.";
      changeFile(w, (t) => `${t.trimEnd()}\n\n- ${messy}\n`);
      await pass(w);
      const made = (await w.store.listAllHeads(w.key)).filter((l) => l.provenance.reflectorRun === "repo_file");
      expect(made).toHaveLength(1);
      expect(Object.keys((await w.current()).rendered)).toContain(made[0]!.id);
      await pass(w);
      await pass(w);
      expect((await w.store.listAllHeads(w.key)).filter((l) => l.provenance.reflectorRun === "repo_file" && l.status === "active")).toHaveLength(1);
    });
  });

  describe("H2: erased words do not come back as a new lesson when the id line is stripped", () => {
    async function erased(w: W, id = "les_aaaa0001"): Promise<void> {
      const port = lessonDeletionPort({ store: w.store, vectors: { get: async () => new Map(), put: async () => undefined, remove: async () => undefined }, audit: w.deps.audit, now: w.clock.now });
      await port.withdraw(w.key.workspaceId, w.key.project, id, "sources_deleted");
    }
    it("D: only the erased lesson's id line is deleted: its text is not imported, now or at any later pass (refused once, recorded)", async () => {
      const w = await merged();
      await erased(w);
      changeFile(w, (t) => t.replace("<!-- rovara:les_aaaa0001 -->\n", ""));
      await pass(w);
      expect((await w.store.listAllHeads(w.key)).filter((l) => l.body === FIRST && l.status === "active" && l.id !== "les_aaaa0001")).toEqual([]);
      expect(Object.values((await w.current()).refused ?? {})).toEqual(["gone_text"]);
      await pass(w);
      await pass(w);
      expect((await w.store.listAllHeads(w.key)).filter((l) => l.provenance.reflectorRun === "repo_file")).toEqual([]);
    });
    it("D2: a formatter strips EVERY comment while one lesson is erased: the others are kept and re-marked, the erased text is not imported", async () => {
      const w = await merged();
      await erased(w);
      changeFile(w, (t) => t.replace(/<!--[^>]*-->\n/gu, ""));
      await pass(w);
      expect((await w.store.listAllHeads(w.key)).filter((l) => l.provenance.reflectorRun === "repo_file")).toEqual([]);
      expect((await lesson(w, "les_aaaa0002"))!.status).toBe("active");
    });
    it("a deliberate re-paste after the block was removed (no id line was ever stripped) is the team's new lesson (decision 76.3)", async () => {
      const w = await merged();
      await erased(w);
      // The removal pull request for the erased block is merged by the team.
      const swept = await w.sweep();
      expect(swept.removalOpened).toBe(true);
      w.host.merge(w.host.open.find((pr) => pr.source.startsWith("rovara/lessons-"))!.number);
      await pass(w);
      changeFile(w, (t) => `${t.trimEnd()}\n\n- ${FIRST}\n`);
      await pass(w);
      expect((await w.store.listAllHeads(w.key)).filter((l) => l.body === FIRST && l.status === "active" && l.provenance.reflectorRun === "repo_file")).toHaveLength(1);
    });
  });

  describe("M1: a bulk disappearance is held, not retired", () => {
    async function eight(): Promise<W> {
      const w = passSetup();
      await w.seedLessons(...Array.from({ length: 8 }, (_, i) => repoLesson(`les_bbbb000${String(i + 1)}`)));
      await w.enable();
      const result = await w.run();
      w.host.merge(Number((result as { number: string }).number));
      return w;
    }
    it("a file cut after the first block retires nothing, says so on the status, and is not declined", async () => {
      const w = await eight();
      changeFile(w, (t) => t.slice(0, t.indexOf("<!-- rovara:les_bbbb0002 -->")));
      await pass(w);
      expect((await w.store.listAllHeads(w.key)).filter((l) => l.status === "retired")).toEqual([]);
      const state = await w.current();
      expect(state.readBackHeld).toMatchObject({ missing: 7 });
      expect(state.declined).toEqual([]);
      expect(noticesOf(state, w.clock.now()).join(" ")).toContain("7 lessons are missing from the lessons file");
    });
    it("the file restored at the next pass: nothing happened", async () => {
      const w = await eight();
      const whole = w.host.file("main", FILE)!;
      changeFile(w, (t) => t.slice(0, t.indexOf("<!-- rovara:les_bbbb0002 -->")));
      await pass(w);
      w.host.setFile("main", FILE, whole);
      await pass(w);
      expect((await w.store.listAllHeads(w.key)).filter((l) => l.status === "retired")).toEqual([]);
      expect((await w.current()).readBackHeld).toBeUndefined();
    });
    it("the same lessons still missing after the week: NOT retired by themselves (decision 78); a person is asked, and the hold stays", async () => {
      const w = await eight();
      changeFile(w, (t) => t.slice(0, t.indexOf("<!-- rovara:les_bbbb0002 -->")));
      await pass(w);
      await pass(w);
      expect((await w.store.listAllHeads(w.key)).filter((l) => l.status === "retired")).toEqual([]);
      expect((await w.current()).readBackHeld).toMatchObject({ missing: 7 });
    });
    it("a retire answer under 7 days old retires nothing (the hold is by the clock, whatever the verdict says)", async () => {
      const w = await eight();
      changeFile(w, (t) => t.slice(0, t.indexOf("<!-- rovara:les_bbbb0002 -->")));
      await pass(w);
      const held = await w.current();
      await w.state.put(w.key, { ...held, readBackHeld: { ...held.readBackHeld!, verdict: "retire" } }, held.revision);
      w.clock.advance(DAY);
      await w.run({ force: true });
      expect((await w.store.listAllHeads(w.key)).filter((l) => l.status === "retired")).toEqual([]);
      expect((await w.current()).readBackHeld).toMatchObject({ missing: 7, verdict: "retire" });
    });
    it("up to max(3, 25%) removed at once are retired right away", async () => {
      const w = await eight();
      changeFile(w, (t) => ["les_bbbb0001", "les_bbbb0002"].reduce((text, id) => strip(id)(text), t));
      await pass(w);
      expect((await w.store.listAllHeads(w.key)).filter((l) => l.status === "retired")).toHaveLength(2);
    });
  });

  describe("M2: merge-conflict markers are unreadable", () => {
    it("a file with conflict markers changes nothing", async () => {
      const w = await merged();
      changeFile(w, (t) => `<<<<<<< HEAD\n${t}=======\n${t.replace(FIRST, "Their side.")}>>>>>>> branch\n\n- ${TEAM}\n`);
      expect(await pass(w)).toEqual({ status: "problem", problem: "file_unreadable" });
      expect((await w.store.listAllHeads(w.key)).length).toBe(2);
    });
    it("a line of equals signs or a fenced example is not a conflict", async () => {
      const w = await merged();
      changeFile(w, (t) => `${t.trimEnd()}\n\nHeading\n=======\n\n\`\`\`\n<<<<<<< HEAD\n\`\`\`\n`);
      expect((await pass(w)).status).not.toBe("problem");
    });
  });

  describe("M3: the company's required approver group is honoured", () => {
    it("with a required group, a team bullet and a team edit wait for that group (pending, review required), and the team's block is neither added back nor removed", async () => {
      const w = await merged();
      w.deps.settings = settings({ preset: "standard", mode: "On", approval: { requiredGroup: "security" } });
      changeFile(w, (t) => `${t.replace(FIRST, "Reworded and waiting for the group.")}\n- ${TEAM}\n`);
      await pass(w);
      const edited = (await lesson(w, "les_aaaa0001"))!;
      expect(edited).toMatchObject({ status: "pending", body: "Reworded and waiting for the group.", reviewRequired: true, approvals: [] });
      const created = (await w.store.listAllHeads(w.key)).find((l) => l.body === TEAM)!;
      expect(created).toMatchObject({ status: "pending", reviewRequired: true, approvals: [] });
      await pass(w);
      expect(w.host.open.map((pr) => pr.body).join("\n")).not.toContain("Proposed removals");
      expect((await w.current()).held).toContain("les_aaaa0001");
    });
  });
});

describe("review round 2 (rr3c)", () => {
  const goneHash = (text: string): string => bodyHashOf(text);
  const mark = async (w: W, text = FIRST): Promise<boolean> => { const fp = (await w.store.textFingerprints(w.key, "github:repo/1001", [goneHash(text)])).get(goneHash(text))!; return (await w.store.goneFingerprintsOf(w.key, [fp])).size === 1; };
  const port = (w: W) => lessonDeletionPort({ store: w.store, vectors: { get: async () => new Map(), put: async () => undefined, remove: async () => undefined }, audit: w.deps.audit, now: w.clock.now });
  /** Merges a repository with the lesson les_aaaa0001 written by "mallory" from source E1, and les_aaaa0002. */
  async function withMallory(): Promise<W> {
    const w = passSetup();
    const a = repoLesson("les_aaaa0001");
    await w.seedLessons({ ...a, provenance: { ...a.provenance, sourceEvents: ["E1"], authors: ["mallory"] } }, repoLesson("les_aaaa0002"));
    await w.enable();
    const result = await w.run();
    w.host.merge(Number((result as { number: string }).number));
    return w;
  }
  const reimported = async (w: W) => (await w.store.listAllHeads(w.key)).filter((l) => l.body === FIRST && l.id !== "les_aaaa0001");

  describe("HIGH: every way a lesson is deleted keeps its erased text from coming back through a stripped id line", () => {
    const ways: Array<[string, (w: W) => Promise<void>]> = [
      ["withdrawn (its sources were deleted)", (w) => port(w).withdraw(w.key.workspaceId, w.key.project, "les_aaaa0001", "sources_deleted")],
      ["person erasure (the head is hard-deleted)", async (w) => { await port(w).erasePerson(w.key.workspaceId, w.key.project, { developerId: "mallory" }, new Set(["E1"])); }],
      ["withdraw with the cause person_erased (a purge)", (w) => port(w).withdraw(w.key.workspaceId, w.key.project, "les_aaaa0001", "person_erased")],
    ];
    it.each(ways)("%s: the id line is stripped; the erased words are not imported, now or ever after (refused, marked)", async (_name, erase) => {
      const w = await withMallory();
      await erase(w);
      changeFile(w, (t) => t.replace("<!-- rovara:les_aaaa0001 -->\n", ""));
      await pass(w);
      expect(await reimported(w)).toEqual([]);
      expect(Object.values((await w.current()).refused ?? {})).toEqual(["gone_text"]);
      for (let i = 0; i < 3; i += 1) await pass(w);
      expect(await reimported(w)).toEqual([]);
      expect(await mark(w)).toBe(true);
    });
    it("a formatter that strips EVERY id line at the same time as a person erasure: nothing of the erased text returns, the other lesson is kept", async () => {
      const w = await withMallory();
      await port(w).erasePerson(w.key.workspaceId, w.key.project, { developerId: "mallory" }, new Set(["E1"]));
      changeFile(w, (t) => t.replace(/<!--[^>]*-->\n/gu, ""));
      await pass(w);
      expect(await reimported(w)).toEqual([]);
      expect((await lesson(w, "les_aaaa0002"))!.status).toBe("active");
    });
    it("the mark stays while a stripped copy is in the file (Rovara keeps the block's fingerprint for it), the sweep takes the copy out, and after that a re-paste is the team's new lesson", async () => {
      const w = await withMallory();
      await pass(w);
      await port(w).withdraw(w.key.workspaceId, w.key.project, "les_aaaa0001", "sources_deleted");
      changeFile(w, (t) => t.replace("<!-- rovara:les_aaaa0001 -->\n", ""));
      await pass(w);
      await pass(w);
      expect(Object.keys((await w.current()).rendered)).toContain("les_aaaa0001");
      expect(await mark(w)).toBe(true);
      expect(await reimported(w)).toEqual([]);
      // The erasure sweep removes the copy (it matches the mark, not an id).
      const swept = await w.sweep();
      expect(swept.removalOpened).toBe(true);
      const removal = w.host.open.find((pr) => pr.title.includes("remove"))!;
      expect(w.host.file(removal.source, FILE)).not.toContain(FIRST);
      w.host.merge(removal.number);
      await pass(w);
      expect(await mark(w)).toBe(false);
      expect(Object.keys((await w.current()).rendered)).not.toContain("les_aaaa0001");
      changeFile(w, (t) => `${t.trimEnd()}\n\n- ${FIRST}\n`);
      await pass(w);
      expect(await reimported(w)).toHaveLength(1);
    });
    it("the mark alone is enough: with Rovara's record of the block and of the refusal both lost, the stripped copy is still refused", async () => {
      const w = await withMallory();
      await pass(w);
      await port(w).withdraw(w.key.workspaceId, w.key.project, "les_aaaa0001", "sources_deleted");
      changeFile(w, (t) => t.replace("<!-- rovara:les_aaaa0001 -->\n", ""));
      await pass(w);
      expect(await mark(w)).toBe(true);
      const state = await w.current();
      const { les_aaaa0001: _lost, ...rendered } = state.rendered;
      void _lost;
      const { refused: _refused, ...rest } = state;
      void _refused;
      expect(await w.state.put(w.key, { ...rest, rendered }, state.revision)).toBeDefined();
      await pass(w);
      expect(await reimported(w)).toEqual([]);
      expect(Object.values((await w.current()).refused ?? {})).toEqual(["gone_text"]);
    });
    it("a lesson that was never in a repository file leaves no mark, and the same words written by the team are a new lesson", async () => {
      const w = await merged();
      await w.seedLessons(repoLesson("les_zzzz0001", { body: "A lesson that never reached the repository file." }));
      await port(w).withdraw(w.key.workspaceId, w.key.project, "les_zzzz0001", "sources_deleted");
      changeFile(w, (t) => `${t.trimEnd()}\n\n- A lesson that never reached the repository file.\n`);
      await pass(w);
      expect(await mark(w, "A lesson that never reached the repository file.")).toBe(false);
      expect((await w.store.listAllHeads(w.key)).filter((l) => l.provenance.reflectorRun === "repo_file" && l.status === "active")).toHaveLength(1);
    });
    it("a refusal of erased text is never the one dropped when the record is full", async () => {
      const w = passSetup();
      await w.seedLessons();
      const text = ["# Team lessons", "", "## Whole repository", "", `- ${FIRST}`, ...Array.from({ length: 105 }, (_, i) => `- Ping @user${String(i)} about it.`)].join("\n\n");
      const hash = bodyHashOf(FIRST);
      const result = await readBackFile({ store: w.store, audit: w.deps.audit, now: w.clock.now }, {
        key: w.key, place: "github:repo/1001", repoName: "api", fileText: text, rendered: {}, refused: { [hash]: "gone_text" }, lessons: [], gone: new Set(), names: [],
      });
      expect(result.refused[hash]).toBe("gone_text");
      expect(Object.keys(result.refused).length).toBeLessThanOrEqual(101);
    });
  });

  describe("M1: a bulk disappearance is held a week by the clock", () => {
    async function eight(): Promise<W> {
      const w = passSetup();
      await w.seedLessons(...Array.from({ length: 8 }, (_, i) => repoLesson(`les_bbbb000${String(i + 1)}`)));
      await w.enable();
      const result = await w.run();
      w.host.merge(Number((result as { number: string }).number));
      return w;
    }
    const retired = async (w: W) => (await w.store.listAllHeads(w.key)).filter((l) => l.status === "retired").length;
    it("passes that fail, or run every night, never shorten it: a person is asked only 7 days after the first sighting, and nothing is retired", async () => {
      const w = await eight();
      changeFile(w, (t) => `${t.slice(0, t.indexOf("<!-- rovara:les_bbbb0002 -->"))}\n- A new bullet so the pass has something to write.\n`);
      w.host.failCalls.add("commitFiles");
      w.week();
      for (let day = 0; day < 6; day += 1) {
        const result = await w.run({ force: true });
        expect(["problem", "opened", "no_changes"]).toContain(result.status);
        expect(await retired(w)).toBe(0);
        expect((await w.current()).readBackHeld).toMatchObject({ missing: 7 });
        w.clock.advance(DAY);
      }
      w.clock.advance(DAY);
      await w.run({ force: true });
      // After the week nothing retires by itself: the hold stays, waiting for a person's answer (decision 78).
      expect(await retired(w)).toBe(0);
      expect((await w.current()).readBackHeld).toMatchObject({ missing: 7 });
      expect(rowOf(await w.current(), w.clock.now())).toMatchObject({ retireConfirm: { missing: 7 } });
    });
    it("shows the date on the status the whole time", async () => {
      const w = await eight();
      changeFile(w, (t) => t.slice(0, t.indexOf("<!-- rovara:les_bbbb0002 -->")));
      await pass(w);
      const state = await w.current();
      const date = new Date(state.readBackHeld!.at + 7 * DAY).toISOString().slice(0, 10);
      expect(noticesOf(state, w.clock.now()).join(" ")).toContain(`7 lessons are missing from the lessons file; on or after ${date} a person will be asked to confirm retiring them unless they are restored`);
    });
    it("a different set missing starts the week again", async () => {
      const w = await eight();
      const whole = w.host.file("main", FILE)!;
      changeFile(w, (t) => t.slice(0, t.indexOf("<!-- rovara:les_bbbb0002 -->")));
      await pass(w);
      const first = (await w.current()).readBackHeld!;
      w.host.setFile("main", FILE, whole.slice(0, whole.indexOf("<!-- rovara:les_bbbb0003 -->")));
      await pass(w);
      expect((await w.current()).readBackHeld).toMatchObject({ missing: 6 });
      expect((await w.current()).readBackHeld!.at).toBeGreaterThan(first.at);
      expect(await retired(w)).toBe(0);
    });
  });

  describe("lows", () => {
    it("a lesson that waited for the approver group and expired with no decision keeps the team's block (no removal); a rejection is a decision", async () => {
      const w = await merged();
      w.deps.settings = settings({ preset: "standard", mode: "On", approval: { requiredGroup: "security" } });
      changeFile(w, (t) => t.replace(FIRST, "Reworded and waiting for the group."));
      await pass(w);
      const head = (await lesson(w, "les_aaaa0001"))!;
      expect(head.status).toBe("pending");
      await w.store.commit(w.key, await w.store.setVersion(w.key), [{ ...head, version: head.version + 1, status: "expired" }], 9);
      expect(await pass(w)).toMatchObject({ status: "no_changes" });
      expect((await w.current()).held).toContain("les_aaaa0001");
      const expired = (await lesson(w, "les_aaaa0001"))!;
      await w.store.commit(w.key, await w.store.setVersion(w.key), [{ ...expired, version: expired.version + 1, status: "rejected" }], 10);
      expect(await pass(w)).toMatchObject({ status: "opened", removals: 1 });
    });
    it("the refusal notice names every reason", () => {
      const notice = noticesOf({ ...newRepoFileState("github:repo/1001", "api"), refused: { "0123456789abcdef": "gone_text" } }, 0).join(" ");
      expect(notice).toContain("repeat the text of an erased lesson");
      expect(notice).toContain("not allowed");
    });
  });
});

describe("round 3 (rr3d): the mark is taken from the file, whatever way the block got there", () => {
  const mark = async (w: W, text: string): Promise<boolean> => { const fp = (await w.store.textFingerprints(w.key, "github:repo/1001", [bodyHashOf(text)])).get(bodyHashOf(text))!; return (await w.store.goneFingerprintsOf(w.key, [fp])).size === 1; };
  const port = (w: W) => lessonDeletionPort({ store: w.store, vectors: { get: async () => new Map(), put: async () => undefined, remove: async () => undefined }, audit: w.deps.audit, now: w.clock.now });
  const ways: Array<[string, (w: W) => Promise<void>]> = [
    ["withdraw", (w) => port(w).withdraw(w.key.workspaceId, w.key.project, "les_aaaa0001", "sources_deleted")],
    ["person erasure", async (w) => { await port(w).erasePerson(w.key.workspaceId, w.key.project, { developerId: "mallory" }, new Set(["E1"])); }],
    ["purge", (w) => port(w).withdraw(w.key.workspaceId, w.key.project, "les_aaaa0001", "person_erased")],
  ];
  const mallory = (): ReturnType<typeof repoLesson> => { const a = repoLesson("les_aaaa0001"); return { ...a, provenance: { ...a.provenance, sourceEvents: ["E1"], authors: ["mallory"] } }; };
  const copies = async (w: W, text: string) => (await w.store.listAllHeads(w.key)).filter((l) => l.body === text && l.id !== "les_aaaa0001" && l.status === "active");

  /** How the block reached main: Rovara's own pull request, one a person pushed to (the team's now), or Rovara's then reworded by the team under a lesson that expired. */
  const paths: Array<[string, () => Promise<{ w: W; text: string }>]> = [
    ["Rovara-merged", async () => {
      const w = passSetup();
      await w.seedLessons(mallory(), repoLesson("les_aaaa0002"));
      await w.enable();
      const r = await w.run();
      w.host.merge(Number((r as { number: string }).number));
      return { w, text: FIRST };
    }],
    ["handed over to the team and merged", async () => {
      const w = passSetup();
      await w.seedLessons(mallory(), repoLesson("les_aaaa0002"));
      await w.enable();
      await w.run();
      const open = (await w.current()).open!;
      w.host.setFile(open.branch, "person.txt", "a person's commit");
      await w.seedLessons(repoLesson("les_aaaa0003"));
      w.week();
      await w.run();
      expect((await w.current()).theirs).toHaveLength(1);
      w.host.merge(w.host.prs.find((pr) => pr.source === open.branch)!.number);
      w.week();
      await w.run();
      expect((await w.current()).rendered["les_aaaa0001"]).toBe("merged-by-team");
      return { w, text: FIRST };
    }],
    ["reworded by the team under an expired lesson", async () => {
      const w = passSetup();
      await w.seedLessons(mallory(), repoLesson("les_aaaa0002"));
      await w.enable();
      const r = await w.run();
      w.host.merge(Number((r as { number: string }).number));
      const head = (await lesson(w, "les_aaaa0001"))!;
      await w.store.commit(w.key, await w.store.setVersion(w.key), [{ ...head, version: head.version + 1, status: "expired" }], 9);
      changeFile(w, (t) => t.replace(FIRST, "The team's own wording under an expired lesson."));
      await pass(w);
      expect((await w.current()).held).toContain("les_aaaa0001");
      return { w, text: "The team's own wording under an expired lesson." };
    }],
  ];
  for (const [pathName, build] of paths) {
    for (const [wayName, erase] of ways) {
      it(`${pathName} x ${wayName}: a pass sees the block, then its id line is stripped: the text it HAS in the file never comes back`, async () => {
        const { w, text } = await build();
        await erase(w);
        await pass(w);
        expect(await mark(w, text)).toBe(true);
        changeFile(w, (t) => t.replace("<!-- rovara:les_aaaa0001 -->\n", ""));
        await pass(w);
        for (let i = 0; i < 2; i += 1) await pass(w);
        expect(await copies(w, text)).toEqual([]);
        expect(Object.values((await w.current()).refused ?? {})).toContain("gone_text");
      });
    }
  }
  it("a gone block the sweep sees only as a stripped copy (a pass marked it first) is removed by the sweep, even for a handed-over lesson", async () => {
    const { w, text } = await paths[1]![1]();
    await ways[0]![1](w);
    await pass(w);
    changeFile(w, (t) => t.replace("<!-- rovara:les_aaaa0001 -->\n", ""));
    await pass(w);
    const swept = await w.sweep();
    expect(swept.removalOpened).toBe(true);
    expect(w.host.file(w.host.open.find((pr) => pr.title.includes("remove"))!.source, FILE)).not.toContain(text);
  });

  describe("L-e: when the erased block was the file's last marker, a later re-paste is the team's new lesson", () => {
    it("the record of the erased id goes with the block (not kept for ever because no marker is left), so the mark is cleared and the re-paste is accepted", async () => {
      const w = passSetup();
      await w.seedLessons(mallory());
      await w.enable();
      const r = await w.run();
      w.host.merge(Number((r as { number: string }).number));
      await ways[0]![1](w);
      expect((await w.sweep()).removalOpened).toBe(true);
      w.host.merge(w.host.open.find((pr) => pr.title.includes("remove"))!.number);
      await pass(w);
      expect(Object.keys((await w.current()).rendered)).not.toContain("les_aaaa0001");
      expect(await mark(w, FIRST)).toBe(false);
      changeFile(w, (t) => `${t.trimEnd()}\n\n- ${FIRST}\n`);
      await pass(w);
      expect(await copies(w, FIRST)).toHaveLength(1);
    });
  });

  it("L-f: the pinned fingerprint of an erased lesson is kept when the record is bounded, until its text is gone", async () => {
    const w = passSetup();
    await w.seedLessons(mallory(), repoLesson("les_aaaa0002"));
    await w.enable();
    const r = await w.run();
    w.host.merge(Number((r as { number: string }).number));
    await ways[0]![1](w);
    await pass(w);
    const state = await w.current();
    const filler = Object.fromEntries(Array.from({ length: 450 }, (_, i) => [`les_fill${String(i).padStart(4, "0")}`, "0123456789abcdef:01234567"]));
    expect(await w.state.put(w.key, { ...state, rendered: { ...state.rendered, ...filler } }, state.revision)).toBeDefined();
    await pass(w);
    expect(Object.keys((await w.current()).rendered)).toContain("les_aaaa0001");
  });
});

describe("round 4 (rr3e): fingerprints are recorded on every successful pass, before anything is erased", () => {
  const place = "github:repo/1001";
  const fpOf = async (w: W, text: string): Promise<string> => (await w.store.textFingerprints(w.key, place, [bodyHashOf(text)])).get(bodyHashOf(text))!;
  const marked = async (w: W, text: string): Promise<boolean> => (await w.store.goneFingerprintsOf(w.key, [await fpOf(w, text)])).size === 1;
  const port = (w: W) => lessonDeletionPort({ store: w.store, vectors: { get: async () => new Map(), put: async () => undefined, remove: async () => undefined }, audit: w.deps.audit, now: w.clock.now });
  const ways: Array<[string, (w: W) => Promise<void>]> = [
    ["withdraw", (w) => port(w).withdraw(w.key.workspaceId, w.key.project, "les_aaaa0001", "sources_deleted")],
    ["person erasure", async (w) => { await port(w).erasePerson(w.key.workspaceId, w.key.project, { developerId: "mallory" }, new Set(["E1"])); }],
    ["purge", (w) => port(w).withdraw(w.key.workspaceId, w.key.project, "les_aaaa0001", "person_erased")],
  ];
  const mallory = (): ReturnType<typeof repoLesson> => { const a = repoLesson("les_aaaa0001"); return { ...a, provenance: { ...a.provenance, sourceEvents: ["E1"], authors: ["mallory"] } }; };
  const imported = async (w: W, text: string) => (await w.store.listAllHeads(w.key)).filter((l) => l.body === text && l.id !== "les_aaaa0001" && l.status === "active");
  const strip = (w: W): void => changeFile(w, (t) => t.replace("<!-- rovara:les_aaaa0001 -->\n", ""));

  const paths: Array<[string, () => Promise<{ w: W; text: string }>]> = [
    ["handed over to the team and merged", async () => {
      const w = passSetup();
      await w.seedLessons(mallory(), repoLesson("les_aaaa0002"));
      await w.enable();
      await w.run();
      const open = (await w.current()).open!;
      w.host.setFile(open.branch, "person.txt", "a person's commit");
      await w.seedLessons(repoLesson("les_aaaa0003"));
      w.week();
      await w.run();
      w.host.merge(w.host.prs.find((pr) => pr.source === open.branch)!.number);
      await pass(w);
      expect((await w.current()).rendered["les_aaaa0001"]).toBe("merged-by-team");
      return { w, text: FIRST };
    }],
    ["reworded by the team under an expired lesson", async () => {
      const w = passSetup();
      await w.seedLessons(mallory(), repoLesson("les_aaaa0002"));
      await w.enable();
      const r = await w.run();
      w.host.merge(Number((r as { number: string }).number));
      const head = (await lesson(w, "les_aaaa0001"))!;
      await w.store.commit(w.key, await w.store.setVersion(w.key), [{ ...head, version: head.version + 1, status: "expired" }], 9);
      changeFile(w, (t) => t.replace(FIRST, "The team's own wording under an expired lesson."));
      await pass(w);
      return { w, text: "The team's own wording under an expired lesson." };
    }],
  ];
  for (const [pathName, build] of paths) {
    for (const [wayName, erase] of ways) {
      it(`${pathName} x ${wayName}: erased and stripped before any pass looks: the text never comes back (the fingerprint was recorded while the lesson was live)`, async () => {
        const { w, text } = await build();
        await erase(w);
        strip(w);
        await pass(w);
        for (let i = 0; i < 2; i += 1) await pass(w);
        expect(await imported(w, text)).toEqual([]);
        expect(Object.values((await w.current()).refused ?? {})).toContain("gone_text");
      });
      it(`${pathName} x ${wayName}: reads of the file fail for a week after the erasure, the id line is stripped meanwhile: the text never comes back`, async () => {
        const { w, text } = await build();
        await erase(w);
        w.host.failCalls.add("fileAtRevision");
        w.week();
        for (let day = 0; day < 7; day += 1) { expect((await w.run({ force: true })).status).toBe("problem"); w.clock.advance(DAY); }
        strip(w);
        w.host.failCalls.delete("fileAtRevision");
        await w.run({ force: true });
        expect(await imported(w, text)).toEqual([]);
      });
    }
  }

  it("records the fingerprint of every marked block on each successful pass, replaced when its text changes, dropped when the lesson is neither live nor gone with a copy in the file", async () => {
    const w = passSetup();
    await w.seedLessons(mallory(), repoLesson("les_aaaa0002"));
    await w.enable();
    const r = await w.run();
    w.host.merge(Number((r as { number: string }).number));
    await pass(w);
    expect(Object.keys((await w.current()).seen ?? {}).sort()).toEqual(["les_aaaa0001", "les_aaaa0002"]);
    expect((await w.current()).seen!["les_aaaa0001"]).toEqual([await fpOf(w, FIRST)]);
    changeFile(w, (t) => t.replace(FIRST, "The team's own, different wording of the first lesson."));
    await pass(w);
    expect((await w.current()).seen!["les_aaaa0001"]).toEqual([await fpOf(w, "The team's own, different wording of the first lesson.")]);
    // Erased, then the block is removed: nothing of it is kept.
    await ways[0]![1](w);
    expect((await w.sweep()).removalOpened).toBe(true);
    w.host.merge(w.host.open.find((pr) => pr.title.includes("remove"))!.number);
    await pass(w);
    expect(Object.keys((await w.current()).seen ?? {})).toEqual(["les_aaaa0002"]);
  });

  it("L-h: a gone block reworded in place while it is still in the file: the new text is marked and the old text's mark is cleared", async () => {
    const w = passSetup();
    await w.seedLessons(mallory(), repoLesson("les_aaaa0002"));
    await w.enable();
    const r = await w.run();
    w.host.merge(Number((r as { number: string }).number));
    await ways[0]![1](w);
    await pass(w);
    expect(await marked(w, FIRST)).toBe(true);
    changeFile(w, (t) => t.replace(FIRST, "Reworded in place after the erasure."));
    await pass(w);
    expect(await marked(w, "Reworded in place after the erasure.")).toBe(true);
    expect(await marked(w, FIRST)).toBe(false);
  });

  it("L-i: an id in two blocks: both texts are marked, both are cleared when the blocks are gone, and the status says so", async () => {
    const w = passSetup();
    await w.seedLessons(mallory(), repoLesson("les_aaaa0002"));
    await w.enable();
    const r = await w.run();
    w.host.merge(Number((r as { number: string }).number));
    await ways[0]![1](w);
    changeFile(w, (t) => `${t.trimEnd()}\n\n<!-- rovara:les_aaaa0001 -->\n- A second block under the same id.\n`);
    await pass(w);
    expect(await marked(w, FIRST)).toBe(true);
    expect(await marked(w, "A second block under the same id.")).toBe(true);
    expect(noticesOf(await w.current(), w.clock.now()).join(" ")).toContain("1 lesson id appears twice in the lessons file");
    changeFile(w, (t) => t.replace(/<!-- rovara:les_aaaa0001 -->\n- [^\n]*\n\n?/gu, ""));
    await pass(w);
    expect(await marked(w, FIRST)).toBe(false);
    expect(await marked(w, "A second block under the same id.")).toBe(false);
    expect((await w.current()).duplicateIds).toBeUndefined();
  });

  describe("a repository that left the project keeps its marks until a sweep of it finds no copy left (M-r5)", () => {
    const runtimeOf = (w: W, listed: boolean): RepoFileRuntime => ({ deps: w.deps, targets: async () => (listed ? [w.target] : []), reach: async () => w.target, newHolder: () => "n" });
    const closedRemovals = (w: W) => w.host.prs.filter((pr) => pr.title.includes("remove") && pr.state === "closed");
    async function erasedAndStripped(): Promise<W> {
      const w = passSetup();
      await w.seedLessons(mallory(), repoLesson("les_aaaa0002"));
      await w.enable();
      const r = await w.run();
      w.host.merge(Number((r as { number: string }).number));
      await pass(w);
      await ways[0]![1](w);
      strip(w);
      await pass(w);
      return w;
    }
    it("the repository leaves after the first sweep opened the removal: the next sweep keeps it open, and once it is merged and a sweep finds no copy the mark is released", async () => {
      const w = await erasedAndStripped();
      await sweepProject(runtimeOf(w, true), w.key);
      const removal = w.host.open.find((pr) => pr.title.includes("remove"))!;
      expect((await w.state.listPrs(w.key)).rows.find((row) => row.kind === "watch")?.marks).toHaveLength(1);
      await lessonsRepoFileJob(runtimeOf(w, false), w.key.workspaceId, [w.key.project], 3_600_000, 0);
      await lessonsRepoFileJob(runtimeOf(w, false), w.key.workspaceId, [w.key.project], 3_600_000, 1);
      expect(closedRemovals(w)).toEqual([]);
      expect(await marked(w, FIRST)).toBe(true);
      w.host.merge(removal.number);
      await sweepProject(runtimeOf(w, false), w.key, { hook: true });
      expect(await marked(w, FIRST)).toBe(false);
      expect((await w.state.listPrs(w.key)).rows.find((row) => row.kind === "watch")?.marks).toBeUndefined();
    });
    it("the repository leaves before any sweep: its sweep still takes the stripped copy out", async () => {
      const w = await erasedAndStripped();
      expect(await marked(w, FIRST)).toBe(true);
      await sweepProject(runtimeOf(w, false), w.key, { hook: true });
      const removal = w.host.open.find((pr) => pr.title.includes("remove"));
      expect(removal).toBeDefined();
      expect(w.host.file(removal!.source, FILE)).not.toContain(FIRST);
      expect(await marked(w, FIRST)).toBe(true);
    });
  });

  it("L-k: more than sixteen blocks of one id make the file unreadable (nothing is dropped silently); sixteen are read", async () => {
    const copies = (n: number) => (t: string) => `${t.trimEnd()}\n${Array.from({ length: n }, (_, i) => `\n<!-- rovara:les_aaaa0001 -->\n- A copy number ${String(i)} of the block.`).join("\n")}\n`;
    const w = await merged();
    changeFile(w, copies(17));
    expect(await pass(w)).toEqual({ status: "problem", problem: "file_unreadable" });
    const ok = await merged();
    changeFile(ok, copies(15));
    expect((await pass(ok)).status).not.toBe("problem");
    expect(Object.keys((await ok.current()).seen ?? {})).toContain("les_aaaa0001");
    expect((await ok.current()).seen!["les_aaaa0001"]).toHaveLength(16);
  });

  it("L-l: `seen` holds only what the file holds now: no entry for lessons of another repository or for lessons whose block and text are gone, and a record that does not fit fails loudly", async () => {
    const w = await merged();
    await w.seedLessons(repoLesson("les_other001", { place: "github:repo/2002", body: "A lesson of another repository." }));
    changeFile(w, (t) => t.replace(/<!-- rovara:les_aaaa0002 -->\n- [^\n]*\n\n?/u, ""));
    await pass(w);
    expect(Object.keys((await w.current()).seen ?? {})).toEqual(["les_aaaa0001"]);
    const state = await w.current();
    const huge = Object.fromEntries(Array.from({ length: 6000 }, (_, i) => [`les_huge${String(i).padStart(5, "0")}`, ["0123456789abcdef0123456789abcdef"]]));
    await expect(w.state.put(w.key, { ...state, seen: huge }, state.revision)).rejects.toThrow();
  });
});

describe("round 6 (rr3g): the erasure sweep removes every block of a gone id, however many copies", () => {
  const port = (w: W) => lessonDeletionPort({ store: w.store, vectors: { get: async () => new Map(), put: async () => undefined, remove: async () => undefined }, audit: w.deps.audit, now: w.clock.now });
  const copies = (id: string, n: number): string => Array.from({ length: n }, (_, i) => `<!-- rovara:${id} -->\n- A copy number ${String(i)} of the erased block.`).join("\n\n");
  it.each([2, 5, 50])("%i copies of a gone id: one removal change takes out every one of them, and the other lessons stay", async (n) => {
    const w = await merged();
    changeFile(w, (t) => `${t.trimEnd()}\n\n${copies("les_aaaa0001", n - 1)}\n`);
    await port(w).withdraw(w.key.workspaceId, w.key.project, "les_aaaa0001", "sources_deleted");
    const swept = await w.sweep();
    expect(swept).toMatchObject({ removalOpened: true, failures: 0 });
    const removals = w.host.open.filter((pr) => pr.title.includes("remove"));
    expect(removals).toHaveLength(1);
    const next = w.host.file(removals[0]!.source, FILE)!;
    expect(next).not.toContain("les_aaaa0001");
    expect(next).not.toContain("copy number");
    expect(next).not.toContain(FIRST);
    expect(next).toContain("les_aaaa0002");
  });
  it("a duplicated LIVE id is untouched by the sweep, while the gone id's blocks beside it come out", async () => {
    const w = await merged();
    changeFile(w, (t) => `${t.trimEnd()}\n\n${copies("les_aaaa0002", 2)}\n\n${copies("les_aaaa0001", 2)}\n`);
    await port(w).withdraw(w.key.workspaceId, w.key.project, "les_aaaa0001", "sources_deleted");
    await w.sweep();
    const next = w.host.file(w.host.open.find((pr) => pr.title.includes("remove"))!.source, FILE)!;
    expect(next).not.toContain("les_aaaa0001");
    expect(next.match(/rovara:les_aaaa0002/gu)).toHaveLength(3);
    expect(next).toContain("A copy number 0 of the erased block.");
  });
  it("applyFileChanges: remove leaves a duplicated id alone, removeAll takes every block of it", () => {
    const text = "## Whole repository\n\n<!-- rovara:les_dupe0001 -->\n- One.\n\n<!-- rovara:les_dupe0001 -->\n- Two.\n\n<!-- rovara:les_keep0001 -->\n- Kept.\n";
    expect(applyFileChanges(text, { remove: ["les_dupe0001"], replace: [], add: [] })).toBe(text);
    const out = applyFileChanges(text, { remove: [], removeAll: ["les_dupe0001"], replace: [], add: [] });
    expect(out).not.toContain("les_dupe0001");
    expect(out).toContain("- Kept.");
  });
});

describe("readBackFile, called directly (pure over its inputs)", () => {
  it("an id of another repository's lesson is not read back into this one", async () => {
    const w = passSetup();
    const other = repoLesson("les_other001", { place: "github:repo/2002" });
    await w.seedLessons(other);
    const text = "# Team lessons\n\n## Whole repository\n\n<!-- rovara:les_other001 -->\n- The team reworded it here.\n";
    const result = await readBackFile({ store: w.store, audit: w.deps.audit, now: w.clock.now }, {
      key: w.key, place: "github:repo/1001", repoName: "api", fileText: text, rendered: {}, refused: {}, lessons: await w.store.listAllHeads(w.key), gone: new Set(), names: [],
    });
    expect(result.counts).toEqual({ edited: 0, retired: 0, imported: 0, refused: 0 });
    expect((await w.store.get(w.key, "les_other001"))!.body).not.toContain("reworded");
  });

  it("scopeOfHeading reads back the headings Rovara writes, and treats the team's own as the whole repository", () => {
    expect(scopeOfHeading("Whole repository", "api")).toEqual({ repos: ["api"] });
    expect(scopeOfHeading("Languages: go, ts", "api")).toEqual({ repos: ["api"], languages: ["go", "ts"] });
    expect(scopeOfHeading("src/a/**, src/b/** (ts)", "api")).toEqual({ repos: ["api"], paths: ["src/a/**", "src/b/**"], languages: ["ts"] });
    expect(scopeOfHeading("Our retry rules", "api")).toEqual({ repos: ["api"] });
  });
});
