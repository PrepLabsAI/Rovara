// Engine host (lane E2, step 5): the security-list points a deployed install fills for the FIRST staging run, as adapter modules for BOTH roots (the broker's, aws/core-engine-root.ts, and the
// dispatcher's `extraModules`). None is ever `isDefault` (the registry's NEVER_DEFAULT rule refuses laptop defaults on these points), and none falls back to a laptop rule.
//
//   admission   An allow-list of company ids (the founders' test company on staging) and two dollar caps, per task and per company per UTC day, read from the core's own cost ledger
//               (core/cost/ledger.ts: the task's total and the company's day row) until the Cloud gateway holds money. Any other company is refused with fixed words. `stage()` puts a
//               condition on the company's day row (and the task's total, for a task) into the caller's transaction, so a start commits only while the day is still under its cap.
//               The caps are START GATES, not a held allowance: nothing is reserved (concurrent starts do not see each other), and nothing on AWS books a usage into the ledger yet,
//               so the adapter declares `enforcesCost: false` (Rovara then starts no unattended paid work on it). Declaring `true` needs both a reservation and the usage booking.
//   metering    The price table over the catalog's list prices (the capped price for a reservation). A model no table prices is charged a cautious fixed price, never $0
//               (`UNKNOWN_MODEL_PRICE`, DEC 172/216). No call is made on Rovara's account here: metering only prices usage the company's own provider reported.
//   identity    Code's own sign-in decides who the caller is (the broker verifies the token); this point only names a person of a company, from MEMBERSHIP (R4's reader), never from a claim.
//               It authenticates no credential itself.
//   audit-sink  Code's audit records: the `AUDIT` rows of the company's own partition (the document audit sink), read back by lane AU's company audit read.
//
// Not here: `approvers` (the task owner and the existing rules, with #662's fresh step-up) and `model-keys` (lane G). Each stays empty, so the registry refuses the switch by name.
import auditSinkPlugin from "@agentx/local-adapters/audit-sink";
import { listPricesPerMillion } from "@agentx/model-runtime/catalog";
import {
  IMPLICIT_COMPANY_ID, OrgIdSchema, OrgRoleSchema, when,
  type Admission, type AdmissionDecision, type AdmissionRequest, type Cost, type IdentityProvider, type Metering, type ModelPrice, type ModelUsage, type OrgId, type OrgRole, type Principal, type TransactItem,
} from "@agentx/contracts";
import { createCostLedger, companyDayKey, costPartition, utcDayOf, type CostLedger } from "../core/cost/ledger.js";
import { costMicrosOf, createModelPrices, type ModelPrices } from "../core/cost/price-table.js";
import { coreAdapter, type CoreAdapterModule } from "./registry.js";

/** The identity adapter's name on a deployed install: the principals it names were signed in by Code's own sign-in. */
export const HOSTED_IDENTITY_PROVIDER = "rovara-sign-in";
const OWNER = "E2 step 5 (the first staging run)";

// ---- settings (the function's environment)

/**
 * The companies that may start work on the core: `all` (every company with its own id: DEC 229a, the owner's "everyone", still under the caps) or `org_...[:org_...]`. Absent or
 * empty: no company may (the admission module refuses to build).
 */
export const CORE_ALLOWED_COMPANIES_VARIABLE = "ROVARA_CORE_ALLOWED_COMPANIES";
/** The per-task cap in whole dollars. Default 5. */
export const CORE_TASK_CAP_VARIABLE = "ROVARA_CORE_TASK_CAP_USD";
/** The per-company, per-UTC-day cap in whole dollars. Default 25. */
export const CORE_COMPANY_DAY_CAP_VARIABLE = "ROVARA_CORE_COMPANY_DAY_CAP_USD";
export const DEFAULT_TASK_CAP_USD = 5;
export const DEFAULT_COMPANY_DAY_CAP_USD = 25;
/** The highest cap either setting may hold, in dollars: a typo of extra digits refuses instead of lifting the cap. */
const CAP_MAX_USD = 1_000;

