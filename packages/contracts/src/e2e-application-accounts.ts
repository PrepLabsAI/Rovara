import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import { copyBoundedE2EJsonData } from "./e2e-safe-data.js";
import { E2EAppRecipeSchema, E2ETargetSchema, type E2ETarget } from "./e2e.js";
import { E2ERuntimeAccountRefSchema, type E2ERuntimeAccountRef } from "./e2e-application.js";
import { E2EApplicationExternalConnectionRefSchema } from "./e2e-application-services.js";
import { E2EApplicationServiceContractSchema } from "./e2e-application-services.js";
import { verifyE2ESourceSnapshot, type E2ESourceSnapshot } from "./e2e-source.js";

const sha = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const boundedId = (max = 120) => z.string().trim().min(1).max(max);
const profileSchema = z.object({ profileId: boundedId(), scope: z.enum(["synthetic-test", "external-test"]), authProfileId: boundedId(),
  seedProfileId: boundedId(), tenantRef: boundedId(200), roleRef: boundedId(200), identityProbeId: boundedId() }).strict();
export const E2EApplicationProjectContractSchema = z.object({
  schemaVersion: z.literal("e2e-application-project/v1"), recipe: E2EAppRecipeSchema,
  service: E2EApplicationServiceContractSchema.nullable(),
  accountProfiles: z.array(profileSchema).min(1).max(32), targetAccounts: z.array(z.object({ baseTargetId: boundedId(80), profileId: boundedId() }).strict()).max(12),
}).strict().superRefine((value, context) => {
  const profiles = new Map(value.accountProfiles.map((item) => [item.profileId, item]));
  if (profiles.size !== value.accountProfiles.length) context.addIssue({ code: "custom", path: ["accountProfiles"], message: "application account profiles must be unique" });
  if (new Set(value.targetAccounts.map((item) => `${item.baseTargetId}\0${item.profileId}`)).size !== value.targetAccounts.length) context.addIssue({ code: "custom", path: ["targetAccounts"], message: "application account target variants must be unique" });
  if (value.targetAccounts.some((item) => !profiles.has(item.profileId))) context.addIssue({ code: "custom", path: ["targetAccounts"], message: "target account variant references an undeclared profile" });
  if (new Set(value.recipe.accountProfileIds).size !== value.recipe.accountProfileIds.length
    || value.accountProfiles.some((item) => !value.recipe.accountProfileIds.includes(item.profileId))
    || value.recipe.accountProfileIds.some((profileId) => !profiles.has(profileId))) context.addIssue({ code: "custom", path: ["recipe", "accountProfileIds"], message: "recipe and account profile inventory must match exactly" });
  if (value.accountProfiles.some((item) => item.seedProfileId !== value.recipe.seedProfileId)) context.addIssue({ code: "custom", path: ["accountProfiles"], message: "account seed profiles must match the recipe's approved seed profile" });
  if (value.service === null && value.recipe.launch.kind === "service") context.addIssue({ code: "custom", path: ["service"], message: "service recipe requires a source service contract" });
  if (value.service !== null && value.recipe.launch.kind !== "service") context.addIssue({ code: "custom", path: ["service"], message: "source service contract requires a service launch recipe" });
  const origins = value.service?.originBindings ?? [];
  if (new Set(origins.map((item) => item.originRef)).size !== origins.length || new Set(origins.map((item) => item.envName)).size !== origins.length) context.addIssue({ code: "custom", path: ["service", "originBindings"], message: "origin bindings must be unique" });
  if (origins.some((item) => !value.recipe.allowedOrigins.includes(item.originRef))) context.addIssue({ code: "custom", path: ["service", "originBindings"], message: "source service origin is not allowed by its recipe" });
  if (value.service && value.recipe.launch.kind === "service" && origins.length === 0) context.addIssue({ code: "custom", path: ["service", "originBindings"], message: "web/API service recipe requires at least one logical origin" });
});
export type E2EApplicationProjectContract = z.infer<typeof E2EApplicationProjectContractSchema>;

