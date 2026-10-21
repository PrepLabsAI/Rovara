import {
  E2EApiMockFixtureSchema, canonicalJson, createE2EOpenApiFixtureDescriptor, e2eApplicationRecipeIsProjectContract, inspectE2EPortableSource,
  inspectE2ERepository, isE2EPlaceholderRuntimeProfileId, isE2EQualifiedRuntimeProfileId, readE2EApplicationProjectContract, redactSecrets, verifyE2ESourceSnapshot,
  type E2EAppRecipe, type E2EApplicationProjectContract, type E2EPolicy, type E2ERuntimeAccountRef, type E2ESourceSnapshot,
} from "@agentx/contracts";
import { E2EAccountRegistryError, latestAccountRef, type E2EAccountRegistryEntry } from "./application-account-registry.js";
import type { ReadyE2ERuntime } from "../aws/e2e-runtime-readiness.js";
import { E2EApplicationIdentityMissingError, e2eApplicationMetadataSourceRefs } from "@agentx/contracts";
import * as ts from "typescript";

const MAX_PLANNING_CONTEXT_BYTES = 12_000;
const nativeApplicationIdentityPath = /(?:^|\/)(?:AndroidManifest\.xml|Info\.plist|[^/]+\.xcodeproj\/project\.pbxproj|[^/]+\.xcworkspace\/contents\.xcworkspacedata|[^/]+\.csproj|[^/]+\.sln|CMakeLists\.txt|meson\.build)$/i;

function accountContextIdentityPath(applicationSourcePaths: readonly string[]): string | undefined {
  return applicationSourcePaths.find((path) => /(^|\/)package\.json$/i.test(path))
    ?? applicationSourcePaths.find((path) => nativeApplicationIdentityPath.test(path));
}

export type FeatureE2EPlanningContext = {
  status: "available";
  source: { origin: "prepared-commit" | "approved-setup"; commitSha: string; treeSha: string; candidateDigest: string;
    preparedCommitStatus: "MATCHED" | "UNKNOWN"; preparedCommitSha: string | null; currentCheckoutUnverified: boolean };
  baselineScenarioIds: string[];
  targets: Array<{ targetId: string; applicationId: string; kind: string; accountProfileId: string }>;
  applicationRefs?: Array<{ applicationId: string; kind: string; sourceRefs: Array<{ path: string; sha256: string }>; recipe: E2EAppRecipe | null }>;
  runtimeRefs?: Array<{ targetId: string; applicationId: string; recipeDigest: string | null; sourceRefs: Array<{ path: string; sha256: string }>;
    runtimeProfileId: string; accountProfileId: string }>;
  unavailableTargetRefs?: Array<{ targetId: string; applicationId: string; accountProfileId: string; sourceRefs: Array<{ path: string; sha256: string }> }>;
  /** Why each unavailable target cannot run application scenarios now; kept apart from the refs, which the proposal copies back strictly. */
  unavailableReasons?: Array<{ targetId: string; reason: FeatureE2EUnavailableReason }>;
  /** The step and assertion kinds a READY runtime executes, once per target kind that has an executable target. */
  executableKinds?: Array<{ kind: "web" | "api"; steps: string[]; assertions: string[] }>;
  /** The account reference of each executable target's synthetic account, which the plan copies into `runtimeAccountRefs` and approval recomputes. */
  runtimeAccountRefs?: Array<{ applicationId: string; profileId: string; revision: number; definitionDigest: string }>;
  portableOperations: Array<{ operationId: string; applicationId: string; requestedTargetIds: string[]; packageExportSubpath: string;
    moduleSpecifier: string; callableSelectors: Array<{ selector: { kind: "default" } | { kind: "named"; exportName: string }; firstInputParameter?: string }>;
    sourceRefs: Array<{ path: string; sha256: string }> }>;
  mockFixtures: Array<{ componentId: string; requestedTargetId: string; operationId: string; sourcePath: string; sourceSha256: string;
    contractPath: string; contractSha256: string; method: string; path: string; inputSelector: { kind: "query"; name: string };
    callableMappings: Array<{ invokeOperationId: string; callableSelector: { kind: "default" } | { kind: "named"; exportName: string }; firstInputParameter: string }>;
    variants: Array<{ id: string; inputValue: string; status: number; response: unknown }> }>;
  accountContextRefs: Array<{ applicationId: string; profileId: string; sourcePath: string; sourceSha256: string }>;
};