/** The value of CORE_ALLOWED_COMPANIES_VARIABLE that lets every company in (never the implicit laptop company). */
export const ALL_COMPANIES = "all";

export interface HostedAdmissionSettings {
  /** `all`: every company with its own id (DEC 229a); else exactly these. */
  allowedCompanies: readonly OrgId[] | typeof ALL_COMPANIES;
  taskCapMicros: number;
  companyDayCapMicros: number;
}

const wholeDollars = (raw: string | undefined, fallback: number): number | undefined => {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^[1-9][0-9]{0,3}$/u.test(raw.trim())) return undefined;
  const value = Number(raw.trim());
  return value <= CAP_MAX_USD ? value : undefined;
};

/** The admission's settings, or a fixed problem (never the value read). The implicit laptop company is never allowed: a deployed company has its own id. */
export function readHostedAdmissionSettings(env: NodeJS.ProcessEnv): { settings: HostedAdmissionSettings } | { problem: string } {
  const raw = env[CORE_ALLOWED_COMPANIES_VARIABLE]?.trim() ?? "";
  if (raw === "" || raw === "none") return { problem: "no company is allowed on the core engine" };
  const task = wholeDollars(env[CORE_TASK_CAP_VARIABLE], DEFAULT_TASK_CAP_USD);
  const day = wholeDollars(env[CORE_COMPANY_DAY_CAP_VARIABLE], DEFAULT_COMPANY_DAY_CAP_USD);
  if (raw === ALL_COMPANIES) {
    if (task === undefined || day === undefined) return { problem: "a spend cap is not a whole number of dollars from 1 to 1000" };
    return { settings: { allowedCompanies: ALL_COMPANIES, taskCapMicros: task * 1_000_000, companyDayCapMicros: day * 1_000_000 } };
  }
  const ids = raw.split(":");
  if (ids.some((id) => !OrgIdSchema.safeParse(id).success || id === IMPLICIT_COMPANY_ID)) return { problem: "an allowed company id is not well formed" };
  if (task === undefined || day === undefined) return { problem: "a spend cap is not a whole number of dollars from 1 to 1000" };
  return { settings: { allowedCompanies: [...new Set(ids)] as OrgId[], taskCapMicros: task * 1_000_000, companyDayCapMicros: day * 1_000_000 } };
}

// ---- admission

export const COMPANY_NOT_ALLOWED = "This company is not on the core engine's list for this install yet.";
export const COMPANY_DAY_CAP_REACHED = "This company has reached today's spending limit on this install. Try again tomorrow (UTC).";
export const TASK_CAP_REACHED = "This task has reached its spending limit on this install.";
export const SPEND_UNKNOWN = "Today's spending could not be worked out, so nothing new was started. Try again later, or ask whoever runs the install.";

const refuse = (code: string, message: string): AdmissionDecision => ({ allowed: false, code, message });

export interface HostedAdmissionOptions {
  settings: HostedAdmissionSettings;
  ledger: Pick<CostLedger, "taskCost" | "companyDayCost">;
  now: () => Date;
}

