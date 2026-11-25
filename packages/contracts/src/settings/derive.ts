/**
 * F1 lane L1a-0 / L1b: the hand-kept lists, derived from the rows. Pure functions of a row list (no CDK, no node), so the CLI, the infrastructure, the broker and the tests all
 * read the same rows:
 *  - OPERATOR_PARAMETERS (the parameters an upgrade keeps at their deployed value, per stack part),
 *  - NAMED_ENVIRONMENT_ONLY_PARAMETERS (the legacy-stack refusal list, from `declaredIn`),
 *  - BROKER_SETTINGS (the broker's packed settings: codes AND order, typed by key),
 *  - the `agentx config` key specs, and the docs table of them.
 * Each equals the literal it replaced, except where L1a-1 deliberately corrected it: tests/contract/settings-install-golden.test.ts and settings-config-golden.test.ts hold them to
 * copies of the old literals and state every difference.
 */
import type { StackPart } from "../environments.js";
import { STACK_PARTS } from "../environments.js";
import type { ConfigKeyInfo, ConfigTargetSpec, PackedSetting, SettingRow, SettingType } from "./types.js";

function byPosition<T>(entries: ReadonlyArray<{ position: number; value: T }>): T[] {
  return [...entries].sort((a, b) => a.position - b.position).map((entry) => entry.value);
}

/** The kept parameters of one stack, with their list positions: a row's position applies to its own stack and to every stack its value is copied to. */
function keptOnPart(rows: readonly SettingRow[], part: StackPart): Array<{ position: number; value: string }> {
  return rows.flatMap((row) => {
    const install = row.install;
    if (install?.kept === undefined || install.parameter === undefined) return [];
    const onThisPart = [{ part: install.part, parameter: install.parameter }, ...(install.also ?? [])].filter((each) => each.part === part);
    return onThisPart.map((each) => ({ position: install.kept!, value: each.parameter }));
  });
}

/** Per stack part, the parameters an upgrade keeps, in their list order. */
export function operatorParametersFromRows(rows: readonly SettingRow[]): Record<StackPart, string[]> {
  return Object.fromEntries(STACK_PARTS.map((part) => [part, byPosition(keptOnPart(rows, part))])) as Record<StackPart, string[]>;
}

/** The stack parts the legacy deployment has: it predates the access and identity stacks, so a parameter of those two can never be missing from a legacy stack. */
const LEGACY_STACK_PARTS: readonly StackPart[] = ["foundation", "runtime", "control-plane", "slack"];

/**
 * The parameters only named environments declare, for the legacy-stack refusal in parameter-update.ts: a `config set` of one of these on a legacy stack says the setting exists only in
 * environments installed with agentx init. DERIVED from `declaredIn` (L1a-1; the hand-kept list it replaces named 18 parameters every legacy template also declares, so the refusal
 * never fired for them, and omitted the ones that really are named-only). In row order, each name once.
 */
export function namedEnvironmentOnlyFromRows(rows: readonly SettingRow[]): string[] {
  // The refusal is by name, so a name some other legacy-capable stack's row says the legacy layout declares (PublicApiUrl: the legacy control plane has it, the legacy foundation does not) is not named-only.
  const declaredByLegacy = new Set(rows.flatMap((row) => (row.install?.parameter !== undefined && (row.install.declaredIn === "both" || row.install.declaredIn === "legacy") && LEGACY_STACK_PARTS.includes(row.install.part) ? [row.install.parameter] : [])));
  const names: string[] = [];
  for (const row of rows) {
    const install = row.install;
    if (install?.declaredIn !== "named" || install.parameter === undefined || !LEGACY_STACK_PARTS.includes(install.part) || declaredByLegacy.has(install.parameter)) continue;
    if (!names.includes(install.parameter)) names.push(install.parameter);
  }
  return names;
}

/** What a broker setting is, as broker-environment.ts reads it (the typed spec carries the literal code and variable). */
export type BrokerSettingFor<P extends PackedSetting> = { readonly code: P["code"]; readonly variable: P["variable"] }
  & (P extends { readonly httpsOrigin: true } ? { readonly httpsOrigin: true } : unknown)
  & (P extends { readonly switchFlag: true } ? { readonly switchFlag: true } : unknown);

type PackedOfRow<R> = R extends { readonly install: { readonly packed: infer P extends PackedSetting } } ? P : never;
export type BrokerSettingsOf<Rows extends readonly SettingRow[]> = { readonly [P in PackedOfRow<Rows[number]> as P["key"]]: BrokerSettingFor<P> };

