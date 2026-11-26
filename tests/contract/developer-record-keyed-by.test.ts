// The sign-in row (`DEVELOPER#<id>` / `META`) keeps its id only in its key. Readers that prove identity take the id from the key,
// and refuse a row whose `pk` or `developerId` attribute names someone else.
import { describe, expect, it } from "vitest";
import { developerRecordKeyedBy, type DeveloperRecord } from "../../packages/broker/src/developer/store.js";

const ID = "a".repeat(64);
const OTHER = "b".repeat(64);
const row = (extra: Record<string, unknown> = {}) => ({ pk: `DEVELOPER#${ID}`, sk: "META", entityType: "DEVELOPER", provider: "slack", issuer: "https://slack.com", subject: "U0OWNER01", slackUserId: "U0OWNER01", displayName: "Owner", revoked: false, ...extra }) as unknown as DeveloperRecord;

describe("developerRecordKeyedBy", () => {
  it("takes the id from the key when the row has no developerId attribute", () => {
    expect(developerRecordKeyedBy(row(), ID)).toMatchObject({ developerId: ID, provider: "slack" });
  });
  it("accepts an agreeing attribute", () => {
    expect(developerRecordKeyedBy(row({ developerId: ID }), ID)).toMatchObject({ developerId: ID });
  });
  it("refuses an attribute that disagrees with the key", () => {
    expect(developerRecordKeyedBy(row({ developerId: OTHER }), ID)).toBeUndefined();
  });
  it("refuses a row whose pk names another person", () => {
    expect(developerRecordKeyedBy(row(), OTHER)).toBeUndefined();
  });
  it("leaves an absent row absent", () => {
    expect(developerRecordKeyedBy(undefined, ID)).toBeUndefined();
  });
});
