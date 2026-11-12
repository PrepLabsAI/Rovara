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

/** The services that use a SigV4 signing name: a request signed for it cannot be told apart by its credential scope alone when there is more than one. */
export function awsServicesForSigningName(signingName: string): readonly string[] {
  return AWS_EMULATOR_SHARED_SIGNING_NAMES[signingName] ?? AWS_EMULATOR_SERVICES.filter((row) => row.signingName === signingName).map((row) => row.key);
}

export type EmulatorEngineCheck =
  | { ok: true }
  | { ok: false; reason: "engine_not_pinned" | "engine_mismatch"; expected: string; actual?: string };

/**
 * Whether a catalog entry runs the engine the table was made from. An entry that is not the emulated one has no engine and passes. An emulated entry must carry `emulator.engineVersion`, and it must equal
 * the table's: a missing or different version is a refusal (the table's operations and scores would describe another engine).
 */
export function checkEmulatorEngine(entry: { backing: string; emulator?: { engineVersion?: string | undefined } | undefined }): EmulatorEngineCheck {
  if (entry.backing !== "emulated") return { ok: true };
  const actual = entry.emulator?.engineVersion;
  if (actual === undefined) return { ok: false, reason: "engine_not_pinned", expected: AWS_EMULATOR_ENGINE_VERSION };
  if (actual !== AWS_EMULATOR_ENGINE_VERSION) return { ok: false, reason: "engine_mismatch", expected: AWS_EMULATOR_ENGINE_VERSION, actual };
  return { ok: true };
}
