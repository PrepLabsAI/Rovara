import { describe, expect, it } from "vitest";
import {
  CONSEQUENTIAL_KEYS, CONSEQUENTIAL_VALUES, OUTWARD_KEYS, OUTWARD_WORDS, READ_VERBS, ROVARA_LABEL, SAFE_CHANGE_KEYS, TRACKER_ITEM_WORDS, WRITE_VERBS,
  destructiveSignal, nameWords,
} from "../../packages/contracts/src/index.js";

describe("the write-classification constants", () => {
  it("pins the safe and consequential argument keys", () => {
    expect(SAFE_CHANGE_KEYS).toEqual(["labels", "labelIds", "addLabels", "removeLabels", "addedLabelIds", "removedLabelIds", "priority", "estimate"]);
    expect(CONSEQUENTIAL_KEYS).toEqual(["assignee", "assigneeId", "assignees", "owner", "ownerId", "reviewers", "teamId", "projectId"]);
    expect(CONSEQUENTIAL_VALUES).toEqual({ event: ["APPROVE", "REQUEST_CHANGES"] });
  });

  it("pins the name lists", () => {
    expect(READ_VERBS).toEqual(["list", "get", "search", "find", "read", "fetch", "describe", "count", "view", "lookup"]);
    expect(WRITE_VERBS).toEqual([
      "create", "add", "update", "edit", "set", "delete", "remove", "close", "merge", "send", "post", "reply", "assign", "transition", "move", "archive",
      "publish", "invite", "notify", "write", "push", "cancel", "reopen", "resolve", "approve", "run", "execute", "trigger", "dispatch", "apply", "rotate",
      "refund", "charge", "pay", "grant", "revoke", "restart", "rollback", "deploy", "start", "stop", "enable", "disable", "submit", "upsert", "save", "sync",
      "import", "transfer", "reset", "purge", "kill",
      "rerun", "retry", "redeploy", "rebuild", "replay",
    ]);
    expect(OUTWARD_WORDS).toEqual(["email", "message", "post", "notify", "publish", "sms", "invite", "send", "reply"]);
    expect(OUTWARD_KEYS).toEqual(["to", "cc", "bcc", "recipient", "recipients", "email", "emails", "phone", "url", "webhook", "endpoint"]);
    expect(TRACKER_ITEM_WORDS).toEqual(["issue", "ticket", "task", "story", "bug", "epic"]);
    expect(ROVARA_LABEL).toBe("rovara");
  });

  it("keeps the filter words closed, merged and deleted out of the write verbs", () => {
    for (const filter of ["closed", "merged", "deleted"]) expect(WRITE_VERBS).not.toContain(filter);
    expect(nameWords("list_closed_issues").some((word) => WRITE_VERBS.includes(word))).toBe(false);
    expect(nameWords("get_merged_pull_requests").some((word) => WRITE_VERBS.includes(word))).toBe(false);
  });

  it("has no name in both the read and write verbs", () => {
    expect(READ_VERBS.filter((verb) => WRITE_VERBS.includes(verb))).toEqual([]);
  });

  it("is reachable from contracts with the moved functions", () => {
    expect(destructiveSignal("delete_widget", {})).toContain("delete");
  });
});
