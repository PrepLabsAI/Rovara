/**
 * F1 lane L1a-0: the two builders of an install row. They fill what every install row shares (the level, who may change it, the store, the surface, the reader) so a rows file
 * states only what differs, and they keep the literal types of `packed` (the broker's setting key, code and variable) so BROKER_SETTINGS can be typed from the rows.
 */
import { defineRow } from "./row.js";
import type { ConfigKeyInfo, InstallInfo, SettingRollout, SettingRow, SettingStoreId, SettingSurface, SettingType } from "./types.js";

type InstallFields = Omit<InstallInfo, "parameter"> & { readonly parameter?: string };

/** A row for a stack parameter (and/or a literal the stack writes) of an environment's stacks. */
export interface InstallRowInput extends InstallFields {
  /** Defaults to the config key when the row has a dotted one, else `install.<part>.<parameter>`. */
  readonly key?: string;
  readonly type: SettingType;
  /** The value when nothing is set, or the word REQUIRED. */
  readonly default: string;
  readonly words: string;
  readonly unit?: "usd" | "minutes" | "count";
  readonly loosens?: "higher" | "lower" | "on" | "off";
  readonly failClosed?: boolean;
  readonly rollout?: SettingRollout;
  readonly configKey?: ConfigKeyInfo;
}

/** The part of the built row that keeps the input's literal `packed` (or `undefined` when the row has none). */
type PackedOf<I> = I extends { readonly packed: infer P } ? P : undefined;
export type InstallRowOf<I extends InstallRowInput> = SettingRow & { readonly install: InstallInfo & { readonly packed: PackedOf<I> } };

function storeOf(input: InstallRowInput): SettingStoreId {
  const target = input.configKey?.target;
  if (target === undefined || input.parameter !== undefined) return "stack-parameter";
  return target.kind === "settings" ? "ssm-settings" : "control-plane-setting";
}

function surfacesOf(input: InstallRowInput): SettingSurface[] {
  return input.configKey === undefined ? ["stack-parameter"] : ["cli-config-set", "stack-parameter"];
}

export function installRow<const I extends InstallRowInput>(input: I): InstallRowOf<I> {
  const { key, type, default: defaultValue, words, unit, loosens, failClosed, rollout, configKey, ...install } = input;
  const built: SettingRow = {
    key: key ?? (configKey?.key.includes(".") === true ? configKey.key : `install.${input.part}.${String(input.parameter)}`),
    levels: [{ level: "install", owner: "code" }],
    type,
    default: defaultValue,
    ...(unit === undefined ? {} : { unit }),
    ...(loosens === undefined ? {} : { loosens }),
    who: "install-operator",
    surfaces: surfacesOf(input),
    reader: input.packed === undefined ? "stack" : "broker",
    store: storeOf(input),
    failClosed: failClosed ?? false,
    words,
    audit: configKey !== undefined,
    install: { ...install, ...(input.parameter === undefined ? {} : { parameter: input.parameter }) } as InstallInfo,
    ...(configKey === undefined ? {} : { configKey }),
    ...(rollout === undefined ? {} : { rollout }),
  };
  return defineRow(built) as InstallRowOf<I>;
}

/** A config key that has no stack parameter of its own: the alert address (SSM settings) and Sign in with ChatGPT's two control-plane settings. */
export interface ConfigRowInput {
  readonly type: SettingType;
  readonly default: string;
  readonly words: string;
  readonly reader: "cli" | "broker";
  readonly configKey: ConfigKeyInfo;
}

export function configRow(input: ConfigRowInput): SettingRow {
  const { configKey } = input;
  return defineRow({
    key: configKey.key,
    levels: [{ level: "install", owner: "code" }],
    type: input.type,
    default: input.default,
    who: "install-operator",
    surfaces: ["cli-config-set"],
    reader: input.reader,
    store: configKey.target.kind === "settings" ? "ssm-settings" : "control-plane-setting",
    failClosed: false,
    words: input.words,
    audit: true,
    configKey,
  });
}