function nativeApplicationRoot(path: string): string | undefined {
  const android = /^(.*?)(?:\/src\/main)\/AndroidManifest\.xml$/i.exec(path);
  if (android) return android[1] || ".";
  const apple = /^(.*?)(?:\/[^/]+\.xcodeproj)\/project\.pbxproj$/i.exec(path);
  return apple ? apple[1] || "." : undefined;
}
function nativeProjectContract(snapshot: E2ESourceSnapshot, path: string): E2EApplicationProjectContract {
  const source = snapshot.sources.find((item) => item.path === path && item.kind === "blob");
  if (!source || source.bytes.byteLength > 262_144) throw new Error("native application sidecar is missing or exceeds its source byte limit");
  let raw: unknown;
  try { raw = copyBoundedE2EJsonData(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(source.bytes)), { maxBytes: 262_144, maxDepth: 32 }); }
  catch { throw new Error("native application sidecar is not bounded valid UTF-8 JSON"); }
  const contract = E2EApplicationProjectContractSchema.parse(raw);
  const { recipeDigest, ...body } = contract.recipe;
  if (sha(body) !== recipeDigest) throw new Error("native application source recipe digest does not match its canonical fields");
  return contract;
}

export function readE2EApplicationProjectContract(snapshot: E2ESourceSnapshot, applicationId: string): E2EApplicationProjectContract | null {
  verifyE2ESourceSnapshot(snapshot, snapshot.candidate);
  const packages = snapshot.sources.filter((source) => source.kind === "blob" && source.path.endsWith("package.json"));
  const declaredNames = new Map<string, number>();
  for (const source of packages) {
    try {
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(source.bytes)) as { name?: unknown };
      if (typeof value.name === "string" && /^[a-zA-Z0-9_.@/-]{1,120}$/.test(value.name)) declaredNames.set(value.name, (declaredNames.get(value.name) ?? 0) + 1);
    } catch { /* Invalid package manifests are handled as source-cited malformed inputs by discovery. */ }
  }
  const matched = packages.filter((source) => {
    try {
      const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(source.bytes)) as { name?: unknown };
      if (typeof parsed.name !== "string") return false;
      const directory = source.path.includes("/") ? source.path.slice(0, source.path.lastIndexOf("/")) : ".";
      const resolvedId = (declaredNames.get(parsed.name) ?? 0) > 1
        ? `${parsed.name.slice(0, 106)}-${createHash("sha256").update(directory).digest("hex").slice(0, 12)}`
        : parsed.name;
      return resolvedId === applicationId;
    } catch { return false; }
  });
  if (matched.length === 0) {
    const roots = new Set(snapshot.sources.map((source) => nativeApplicationRoot(source.path)).filter((root): root is string => root !== undefined));
    const owned = [...roots].filter((root) => applicationId === `native-${createHash("sha256").update(root).digest("hex").slice(0, 12)}`);
    if (owned.length > 1) throw new Error("native application identity is ambiguous across owning project roots");
    if (owned.length === 1) {
      const root = owned[0]!;
      const sidecarPath = root === "." ? ".agentx/e2e-application.json" : `${root}/.agentx/e2e-application.json`;
      const sidecars = snapshot.sources.filter((source) => source.path === sidecarPath);
      if (sidecars.length === 0) return null;
      if (sidecars.length !== 1) throw new Error("native application sidecar is ambiguous within its owning project root");
      return nativeProjectContract(snapshot, sidecarPath);
    }
    if (packages.length > 0) throw new Error("application identity does not match any owning source package manifest");
    return null;
  }
  if (matched.length !== 1) throw new Error("application project metadata is ambiguous across source package manifests");
  const source = matched[0]!;
  const packageRoot = source.path.includes("/") ? source.path.slice(0, source.path.lastIndexOf("/")) : ".";
  const nativeSidecar = packageRoot === "." ? ".agentx/e2e-application.json" : `${packageRoot}/.agentx/e2e-application.json`;
  if (snapshot.sources.some((item) => item.path === nativeSidecar)) throw new Error("same application cannot have both package and native project contract authorities");
  if (source.bytes.byteLength > 262_144) throw new Error("application package metadata exceeds its source byte limit");
  const raw = copyBoundedE2EJsonData(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(source.bytes)), { maxBytes: 262_144, maxDepth: 32 }) as Record<string, unknown>;
  const e2eRoot = (raw.agentx && typeof raw.agentx === "object" && !Array.isArray(raw.agentx) ? raw.agentx as Record<string, unknown> : undefined);
  if (!e2eRoot || !Object.hasOwn(e2eRoot, "e2e")) return null;
  const contract = E2EApplicationProjectContractSchema.parse(e2eRoot.e2e);
  const { recipeDigest, ...body } = contract.recipe;
  if (sha(body) !== recipeDigest) throw new Error("application source recipe digest does not match its canonical fields");
  return contract;
}

export function e2eApplicationAccountTargetId(baseTargetId: string, profileId: string): string {
  return `account-target-${sha([baseTargetId, profileId])}`;
}

