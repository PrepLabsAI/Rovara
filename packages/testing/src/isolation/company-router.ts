// An adapter that serves many companies, made from one adapter per company. A code host, tracker or check runner takes the company in the `HostScope` of every call (`{ orgId }`); this
// router reads that scope, asks the company resolver which company it is, and hands the call to that company's adapter. It is the fake of what a hosted adapter does (one installation or
// connection per company), so the isolation kit can run on a fake: the per-company adapters share raw ids but nothing else.
//
// It fails closed. A call that carries no scope, a scope that names no company (`{ system: ... }`), a resolver that throws or answers `undefined`, and a company with no adapter are all
// refused with one fixed sentence that names no company, and the call goes to nobody. The router never falls back to a first or default company.
import { HostScopeSchema, agentXError, type HostScope } from "@agentx/contracts";

export type CompanyResolver = (scope: HostScope) => string | undefined | Promise<string | undefined>;

export interface CompanyRouterOptions {
  /** Which company a call is for. Default: the scope's `orgId`. */
  resolve?: CompanyResolver;
}

export const NO_COMPANY_WORDS = "the call does not say which company it is for";

/** The resolver a router uses unless it is given one: the scope's own `orgId`. */
export const scopeOrgId: CompanyResolver = (scope) => ("orgId" in scope ? scope.orgId : undefined);

const scopeOf = (args: readonly unknown[]): HostScope | undefined => {
  for (const arg of args) {
    if (typeof arg === "object" && arg !== null && HostScopeSchema.safeParse(arg).success) return arg as HostScope;
  }
  return undefined;
};

/** A proxy over `pick(first adapter)` whose methods go to the calling company's adapter. A nested object named `events` (a code host's or tracker's delivery reader) is routed the same way. */
function routed<T extends object>(adapters: ReadonlyMap<string, T>, resolve: CompanyResolver, pick: (adapter: T) => object): object {
  const first = pick([...adapters.values()][0]!) as Record<PropertyKey, unknown>;
  return new Proxy(first, {
    get(_target, property) {
      const held = first[property];
      if (typeof held === "function") {
        return async (...args: unknown[]) => {
          const scope = scopeOf(args);
          let company: string | undefined;
          try {
            company = scope === undefined ? undefined : await resolve(scope);
          } catch {
            throw agentXError("FORBIDDEN", NO_COMPANY_WORDS);
          }
          const adapter = company === undefined ? undefined : adapters.get(company);
          if (adapter === undefined) throw agentXError("FORBIDDEN", NO_COMPANY_WORDS);
          const target = pick(adapter) as Record<PropertyKey, (...rest: unknown[]) => unknown>;
          return target[property]!.apply(target, args);
        };
      }
      if (property === "events" && typeof held === "object" && held !== null) return routed(adapters, resolve, (adapter) => (pick(adapter) as { events: object }).events);
      return held;
    },
  });
}

/** One adapter per company, behind one object of the same type. The adapters' own data properties (`kind`, `capabilities`) are read from the first. */
export function routeByCompany<T extends object>(adapters: ReadonlyMap<string, T>, options: CompanyRouterOptions = {}): T {
  if (adapters.size === 0) throw new Error("a company router needs at least one company");
  return routed(adapters, options.resolve ?? scopeOrgId, (adapter) => adapter) as T;
}
