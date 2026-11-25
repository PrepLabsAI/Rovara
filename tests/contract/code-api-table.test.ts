// F3 cut 1: the route table moved to packages/code-api/src/routes.ts, rows and order unchanged. The broker still serves exactly these rows (devRouteOf/appRouteOf select over them), no second list
// exists, and the digests below are the digests of the rows as they stood in dev-route-scopes.ts the day they moved. The text-scraping conformance test (named-scopes.test.ts) and the ownership test
// (core-parity-route-ownership.test.ts) keep running over the same rows.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { APP_ROUTES, CLIENT_SCOPES, DEV_ROUTES, ROUTES, routeIdOf } from "@preplabsai/rovara-code-api";
import * as broker from "../../packages/broker/src/aws/dev-route-scopes.js";

const keyOf = (route: { method: string; path: string; requires: string }) => `${route.method} ${route.path} ${route.requires}`;
const digest = (rows: readonly string[]) => createHash("sha256").update(rows.join("\n")).digest("hex");

describe("the one route table", () => {
  it("holds the rows it held in dev-route-scopes.ts, in the same order", () => {
    expect([DEV_ROUTES.length, APP_ROUTES.length]).toEqual([179, 108]);
    expect(digest(DEV_ROUTES.map(keyOf))).toBe("35d7796eb4934166a2e6be86190c0609865b3c9f5d66adfad9e58b97c823968a");
    expect(digest(APP_ROUTES.map(keyOf))).toBe("6c92cc6017ce24bbf0bad3b9ef5df0e0d4f27e0cd5f138019fd9eb6b6fdab2ce");
  });

  it("is the developer rows then the app rows, each row once, and no row carries more than method, path and scope yet", () => {
    expect(ROUTES).toEqual([...DEV_ROUTES, ...APP_ROUTES]);
    expect(DEV_ROUTES.every((route) => route.path.startsWith("/v1/dev/"))).toBe(true);
    expect(APP_ROUTES.every((route) => route.path.startsWith("/v1/app/"))).toBe(true);
    expect(new Set(ROUTES.map((route) => `${route.method} ${route.path}`)).size).toBe(ROUTES.length);
    for (const route of ROUTES) expect(Object.keys(route).sort(), keyOf(route)).toEqual(["method", "path", "requires"]);
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
    expect(broker.devRouteOf("GET", "/v1/dev/tasks/t1")).toEqual({ method: "GET", path: "/v1/dev/tasks/{taskId}", requires: "tasks:read" });
    expect(broker.devRouteOf("GET", "/v1/dev/not-a-route")).toBeUndefined();
    expect(broker.appRouteOf("GET", "/v1/app/decisions")).toEqual({ method: "GET", path: "/v1/app/decisions", requires: "decisions:decide" });
  });
});
