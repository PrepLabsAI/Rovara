// DEC 254zzz80 (R2-F1): one place picks a project-revision or project-grant key. A named company uses its own partition; the built-in company and no company keep the legacy keys.
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID } from "@agentx/contracts";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";
import {
  grantKeyFor, grantsPkFor, latestRevisionRowFor, namedCompany, namedCompanyLatestRevisionRow, projectMemberRowKeyFor, projectMembersPkFor, revisionKeyFor, revisionPkFor,
} from "../../packages/broker/src/aws/company-layout.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const A = COMPANY_A.orgId, B = COMPANY_B.orgId, P = "f".repeat(64);
const definition = (name: string, revision: number) => ({
  name, revision, orchestratorInstructions: "x",
  setup: [{ executable: "npm", args: ["ci"], cwd: "repo/r", timeoutSeconds: 900 }], readiness: [{ executable: "npm", args: ["test"], cwd: "repo/r", timeoutSeconds: 900 }],
  repositories: [{ name: "r", url: "https://github.com/acme/r", defaultBranch: `b${revision}`, path: "repo/r", credentialRef: "github-agentx-sdlc" }],
});

describe("company-layout keys", () => {
  it("a named company uses its own partition; the built-in company, no company and a malformed id keep the legacy keys", () => {
    expect(namedCompany(A)).toBe(A);
    for (const legacy of [undefined, IMPLICIT_COMPANY_ID, "not-an-org", `${A}#x`]) {
      expect(namedCompany(legacy)).toBeUndefined();
      expect(revisionPkFor(legacy, "p")).toBe("PROJECT#p");
      expect(revisionKeyFor(legacy, "p", 4)).toEqual({ pk: "PROJECT#p", sk: "REV#000000000004" });
      expect(grantsPkFor(legacy, P)).toBe(`MEMBER#${P}`);
      expect(grantKeyFor(legacy, P, "p")).toEqual({ pk: `MEMBER#${P}`, sk: "PROJECT#p" });
      expect(projectMembersPkFor(legacy, "p")).toBe("PROJECT_MEMBERS#p");
      expect(projectMemberRowKeyFor(legacy, "p", P)).toEqual({ pk: "PROJECT_MEMBERS#p", sk: `DEVELOPER#${P}` });
    }
    expect(revisionKeyFor(A, "p", 4)).toEqual({ pk: `ORG#${A}#PROJECT#p`, sk: "REV#000000000004" });
    expect(grantKeyFor(A, P, "p")).toEqual({ pk: `ORG#${A}#MEMBER#${P}`, sk: "PROJECT#p" });
    expect(projectMemberRowKeyFor(A, "p", P)).toEqual({ pk: `ORG#${A}#PROJECT_MEMBERS#p`, sk: `DEVELOPER#${P}` });
    expect(grantsPkFor(B, P)).not.toBe(grantsPkFor(A, P));
  });

  it("the latest revision in the core's order: catalog pointer, else newest non-candidate; drift and unparsable rows are absent", async () => {
    const db = new FakeDynamoDb({ seed: 3 });
    const rev = (n: number, extra: Record<string, unknown> = {}) => db.set({ pk: `ORG#${A}#PROJECT#p`, sk: `REV#${String(n).padStart(12, "0")}`, entityType: "PROJECT", definition: definition("p", n), ...extra });
    rev(1); rev(2); rev(3, { candidate: true });
    expect(((await namedCompanyLatestRevisionRow(db, "S", A, "p"))?.definition as { revision: number }).revision).toBe(2);
    db.set({ pk: `ORG#${A}#PROJECT_CATALOG`, sk: "PROJECT#p", latestRevision: 1 });
    expect(((await namedCompanyLatestRevisionRow(db, "S", A, "p"))?.definition as { revision: number }).revision).toBe(1);
    // An approved setup moves the catalog onto its candidate revision, which keeps `candidate: true` (core/setup-agent/apply.ts): the pointer wins, as in the core.
    db.set({ pk: `ORG#${A}#PROJECT_CATALOG`, sk: "PROJECT#p", latestRevision: 3 });
    expect(((await namedCompanyLatestRevisionRow(db, "S", A, "p"))?.definition as { revision: number }).revision).toBe(3);
    // Another company's partition is never read; a row naming another company is not this one's.
    expect(await namedCompanyLatestRevisionRow(db, "S", B, "p")).toBeUndefined();
    db.delete(`ORG#${A}#PROJECT_CATALOG`, "PROJECT#p");
    rev(2, { companyId: B });
    expect(await namedCompanyLatestRevisionRow(db, "S", A, "p")).toBeUndefined();
    rev(2, { definition: { name: "p", revision: 2 } });
    expect(await namedCompanyLatestRevisionRow(db, "S", A, "p")).toBeUndefined();
    // The legacy partition for the built-in company, unchanged.
    db.set({ pk: "PROJECT#p", sk: "REV#0001", definition: { revision: 9 } });
    expect(((await latestRevisionRowFor(db, "S", IMPLICIT_COMPANY_ID, "p"))?.definition as { revision: number }).revision).toBe(9);
    expect(((await latestRevisionRowFor(db, "S", undefined, "p"))?.definition as { revision: number }).revision).toBe(9);
  });
});
