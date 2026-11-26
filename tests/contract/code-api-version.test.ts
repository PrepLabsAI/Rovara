// F3 cut 1 (plan 6.4): a digest of the Code API's CONTRACT SURFACE keeps the version number honest. The surface is: the rows that carry a schema or `webAppOnly`, the code list (names, statuses, order)
// and CODE_API_MIN_CLIENT. Rows with only `requires` ride along unversioned (a client does not compile against them), so a new route anywhere else in Code forces nothing and two route changes
// do not fight over a literal. When the surface changes, bump CODE_API_VERSION (packages/code-api/src/version.ts) and ADD a line to DIGESTS for the new version; never edit a line already there.
// This is a Code-internal guard, not a cross-repo drift detector.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AgentXErrorCodeSchema, CODE_API_MIN_CLIENT, CODE_API_VERSION, ROUTES, errorStatus, type Route } from "@preplabsai/rovara-code-api";

const DIGESTS: Readonly<Record<string, string>> = {
  "1.2": "49913e532fa3c49d0bbe01199b1756de4bfc19265f68a41036c6a18d987e5ad3",
  // 1.3 (R1 + L1 6.2b): the code LINEAR_TEAM_TAKEN, appended (409). The three intake rows that moved from /v1/dev to /v1/app carry no schema and no webAppOnly, so they are not in the digest.
  "1.3": "93e0ed04e8c4a8c2a878027c951ad5c786ea724531b4ebedf9444f45022fc889",
  // 1.4 (F2-B): the row `tasks.read` (GET /v1/dev/tasks/{taskId}) now names itself and carries a tolerant response schema naming `standing` (where the task stands for the person reading it). Code first: older clients ignore the member.
  "1.4": "23d876ecf8aabc9571137f1c00408a6934f4c112f04c3ceb71c861ef843c2bc6",
  // 1.5 (RD-2.0): the task page's reads. The six that were served unlisted (events, plan, people, diff, comments, the proof index) name themselves and carry tolerant response schemas; four new rows (spec, checks, changes, timeline) with schemas and the
  // not-served refusal; the code ROUTE_NOT_SERVED (404), appended; the read rule adds the code TASK_PART_NOT_SHOWN (403), appended, and lists it on the spec, checks and changes rows (digest recomputed: 1.5 is unreleased). Code first: an older client never calls the new rows and ignores a schema it does not read.
  "1.5": "57877feaca923f6f862507a78c1439528eaf78145ef38f0dd3387cf2af4e1fb6",
  // 1.8 (PROJECT-INCARNATION-FENCE): the archive and restore confirm bodies accept the optional `expectedProjectIncarnation` the preview carries. Those two rows carry no schema in ROUTES, so the digest is the same as 1.5's; the number is how Cloud
  // learns (from the discovery document's apiVersion) that Code accepts the field, and sends it only then. Code first: an older Code's strict body would refuse a Cloud that sends it. 1.6 and 1.7 are taken by lanes still in flight.
  "1.8": "57877feaca923f6f862507a78c1439528eaf78145ef38f0dd3387cf2af4e1fb6",
};

const schemaOf = (schema: z.ZodType | undefined) => (schema === undefined ? null : z.toJSONSchema(schema));

/** The contract surface of a table, a code list and a minimum client, as one string. */
function contractSurface(routes: readonly Route[], codes: readonly string[], status: (code: string) => number, minClient: string): string {
  const rows = routes
    .filter((route) => route.request !== undefined || route.response !== undefined || route.webAppOnly === true)
    .map((route) => ({ id: route.id ?? `${route.method} ${route.path}`, method: route.method, path: route.path, requires: route.requires, webAppOnly: route.webAppOnly === true, request: schemaOf(route.request), response: schemaOf(route.response), errors: route.errors ?? [] }));
  return JSON.stringify({ rows, codes: codes.map((code) => [code, status(code)]), minClient });
}

const digestOf = (surface: string) => createHash("sha256").update(surface).digest("hex");
const surfaceNow = () => contractSurface(ROUTES, AgentXErrorCodeSchema.options, (code) => errorStatus(code as never), CODE_API_MIN_CLIENT);

describe("the Code API version", () => {
  it("is major.minor, and the oldest client served is not newer than it", () => {
    expect(CODE_API_VERSION).toMatch(/^\d+\.\d+$/u);
    expect(CODE_API_MIN_CLIENT).toMatch(/^\d+\.\d+$/u);
    const [major, minor] = CODE_API_VERSION.split(".").map(Number) as [number, number];
    const [minMajor, minMinor] = CODE_API_MIN_CLIENT.split(".").map(Number) as [number, number];
    expect(minMajor).toBe(major);
    expect(minMinor).toBeLessThanOrEqual(minor);
  });

  it("has the digest recorded for this version: changing the contract surface needs a version bump and a new line", () => {
    expect(DIGESTS[CODE_API_VERSION], `no digest recorded for CODE_API_VERSION ${CODE_API_VERSION}; the surface now digests to ${digestOf(surfaceNow())}`).toBeDefined();
    expect(digestOf(surfaceNow())).toBe(DIGESTS[CODE_API_VERSION]);
  });
});

describe("what the digest covers", () => {
  const codes = ["A_CODE", "B_CODE"];
  const status = () => 409;
  const base: Route[] = [{ method: "GET", path: "/v1/dev/a", requires: "full" }];
  const before = digestOf(contractSurface(base, codes, status, "1.2"));

  it("ignores a row that carries only method, path and scope", () => {
    expect(digestOf(contractSurface([...base, { method: "POST", path: "/v1/dev/b", requires: "tasks:act" }], codes, status, "1.2"))).toBe(before);
  });

  it("changes with a row that carries webAppOnly or a schema, a code, a status, the order of the codes or the minimum client", () => {
    const changed = [
      contractSurface([...base, { method: "POST", path: "/v1/dev/b", requires: "full", webAppOnly: true }], codes, status, "1.2"),
      contractSurface([...base, { method: "POST", path: "/v1/dev/b", requires: "full", response: z.object({ ok: z.boolean() }) }], codes, status, "1.2"),
      contractSurface([...base, { method: "POST", path: "/v1/dev/b", requires: "full", response: z.object({ ok: z.string() }) }], codes, status, "1.2"),
      contractSurface(base, [...codes, "C_CODE"], status, "1.2"),
      contractSurface(base, [...codes].reverse(), status, "1.2"),
      contractSurface(base, codes, (code) => (code === "A_CODE" ? 403 : 409), "1.2"),
      contractSurface(base, codes, status, "1.3"),
    ].map(digestOf);
    expect(new Set([before, ...changed]).size).toBe(changed.length + 1);
  });
});
