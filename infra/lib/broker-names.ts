// The broker's environment, compacted in a named environment (ENV-ROOM; core switch-on blocker, 2026-11-15). packages/contracts/src/broker-environment.ts
// says what is packed, what is derived and why; packages/broker/src/aws/broker-environment.ts puts it back. The legacy install passes every variable whole, as before: its
// template does not change.
import { CfnParameter, Fn, Lazy, Stack, Token } from "aws-cdk-lib";
import type { aws_lambda as lambda } from "aws-cdk-lib";
import {
  BROKER_ACCOUNT_VARIABLE, BROKER_NAMES, BROKER_NAMES_VARIABLE, BROKER_SETTINGS, BROKER_SETTINGS_VARIABLE, BROKER_SETTING_VALUE, DERIVED_BROKER_VARIABLES,
  type BrokerNameKey, type BrokerSettingKey,
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

/** A named environment's broker: AGENTX_NAMES, AGENTX_SETTINGS and AGENTX_ACCOUNT_ID, given to the function once. */
class BrokerEnvironment {
  private static readonly byBroker = new WeakMap<lambda.Function, BrokerEnvironment>();
  readonly names: PackedList<BrokerNameKey>;
  readonly settings: PackedList<BrokerSettingKey>;

  private constructor(broker: lambda.Function) {
    const stack = Stack.of(broker);
    this.names = new PackedList<BrokerNameKey>(stack, "the broker's name", (key) => BROKER_NAMES[key].code, LITERAL_NAME);
    this.settings = new PackedList<BrokerSettingKey>(stack, "the broker's setting", (key) => BROKER_SETTINGS[key].code, BROKER_SETTING_VALUE);
    broker.addEnvironment(BROKER_ACCOUNT_VARIABLE, stack.account);
    broker.addEnvironment(BROKER_NAMES_VARIABLE, Lazy.string({ produce: () => this.names.joined() }));
    broker.addEnvironment(BROKER_SETTINGS_VARIABLE, Lazy.string({ produce: () => this.settings.joined() }));
  }

  static of(broker: lambda.Function): BrokerEnvironment {
    const existing = BrokerEnvironment.byBroker.get(broker);
    if (existing !== undefined) return existing;
    const created = new BrokerEnvironment(broker);
    BrokerEnvironment.byBroker.set(broker, created);
    return created;
  }
}

/**
 * A name the broker reads as `BROKER_NAMES[key].variable`. Named environment: `bare` (the name or id CloudFormation gives the resource) goes in AGENTX_NAMES and the broker builds
 * the variable's value from it. Legacy: the variable is `whole`, as it always was.
 */
export function addBrokerName(broker: lambda.Function, naming: AgentXNaming, key: BrokerNameKey, bare: string, whole: string): void {
  if (naming.env === undefined) broker.addEnvironment(BROKER_NAMES[key].variable, whole);
  else BrokerEnvironment.of(broker).names.add(key, bare);
}

/** The broker's dead-letter queues for the health route: named, each queue's name in AGENTX_NAMES; legacy, the one JSON variable of URLs, as before. */
export function addBrokerDeadLetterQueues(broker: lambda.Function, naming: AgentXNaming, queues: ReadonlyArray<readonly [BrokerNameKey, { queueName: string; queueUrl: string }]>, legacyJson: () => string): void {
  for (const [key] of queues) if (BROKER_NAMES[key].kind !== "deadLetterQueue") throw new Error(`the broker's name ${key} is not a dead-letter queue`);
  if (naming.env === undefined) broker.addEnvironment("HEALTH_DEAD_LETTER_QUEUES", legacyJson());
  else for (const [key, queue] of queues) BrokerEnvironment.of(broker).names.add(key, queue.queueName);
}

/** A constrained setting the broker reads as `BROKER_SETTINGS[key].variable`: named, in AGENTX_SETTINGS; legacy, the variable whole. */
export function addBrokerSetting(broker: lambda.Function, naming: AgentXNaming, key: BrokerSettingKey, value: string): void {
  if (naming.env === undefined) broker.addEnvironment(BROKER_SETTINGS[key].variable, value);
  else BrokerEnvironment.of(broker).settings.add(key, value);
}

/**
 * A variable the broker derives from the environment's name (DERIVED_BROKER_VARIABLES). Named: nothing is passed, and synthesis stops unless the derivation gives exactly `value`,
 * the value this would have passed (so the code and the infrastructure cannot drift apart). Legacy: the variable whole.
 */
export function addDerivedBrokerVariable(broker: lambda.Function, naming: AgentXNaming, variable: string, value: string): void {
  if (naming.env === undefined) { broker.addEnvironment(variable, value); return; }
  const entry = DERIVED_BROKER_VARIABLES.find((candidate) => candidate.variable === variable);
  if (entry === undefined || entry.kind !== "text") throw new Error(`${variable} is not a variable the broker derives as text`);
  if (Token.isUnresolved(value) || entry.value(naming.env) !== value) throw new Error(`the broker would derive ${variable} differently from the value the infrastructure has for it`);
  BrokerEnvironment.of(broker);
}
