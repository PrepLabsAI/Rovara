/**
 * F1 lane L0: the runtime check of a settings row, `defineRow` (the one way a row is written) and the cross-row rules (`settingRowProblems`).
 *
 * A row with no named reader is refused (rule 1 of the row type). The cross-row rules are what make "a second row cannot reuse a key, a packed code or a stack parameter" a test
 * failure and not a review comment: tests/contract/settings-rows.test.ts runs `settingRowProblems` over every rows file.
 */
import { z } from "zod";
import type { SettingRow } from "./types.js";

const KEY = /^[a-z][A-Za-z0-9-]*(\.[A-Za-z0-9][A-Za-z0-9-]*)+$/u;
/** An `agentx config` key is the one name already in people's hands (`workerSandboxEgress` has no dot), so it is held to a looser pattern than a row key. */
const CONFIG_KEY = /^[a-z][A-Za-z0-9-]*(\.[A-Za-z0-9][A-Za-z0-9-]*)*$/u;
const PART = z.enum(["access", "foundation", "identity", "control-plane", "gateway", "runtime", "slack"]);

const SettingLevelSchema = z.strictObject({
  level: z.enum(["install", "company", "project", "person", "repo-file"]),
  owner: z.enum(["code", "cloud"]),
});

const SettingTypeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("bool") }),
  z.strictObject({ kind: z.literal("choice"), values: z.array(z.string()).min(1) }),
  z.strictObject({ kind: z.literal("int"), min: z.number().optional(), max: z.number().optional() }),
  z.strictObject({ kind: z.literal("usd"), min: z.number().optional(), max: z.number().optional() }),
  z.strictObject({ kind: z.literal("minutes"), min: z.number().optional(), max: z.number().optional() }),
  z.strictObject({ kind: z.literal("text"), max: z.number().optional(), pattern: z.string().optional() }),
  z.strictObject({ kind: z.literal("list"), item: z.enum(["text", "int"]), max: z.number() }),
  z.strictObject({ kind: z.literal("host") }),
]);

const StackParameterRefSchema = z.strictObject({ part: PART, parameter: z.string().min(1) });

const PackedSettingSchema = z.strictObject({
  key: z.string().regex(/^[a-z][A-Za-z0-9]*$/u),
  code: z.string().regex(/^[a-z]{2}$/u),
  variable: z.string().min(1),
  order: z.number().int().positive(),
  httpsOrigin: z.literal(true).optional(),
  switchFlag: z.literal(true).optional(),
});

const InstallInfoSchema = z.strictObject({
  part: PART,
  parameter: z.string().min(1).optional(),
  also: z.array(StackParameterRefSchema).optional(),
  class: z.enum(["answer", "operator", "internal"]),
  declaredIn: z.enum(["both", "named", "legacy", "neither"]),
  kept: z.number().int().positive().optional(),
  packed: PackedSettingSchema.optional(),
  carriedBy: z.array(z.enum(["answers", "operator-kept", "ssm-sign-in", "settings-models", "deployed-stack", "control-plane-outputs", "stack-outputs", "none"])).min(1),
  secret: z.literal(true).optional(),
});

const ConfigValidatorSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("oneOf"), values: z.array(z.string()).min(1) }),
  z.strictObject({ kind: z.literal("wholeNumber"), min: z.number(), max: z.number() }),
  z.strictObject({ kind: z.literal("modelId") }),
  z.strictObject({ kind: z.literal("e2eAgentModel") }),
  z.strictObject({ kind: z.literal("fallbackModel") }),
  z.strictObject({ kind: z.literal("email") }),
  z.strictObject({ kind: z.literal("chatgptModelId") }),
  z.strictObject({ kind: z.literal("coreModelGatewayUrl") }),
  z.strictObject({ kind: z.literal("coreAgentModel") }),
  z.strictObject({ kind: z.literal("coreAnswersModel") }),
  z.strictObject({ kind: z.literal("coreLearningModel") }),
  z.strictObject({ kind: z.literal("savedEnvSwitch") }),
]);

const ConfigTargetSpecSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("stack-parameter") }),
  z.strictObject({ kind: z.literal("settings"), field: z.literal("alertAddress") }),
  z.strictObject({ kind: z.literal("control-plane-setting"), field: z.enum(["perPerson", "perOrganization"]) }),
  z.strictObject({ kind: z.literal("chatgpt-setting"), field: z.enum(["enabled", "preferredModel"]) }),
]);

const ConfigKeyInfoSchema = z.strictObject({
  key: z.string().regex(CONFIG_KEY),
  description: z.string().min(1),
  order: z.number().int().positive(),
  target: ConfigTargetSpecSchema,
  validator: ConfigValidatorSchema,
  defaultValue: z.string().optional(),
  e2eAgentModel: z.literal(true).optional(),
  fallbackModel: z.literal(true).optional(),
  corePairedWith: z.string().optional(),
  gatewayOffered: z.literal(true).optional(),
  shown: z.enum(["coreModelGatewayUrl", "savedEnvSwitch"]).optional(),
  model: z.enum(["orchestrator", "classifier", "worker"]).optional(),
  docs: z.strictObject({ order: z.number().int().positive(), where: z.string(), default: z.string(), notes: z.string() }),
});

