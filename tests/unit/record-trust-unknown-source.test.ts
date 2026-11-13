// Port lane P6 (item T1, owner decision 60): an unknown team-record source is the narrowest audience, never "everyone in the project".
import { describe, expect, it } from "vitest";
import { AudienceSchema, MAINTAINERS_GROUP, audienceForSource, unknownSourceAudience, type Audience } from "@rovara-code/contracts";

const AT = "2026-11-10T00:00:00.000Z";
const PROJECT: Audience = { kind: "project" };
const restricted = (source: string): Audience => ({ kind: "restricted", acl: { source, scope: "room-1", principals: ["u1", "u2"], capturedAt: AT, liveCheck: "on_read" } });

describe("unknownSourceAudience", () => {
  it("is restricted to the project's maintainers, and is a valid audience", () => {
    const audience = unknownSourceAudience({ source: "examplechat", scope: "room-7", capturedAt: AT });
    expect(audience).toEqual({ kind: "restricted", acl: { source: "examplechat", scope: "room-7", groups: [MAINTAINERS_GROUP], capturedAt: AT, liveCheck: "none" } });
    expect(AudienceSchema.safeParse(audience).success).toBe(true);
  });

  it("still gives a valid audience for a source id that is not well formed, and for a missing or oversize scope, without keeping the text it was given", () => {
    for (const source of ["", "Has Spaces", "x".repeat(200), "a:b:c"]) {
      const audience = unknownSourceAudience({ source, scope: "y".repeat(400), capturedAt: AT });
      expect(AudienceSchema.safeParse(audience).success, source).toBe(true);
      expect(JSON.stringify(audience)).not.toContain("Has Spaces");
      expect(audience.kind === "restricted" && audience.acl.scope).toBe("unknown-source");
    }
  });
});

describe("audienceForSource", () => {
  it("keeps the declared audience of a registered source", () => {
    expect(audienceForSource({ source: "examplechat", declared: PROJECT, capturedAt: AT }, ["examplechat"])).toEqual(PROJECT);
    expect(audienceForSource({ source: "codehost:examplehost", declared: restricted("codehost:examplehost"), capturedAt: AT }, new Set(["codehost:examplehost"]))).toEqual(restricted("codehost:examplehost"));
  });

  it("never reads an unknown source as the whole project: a declared project audience becomes the maintainers", () => {
    const audience = audienceForSource({ source: "unregistered", declared: PROJECT, capturedAt: AT }, ["examplechat"]);
    expect(audience.kind).toBe("restricted");
    expect(audience.kind === "restricted" && audience.acl.groups).toEqual([MAINTAINERS_GROUP]);
    expect(audienceForSource({ source: "unregistered", declared: PROJECT, capturedAt: AT }, [])).toEqual(audience);
  });

  it("fails closed for a source id that is not well formed, even if it is in the known list", () => {
    expect(audienceForSource({ source: "Not Valid", declared: PROJECT, capturedAt: AT }, ["Not Valid"]).kind).toBe("restricted");
  });

  it("ignores EVERYTHING an unknown source declared, including a restricted ACL that names another source, a broad group and arbitrary principals", () => {
    const hostile: Audience = { kind: "restricted", acl: { source: "slack", scope: "C-everyone", groups: ["project:members", "company:all"], principals: ["U1", "U2", "U3"], capturedAt: AT, liveCheck: "none" } };
    const audience = audienceForSource({ source: "evil-src", declared: hostile, capturedAt: AT }, ["slack"]);
    expect(audience).toEqual({ kind: "restricted", acl: { source: "evil-src", scope: "unknown-source", groups: [MAINTAINERS_GROUP], capturedAt: AT, liveCheck: "none" } });
    expect(audience.kind === "restricted" && audience.acl.principals).toBeUndefined();
    expect(JSON.stringify(audience)).not.toContain("slack");
    expect(JSON.stringify(audience)).not.toContain("project:members");
  });

  it("gives the narrowest audience for an unknown source that declared a restricted audience under its own name too", () => {
    expect(audienceForSource({ source: "unregistered", declared: restricted("unregistered"), capturedAt: AT }, [])).toEqual(unknownSourceAudience({ source: "unregistered", capturedAt: AT }));
  });
});
