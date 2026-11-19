// The broker's environment, compacted in a named environment (ENV-ROOM; core switch-on blocker, 2026-11-15). packages/contracts/src/broker-environment.ts
// says what is packed, what is derived and why; packages/broker/src/aws/broker-environment.ts puts it back. Since ENV-ROOM 2 (2026-11-17) the packed names are written to one SSM
// String parameter, not the function's environment, and packages/broker/src/aws/broker-handler.ts reads them before the broker loads. Since #1149 the legacy install (production) packs
// its broker's environment the same way, under LEGACY_BROKER_ENV, with a layout marker so it derives only values identical to its own; a role's ARN and a value that would derive
// differently stay whole.
import { createHash } from "node:crypto";
import { Aws, CfnParameter, Fn, Lazy, Stack, Token } from "aws-cdk-lib";
import { aws_ssm as ssm, type aws_lambda as lambda } from "aws-cdk-lib";
import {
  BROKER_ACCOUNT_VARIABLE, BROKER_NAMES, BROKER_NAMES_PARAMETER_VARIABLE, BROKER_NAMES_REVISION_VARIABLE, BROKER_SETTINGS, BROKER_SETTINGS_VARIABLE, BROKER_SETTING_VALUE,
  DERIVED_BROKER_VARIABLES, LEGACY_INSTALL_LAYOUT, brokerNamesParameterName, encodeBrokerNamesParameterPrefix, type BrokerNameKey, type BrokerSettingKey,
} from "@agentx/contracts";
import type { AgentXNaming } from "./naming.js";

/** A literal name: what the broker accepts as a name (broker-environment.ts), so a literal with a separator is refused when it is added. */
const LITERAL_NAME = /^[A-Za-z0-9._-]{1,255}$/u;
/** What must never reach the list joined without escaping: it ends a pair, starts a value, or escapes (the pairs are `code=value,code=value`). */
const SEPARATORS = ['"', "\\", ",", "=", "{", "}", "/", " ", "\n"];

/** True where the pattern has a construct that takes any character (`.`, `\S`, `\W`, `\D`, a negated class), outside a character class where `.` is literal. */
function patternIsOpen(pattern: string): boolean {
  let inClass = false;
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]!;
    if (char === "\\") {
      if ("SWD".includes(pattern[index + 1] ?? "")) return true;
      index++;
    } else if (inClass) {
      if (char === "]") inClass = false;
    } else if (char === "[") {
      inClass = true;
      if (pattern[index + 1] === "^") return true;
    } else if (char === ".") return true;
  }
  return false;
}

/** Whether an AllowedPattern lets a separator through: no open construct, and no probe built from the pattern's own leading literal plus a separator matches. A guard, not a proof. */
function patternAdmitsSeparator(pattern: string): boolean {
  if (patternIsOpen(pattern)) return true;
  let accepts: RegExp;
  try { accepts = new RegExp(pattern, "u"); } catch { return true; }
  const prefix = /^\^?((?:[A-Za-z0-9_:-]|\\\.)*)/u.exec(pattern)?.[1]?.replace(/\\\./gu, ".") ?? "";
  const bases = ["", "a", "0", "T0", "E0", prefix, `${prefix}0`, `${prefix}a`];
  return bases.some((base) => SEPARATORS.some((separator) => [`${base}${separator}`, `${base}${separator}0`, `${base}0${separator}0`, `${base}a${separator}b`].some((probe) => accepts.test(probe))));
}

/**
 * Packing needs a value that cannot carry a separator. A literal is checked at once (by the caller). A token is checked when the variable is built, at synthesis: every Ref to a
 * parameter in it must be a Number, or have AllowedValues without a separator, or an AllowedPattern that admits none. Other tokens (a resource's name or id) are CloudFormation's
 * own generated values.
 */