/** The staging admission (see the file comment). */
export function createHostedAdmission(options: HostedAdmissionOptions): Admission {
  const { settings, ledger } = options;
  const listed = settings.allowedCompanies === ALL_COMPANIES ? undefined : new Set<string>(settings.allowedCompanies);
  // `all`: any well-formed company id of its own; the implicit laptop company never.
  const isAllowed = (companyId: string): boolean => (listed === undefined ? OrgIdSchema.safeParse(companyId).success && companyId !== IMPLICIT_COMPANY_ID : listed.has(companyId));

  /** The decision and, when allowed, the conditions that hold it at commit. Any spend that cannot be read as dollars refuses. */
  async function decide(request: AdmissionRequest): Promise<{ decision: AdmissionDecision; holds: TransactItem[] }> {
    if (typeof request?.companyId !== "string" || !isAllowed(request.companyId)) return { decision: refuse("company_not_allowed", COMPANY_NOT_ALLOWED), holds: [] };
    const companyId = request.companyId;
    const estimate: Cost | undefined = request.estimate?.cost;
    if (estimate !== undefined && (estimate === null || typeof estimate !== "object" || estimate.currency !== "USD" || !Number.isSafeInteger(estimate.micros) || estimate.micros < 0)) {
      return { decision: refuse("spend_unknown", SPEND_UNKNOWN), holds: [] };
    }
    const asked = estimate?.micros ?? 0;
    // Within the cap: nothing asked needs the spend BELOW the cap; an estimate needs spend plus the estimate AT MOST the cap.
    const fits = (spent: number, cap: number): boolean => (asked === 0 ? spent < cap : spent + asked <= cap);
    const holdOn = (path: string, cap: number) => (asked === 0 ? when.lt(path, cap) : when.lte(path, cap - asked));
    const day = utcDayOf(options.now());
    const spentToday = await ledger.companyDayCost(companyId, day);
    if (spentToday.uncountedEntries > 0) return { decision: refuse("spend_unknown", SPEND_UNKNOWN), holds: [] };
    if (!fits(spentToday.usdMicros, settings.companyDayCapMicros)) return { decision: refuse("company_day_cap", COMPANY_DAY_CAP_REACHED), holds: [] };
    const holds: TransactItem[] = [{ kind: "check", key: companyDayKey(companyId, day), condition: when.or(when.absent(), when.and(holdOn("usdMicros", settings.companyDayCapMicros), when.eq("uncountedEntries", 0))) }];
    if (request.subject?.type === "task" && typeof request.subject.id === "string" && request.subject.id !== "") {
      const task = await ledger.taskCost(companyId, request.subject.id);
      if (task.unpricedEntries > 0 || (task.currency !== undefined && task.currency !== "USD")) return { decision: refuse("spend_unknown", SPEND_UNKNOWN), holds: [] };
      if (!fits(task.micros, settings.taskCapMicros)) return { decision: refuse("task_cap", TASK_CAP_REACHED), holds: [] };
      holds.push({ kind: "check", key: { pk: costPartition(companyId, request.subject.id), sk: "TOTAL" }, condition: when.or(when.absent(), when.and(holdOn("micros", settings.taskCapMicros), when.eq("unpricedEntries", 0))) });
    }
    return { decision: { allowed: true }, holds };
  }

  return {
    // Not a held cap (see the file comment): no reservation, and no usage booking on AWS yet.
    enforcesCost: false,
    async admit(request) {
      return (await decide(request)).decision;
    },
    async stage(request) {
      const { decision, holds } = await decide(request);
      return { decision, items: decision.allowed ? holds : [] };
    },
    // No reservation is held: a usage is counted when the ledger records it.
    async settle() {},
    async release() {},
  };
}

// ---- metering

/**
 * What a model no table prices is charged, per million tokens (USD micros): a cautious fixed price (a top-tier frontier model's list price; not the catalog's maximum). Never $0: an
 * unknown model is assumed expensive, so a cap holds back rather than letting it run free (DEC 172/216).
 */
export const UNKNOWN_MODEL_PRICE: ModelPrice = Object.freeze({
  inputMicrosPerMillionTokens: 15_000_000,
  outputMicrosPerMillionTokens: 75_000_000,
  cacheReadMicrosPerMillionTokens: 1_500_000,
  cacheWriteMicrosPerMillionTokens: 18_750_000,
});

