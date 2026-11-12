// The AWS services a test environment may ask Rovara local AWS for: the generated table (`generated/aws-emulator-services.ts`, made by `scripts/aws-emulator/gen-service-table.ts`) and the few rules around it.
//
//   - A SERVICE KEY is one id of that table (`s3`, `secrets-manager`, `cognito-identity-provider`). A plan names its services by key.
//   - A LEGACY KEY is an older spelling of a key (`secretsmanager`, `events`, `cognito-idp`). It is read on input and turned into the key, and never written.
//   - The ENGINE PIN: a catalog entry that carries the engine must carry the table's engine version, or it is refused.
// Browser-safe: nothing here imports a Node module.
import { z } from "zod";
import { AWS_EMULATOR_ENGINE_VERSION, AWS_EMULATOR_SERVICES, AWS_EMULATOR_SHARED_SIGNING_NAMES, type AwsEmulatorServiceRow } from "./generated/aws-emulator-services.js";

/** The most services one plan (one emulated dependency) names. */
export const AWS_PLAN_SERVICES_MAX = 64;

const BY_KEY: ReadonlyMap<string, AwsEmulatorServiceRow> = new Map(AWS_EMULATOR_SERVICES.map((row) => [row.key, row]));
const KEY_OF_LEGACY: ReadonlyMap<string, string> = new Map(AWS_EMULATOR_SERVICES.flatMap((row) => row.legacyKeys.map((alias): [string, string] => [alias, row.key])));

/** The table's row for a key (not a legacy key: use `normaliseAwsServiceKey` first). */
export function awsEmulatorServiceRow(key: string): AwsEmulatorServiceRow | undefined {
  return BY_KEY.get(key);
}

/** The key of a service id: the id itself when it is a key, the key it stands for when it is a legacy key, and undefined for anything else. */
export function normaliseAwsServiceKey(id: string): string | undefined {
  if (BY_KEY.has(id)) return id;
  return KEY_OF_LEGACY.get(id);
}

/** `id` as a key when the table knows it, otherwise as it came: for comparing ids that may not be in the table (an unknown id then equals only itself). */
export function awsServiceKeyOrSelf(id: string): string {
  return normaliseAwsServiceKey(id) ?? id;
}

/** A service id in a plan: a key, or a legacy key that is turned into its key on parse. Anything the table does not know is refused. */
export const AwsPlanServiceSchema = z.string().max(40).transform((value, context) => {
  const key = normaliseAwsServiceKey(value);
  if (key === undefined) {
    context.addIssue({ code: "custom", message: "an AWS service Rovara local AWS serves" });
    return z.NEVER;
  }
  return key;
});

/** The services that use a SigV4 signing name: a request signed for it cannot be told apart by its credential scope alone when there is more than one. Nothing for a name the table does not know. */
export function awsServicesForSigningName(signingName: string): readonly string[] {
  if (Object.hasOwn(AWS_EMULATOR_SHARED_SIGNING_NAMES, signingName)) return AWS_EMULATOR_SHARED_SIGNING_NAMES[signingName] ?? [];
  return AWS_EMULATOR_SERVICES.filter((row) => row.signingName === signingName).map((row) => row.key);
}

/**
 * The key a name stands for in a request ledger or a log: a key or legacy key as `normaliseAwsServiceKey` reads it, else a signing name (`monitoring` for CloudWatch) that only one service uses. A signing name
 * several services share (`apigateway`) names none of them, so it comes back as it was, and so does anything the table does not know.
 */
export function normaliseAwsLedgerName(name: string): string {
  const key = normaliseAwsServiceKey(name);
  if (key !== undefined) return key;
  const bySigning = awsServicesForSigningName(name);
  return bySigning.length === 1 ? bySigning[0]! : name;
}

// ---- the names each SDK uses for a service, read from the table (detection never keeps its own list of them)

/** Where a service name was read: boto3's client name, an `@aws-sdk/client-*` package suffix, the last part of a Java package or a Go module, or CloudFormation's `AWS::<name>::`. */
export type AwsSdkNameKind = "boto3" | "js" | "java" | "go" | "cfn" | "endpointVariable";

