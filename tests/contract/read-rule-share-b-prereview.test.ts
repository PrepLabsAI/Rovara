// READ-RULE-SHARE-B (owner DEC 254zzz577), the Sonnet pre-review's own tests. Two gaps the lane's tests leave open:
//   1. rule 1 on the real company layer for the BUILT-IN (implicit) company: `taskReaderPerson` compares the task's named company with the person's live one, and a built-in company is "no named company" on both sides. A person of a NAMED company is
//      never a member of a built-in company task (and the other way round); two built-in members are one company (the legacy rows, as before).
//   2. option A, exactly: a stored share with NO project grant is served the same bodies, read for read, as a stored share WITH a grant, and no body carries a repository credential or a token; the readable and merge reads stay refused.
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID } from "@agentx/contracts";
import { taskReaderPerson, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { FAKE_COMPANY } from "../support/core-host-fakes.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { PERSONAS, readRuleWorld, type ReadName } from "../support/read-rule-world.js";

const NAMED = FAKE_COMPANY;
const PERSON = "b".repeat(64);

function layer(personCompany: string | undefined) {
  const db = new FakeDynamoDb();
  db.set({ pk: `DEVELOPER#${PERSON}`, sk: "META", developerId: PERSON, displayName: "Person b", revoked: false });
  const deps = {
    documentClient: { send: (command: unknown) => db.send(command as never) }, tableName: "state", now: () => 0, developer: { signInTableName: "signin" },
    companies: { companyOf: async () => personCompany },
  } as unknown as DeveloperRouteDependencies;
  return (taskCompany: string) => taskReaderPerson(deps, PERSON, "payments", taskCompany);
}

describe("taskReaderPerson: the built-in company on either side (rule 1)", () => {
  it("a person of a named company is no member of a built-in company's task; a built-in member is no member of a named company's task; two built-in members are one company; no membership at all is no one", async () => {
    expect(await layer(NAMED)(IMPLICIT_COMPANY_ID)).toMatchObject({ companyMember: false });
    expect(await layer(IMPLICIT_COMPANY_ID)(NAMED)).toMatchObject({ companyMember: false });
    expect(await layer(IMPLICIT_COMPANY_ID)(IMPLICIT_COMPANY_ID)).toMatchObject({ companyMember: true });
    expect(await layer(NAMED)(NAMED)).toMatchObject({ companyMember: true });
    // A directory that knows no membership for the person (revoked or never joined) throws inside the company read: not a member of either.
    expect(await layer(undefined)(NAMED)).toMatchObject({ companyMember: false });
    expect(await layer(undefined)(IMPLICIT_COMPANY_ID)).toMatchObject({ companyMember: false });
  });
});

describe("a share with no project grant is exactly the share with one (owner option A, nothing more)", () => {
  const personaOf = (name: string) => PERSONAS.find((persona) => persona.name === name)!;
  const PAGE: ReadName[] = ["task", "answers", "events", "diff", "plan", "evidence", "comments", "spec", "checks", "changes"];

  it("every page read answers the no-grant share the same body as the share with a grant; the diff read reaches the pull request by the install's own reader only; nothing carries a credential or a token; the round and the merge standing stay refused", async () => {
    const w = await readRuleWorld({ hosted: true, diffPullRequest: true });
    const withGrant = personaOf("shared reader");
    const noGrant = personaOf("left the project");
    expect(withGrant.projectMember).toBe(true);
    expect(noGrant.projectMember).toBe(false);
    const normal = (value: unknown, persona: typeof withGrant): string => JSON.stringify(value).replaceAll(persona.personId, "<person>").replaceAll(w.taskIdOf(persona), "<task>").replace(/"(answerId|threadId)":"[^"]*"/gu, '"$1":"<id>"');
    for (const read of PAGE) {
      const a = await w.raw(withGrant, read);
      const b = await w.raw(noGrant, read);
      expect(JSON.stringify(a), `${read}: the share with a grant is not refused as a missing task`).not.toContain("TASK_NOT_FOUND");
      expect(normal(b, noGrant), `${read}: the share with no grant is served the same`).toBe(normal(a, withGrant));
      expect(JSON.stringify(b), `${read}: no credential or token in the body`).not.toMatch(/credential|token|secret|password/iu);
    }
    // The diff of a no-grant share was read by the deployment's own pull request reader (the share does not bring a repository grant of its own).
    expect(w.diffReads.length).toBeGreaterThan(0);
    for (const read of ["readable", "merge"] as const) {
      const answer = await w.ask(noGrant, read);
      expect(answer.status, `${read} stays refused`).toBe(404);
    }
  }, 120_000);
});