/** The staging meter: the catalog's prices; an unknown model at `UNKNOWN_MODEL_PRICE`. Stateless: the ledger counts each usage once. */
export function createHostedMetering(prices: ModelPrices = createModelPrices({ providers: () => [], catalog: listPricesPerMillion })): Metering {
  const cautious = (usage: ModelUsage): Cost => ({ micros: costMicrosOf(UNKNOWN_MODEL_PRICE, usage.tokens), currency: "USD" });
  return {
    async price(usage) {
      const found = prices.findCap({ provider: usage.provider, modelId: usage.modelId });
      return found === undefined ? cautious(usage) : { micros: costMicrosOf(found.price, usage.tokens), currency: found.currency };
    },
    async record(entry) {
      const found = prices.find({ provider: entry.usage.provider, modelId: entry.usage.modelId });
      return found === undefined ? { cost: cautious(entry.usage), source: "unknown" } : { cost: { micros: costMicrosOf(found.price, entry.usage.tokens), currency: found.currency }, source: "price-table" };
    },
  };
}

// ---- identity

/** What membership says about a person (R4's reader): their company and live role. Undefined: not a member of any company. */
export type MembershipOf = (personId: string) => Promise<{ companyId: string; role: OrgRole } | undefined>;

export interface HostedIdentityOptions {
  membershipOf: MembershipOf;
  /** The person's display name (the sign-in record). Undefined: the person is not known. */
  displayNameOf: (personId: string) => Promise<string | undefined>;
}

/** The deployed identity point: names a member of a company; authenticates nothing (Code's sign-in does). */
export function createHostedIdentity(options: HostedIdentityOptions): IdentityProvider {
  return {
    capabilities: { interactiveSignIn: false, externalAccounts: false },
    async authenticate() {
      return { ok: false, reason: "refused" };
    },
    async resolveExternalAccount() {
      return undefined;
    },
    async getPrincipal(companyId, personId): Promise<Principal | undefined> {
      if (typeof personId !== "string" || personId === "" || !OrgIdSchema.safeParse(companyId).success) return undefined;
      const membership = await options.membershipOf(personId);
      if (membership === undefined || membership.companyId !== companyId || !OrgRoleSchema.safeParse(membership.role).success) return undefined;
      const displayName = await options.displayNameOf(personId);
      if (displayName === undefined) return undefined;
      return { companyId, personId, displayName, roles: [membership.role], provider: HOSTED_IDENTITY_PROVIDER };
    },
  };
}

// ---- the modules

export interface HostedSecurityInputs {
  env: NodeJS.ProcessEnv;
  identity: HostedIdentityOptions;
  /** The meter's prices (tests). Absent: the catalog's. */
  prices?: ModelPrices;
}

/**
 * The step 5 modules, in build order (metering before admission, which reads the ledger over the registry's store and meter). The admission module refuses to build without an allow-list,
 * so the whole registry is refused (the switch then serves nothing) rather than run with every company let in.
 */
export function hostedSecurityModules(inputs: HostedSecurityInputs): CoreAdapterModule[] {
  return [
    coreAdapter({ point: "metering", name: "hosted-price-table", owner: OWNER, create: () => createHostedMetering(inputs.prices) }),
    coreAdapter({
      point: "admission", name: "hosted-allow-list", owner: OWNER,
      create: (context, registry) => {
        const read = readHostedAdmissionSettings(inputs.env);
        if ("problem" in read) throw new Error(`the core engine's admission cannot be built: ${read.problem}`);
        const ledger = createCostLedger({ store: registry.require("storage"), metering: registry.require("metering"), now: context.now });
        return createHostedAdmission({ settings: read.settings, ledger, now: context.now });
      },
    }),
    coreAdapter({ point: "identity", name: HOSTED_IDENTITY_PROVIDER, owner: OWNER, create: () => createHostedIdentity(inputs.identity) }),
    coreAdapter({
      point: "audit-sink", name: "document", owner: OWNER,
      create: (context, registry) => auditSinkPlugin.create({ defaultCompanyId: context.installCompanyId, settings: {}, registry: registry, now: context.now }),
    }),
  ];
}