const lastPart = (value: string, separator: string): string => value.slice(value.lastIndexOf(separator) + 1);
const SDK_NAME_OF: Readonly<Record<AwsSdkNameKind, (row: AwsEmulatorServiceRow) => string | null>> = {
  boto3: (row) => row.boto3Name,
  js: (row) => row.jsPackage.replace(/^@aws-sdk\/client-/u, ""),
  java: (row) => lastPart(row.javaPackage, "."),
  go: (row) => lastPart(row.goPackage, "/"),
  cfn: (row) => row.cfnName,
  endpointVariable: (row) => row.envKey,
};
const BY_SDK_NAME: Readonly<Record<AwsSdkNameKind, ReadonlyMap<string, string>>> = Object.fromEntries(
  (Object.keys(SDK_NAME_OF) as AwsSdkNameKind[]).map((kind) => {
    const map = new Map<string, string>();
    for (const row of AWS_EMULATOR_SERVICES) {
      const name = SDK_NAME_OF[kind](row);
      if (name === null) continue;
      const before = map.get(name);
      // Two services can share a name (CloudFormation's `SES` is Amazon SES and Mail Manager): the one whose own key (or legacy spelling) is that name wins, else the first of the table (sorted by key).
      const plain = name.toLowerCase().replace(/[-_]/gu, "");
      const own = normaliseAwsServiceKey(name.toLowerCase()) === row.key || row.key.replace(/-/gu, "") === plain;
      if (before === undefined || (own && before !== row.key && BY_KEY.get(before)?.key.replace(/-/gu, "") !== plain)) map.set(name, row.key);
    }
    return [kind, map];
  }),
) as unknown as Record<AwsSdkNameKind, ReadonlyMap<string, string>>;

/** The key of the service an SDK, package or template spells `name` (`secretsmanager` for boto3, `secrets-manager` for the JS package, `SecretsManager` for CloudFormation), or undefined when no service of the table does. */
export function awsServiceKeyFromSdkName(kind: AwsSdkNameKind, name: string): string | undefined {
  return BY_SDK_NAME[kind].get(name);
}

/** CloudFormation names that two services share and that the resource type then tells apart: `AWS::Cognito::IdentityPool` is Cognito identity, every other `AWS::Cognito::` type is user pools. */
const CFN_TYPE_PREFIX_KEYS: ReadonlyArray<readonly [string, string]> = [["AWS::Cognito::IdentityPool", "cognito-identity"], ["AWS::Cognito::", "cognito-identity-provider"]];

/** The key of the service a CloudFormation resource type (`AWS::SQS::Queue`) belongs to, or undefined (an `AWS::Serverless::` type is SAM's and not one service). */
export function awsServiceKeyFromCfnType(type: string): string | undefined {
  const named = CFN_TYPE_PREFIX_KEYS.find(([prefix]) => type.startsWith(prefix));
  if (named !== undefined) return named[1];
  const match = /^AWS::([A-Za-z0-9]{1,40})::[A-Za-z0-9:]{1,100}$/u.exec(type);
  return match === null ? undefined : BY_SDK_NAME.cfn.get(match[1]!);
}

/** The key of the service `AWS_ENDPOINT_URL_<suffix>` is for (`SECRETS_MANAGER`), or undefined. */
export function awsServiceKeyFromEndpointVariable(suffix: string): string | undefined {
  return BY_SDK_NAME.endpointVariable.get(suffix);
}

/** The suffix of the variable that points one service at an address (`AWS_ENDPOINT_URL_<suffix>`), or undefined for a key the table does not know. Legacy spellings are read as their keys. */
export function awsEndpointVariableSuffix(id: string): string | undefined {
  const key = normaliseAwsServiceKey(id);
  return key === undefined ? undefined : BY_KEY.get(key)?.envKey;
}

// ---- evidence: what the emulator is, and how far it matches AWS

