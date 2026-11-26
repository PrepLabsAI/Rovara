// L4-D (DEC 254z b): how risky a setup candidate is, and who may approve it at that risk. The risk is read from the candidate's own DIFF against the project's current approved revision,
// field by field, in code: never from the run's words, the model's summary or anything a client sends.
//
//   low     the setup (install) and test commands changed, with no new environment on any command: a version bump, another install or test command, a cache path;
//   medium  a test mock changed (`generalFakes`, Rovara-made fakes), or the prompt locations changed (`promptLocations`, L4-EVP: which files and regions ask for the AI evaluation; no command, website or credential rides on one, and the eval's spend is its own separate approval);
//   high    a website the machines may reach (`network`), a package registry (`registries`, with its credential reference), an integration (`integrations`), the dev container, a command that
//           gains an environment entry (a secret, a cloud account or a credential can ride on it), ANY other field, a field this code does not know, a value it cannot read, and a missing base.
//   `revision` and `origins` are bookkeeping (the candidate always has the next number, and origins only say the commands came from the setup run).
//
// Who approves (DEC 254z b): low and medium, anyone who maintains the project (a company owner or admin, or the project's administrator); high, a company owner or admin. A rejection
// applies nothing (the candidate is removed), so anyone who maintains the project may reject at any risk.
import { canonicalJson, inlineEnvEntries, shellLineOf } from "@agentx/contracts";

export type SetupRisk = "low" | "medium" | "high";
export type SetupChangeArea = "setup_commands" | "test_commands" | "test_mocks" | "prompt_locations" | "websites" | "registries" | "integrations" | "dev_container" | "other";
export interface SetupChange { area: SetupChangeArea; risk: SetupRisk }
export interface SetupChangeRisk { risk: SetupRisk; changes: SetupChange[] }

/** Who approves at each risk: a project maintainer, or a company admin (or owner). */
export const SETUP_RISK_APPROVER: Readonly<Record<SetupRisk, "maintainer" | "admin">> = Object.freeze({ low: "maintainer", medium: "maintainer", high: "admin" });

const RANK: Readonly<Record<SetupRisk, number>> = { low: 0, medium: 1, high: 2 };
/** Fields that never change risk: the revision number and the origins bookkeeping. */
const BOOKKEEPING = new Set(["revision", "origins"]);
/** Fields with a fixed risk when they change. Anything not here (and not a command list or bookkeeping) is `other`, high. */
const FIXED: Readonly<Record<string, SetupChange>> = {
  generalFakes: { area: "test_mocks", risk: "medium" },
  promptLocations: { area: "prompt_locations", risk: "medium" },
  network: { area: "websites", risk: "high" },
  registries: { area: "registries", risk: "high" },
  integrations: { area: "integrations", risk: "high" },
  devcontainer: { area: "dev_container", risk: "high" },
};
/** The order changes are listed in. */
const AREA_ORDER: readonly SetupChangeArea[] = ["setup_commands", "test_commands", "test_mocks", "prompt_locations", "websites", "registries", "integrations", "dev_container", "other"];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const same = (left: unknown, right: unknown): boolean => {
  try { return canonicalJson(left) === canonicalJson(right); } catch { return false; }
};

/** A command's environment entries as `name=value` texts, or undefined for a command this code cannot read whole. */
function envOf(command: unknown): string[] | undefined {
  if (!isRecord(command) || typeof command["cwd"] !== "string" || typeof command["executable"] !== "string" || !Array.isArray(command["args"]) || !command["args"].every((arg) => typeof arg === "string")
    || typeof command["timeoutSeconds"] !== "number") return undefined;
  const env = command["env"];
  // SETUP-L9-SHELL: a shell line's inline `NAME=value` (`FOO=1 make`, `export FOO=1 && make`) is an environment entry too.
  const inline = inlineEnvEntries(shellLineOf({ executable: command["executable"], args: command["args"] }) ?? "").map((entry) => `inline:${entry}`);
  if (env === undefined) return inline;
  if (!isRecord(env) || !Object.values(env).every((value) => typeof value === "string")) return undefined;
  return [...inline, ...Object.entries(env).map(([name, value]) => `${name}=${String(value)}`)];
}

/** A changed command list: low, unless a command cannot be read or gains an environment entry the approved commands did not have (high). */
function commandsRisk(before: unknown, after: unknown): SetupRisk {
  if (!Array.isArray(after) || !Array.isArray(before)) return "high";
  const known = new Set<string>();
  for (const command of before) {
    const env = envOf(command);
    if (env === undefined) return "high";
    for (const entry of env) known.add(entry);
  }
  for (const command of after) {
    const env = envOf(command);
    if (env === undefined || env.some((entry) => !known.has(entry))) return "high";
  }
  return "low";
}

/** The risk of making `candidate` the project's setup in place of `base` (the current approved revision). Pure; validates its inputs at run time. */
export function classifySetupChange(base: unknown, candidate: unknown): SetupChangeRisk {
  if (!isRecord(base) || !isRecord(candidate)) return { risk: "high", changes: [{ area: "other", risk: "high" }] };
  const found = new Map<SetupChangeArea, SetupRisk>();
  const add = (change: SetupChange): void => {
    const before = found.get(change.area);
    if (before === undefined || RANK[change.risk] > RANK[before]) found.set(change.area, change.risk);
  };
  for (const field of new Set([...Object.keys(base), ...Object.keys(candidate)])) {
    if (BOOKKEEPING.has(field) || same(base[field], candidate[field])) continue;
    if (field === "setup") add({ area: "setup_commands", risk: commandsRisk(base[field], candidate[field]) });
    else if (field === "readiness") add({ area: "test_commands", risk: commandsRisk(base[field], candidate[field]) });
    // Own keys only: a field named like an inherited property (`constructor`, `__proto__`) is unknown, so high.
    else add(Object.hasOwn(FIXED, field) ? FIXED[field]! : { area: "other", risk: "high" });
  }
  const changes = AREA_ORDER.filter((area) => found.has(area)).map((area) => ({ area, risk: found.get(area)! }));
  const risk = changes.reduce<SetupRisk>((highest, change) => (RANK[change.risk] > RANK[highest] ? change.risk : highest), "low");
  return { risk, changes };
}

/** A person's live standing as the approver rule reads it: their company role and their grant on the project. */
export interface SetupApproverStanding { companyRole: "owner" | "admin" | "member"; projectGrant?: "administrator" | "developer" | undefined }

/** Whether this person may give this answer on a setup candidate of this risk (see the file comment). Anything it does not know is a no. */
export function setupApproverAllows(standing: SetupApproverStanding | undefined, risk: SetupRisk, outcome: "approve" | "reject"): boolean {
  if (!isRecord(standing) || !Object.hasOwn(RANK, risk)) return false;
  const admin = standing.companyRole === "owner" || standing.companyRole === "admin";
  const maintainer = admin || (standing.companyRole === "member" && standing.projectGrant === "administrator");
  if (outcome === "reject") return maintainer;
  if (outcome !== "approve") return false;
  return SETUP_RISK_APPROVER[risk] === "admin" ? admin : maintainer;
}

/**
 * Whether this person may allow or refuse a WEBSITE for a project's setup run (L4-SF d). A website changes what a repository's code can reach, so it is the high-risk rule for both answers: only a company
 * owner or admin. A project maintainer who is not one may not decide it (a refusal keeps the website out for a week, for everyone). Anything it does not know is a no.
 */
export function setupHostApproverAllows(standing: SetupApproverStanding | undefined): boolean {
  return isRecord(standing) && (standing.companyRole === "owner" || standing.companyRole === "admin");
}
