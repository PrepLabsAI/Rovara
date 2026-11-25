// Migration plan v3.2, lane ID part 1 (DEC 214 decision 7): named scopes in front of Rovara's developer API.
// Every /v1/dev/* route the broker serves has exactly one row, by method and path. The ROWS moved to the Code API package (@preplabsai/rovara-code-api, packages/code-api/src/routes.ts, F3 cut 1),
// the one route table; this file keeps only the selectors over them and the worker rows, which are not part of that API. A request whose method and path match no row is refused before anyone
// is authenticated (fail closed), so a new route is unreachable until it is given a row. A sign-in client's token reaches a row only with the row's scope; the Rovara CLI's own token reaches every
// row, as before.
import { APP_ROUTES, DEV_ROUTES, type Route, type RouteMethod, type RouteRequirement } from "@preplabsai/rovara-code-api";

export { APP_ROUTES, DEV_ROUTES };

/** What a row needs from a sign-in client's token (see `RouteRequirement` in the package). */
export type DevRouteRequirement = RouteRequirement;

export type DevRouteMethod = RouteMethod;

export type DevRoute = Route;

const compile = (routes: readonly DevRoute[]) => routes.map((route) => ({
  route,
  pattern: new RegExp(`^${route.path.split("/").map((segment) => /^\{[A-Za-z]+\}$/.test(segment) ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")).join("/")}$`),
}));
const COMPILED = compile(DEV_ROUTES);
const APP_COMPILED = compile(APP_ROUTES);

/** The row for this method and raw (still percent-encoded) path, or undefined: refused. */
export function devRouteOf(method: string, pathname: string): DevRoute | undefined {
  return COMPILED.find(({ route, pattern }) => route.method === method && pattern.test(pathname))?.route;
}

/** Lane L12: the /v1/app/* row for this method and raw (still percent-encoded) path, or undefined: refused. */
export function appRouteOf(method: string, pathname: string): DevRoute | undefined {
  return APP_COMPILED.find(({ route, pattern }) => route.method === method && pattern.test(pathname))?.route;
}

// Worker callbacks have no developer-token scope. Keep them out of APP_ROUTES and
// DEV_ROUTES: a full-access person must never acquire worker authority.
export const SAVED_ENV_WORKER_ROUTES = [
  { method: "POST", path: "/v1/internal/workspaces/{workspace}/operations/{operation}/saved-env-push-login", requires: "worker" },
  { method: "POST", path: "/v1/internal/workspaces/{workspace}/operations/{operation}/saved-env-result", requires: "worker" },
  { method: "POST", path: "/v1/internal/workspaces/{workspace}/operations/{operation}/saved-env-fallback", requires: "worker" },
  { method: "POST", path: "/v1/internal/workspaces/{workspace}/operations/{operation}/saved-env-login", requires: "worker" },
] as const;
export function savedEnvWorkerRouteOf(method: string, path: string): (typeof SAVED_ENV_WORKER_ROUTES)[number] | undefined {
  return SAVED_ENV_WORKER_ROUTES.find(row => row.method === method && new RegExp(`^${row.path.replace(/\{[a-z]+\}/gu, "[^/]+")}$`, "u").test(path));
}

// Exact worker-only context paths; person scopes never authorize them.
export const CORE_CONTEXT_WORKER_ROUTES = [
  { method: "GET", path: "/v1/internal/context-tools", requires: "worker" },
  { method: "GET", path: "/v1/internal/design-review/packet", requires: "worker" },
  { method: "POST", path: "/v1/internal/context-tools/call", requires: "worker" },
  { method: "POST", path: "/v1/internal/mcp", requires: "worker" },
] as const;
export function coreContextWorkerRouteOf(method: string, pathname: string): (typeof CORE_CONTEXT_WORKER_ROUTES)[number] | undefined {
  return CORE_CONTEXT_WORKER_ROUTES.find(row => row.method === method && row.path === pathname);
}