export const SettingRowSchema = z.strictObject({
  key: z.string().regex(KEY, "a setting key is dotted: <area>.<name>"),
  levels: z.array(SettingLevelSchema).min(1),
  type: SettingTypeSchema,
  default: z.string(),
  unit: z.enum(["usd", "minutes", "count"]).optional(),
  loosens: z.enum(["higher", "lower", "on", "off"]).optional(),
  who: z.enum(["install-operator", "company-admin", "project-admin", "person"]),
  surfaces: z.array(z.enum(["web", "cli-config-set", "config-file", "slack", "stack-parameter"])).min(1),
  reader: z.enum(["broker", "dispatcher", "worker", "gateway", "cloud-server", "web", "cli", "stack"]),
  store: z.enum(["stack-parameter", "ssm-settings", "control-plane-setting"]),
  failClosed: z.boolean(),
  words: z.string(),
  audit: z.boolean(),
  request: z.strictObject({ ref: z.string().min(1), reason: z.string().min(1) }).optional(),
  install: InstallInfoSchema.optional(),
  configKey: ConfigKeyInfoSchema.optional(),
  rollout: z.strictObject({ dueBy: z.string().min(1) }).optional(),
});

/** The one way a row is written: checked against the schema, returned unchanged (its literal type is kept). */
export function defineRow<const R extends SettingRow>(row: R): R {
  const parsed = SettingRowSchema.safeParse(row);
  if (!parsed.success) throw new Error(`setting row ${String((row as { key?: unknown }).key)} is not valid: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  return row;
}

/**
 * Packed codes Code must never use: a code Cloud's own table gives a different meaning (a code means one thing in both repositories), and a code a retired setting used (an older
 * packed value or a rollback may still carry it, so it never means anything else).
 */
export const RESERVED_PACKED_CODES: Readonly<Record<string, string>> = {
  tx: "Cloud's own test services switch (off by default); Code's test services switch is `td`",
  tu: "retired in F1 L1a-1 with the TaskPeoplePublicInvitationsEnabled parameter (nothing read it)",
  tv: "retired in F1 L1a-1 with the TaskPeoplePrivateInvitationsEnabled parameter (nothing read it)",
};

function duplicates<T>(values: readonly T[]): T[] {
  const seen = new Set<T>();
  const repeated = new Set<T>();
  for (const value of values) (seen.has(value) ? repeated : seen).add(value);
  return [...repeated];
}

/** Every stack parameter a row sets: its primary one and the `also` copies. */
export function rowStackParameters(row: SettingRow): Array<{ part: string; parameter: string }> {
  if (row.install?.parameter === undefined) return [];
  return [{ part: row.install.part, parameter: row.install.parameter }, ...(row.install.also ?? [])];
}

/** Cross-row problems, as sentences: a repeated key, stack parameter, packed code or key, or a repeated position in an ordered list. Empty means the rows are consistent. */
export function settingRowProblems(rows: readonly SettingRow[]): string[] {
  const problems: string[] = [];
  const report = (what: string, repeated: readonly unknown[]) => { for (const value of repeated) problems.push(`${what} ${String(value)} is used by more than one row`); };
  report("the key", duplicates(rows.map((row) => row.key)));
  report("the stack parameter", duplicates(rows.flatMap(rowStackParameters).map((each) => `${each.part}.${each.parameter}`)));
  const installs = rows.flatMap((row) => (row.install === undefined ? [] : [row.install]));
  report("the packed code", duplicates(installs.flatMap((install) => (install.packed === undefined ? [] : [install.packed.code]))));
  for (const install of installs) if (install.packed !== undefined && Object.hasOwn(RESERVED_PACKED_CODES, install.packed.code)) problems.push(`the packed code ${install.packed.code} is reserved: ${RESERVED_PACKED_CODES[install.packed.code]}`);
  report("the packed key", duplicates(installs.flatMap((install) => (install.packed === undefined ? [] : [install.packed.key]))));
  report("the packed order", duplicates(installs.flatMap((install) => (install.packed === undefined ? [] : [install.packed.order]))));
  for (const part of ["access", "foundation", "identity", "control-plane", "gateway", "runtime", "slack"]) {
    const positions = rows.flatMap((row) => (row.install !== undefined && row.install.kept !== undefined && rowStackParameters(row).some((each) => each.part === part) ? [row.install.kept] : []));
    report(`the kept-on-upgrade position in ${part},`, duplicates(positions));
  }
  const configKeys = rows.flatMap((row) => (row.configKey === undefined ? [] : [row.configKey]));
  report("the config key", duplicates(configKeys.map((entry) => entry.key)));
  report("the config key position", duplicates(configKeys.map((entry) => entry.order)));
  report("the docs table position", duplicates(configKeys.map((entry) => entry.docs.order)));
  for (const row of rows) {
    if (row.configKey !== undefined && row.configKey.target.kind === "stack-parameter" && row.install === undefined) problems.push(`${row.key} has a stack-parameter config key but no install parameter`);
    if (row.install?.packed !== undefined && row.reader !== "broker") problems.push(`${row.key} is packed into the broker's settings, so its reader is the broker`);
  }
  return problems;
}