/** The broker's packed settings by key, in `packed.order`, with only the fields the spec has (a spec with no `httpsOrigin` has no such key). */
export function brokerSettingsFromRows<const Rows extends readonly SettingRow[]>(rows: Rows): BrokerSettingsOf<Rows> {
  const packed = rows.flatMap((row) => (row.install?.packed === undefined ? [] : [row.install.packed]));
  const entries = [...packed].sort((a, b) => a.order - b.order).map((each) => [each.key, {
    code: each.code,
    variable: each.variable,
    ...(each.httpsOrigin === undefined ? {} : { httpsOrigin: each.httpsOrigin }),
    ...(each.switchFlag === undefined ? {} : { switchFlag: each.switchFlag }),
  }] as const);
  return Object.fromEntries(entries) as unknown as BrokerSettingsOf<Rows>;
}

/** A config key's target with the row's own stack parameter filled in: the shape `agentx config` uses (ConfigTarget in packages/cli/src/config/keys.ts). */
export type ResolvedConfigTarget =
  | { kind: "stack-parameter"; part: StackPart; parameter: string; also?: ReadonlyArray<{ part: StackPart; parameter: string }> }
  | { kind: "settings"; field: "alertAddress" }
  | { kind: "control-plane-setting"; field: "perPerson" | "perOrganization"; installDefault: { part: StackPart; parameter: string } }
  | { kind: "chatgpt-setting"; field: "enabled" | "preferredModel" };

export interface ConfigKeySpec extends Omit<ConfigKeyInfo, "target" | "order"> { target: ResolvedConfigTarget }

function resolveTarget(row: SettingRow, target: ConfigTargetSpec): ResolvedConfigTarget {
  if (target.kind === "settings" || target.kind === "chatgpt-setting") return target;
  const install = row.install;
  if (install?.parameter === undefined) throw new Error(`config key ${row.configKey?.key ?? row.key} names a stack parameter its row does not have`);
  if (target.kind === "control-plane-setting") return { kind: "control-plane-setting", field: target.field, installDefault: { part: install.part, parameter: install.parameter } };
  return { kind: "stack-parameter", part: install.part, parameter: install.parameter, ...(install.also === undefined ? {} : { also: install.also.map((each) => ({ part: each.part, parameter: each.parameter })) }) };
}

/** Every `agentx config` key, in `config list` order. */
export function configKeySpecsFromRows(rows: readonly SettingRow[]): ConfigKeySpec[] {
  const entries: Array<{ position: number; value: ConfigKeySpec }> = [];
  for (const row of rows) {
    if (row.configKey === undefined) continue;
    const { order, target, ...rest } = row.configKey;
    entries.push({ position: order, value: { ...rest, target: resolveTarget(row, target) } });
  }
  return byPosition(entries);
}

/** docs/day-two.md's table of the config keys, one line each, as the guide prints it. */
export function configDocsTable(rows: readonly SettingRow[]): string[] {
  const lines = ["| Key | Where it lives | Default | Notes |", "|---|---|---|---|"];
  for (const spec of [...configKeySpecsFromRows(rows)].sort((a, b) => a.docs.order - b.docs.order)) lines.push(`| \`${spec.key}\` | ${spec.docs.where} | ${spec.docs.default} | ${spec.docs.notes} |`);
  return lines;
}

/**
 * The setting type a CloudFormation parameter's declaration implies (Number with Min/MaxValue is an int; AllowedValues a choice; anything else text with its length and pattern).
 * The synth test holds each install row's type to this, so the rows cannot drift from the template.
 */
export function settingTypeOfTemplateParameter(definition: { Type?: string; AllowedValues?: readonly unknown[]; MinValue?: number; MaxValue?: number; MaxLength?: number; AllowedPattern?: string } | undefined): SettingType {
  if (definition === undefined) return { kind: "text" };
  if (definition.Type === "Number") {
    return { kind: "int", ...(definition.MinValue === undefined ? {} : { min: definition.MinValue }), ...(definition.MaxValue === undefined ? {} : { max: definition.MaxValue }) };
  }
  if (definition.AllowedValues !== undefined) return { kind: "choice", values: definition.AllowedValues.map(String) };
  return { kind: "text", ...(definition.MaxLength === undefined ? {} : { max: definition.MaxLength }), ...(definition.AllowedPattern === undefined ? {} : { pattern: definition.AllowedPattern }) };
}
