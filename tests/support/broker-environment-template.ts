// ENV-ROOM: a named environment's broker is given its generated names packed (AGENTX_NAMES), its constrained settings packed (AGENTX_SETTINGS) and nothing it derives from the
// environment's name (packages/contracts/src/broker-environment.ts). For template tests that ask "what does the broker get for X", this unpacks a synthesized broker's Variables
// into one entry per variable the broker's code reads:
//  - a packed name: the BARE intrinsic the control plane packs (a queue's QueueName, a key's Ref (its id), a role's Ref (its name), a function's Ref, a state machine's Name),
//    not the URL or ARN the broker builds from it (tests/contract/broker-environment.test.ts proves the built values);
//  - HEALTH_DEAD_LETTER_QUEUES: `{ label: the queue's QueueName intrinsic }`;
//  - a packed setting: its parameter's Ref;
//  - a derived variable: the literal the broker derives from AGENTX_ENV (a core dispatch queue's URL as its fixed queue name).
// A legacy broker (nothing packed) is returned as it is.
import { BROKER_NAMES, BROKER_NAMES_VARIABLE, BROKER_SETTINGS, BROKER_SETTINGS_VARIABLE, DERIVED_BROKER_VARIABLES, type BrokerNameSpec, type BrokerSettingSpec } from "@agentx/contracts";

function pieces(raw: unknown): Map<string, unknown> {
  const join = (raw as { "Fn::Join"?: [string, unknown[]] } | undefined)?.["Fn::Join"];
  const found = new Map<string, unknown>();
  if (join === undefined) return found;
  for (let index = 0; index < join[1].length; index += 2) {
    const code = /^,?([a-z]{2})=$/u.exec(String(join[1][index]))?.[1];
    if (code === undefined) throw new Error(`unexpected packed piece ${JSON.stringify(join[1][index])}`);
    found.set(code, join[1][index + 1]);
  }
  return found;
}

export function unpackedBrokerVariables(variables: Record<string, unknown>): Record<string, unknown> {
  if (!(BROKER_NAMES_VARIABLE in variables) && !(BROKER_SETTINGS_VARIABLE in variables)) return variables;
  const { [BROKER_NAMES_VARIABLE]: names, [BROKER_SETTINGS_VARIABLE]: settings, ...rest } = variables;
  const out: Record<string, unknown> = { ...rest };
  const nameSpecs = new Map((Object.values(BROKER_NAMES) as BrokerNameSpec[]).map((spec) => [spec.code, spec]));
  const settingSpecs = new Map((Object.values(BROKER_SETTINGS) as BrokerSettingSpec[]).map((spec) => [spec.code, spec]));
  const deadLetters: Record<string, unknown> = {};
  for (const [code, value] of pieces(names)) {
    const spec = nameSpecs.get(code);
    if (spec === undefined) throw new Error(`unknown name code ${code}`);
    if (spec.kind === "deadLetterQueue") deadLetters[spec.label!] = value;
    else out[spec.variable] = value;
  }
  if (Object.keys(deadLetters).length > 0) out.HEALTH_DEAD_LETTER_QUEUES = deadLetters;
  for (const [code, value] of pieces(settings)) {
    const spec = settingSpecs.get(code);
    if (spec === undefined) throw new Error(`unknown setting code ${code}`);
    out[spec.variable] = value;
  }
  const env = rest.AGENTX_ENV;
  if (typeof env === "string") for (const entry of DERIVED_BROKER_VARIABLES) out[entry.variable] = entry.kind === "text" ? entry.value(env) : entry.queueName(env);
  return out;
}

/** Takes the pieces with these codes out of a packed variable's Fn::Join (in place), for digest and snapshot tests that remove one feature's additions. */
export function removePackedPieces(variables: Record<string, unknown>, variable: string, codes: readonly string[]): void {
  const join = (variables[variable] as { "Fn::Join"?: [string, unknown[]] } | undefined)?.["Fn::Join"];
  if (join === undefined) throw new Error(`${variable} is not packed`);
  const parts = join[1];
  const kept: unknown[] = [];
  for (let index = 0; index < parts.length; index += 2) {
    const code = /^,?([a-z]{2})=$/u.exec(String(parts[index]))![1]!;
    if (!codes.includes(code)) kept.push(`${kept.length === 0 ? "" : ","}${code}=`, parts[index + 1]);
  }
  if (kept.length === 0) delete variables[variable];
  else join[1] = kept;
}
