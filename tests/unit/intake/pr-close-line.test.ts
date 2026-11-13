// The ticket a task started from, on its pull request: the description says `Fixes <KEY>` for a Linear ticket, read from the session's own binding, and a binding that cannot be read leaves the line out.
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, type SessionBinding } from "@rovara-code/contracts";
import { ticketIssueKeyOf } from "../../../packages/core/src/core/build-step/changed-files.js";

const LINEAR: SessionBinding = { kind: "tracker_item", system: "linear", id: "ENG-142", url: "https://linear.app/acme/issue/ENG-142/refunds" };
const JIRA: SessionBinding = { kind: "tracker_item", system: "jira", id: "PAY-12", url: "https://acme.atlassian.net/browse/PAY-12" };
const deps = (read: (() => Promise<SessionBinding[]>) | undefined) => ({ companyId: IMPLICIT_COMPANY_ID, ...(read === undefined ? {} : { sessionBindings: { read } }) });

describe("the line that closes the ticket", () => {
  it("is the Linear ticket's key, from the session's binding", async () => {
    expect(await ticketIssueKeyOf(deps(async () => [LINEAR]), { sessionId: "ses_aaaaaaaaaaaaaaaaaaaa" })).toBe("ENG-142");
  });

  it("is nothing for a ticket of another tracker, a task with no session, no reader, or a read that failed", async () => {
    expect(await ticketIssueKeyOf(deps(async () => [JIRA]), { sessionId: "ses_aaaaaaaaaaaaaaaaaaaa" })).toBeUndefined();
    expect(await ticketIssueKeyOf(deps(async () => [LINEAR]), {})).toBeUndefined();
    expect(await ticketIssueKeyOf(deps(undefined), { sessionId: "ses_aaaaaaaaaaaaaaaaaaaa" })).toBeUndefined();
    expect(await ticketIssueKeyOf(deps(async () => { throw new Error("the store is away"); }), { sessionId: "ses_aaaaaaaaaaaaaaaaaaaa" })).toBeUndefined();
  });
});