function refuseUnconstrainedParameters(scope: Stack, what: string, key: string, value: string): void {
  const parameters = new Map<string, CfnParameter>();
  for (const child of scope.node.findAll()) if (child instanceof CfnParameter) parameters.set(String(scope.resolve(child.logicalId)), child);
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const ref = record.Ref;
    const parameter = typeof ref === "string" ? parameters.get(ref) : undefined;
    if (parameter !== undefined) {
      if (parameter.type === "Number") return;
      const unsafe = (reason: string): never => { throw new Error(`${what} ${key} comes from the parameter ${String(ref)}, which ${reason}; it is joined into the broker's variable unescaped, so the parameter needs an AllowedPattern or AllowedValues that keeps out quotes, commas, equals signs, braces, slashes and spaces`); };
      if (parameter.allowedValues !== undefined) {
        if (parameter.allowedValues.some((allowed) => SEPARATORS.some((separator) => allowed.includes(separator)))) unsafe("allows a value with a separator");
      } else if (parameter.allowedPattern === undefined) unsafe("has no AllowedPattern or AllowedValues");
      else if (patternAdmitsSeparator(parameter.allowedPattern)) unsafe(`has an AllowedPattern (${parameter.allowedPattern}) that admits a separator`);
      return;
    }
    Object.values(record).forEach(walk);
  };
  walk(scope.resolve(value));
}

/** One packed variable: pieces added by the constructs that own them, joined in code order at synthesis (after every construct has added its own). */
class PackedList<K extends string> {
  private readonly values = new Map<K, string>();

  constructor(
    private readonly stack: Stack,
    private readonly what: string,
    private readonly codeOf: (key: K) => string,
    private readonly literal: RegExp,
  ) {}

  add(key: K, value: string): void {
    if (this.values.has(key)) throw new Error(`${this.what} ${key} is added twice`);
    if (!Token.isUnresolved(value) && !this.literal.test(value)) throw new Error(`${this.what} ${key} is a literal that is not plain text, and it is joined into the broker's variable unescaped`);
    this.values.set(key, value);
  }

  joined(): string {
    for (const [key, value] of this.values) refuseUnconstrainedParameters(this.stack, this.what, key, value);
    const parts = [...this.values.entries()]
      .sort(([a], [b]) => this.codeOf(a).localeCompare(this.codeOf(b)))
      .flatMap(([key, value], index) => [`${index === 0 ? "" : ","}${this.codeOf(key)}=`, value]);
    // Nothing added: an empty variable (the broker reads an empty list as none). Fn::Join refuses an empty list.
    return parts.length === 0 ? "" : Fn.join("", parts);
  }
}

/**
 * The revision of the broker's names as written: the sha256 of the format and of the list's CloudFormation expression (each code and the resource it names), so a template that
 * packs a name differently, adds one or drops one writes a new revision, and the function, which carries it too, changes with it. It does not see a name's value, which only
 * CloudFormation knows: a resource replaced under the same logical id gets a new generated name under the same revision, and the old name, never reused, fails where it is used.
 */
/** The ARN of a named environment's broker names parameter, which the broker may read (ssm:GetParameters) and nothing more. */
export function brokerNamesParameterArn(env: string): string {
  return `arn:${Aws.PARTITION}:ssm:${Aws.REGION}:${Aws.ACCOUNT_ID}:parameter${brokerNamesParameterName(env)}`;
}

export function brokerNamesRevision(resolvedList: unknown): string {
  return createHash("sha256").update(JSON.stringify({ format: "v1", names: resolvedList })).digest("hex");
}

/**
 * A named environment's broker: AGENTX_SETTINGS and AGENTX_ACCOUNT_ID in the function's environment, and AGENTX_NAMES in its own SSM String parameter (ENV-ROOM 2,
 * packages/contracts/src/broker-environment.ts), with the parameter's name and the revision written in the environment; given to the function once.
 */
