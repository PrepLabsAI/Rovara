// F3 cut 1: the route table moved to packages/code-api/src/routes.ts, rows and order unchanged. The broker still serves exactly these rows (devRouteOf/appRouteOf select over them), no second list
// exists, and the digests below are the digests of the rows as they stood in dev-route-scopes.ts the day they moved. The text-scraping conformance test (named-scopes.test.ts) and the ownership test
// (core-parity-route-ownership.test.ts) keep running over the same rows.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { APP_ROUTES, CLIENT_SCOPES, DEV_ROUTES, ROUTES, ROUTE_NOT_SERVED_MESSAGE, routeIdOf } from "@preplabsai/rovara-code-api";
import * as broker from "../../packages/broker/src/aws/dev-route-scopes.js";

const keyOf = (route: { method: string; path: string; requires: string }) => `${route.method} ${route.path} ${route.requires}`;
const digest = (rows: readonly string[]) => createHash("sha256").update(rows.join("\n")).digest("hex");

describe("the one route table", () => {
  it("holds the rows it held in dev-route-scopes.ts, in the same order", () => {
    // R1 + L1 6.2b (Code API 1.3): the three waiting-ticket rows moved from /v1/dev/projects/{project}/intake* to /v1/app/projects/{project}/intake* (179/108 became 176/111).
    // RD-2.0 (Code API 1.5): four rows for the task page's new reads (spec, checks, changes, timeline) after the proof index (176 became 180).
    // D1-2 (owner DEC 254zzz519): the unconnected `POST /v1/dev/tasks/{taskId}/merge` row is deleted (180 became 179). No other row moved; the digest below is the one of this table without that row.
    // RD-2d: one app row for the file behind a link of the checks read, GET /v1/app/tasks/{taskId}/evidence/{sha}, after the merge rows (111 became 112). It carries only its scope: no schema, no version bump.
    expect([DEV_ROUTES.length, APP_ROUTES.length]).toEqual([179, 112]);
    expect(digest(DEV_ROUTES.map(keyOf))).toBe("50d4111fb426355a956f2101b7045cd11f4605e86aea6322d2b6f522b9d5a720");
    expect(digest(APP_ROUTES.map(keyOf))).toBe("eb8d562ca509716ec37d2d6594a3f4ef86fde68633cd8a047a1bc559a7f065c4");
  });

  it("is the developer rows then the app rows, each row once, and only the rows that carry a schema carry more than method, path and scope (F2-B: `tasks.read`; RD-2.0: the ten task reads)", () => {
    expect(ROUTES).toEqual([...DEV_ROUTES, ...APP_ROUTES]);
    expect(DEV_ROUTES.every((route) => route.path.startsWith("/v1/dev/"))).toBe(true);
    expect(APP_ROUTES.every((route) => route.path.startsWith("/v1/app/"))).toBe(true);
    expect(new Set(ROUTES.map((route) => `${route.method} ${route.path}`)).size).toBe(ROUTES.length);
    // A row with a schema names itself and may add its refusals and one example; any other row is method, path and scope.
    for (const route of ROUTES) {
      const keys = Object.keys(route).sort();
      if (route.response === undefined) expect(keys, keyOf(route)).toEqual(["method", "path", "requires"]);
      else expect(["id", "method", "path", "requires", "response"].every((key) => keys.includes(key)) && keys.every((key) => ["id", "method", "path", "requires", "response", "errors", "example"].includes(key)), keyOf(route)).toBe(true);
    }
    expect(ROUTES.filter((route) => route.response !== undefined).map(routeIdOf)).toEqual([
      "tasks.read", "tasks.events", "tasks.plan", "tasks.people", "tasks.diff", "tasks.comments", "tasks.evidence.list", "tasks.spec", "tasks.checks", "tasks.changes", "tasks.timeline",
    ]);
  });

  it("pins the ten task page reads: each a GET under the task read's scope, with a tolerant response schema and an example that parses with it; the four new reads list the not-served refusal and carry it as their example refusal", () => {
    const paths: Record<string, string> = {
      "tasks.events": "events", "tasks.plan": "plan", "tasks.people": "people", "tasks.diff": "diff", "tasks.comments": "comments", "tasks.evidence.list": "evidence",
      "tasks.spec": "spec", "tasks.checks": "checks", "tasks.changes": "changes", "tasks.timeline": "timeline",
    };
    for (const [id, tail] of Object.entries(paths)) {
      const row = ROUTES.find((route) => routeIdOf(route) === id)!;
      expect([row.method, row.path, row.requires], id).toEqual(["GET", `/v1/dev/tasks/{taskId}/${tail}`, "tasks:read"]);
      expect(z.toJSONSchema(row.response!), id).toBeDefined();
      expect(row.example?.response, id).toBeDefined();
      expect(row.response!.safeParse(row.example!.response).success, id).toBe(true);
      // Tolerant: an empty answer and an answer with an unknown member both read (every member optional, unknown ones pass through).
      expect(row.response!.safeParse({}).success, `${id} empty`).toBe(true);
      expect(row.response!.safeParse({ ...(row.example!.response as object), aNewerMember: { x: 1 } }).success, `${id} unknown member`).toBe(true);
    }
    // The four new shapes also read a member served as null (a lane's "none") as absent: with every scalar of the example set to null (lists and objects kept, so the null is inside list entries too; a list of plain values stays as it is), and with every list set to null, the answer still parses.
    const scalarsNull = (value: unknown): unknown => Array.isArray(value) ? (value as unknown[]).map((entry) => (entry !== null && typeof entry === "object" ? scalarsNull(entry) : entry)) : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, member]) => [key, scalarsNull(member)])) : null;
    const listsNull = (value: unknown): unknown => Array.isArray(value) ? null : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, member]) => [key, listsNull(member)])) : value;
    for (const id of ["tasks.spec", "tasks.checks", "tasks.changes", "tasks.timeline"]) {
      const row = ROUTES.find((route) => routeIdOf(route) === id)!;
      expect(row.response!.safeParse(scalarsNull(row.example!.response)).success, `${id} null scalars`).toBe(true);
      expect(row.response!.safeParse(listsNull(row.example!.response)).success, `${id} null lists`).toBe(true);
    }
    for (const id of ["tasks.spec", "tasks.checks", "tasks.changes", "tasks.timeline"]) {
      const row = ROUTES.find((route) => routeIdOf(route) === id)!;
      // The read rule: a task shared for its summary is told the plan, the checks and the code changes are not shown (403), the timeline is shown.
      expect(row.errors, id).toEqual([{ code: "TASK_NOT_FOUND", status: 404 }, { code: "ROUTE_NOT_SERVED", status: 404 }, ...(id === "tasks.timeline" ? [] : [{ code: "TASK_PART_NOT_SHOWN", status: 403 }])]);
      expect(row.example?.refusal, id).toEqual({ error: { code: "ROUTE_NOT_SERVED", message: ROUTE_NOT_SERVED_MESSAGE } });
    }
  });

  it("names each row `METHOD path` until a row names itself, and every id is unique", () => {
    expect(routeIdOf({ method: "GET", path: "/v1/dev/tasks/{taskId}" })).toBe("GET /v1/dev/tasks/{taskId}");
    expect(routeIdOf({ id: "tasks.read", method: "GET", path: "/v1/dev/tasks/{taskId}" })).toBe("tasks.read");
    expect(new Set(ROUTES.map(routeIdOf)).size).toBe(ROUTES.length);
  });

  it("gives every row a scope the table knows", () => {
    const allowed = new Set<string>([...CLIENT_SCOPES, "full", "none"]);
    expect(ROUTES.filter((route) => !allowed.has(route.requires))).toEqual([]);
  });

  it("is the table the broker serves: the selectors return the package's own row objects, and re-export the same arrays", () => {
    expect(broker.DEV_ROUTES).toBe(DEV_ROUTES);
    expect(broker.APP_ROUTES).toBe(APP_ROUTES);
    const concrete = (path: string) => path.replace(/\{[A-Za-z]+\}/g, "x1");
    for (const route of DEV_ROUTES) expect(DEV_ROUTES, keyOf(route)).toContain(broker.devRouteOf(route.method, concrete(route.path)));
    for (const route of APP_ROUTES) expect(APP_ROUTES, keyOf(route)).toContain(broker.appRouteOf(route.method, concrete(route.path)));
    expect(broker.devRouteOf("GET", "/v1/dev/tasks/t1")).toMatchObject({ method: "GET", path: "/v1/dev/tasks/{taskId}", requires: "tasks:read" });
    expect(broker.devRouteOf("GET", "/v1/dev/not-a-route")).toBeUndefined();
    expect(broker.appRouteOf("GET", "/v1/app/decisions")).toEqual({ method: "GET", path: "/v1/app/decisions", requires: "decisions:decide" });
  });
});