export function createE2EApplicationAccountTarget(baseTarget: E2ETarget, profile: { profileId: string; scope: "synthetic-test" | "external-test" }): E2ETarget {
  if (profile.profileId === baseTarget.accountProfileId) return baseTarget;
  const target = E2ETargetSchema.parse({ ...baseTarget, targetId: e2eApplicationAccountTargetId(baseTarget.targetId, profile.profileId), accountProfileId: profile.profileId });
  return target;
}

export const E2EApplicationAccountDefinitionSchema = z.object({
  schemaVersion: z.literal("e2e-application-account-definition/v1"), applicationId: boundedId(200), profileId: boundedId(200), revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  contractDigest: digest, authProfileId: boundedId(200), seedProfileId: boundedId(200), subjectIdDigest: digest, tenantIdDigest: digest,
  roleRef: boundedId(200), credentialHandleId: boundedId(200).nullable(), connectionRef: E2EApplicationExternalConnectionRefSchema.nullable(),
  expiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/).refine((value) => {
    const date = new Date(value); return Number.isFinite(date.getTime()) && date.toISOString() === value;
  }, "expiry must be a real canonical UTC instant"),
}).strict();
export type E2EApplicationAccountDefinition = z.infer<typeof E2EApplicationAccountDefinitionSchema>;
export function e2eApplicationAccountDefinitionDigest(definition: E2EApplicationAccountDefinition): string {
  return sha(E2EApplicationAccountDefinitionSchema.parse(definition));
}
export function deriveE2EApplicationRuntimeAccountRef(definitionInput: E2EApplicationAccountDefinition): E2ERuntimeAccountRef {
  const definition = E2EApplicationAccountDefinitionSchema.parse(definitionInput);
  return E2ERuntimeAccountRefSchema.parse({ applicationId: definition.applicationId, profileId: definition.profileId, revision: definition.revision,
    definitionDigest: e2eApplicationAccountDefinitionDigest(definition) });
}
export function validateE2EApplicationAccountBinding(input: { contract: E2EApplicationProjectContract; definition: E2EApplicationAccountDefinition;
  expectedRef: E2ERuntimeAccountRef; now: string }): E2ERuntimeAccountRef {
  const contract = E2EApplicationProjectContractSchema.parse(input.contract);
  const definition = E2EApplicationAccountDefinitionSchema.parse(input.definition);
  const reference = E2ERuntimeAccountRefSchema.parse(input.expectedRef);
  const profile = contract.accountProfiles.find((item) => item.profileId === definition.profileId);
  if (!profile || definition.contractDigest !== sha(contract) || definition.authProfileId !== profile.authProfileId
    || definition.seedProfileId !== profile.seedProfileId || definition.roleRef !== profile.roleRef
    || definition.applicationId.trim() === "" || definition.tenantIdDigest !== sha(profile.tenantRef) || definition.expiresAt <= input.now
    || (profile.scope === "external-test" && (definition.connectionRef === null || definition.credentialHandleId === null))
    || (profile.scope === "synthetic-test" && definition.connectionRef !== null)
    || (profile.scope === "external-test" && !contract.service?.originBindings.some((origin) => origin.originRef === definition.connectionRef?.originRef))) {
    throw new Error("application account definition does not match the current source contract, identity, scope, connection or expiry");
  }
  const derived = deriveE2EApplicationRuntimeAccountRef(definition);
  if (canonicalJson(reference) !== canonicalJson(derived)) throw new Error("application account reference is stale or differs from its protected definition");
  return derived;
}

export function bindE2EApplicationAccountTargets(input: { contract: E2EApplicationProjectContract; applicationId: string; baseTargets: readonly E2ETarget[] }): E2ETarget[] {
  const contract = E2EApplicationProjectContractSchema.parse(input.contract);
  const bases = new Map(input.baseTargets.map((target) => [target.targetId, target]));
  const result: E2ETarget[] = [...input.baseTargets];
  for (const variant of contract.targetAccounts) {
    const base = bases.get(variant.baseTargetId);
    const profile = contract.accountProfiles.find((item) => item.profileId === variant.profileId);
    if (!base || !profile || base.applicationId !== input.applicationId || base.kind === "contract") throw new Error("application account variant references a foreign or unsupported base target");
    if (base.accountProfileId === variant.profileId) continue;
    result.push(createE2EApplicationAccountTarget(base, profile));
  }
  if (result.length > 12) throw new Error("application account variants exceed the target inventory limit");
  return result;
}