class BrokerEnvironment {
  private static readonly byBroker = new WeakMap<lambda.Function, BrokerEnvironment>();
  readonly names: PackedList<BrokerNameKey>;
  readonly settings: PackedList<BrokerSettingKey>;
  private written?: { revision: string; value: string };
  private readonly stack: Stack;
  private readonly legacy: boolean;

  private constructor(broker: lambda.Function, env: string | undefined, legacy: boolean) {
    const stack = Stack.of(broker);
    this.stack = stack;
    this.legacy = legacy;
    this.names = new PackedList<BrokerNameKey>(stack, "the broker's name", (key) => BROKER_NAMES[key].code, LITERAL_NAME);
    this.settings = new PackedList<BrokerSettingKey>(stack, "the broker's setting", (key) => BROKER_SETTINGS[key].code, BROKER_SETTING_VALUE);
    if (env !== undefined) {
      const parameterName = brokerNamesParameterName(env);
      // Standard tier, plain String: names only, no secret (a SecureString would need a key grant and a decrypt on every cold start for nothing).
      const parameter = new ssm.CfnParameter(stack, "BrokerNamesParameter", {
        type: "String",
        tier: "Standard",
        name: parameterName,
        description: "The broker's CloudFormation-generated resource names (AGENTX_NAMES); no secrets. Written by the control plane stack only.",
        value: Lazy.string({ produce: () => this.namesWritten().value }),
      });
      broker.addEnvironment(BROKER_ACCOUNT_VARIABLE, stack.account);
      broker.addEnvironment(BROKER_NAMES_PARAMETER_VARIABLE, parameterName);
      broker.addEnvironment(BROKER_NAMES_REVISION_VARIABLE, Lazy.string({ produce: () => this.namesWritten().revision }));
      // The parameter is written before the function changes, so a running broker keeps its names and a cold start of the old revision refuses (the revisions differ) until
      // the function is updated. Only the function itself depends on it: its role is referenced by resources whose names the parameter holds.
      (broker.node.defaultChild as lambda.CfnFunction).addDependency(parameter);
      // The read grant is this parameter's ARN (brokerNamesParameterArn) in the broker's one ssm:GetParameters statement (control-plane.ts): no path reads, no history, no other parameter.
    }
    // #1149: the legacy install's broker says so, so it derives only the variables identical to its own (contracts LEGACY_INSTALL_LAYOUT).
    if (legacy) this.settings.add("installLayout", LEGACY_INSTALL_LAYOUT);
    broker.addEnvironment(BROKER_SETTINGS_VARIABLE, Lazy.string({ produce: () => this.settings.joined() }));
  }

  /** The list, and its revision, once every construct has added its names (at synthesis). */
  private namesWritten(): { revision: string; value: string } {
    if (this.written === undefined) {
      const joined = this.names.joined();
      const revision = brokerNamesRevision(this.stack.resolve(joined));
      this.written = { revision, value: `${encodeBrokerNamesParameterPrefix(revision)}${joined}` };
    }
    return this.written;
  }

  static of(broker: lambda.Function, env: string | undefined, legacy = false): BrokerEnvironment {
    const existing = BrokerEnvironment.byBroker.get(broker);
    if (existing !== undefined) {
      if (existing.legacy !== legacy) throw new Error("the broker's environment is packed once, as one layout");
      return existing;
    }
    const created = new BrokerEnvironment(broker, env, legacy);
    BrokerEnvironment.byBroker.set(broker, created);
    return created;
  }
}

/** #1149: the name the legacy install's (production's) packed broker environment is under: its names parameter is brokerNamesParameterName of it, and AGENTX_ENV is it. */
export const LEGACY_BROKER_ENV = "production";

/** #1149: the broker's packed environment, a named environment's own or, for the legacy install, under LEGACY_BROKER_ENV with the legacy layout marker. */
function packedBroker(broker: lambda.Function, naming: AgentXNaming): BrokerEnvironment {
  return naming.env === undefined ? BrokerEnvironment.of(broker, LEGACY_BROKER_ENV, true) : BrokerEnvironment.of(broker, naming.env);
}