/** The percentage a fidelity score reads as, or undefined when the service has no scored behavioural unit of its own (`behavioralOwnScore`: units that name this service alone, so another service's gap does not lower it). */
export function awsFidelityPercent(service: string): number | undefined {
  const key = normaliseAwsServiceKey(service);
  const score = key === undefined ? undefined : BY_KEY.get(key)?.behavioralOwnScore;
  return score === null || score === undefined ? undefined : Math.round(score * 100);
}

/**
 * The evidence line of one planned service: what emulated it and how far that matches AWS (`<key>: Emulated by AWS Emulator 1.0.322, AWS fidelity score 83%`, or `AWS fidelity score: not scored`). Undefined for an id the
 * table does not know. Fixed words and table values only: nothing the repository wrote.
 */
export function awsEmulatorEvidenceLine(service: string): string | undefined {
  const key = normaliseAwsServiceKey(service);
  if (key === undefined) return undefined;
  const percent = awsFidelityPercent(key);
  return `${key}: Emulated by AWS Emulator ${AWS_EMULATOR_ENGINE_VERSION}, ${percent === undefined ? "AWS fidelity score: not scored" : `AWS fidelity score ${String(percent)}%`}`;
}

/**
 * The evidence of a run's AWS usage per service: for each planned service its fidelity line, and for each service the run called operations of that the emulator does not support, one more line naming them (the
 * operation names a usage record keeps already passed `AwsOperationNameSchema`). Pure; the broker's `dependencyEvidenceOf` puts the lines in the pack, and a caller on the other side can call the same function.
 */
export function awsEmulatorEvidenceLines(plannedServices: readonly string[], unsupportedOperations: ReadonlyArray<{ service: string; operation: string; count: number }> = []): string[] {
  const planned = [...new Set(plannedServices.flatMap((service) => { const key = normaliseAwsServiceKey(service); return key === undefined ? [] : [key]; }))];
  const lines = planned.flatMap((service) => { const line = awsEmulatorEvidenceLine(service); return line === undefined ? [] : [line]; });
  const byService = new Map<string, string[]>();
  for (const row of unsupportedOperations) {
    const key = awsServiceKeyOrSelf(row.service);
    byService.set(key, [...(byService.get(key) ?? []), `${row.operation} (${String(row.count)})`]);
  }
  for (const [service, operations] of byService) lines.push(`${service}: operations AWS Emulator does not support, called by the tests: ${operations.slice(0, 8).join(", ")}${operations.length > 8 ? `, and ${String(operations.length - 8)} more` : ""}`);
  return lines;
}

export type EmulatorEngineCheck =
  | { ok: true }
  | { ok: false; reason: "engine_not_pinned" | "engine_mismatch"; expected: string; actual?: string };

/**
 * Whether a catalog entry runs the engine the table was made from. An entry that is not the emulated one has no engine and passes. An emulated entry must carry `emulator.engineVersion`, and it must equal
 * the table's: a missing or different version is a refusal (the table's operations and scores would describe another engine). With `pinned: "optional"` a missing version passes (the field is optional in the catalog
 * for now, so a catalog made before it still parses and starts), and a different one is still refused.
 */
export function checkEmulatorEngine(entry: { backing: string; emulator?: { engineVersion?: string | undefined } | undefined }, options: { pinned?: "required" | "optional" } = {}): EmulatorEngineCheck {
  if (entry.backing !== "emulated") return { ok: true };
  const actual = entry.emulator?.engineVersion;
  // `optional`: what the broker and the worker use while the catalog may still be one made before the pin (an entry with no version passes, one with a different version does not).
  if (actual === undefined) return options.pinned === "optional" ? { ok: true } : { ok: false, reason: "engine_not_pinned", expected: AWS_EMULATOR_ENGINE_VERSION };
  if (actual !== AWS_EMULATOR_ENGINE_VERSION) return { ok: false, reason: "engine_mismatch", expected: AWS_EMULATOR_ENGINE_VERSION, actual };
  return { ok: true };
}