/**
 * Why a target is not executable for application scenarios: the placeholder profile, no launch recipe, only an inferred recipe, a runtime that is not READY
 * now, an application with no source-owned package or native project identity to bind its account and source references to, or an account with no usable registered
 * definition (`no-account-definition`: none was written when the setup was approved, or the latest has expired or is not what the approved contract says).
 */
export type FeatureE2EUnavailableReason = "runtime-unavailable" | "no-launch-recipe" | "needs-project-contract" | "runtime-not-ready" | "no-source-identity" | "no-account-definition";

export type FeatureE2EPlanningContextResult = FeatureE2EPlanningContext | { status: "unknown"; reason: string };

/** Confirms a captured or approved-setup snapshot is bound to the registered repository and requested commit. */
export function isExactFeatureE2ESourceSnapshot(snapshot: E2ESourceSnapshot, repositoryId: string, commitSha: string): boolean {
  try {
    if (snapshot.commitSha !== commitSha || snapshot.candidate.repositories.length !== 1
      || snapshot.candidate.repositories[0]?.repositoryId.toLowerCase() !== repositoryId.toLowerCase()
      || snapshot.candidate.repositories[0]?.commitSha !== commitSha) return false;
    verifyE2ESourceSnapshot(snapshot, snapshot.candidate);
    return true;
  } catch {
    return false;
  }
}

/** Return only a simple AST-derived first argument name for a callable export; never return source text. */
function firstInputParameter(sourceText: string, path: string, selector: { kind: "default" } | { kind: "named"; exportName: string }): string | undefined {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const scriptKind = ext === "tsx" ? ts.ScriptKind.TSX : ext === "jsx" ? ts.ScriptKind.JSX : /^(?:js|mjs|cjs)$/.test(ext) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true, scriptKind);
  const declarations = new Map<string, ts.FunctionLikeDeclaration>();
  const exports = new Map<string, string>();
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      declarations.set(statement.name.text, statement);
      if (ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
        exports.set(statement.name.text, statement.name.text);
      }
    }
    if (ts.isVariableStatement(statement) && ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer
          && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) {
          declarations.set(declaration.name.text, declaration.initializer);
          exports.set(declaration.name.text, declaration.name.text);
        }
      }
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals && ts.isIdentifier(statement.expression)) exports.set("default", statement.expression.text);
    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const item of statement.exportClause.elements) exports.set(item.name.text, item.propertyName?.text ?? item.name.text);
    }
  }
  const exportName = selector.kind === "default" ? "default" : selector.exportName;
  const declaration = declarations.get(exports.get(exportName) ?? "");
  const first = declaration?.parameters[0]?.name;
  if (first === undefined || !ts.isIdentifier(first) || declaration?.body === undefined) return undefined;
  return first.text;
}

