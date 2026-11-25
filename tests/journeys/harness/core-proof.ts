// The real-core proof (A1 plan check, change 4): every journey ends with "every person-facing request and every worker callback this journey made was answered by the CORE".
// The broker's HTTP front (aws/broker.ts) serves two engines. A request the core declines falls through to the old callback handler or the old developer routes, and a journey
// that went green on that path would prove nothing about the core. So the front is wrapped: the core's three entries (`callback`, `coreTasks.route`, `coreApp.route`) mark the
// request they answer, and the front's own handler records every request. A journey that touched the old handler fails with the request named.
import { AsyncLocalStorage } from "node:async_hooks";
import type { BrokerCoreRoot } from "../../../packages/broker/src/aws/core-engine-root.js";

export interface SeenRequest { method: string; path: string; status: number; answeredByCore: boolean; kind: "person" | "callback" | "probe" | "other" }
type Event = { rawPath?: string; requestContext?: { http?: { method?: string } } };

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** What a person's browser or tool asks of a task, and what a worker calls back; the paths the core serves. Anything else (sign-in, the plain task list) is "other" and not held to the rule. */
const PERSON = [/^\/v1\/dev\/projects\/[^/]+\/intake(\/.*)?$/u, new RegExp(`^/v1/dev/tasks$`), new RegExp(`^/v1/dev/tasks/${UUID}(/.*)?$`), /^\/v1\/app\/(decisions|tasks|sessions)(\/.*)?$/u];
const CALLBACK = new RegExp(`^/v1/internal/workspaces/${UUID}/operations/${UUID}/[a-z0-9-]+$`);

export function kindOf(method: string, path: string): SeenRequest["kind"] {
  if (CALLBACK.test(path)) return "callback";
  // GET /v1/dev/tasks (the plain list) is the old broker's by design (core-host/dev-routes.ts); only the involved list is the core's, and no journey asks for it.
  if (path === "/v1/dev/tasks" && method === "GET") return "other";
  return PERSON.some((pattern) => pattern.test(path)) ? "person" : "other";
}

export interface CoreProof {
  /** The root the broker is given: the real root with its three entries recorded. */
  wrap(root: BrokerCoreRoot): BrokerCoreRoot;
  /** The broker handler, recorded. Every request a journey makes goes through it. */
  track<H extends (event: never) => Promise<{ statusCode: number }>>(handler: H): H;
  readonly seen: readonly SeenRequest[];
  /** Fails with the request named when a person-facing request or a worker callback was not answered by the core. */
  assertAllCore(options?: { callbacks?: boolean }): void;
  /**
   * Runs a request the journey makes as a PROBE: a person who must be refused (another company's member). Today the core declines a company it does not serve for that task and the old
   * developer routes answer "no such task", so a probe is not held to "answered by the core" but must be refused (4xx), and is listed. Known gap: after the old routes go, the core answers it.
   */
  probe<T>(request: () => Promise<T>): Promise<T>;
  /** For the proof's own test only: the core declines requests whose path matches, as an engine that did not serve them would. */
  decline(pattern: RegExp): void;
}

export function createCoreProof(): CoreProof {
  const current = new AsyncLocalStorage<SeenRequest>();
  const probing = new AsyncLocalStorage<true>();
  const seen: SeenRequest[] = [];
  const declined: RegExp[] = [];
  const mark = (): void => { const record = current.getStore(); if (record !== undefined) record.answeredByCore = true; };
  const refuses = (path: string): boolean => declined.some((pattern) => pattern.test(path));
  const wrapRoute = <R extends { route(request: never, caller: never): Promise<unknown> }>(entry: R | undefined): R | undefined => entry === undefined ? undefined : {
    ...entry,
    route: async (request: { path: string }, caller: never) => {
      if (refuses(request.path)) return undefined;
      const answer = await entry.route(request as never, caller);
      if (answer !== undefined) mark();
      return answer;
    },
  };
  return {
    seen,
    probe: (request) => probing.run(true, request),
    decline: (pattern) => { declined.push(pattern); },
    wrap: (root) => ({
      ...root,
      // The tracker intake is the core's too: the waiting-ticket routes and the webhook's hand-over reach it through these methods.
      intake: root.intake === undefined ? undefined : new Proxy(root.intake, { get: (target, field) => {
        const value = (target as unknown as Record<PropertyKey, unknown>)[field];
        return typeof value === "function" ? (...args: unknown[]) => { mark(); return (value as (...input: unknown[]) => unknown).apply(target, args); } : value;
      } }),
      coreTasks: wrapRoute(root.coreTasks as never),
      coreApp: wrapRoute(root.coreApp as never),
      callback: async (request) => {
        if (refuses(request.path)) return undefined;
        const answer = await root.callback(request);
        if (answer !== undefined) mark();
        return answer;
      },
    }),
    track: (handler) => (async (event: Event) => {
      const method = event.requestContext?.http?.method ?? "GET";
      const path = event.rawPath ?? "";
      const record: SeenRequest = { method, path, status: 0, answeredByCore: false, kind: probing.getStore() === true ? "probe" : kindOf(method, path) };
      seen.push(record);
      const response = await current.run(record, () => handler(event as never));
      record.status = response.statusCode;
      return response;
    }) as never,
    assertAllCore: (options = {}) => {
      const unrefused = seen.filter((request) => request.kind === "probe" && request.status < 400);
      if (unrefused.length > 0) throw new Error(`a probe that must be refused was not: ${unrefused.map((request) => `${request.method} ${request.path} -> ${request.status}`).join("; ")}`);
      const strays = seen.filter((request) => request.kind !== "other" && request.kind !== "probe" && !request.answeredByCore);
      if (strays.length > 0) {
        throw new Error(`the old handler answered, not the core: ${strays.map((request) => `${request.method} ${request.path} -> ${request.status}`).join("; ")}`);
      }
      if (!seen.some((request) => request.kind === "person") || (options.callbacks !== false && !seen.some((request) => request.kind === "callback"))) {
        throw new Error(`the journey made no person-facing request or (unless it says it needs none) no worker callback, so it proved nothing about the core (saw ${seen.length} requests)`);
      }
    },
  };
}