/** The environment name the broker's packed names are under: a named environment's own, or the legacy install's LEGACY_BROKER_ENV (#1149). */
export function brokerEnvironmentName(naming: AgentXNaming): string {
  return naming.env ?? LEGACY_BROKER_ENV;
}

/**
 * A name the broker reads as `BROKER_NAMES[key].variable`: `bare` (the name or id CloudFormation gives the resource) goes in AGENTX_NAMES and the broker builds the variable's
 * value from it. #1149: the legacy install packs its names too, except a role's ARN, which the broker would build with a named environment's role path (/agentx/<env>/) that the
 * legacy install's roles do not have: that one stays `whole`, as it always was.
 */
export function addBrokerName(broker: lambda.Function, naming: AgentXNaming, key: BrokerNameKey, bare: string, whole: string): void {
  if (naming.env === undefined && BROKER_NAMES[key].kind === "roleArn") broker.addEnvironment(BROKER_NAMES[key].variable, whole);
  else packedBroker(broker, naming).names.add(key, bare);
}

/** The broker's dead-letter queues for the health route: each queue's name in AGENTX_NAMES (the legacy install's too since #1149; the broker rebuilds the same JSON of URLs). */
export function addBrokerDeadLetterQueues(broker: lambda.Function, naming: AgentXNaming, queues: ReadonlyArray<readonly [BrokerNameKey, { queueName: string; queueUrl: string }]>): void {
  for (const [key] of queues) if (BROKER_NAMES[key].kind !== "deadLetterQueue") throw new Error(`the broker's name ${key} is not a dead-letter queue`);
  for (const [key, queue] of queues) packedBroker(broker, naming).names.add(key, queue.queueName);
}

/** A constrained setting the broker reads as `BROKER_SETTINGS[key].variable`, in AGENTX_SETTINGS (the legacy install's too since #1149). */
export function addBrokerSetting(broker: lambda.Function, naming: AgentXNaming, key: BrokerSettingKey, value: string): void {
  packedBroker(broker, naming).settings.add(key, value);
}

/** Add a setting to the packed list on any named Lambda without adding the broker-only name/account variables. */
export function addPackedSetting(fn: lambda.Function, key: BrokerSettingKey, value: string): void {
  BrokerEnvironment.of(fn, undefined).settings.add(key, value);
}

/**
 * A variable the broker derives from the environment's name (DERIVED_BROKER_VARIABLES). Named: nothing is passed, and synthesis stops unless the derivation gives exactly `value`,
 * the value this would have passed (so the code and the infrastructure cannot drift apart). #1149, legacy: nothing is passed only where the entry is marked `legacy` and its
 * derivation for LEGACY_BROKER_ENV is exactly `value`; otherwise the variable whole, as before (the broker derives nothing else for the legacy layout).
 */
export function addDerivedBrokerVariable(broker: lambda.Function, naming: AgentXNaming, variable: string, value: string): void {
  if (naming.env === undefined) {
    const legacyEntry = DERIVED_BROKER_VARIABLES.find((candidate) => candidate.variable === variable);
    if (legacyEntry?.kind === "text" && legacyEntry.legacy === true && !Token.isUnresolved(value) && legacyEntry.value(LEGACY_BROKER_ENV) === value) packedBroker(broker, naming);
    else broker.addEnvironment(variable, value);
    return;
  }
  const entry = DERIVED_BROKER_VARIABLES.find((candidate) => candidate.variable === variable);
  if (entry === undefined || entry.kind !== "text") throw new Error(`${variable} is not a variable the broker derives as text`);
  if (Token.isUnresolved(value) || entry.value(naming.env) !== value) throw new Error(`the broker would derive ${variable} differently from the value the infrastructure has for it`);
  BrokerEnvironment.of(broker, naming.env);
}
