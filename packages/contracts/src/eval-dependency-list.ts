// L4-E12 (E2, DEC 254zzz55 N6): what a FREE dry run of the eval found it reaches. At setup the worker runs the eval once on main inside the sealed eval box with the model helper serving scripted
// replies (no model call is possible: nothing is bridged and nothing is spent), reads what the eval tried to reach, and sends this list through the setup run's existing callback. The broker keeps ONE
// list per company and project (the newest run's) and shows it through the TH1 words (`evalBlockedReachClause`), so a person reads "your eval tried to reach a database (port 5432) and an outside
// service (api.example.com)" before any paid run.
//
// FIXED words only, like TH1: a database is named by its port (and the engine that port belongs to), an outside service by a host NAME that passed the strict shape (never an address, a path, a query
// or a credential), a missing variable by its NAME in upper-case word shape. No log line, value or error text is ever in a list. Browser-safe and pure.
import { z } from "zod";
import { EVAL_BLOCKED_HOST, EVAL_BLOCKED_REACH_MAX_ITEMS, evalBlockedReachClause, evalRunFailureSentence, type EvalBlockedReach } from "./eval-run-diagnostic.js";

export const EVAL_DEPENDENCY_LIST_VERSION = 1;
export const EVAL_DEPENDENCY_DATABASES_MAX = 8;
export const EVAL_DEPENDENCY_HOSTS_MAX = 16;
export const EVAL_DEPENDENCY_ENV_VARS_MAX = 16;
/** An environment variable's NAME: upper-case words (`DATABASE_URL`, `STRIPE_API_KEY`). Anything else is not kept. */
export const EVAL_DEPENDENCY_ENV_NAME = /^[A-Z][A-Z0-9_]{1,63}$/u;
export const EVAL_DEPENDENCY_ENGINES = ["postgres", "mysql", "redis", "mongodb", "other"] as const;

/** The causes (`EvalRunFailureCode`) after which a dry run's list may be incomplete. */
export const EVAL_DEPENDENCY_STOPPED_EARLY = ["missing_package", "missing_file", "command_not_found", "run_timed_out"] as const;
const Port = z.number().int().min(1).max(65_535);
export const EvalDependencyListSchema = z.object({
  version: z.literal(EVAL_DEPENDENCY_LIST_VERSION),
  /** Databases and caches the eval tried to reach, by port (the project's own host name for one is private). */
  databases: z.array(z.object({ port: Port.optional(), engine: z.enum(EVAL_DEPENDENCY_ENGINES) }).strict()).max(EVAL_DEPENDENCY_DATABASES_MAX),
  /** Outside names the eval looked up or connected to (the sealed name server's record and the eval's own error lines), each with the port when one was seen. */
  hosts: z.array(z.object({ name: z.string().regex(EVAL_BLOCKED_HOST), port: Port.optional() }).strict()).max(EVAL_DEPENDENCY_HOSTS_MAX),
  /** Variables the eval read and did not find (`KeyError: 'DATABASE_URL'`, `process.env.X is undefined`). Names only. */
  envVars: z.array(z.string().regex(EVAL_DEPENDENCY_ENV_NAME)).max(EVAL_DEPENDENCY_ENV_VARS_MAX),
  /** The model was never called: a dry run serves scripted replies and bridges nothing. Always 0; a list that says anything else is refused. */
  modelCalls: z.literal(0),
  /** How the one run ended. A run that failed still lists what it reached before it stopped. */
  ended: z.enum(["finished", "failed", "timed_out"]),
  /** Why the run stopped before the eval could finish, when it stopped on something that hides what comes after (a package that is not installed, a missing file or command, the time limit). The list may then be incomplete. */
  stoppedEarly: z.enum(EVAL_DEPENDENCY_STOPPED_EARLY).optional(),
  /** True when this install's test services were off, so no database or stand-in was offered to the run. */
  servicesOff: z.boolean().optional(),
}).strict();
export type EvalDependencyList = z.infer<typeof EvalDependencyListSchema>;

/** Whether a list found nothing the eval reaches. */
export const evalDependencyListIsEmpty = (list: EvalDependencyList): boolean => list.databases.length === 0 && list.hosts.length === 0 && list.envVars.length === 0;

/**
 * The TH1 view of a list: databases by port, outside hosts by name, at most 3 items (a longer list says `more`). The words come from `evalBlockedReachClause`, so a dry run and a failed eval say the same thing the
 * same way. Undefined when the list names nothing a person could see (a variable alone is shown by `evalDependencyListWords`).
 */
export function evalDependencyListToBlockedReach(list: EvalDependencyList): EvalBlockedReach | undefined {
  const parsed = EvalDependencyListSchema.safeParse(list);
  if (!parsed.success) return undefined;
  const items: EvalBlockedReach["items"] = [
    ...parsed.data.databases.map((database) => ({ kind: "database" as const, ...(database.port === undefined ? {} : { port: database.port }) })),
    ...parsed.data.hosts.map((host) => ({ kind: "service" as const, host: host.name })),
  ];
  if (items.length === 0) return undefined;
  return { items: items.slice(0, EVAL_BLOCKED_REACH_MAX_ITEMS), ...(items.length > EVAL_BLOCKED_REACH_MAX_ITEMS ? { more: true } : {}) };
}

/** Said when test services are off on the install the dry run ran on. */
export const EVAL_TEST_SERVICES_OFF_WORDS = "Test services are off on this install, so your evals get no database or stand-in here yet." as const;

/**
 * The fixed sentence for a list, or undefined when it found nothing. "A free dry run of your eval on main found it reaches a database (port 5432) and an outside service (api.example.com) and needs the
 * variable DATABASE_URL. Test services are off on this install, so your evals get no database or stand-in here yet." Never echoes free text: a port is an integer, a host passed the shape, a variable its name shape.
 */
export function evalDependencyListWords(list: EvalDependencyList): string | undefined {
  const parsed = EvalDependencyListSchema.safeParse(list);
  if (!parsed.success) return undefined;
  const early = parsed.data.stoppedEarly === undefined ? "" : ` The dry run stopped early (${evalRunFailureSentence({ code: parsed.data.stoppedEarly }, { named: false })}), so this list may be incomplete.`;
  const off = parsed.data.servicesOff === true ? ` ${EVAL_TEST_SERVICES_OFF_WORDS}` : "";
  if (evalDependencyListIsEmpty(parsed.data)) return early === "" ? undefined : `A free dry run of your eval on main found nothing it reaches.${early}${off}`;
  const reach = evalDependencyListToBlockedReach(parsed.data);
  const names = parsed.data.envVars.slice(0, 3);
  const variables = names.length === 0 ? undefined : `${names.length > 1 ? "the variables" : "the variable"} ${names.join(", ")}${parsed.data.envVars.length > names.length ? " and more" : ""}`;
  const reachWords = reach === undefined ? undefined : evalBlockedReachClause(reach).replace(/^your eval tried to reach /u, "").replace(/\. Rovara's sealed check can't reach (?:those|that) yet$/u, "");
  const found = [reachWords === undefined ? undefined : `reaches ${reachWords}`, variables === undefined ? undefined : `needs ${variables}`].filter((part): part is string => part !== undefined).join(" and ");
  return `A free dry run of your eval on main found it ${found}.${early}${off}`;
}