/** Builds prompt-only references from the exact source tree and policy pinned to the task. */
export function buildFeatureE2EPlanningContext(policy: E2EPolicy, snapshot: E2ESourceSnapshot, identity: {
  origin?: FeatureE2EPlanningContext["source"]["origin"]; preparedCommitSha?: string | null;
  /** The web/API runtimes READY for the project's runtime binding right now (see readProjectReadyE2ERuntimes); none when omitted. */
  readyRuntimes?: readonly ReadyE2ERuntime[];
  /** The registered test accounts of the project (the setup approval writes them): the planner is shown each executable target's latest account ref. None when omitted. */
  accountRegistry?: readonly E2EAccountRegistryEntry[];
  /** The clock the registered definitions' expiry is judged by (milliseconds); the current time when omitted. */
  now?: number;
} = {}): FeatureE2EPlanningContextResult {
  try {
    const sourceOrigin = identity.origin ?? "prepared-commit";
    const preparedCommitSha = identity.preparedCommitSha === undefined ? snapshot.commitSha : identity.preparedCommitSha;
    if ((sourceOrigin === "prepared-commit" && preparedCommitSha !== snapshot.commitSha)
      || (preparedCommitSha !== null && preparedCommitSha !== snapshot.commitSha)) {
      return { status: "unknown", reason: "source snapshot identity does not match the prepared commit" };
    }
    const discovered = inspectE2ERepository(snapshot, snapshot.candidate);
    const sourceByPath = new Map(snapshot.sources.map((source) => [source.path, source]));
    const targetedApplicationIds = new Set(policy.targets.map((configured) => configured.applicationId));
    const identitylessApplicationIds = new Set<string>();
    const applicationRefs = discovered.inspection.applications.flatMap((application) => {
      try {
        return [{ applicationId: application.applicationId, kind: application.kind, recipe: application.recipe,
          sourceRefs: e2eApplicationMetadataSourceRefs(snapshot, application.applicationId, application.sourcePaths) }];
      } catch (error) {
        // An application with no source-owned identity is left out, and the policy's target on it (if any) becomes unavailable below. It must not erase the
        // source context of the applications that do have one. Every other failure (ambiguous or malformed identity, an over-large reference set) stays fatal.
        if (!(error instanceof E2EApplicationIdentityMissingError)) throw error;
        identitylessApplicationIds.add(application.applicationId);
        return [];
      }
    });
    const targets = policy.targets.flatMap((configured) => {
      const found = discovered.inspection.proposedTargets.find((target) => target.targetId === configured.targetId
        && target.applicationId === configured.applicationId && target.kind === configured.kind && target.accountProfileId === configured.accountProfileId);
      return found === undefined ? [] : [{ targetId: found.targetId, applicationId: found.applicationId, kind: found.kind, accountProfileId: found.accountProfileId }];
    });
    if (targets.length === 0) return { status: "unknown", reason: "the pinned policy targets do not match any target discovered from the prepared source commit" };

    const selectedTargetIds = new Set(targets.map((target) => target.targetId));
    // The runtime profile is the one the project's approved setup assigned (policy targets), not the discovery placeholder; the target is
    // executable for application scenarios only while that profile's runtime is READY for the project now and its recipe is the project's own.
    const readyRuntimes = identity.readyRuntimes ?? [];
    const configuredTarget = (targetId: string) => policy.targets.find((item) => item.targetId === targetId)!;
    const readyRuntimeFor = (target: (typeof targets)[number]): ReadyE2ERuntime | undefined => {
      const profileId = configuredTarget(target.targetId).runtimeProfileId;
      return target.kind === "web" || target.kind === "api" ? readyRuntimes.find((item) => item.kind === target.kind && item.profileId === profileId) : undefined;
    };
    // The target's account as the registry holds it now, held to the approved contract: absent when none is registered or the latest cannot be used (Task 3.1).
    const accountNow = identity.now ?? Date.now();
    const accountRefCache = new Map<string, E2ERuntimeAccountRef | undefined>();
    const accountRefFor = (applicationId: string, profileId: string): E2ERuntimeAccountRef | undefined => {
      const key = `${applicationId}\0${profileId}`;
      if (accountRefCache.has(key)) return accountRefCache.get(key);
      let contract: E2EApplicationProjectContract | null;
      try { contract = readE2EApplicationProjectContract(snapshot, applicationId); } catch { contract = null; }
      let ref: E2ERuntimeAccountRef | undefined;
      if (contract !== null) {
        try { ref = latestAccountRef({ contract, entries: identity.accountRegistry ?? [], applicationId, profileId, now: accountNow }); }
        catch (error) { if (!(error instanceof E2EAccountRegistryError)) throw error; }
      }
      accountRefCache.set(key, ref);
      return ref;
    };
    const unavailableReason = (target: (typeof targets)[number]): FeatureE2EUnavailableReason | undefined => {
      const profileId = configuredTarget(target.targetId).runtimeProfileId;
      const application = applicationRefs.find((item) => item.applicationId === target.applicationId);
      if (identitylessApplicationIds.has(target.applicationId) && targetedApplicationIds.has(target.applicationId)) return "no-source-identity";
      if (application === undefined || isE2EPlaceholderRuntimeProfileId(profileId)) return "runtime-unavailable";
      if (application.recipe === null) return "no-launch-recipe";
      if (isE2EQualifiedRuntimeProfileId(profileId) && !e2eApplicationRecipeIsProjectContract(snapshot, target.applicationId, application.recipe)) return "needs-project-contract";
      if (readyRuntimeFor(target) === undefined) return isE2EQualifiedRuntimeProfileId(profileId) ? "runtime-not-ready" : "runtime-unavailable";
      return isE2EQualifiedRuntimeProfileId(profileId) && accountRefFor(target.applicationId, target.accountProfileId) === undefined ? "no-account-definition" : undefined;
    };
    const runtimeRefs = targets.flatMap((target) => {
      const applicationRef = applicationRefs.find((item) => item.applicationId === target.applicationId);
      return applicationRef === undefined ? [] : [{ targetId: target.targetId,
        applicationId: target.applicationId, recipeDigest: applicationRef.recipe?.recipeDigest ?? null,
        sourceRefs: applicationRef.sourceRefs, runtimeProfileId: configuredTarget(target.targetId).runtimeProfileId, accountProfileId: target.accountProfileId }];
    });
    const unavailableReasons = targets.flatMap((target) => {
      const reason = unavailableReason(target);
      return reason === undefined ? [] : [{ targetId: target.targetId, reason }];
    });
    const unavailableTargetRefs = targets.flatMap((target) => {
      const applicationRef = applicationRefs.find((item) => item.applicationId === target.applicationId);
      return applicationRef === undefined || !unavailableReasons.some((item) => item.targetId === target.targetId) ? []
        : [{ targetId: target.targetId, applicationId: target.applicationId, accountProfileId: target.accountProfileId, sourceRefs: applicationRef.sourceRefs }];
    });
    const executableKinds = (["web", "api"] as const).flatMap((kind) => {
      const ready = targets.filter((target) => target.kind === kind && unavailableReason(target) === undefined).map(readyRuntimeFor)[0];
      return ready === undefined ? [] : [{ kind, steps: ready.supportedSteps.filter((step) => step !== "agent"), assertions: [...ready.supportedAssertions] }];
    });
    // The refs the plan copies are the registry's latest, one per (application, account profile): an owner and a viewer of one application each get their own.
    const runtimeAccountRefs = runtimeRefs.flatMap((ref) => {
      if (unavailableReasons.some((item) => item.targetId === ref.targetId) || ref.recipeDigest === null) return [];
      const account = accountRefFor(ref.applicationId, ref.accountProfileId);
      return account === undefined ? [] : [account];
    }).filter((ref, index, refs) => refs.findIndex((item) => item.applicationId === ref.applicationId && item.profileId === ref.profileId) === index);
    const portableOperations = discovered.portableOperations.flatMap((operation) => {
      const requestedTargetIds = operation.targetIds.filter((targetId) => selectedTargetIds.has(targetId));
      if (requestedTargetIds.length === 0) return [];
      const moduleSource = operation.sourceRefs.map((ref) => sourceByPath.get(ref.path)).find((source) => source !== undefined);
      if (!moduleSource) return [];
      const moduleText = Buffer.from(moduleSource.bytes).toString("utf8");
      const moduleInspection = inspectE2EPortableSource(moduleText, moduleSource.path);
      const callableSelectors = moduleInspection.exports.filter((entry) => entry.kind === "callable").map((entry) => {
        const selector = entry.name === "default" ? { kind: "default" as const } : { kind: "named" as const, exportName: entry.name };
        const firstParameter = firstInputParameter(moduleText, moduleSource.path, selector);
        return { selector, ...(firstParameter === undefined ? {} : { firstInputParameter: firstParameter }) };
      });
      const manifestDirectory = operation.manifestPath.includes("/") ? operation.manifestPath.slice(0, operation.manifestPath.lastIndexOf("/")) : ".";
      const moduleSpecifier = manifestDirectory === "." ? `./${moduleSource.path}` : `./${moduleSource.path.slice(manifestDirectory.length + 1)}`;
      return [{ operationId: operation.operationId, applicationId: operation.applicationId, requestedTargetIds, packageExportSubpath: operation.exportName,
        moduleSpecifier, callableSelectors, sourceRefs: operation.sourceRefs.map((ref) => ({ path: ref.path, sha256: ref.sha256 })) }];
    }).slice(0, 32);

    const mockFixtures: FeatureE2EPlanningContext["mockFixtures"] = [];
    for (const target of targets) {
      for (const edge of discovered.inspection.dependencyEdges.filter((item) => item.fromApplicationId === target.applicationId
        && item.contractRef !== null && /(^|\/)(?:openapi|swagger)\.(?:json|ya?ml)$/i.test(item.contractRef))) {
        const contractPath = edge.contractRef!;
        const contractSource = sourceByPath.get(contractPath);
        if (contractSource === undefined) continue;
        const contractDescriptor = createE2EOpenApiFixtureDescriptor(contractSource.bytes);
        if (contractDescriptor === undefined) continue;
        for (const source of snapshot.sources) {
          if (!/(?:mock|fixture)/i.test(source.path) || !/\.json$/i.test(source.path)) continue;
          let raw: unknown;
          try { raw = JSON.parse(Buffer.from(source.bytes).toString("utf8")) as unknown; } catch { continue; }
          const parsed = E2EApiMockFixtureSchema.safeParse(raw);
          if (!parsed.success) continue;
          const contractOperation = contractDescriptor.operations.find((operation) => operation.operationId === parsed.data.operationId
            && operation.method === parsed.data.method && operation.path === parsed.data.path);
          const inputParameter = contractOperation?.parameters.find((parameter) => parameter.in === "query" && parameter.name === parsed.data.inputField);
          const inputMatchesSchema = inputParameter?.schema.type === "string"
            && (inputParameter.schema.enum === undefined || inputParameter.schema.enum.includes(parsed.data.variants[0]!.inputValue))
            && parsed.data.variants.every((variant) => inputParameter.schema.type === "string"
              && (inputParameter.schema.enum === undefined || inputParameter.schema.enum.includes(variant.inputValue))
              && (inputParameter.schema.maxLength === undefined || variant.inputValue.length <= inputParameter.schema.maxLength)
              && (inputParameter.schema.minLength === undefined || variant.inputValue.length >= inputParameter.schema.minLength));
          if (contractOperation === undefined || inputParameter === undefined || !inputMatchesSchema) continue;
          if (mockFixtures.some((item) => item.requestedTargetId === target.targetId && item.componentId === edge.toComponentId)) continue;
          mockFixtures.push({ componentId: edge.toComponentId, requestedTargetId: target.targetId, operationId: parsed.data.operationId,
            sourcePath: source.path, sourceSha256: source.sha256, contractPath, contractSha256: contractSource.sha256,
            method: parsed.data.method, path: parsed.data.path, inputSelector: { kind: "query", name: parsed.data.inputField },
            callableMappings: [],
            variants: parsed.data.variants.map((variant) => ({ id: variant.id, inputValue: variant.inputValue, status: variant.status,
              response: redactSecrets(variant.body) })) });
        }
      }
    }
    const applications = new Set(targets.map((target) => target.applicationId));
    const accountContextRefs = targets.flatMap((target) => {
      const application = discovered.inspection.applications.find((item) => item.applicationId === target.applicationId);
      const applicationRef = applicationRefs.find((item) => item.applicationId === target.applicationId);
      const identityPath = application === undefined ? undefined : accountContextIdentityPath(application.sourcePaths);
      const sourceRef = identityPath === undefined ? undefined : applicationRef?.sourceRefs.find((ref) => ref.path === identityPath);
      return sourceRef === undefined || !applications.has(target.applicationId) ? [] : [{ applicationId: target.applicationId,
        profileId: target.accountProfileId, sourcePath: sourceRef.path, sourceSha256: sourceRef.sha256 }];
    }).filter((item, index, values) => values.findIndex((candidate) => candidate.applicationId === item.applicationId && candidate.profileId === item.profileId) === index).slice(0, 32);
    const context: FeatureE2EPlanningContext = {
      status: "available", source: { origin: sourceOrigin, commitSha: snapshot.commitSha, treeSha: snapshot.treeSha,
        candidateDigest: snapshot.candidate.digest, preparedCommitStatus: preparedCommitSha === null ? "UNKNOWN" : "MATCHED", preparedCommitSha,
        currentCheckoutUnverified: identity.origin === "approved-setup" },
      baselineScenarioIds: policy.baselineScenarioIds, targets, applicationRefs, runtimeRefs, unavailableTargetRefs,
      // Ruling AQ: a policy with no target on a qualified profile (every P0 project) keeps the pre-2.2 context and prompt exactly.
      ...(targets.some((target) => isE2EQualifiedRuntimeProfileId(configuredTarget(target.targetId).runtimeProfileId)) || unavailableReasons.some((item) => item.reason === "no-source-identity")
        ? { unavailableReasons, executableKinds, runtimeAccountRefs } : {}),
      portableOperations, mockFixtures: mockFixtures.slice(0, 32), accountContextRefs,
    };
    if (Buffer.byteLength(canonicalJson(context), "utf8") > MAX_PLANNING_CONTEXT_BYTES) {
      return { status: "unknown", reason: "source-backed planning references exceed the bounded prompt context" };
    }
    return context;
  } catch {
    return { status: "unknown", reason: "the prepared source snapshot could not be independently inspected" };
  }
}

export { describeFeatureE2EExecutableKinds } from "./feature-plan-executable-kinds.js";
