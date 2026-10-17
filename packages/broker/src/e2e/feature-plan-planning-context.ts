import {
  E2EApiMockFixtureSchema, canonicalJson, createE2EOpenApiFixtureDescriptor, inspectE2EPortableSource, inspectE2ERepository, redactSecrets,
  verifyE2ESourceSnapshot, type E2EAppRecipe, type E2EPolicy, type E2ESourceSnapshot,
} from "@agentx/contracts";
import * as ts from "typescript";

const MAX_PLANNING_CONTEXT_BYTES = 12_000;

export type FeatureE2EPlanningContext = {
  status: "available";
  source: { origin: "prepared-commit" | "approved-setup"; commitSha: string; treeSha: string; candidateDigest: string;
    preparedCommitStatus: "MATCHED" | "UNKNOWN"; preparedCommitSha: string | null; currentCheckoutUnverified: boolean };
  baselineScenarioIds: string[];
  targets: Array<{ targetId: string; applicationId: string; kind: string; accountProfileId: string }>;
  applicationRefs?: Array<{ applicationId: string; kind: string; sourceRefs: Array<{ path: string; sha256: string }>; recipe: E2EAppRecipe | null }>;
  runtimeRefs?: Array<{ targetId: string; applicationId: string; recipeDigest: string | null; sourceRefs: Array<{ path: string; sha256: string }>;
    runtimeProfileId: string; accountProfileId: string }>;
  portableOperations: Array<{ operationId: string; applicationId: string; requestedTargetIds: string[]; packageExportSubpath: string;
    moduleSpecifier: string; callableSelectors: Array<{ selector: { kind: "default" } | { kind: "named"; exportName: string }; firstInputParameter?: string }>;
    sourceRefs: Array<{ path: string; sha256: string }> }>;
  mockFixtures: Array<{ componentId: string; requestedTargetId: string; operationId: string; sourcePath: string; sourceSha256: string;
    contractPath: string; contractSha256: string; method: string; path: string; inputSelector: { kind: "query"; name: string };
    callableMappings: Array<{ invokeOperationId: string; callableSelector: { kind: "default" } | { kind: "named"; exportName: string }; firstInputParameter: string }>;
    variants: Array<{ id: string; inputValue: string; status: number; response: unknown }> }>;
  accountContextRefs: Array<{ applicationId: string; profileId: string; sourcePath: string; sourceSha256: string }>;
};

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
    const inspectionSourceByPath = new Map(discovered.inspection.sources.map((source) => [source.path, source]));
    const applicationRefs = discovered.inspection.applications.map((application) => {
      const packagePath = application.sourcePaths.find((path) => /(^|\/)package\.json$/i.test(path));
      const packageDirectory = packagePath === undefined ? undefined : packagePath.includes("/") ? packagePath.slice(0, packagePath.lastIndexOf("/")) : ".";
      const lockfileName = /^(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lock(?:b)?)$/i;
      const identityPath = /(?:^|\/)(?:AndroidManifest\.xml|Info\.plist|[^/]+\.xcodeproj\/project\.pbxproj|[^/]+\.csproj|[^/]+\.sln|CMakeLists\.txt|meson\.build)$/i;
      const paths = [...new Set([
        ...(packagePath === undefined ? [] : [packagePath]),
        ...application.sourcePaths.filter((path) => identityPath.test(path)),
        ...snapshot.sources.filter((source) => packageDirectory !== undefined
          && (source.path.includes("/") ? source.path.slice(0, source.path.lastIndexOf("/")) : ".") === packageDirectory
          && lockfileName.test(source.path.slice(source.path.lastIndexOf("/") + 1))).map((source) => source.path),
      ])].sort((left, right) => left.localeCompare(right));
      return { applicationId: application.applicationId, kind: application.kind, recipe: application.recipe,
        sourceRefs: paths.flatMap((path) => { const source = sourceByPath.get(path); return source === undefined ? [] : [{ path, sha256: source.sha256 }]; }) };
    });
    const targets = policy.targets.flatMap((configured) => {
      const found = discovered.inspection.proposedTargets.find((target) => target.targetId === configured.targetId
        && target.applicationId === configured.applicationId && target.kind === configured.kind && target.accountProfileId === configured.accountProfileId);
      return found === undefined ? [] : [{ targetId: found.targetId, applicationId: found.applicationId, kind: found.kind, accountProfileId: found.accountProfileId }];
    });
    if (targets.length === 0) return { status: "unknown", reason: "the pinned policy targets do not match any target discovered from the prepared source commit" };

    const selectedTargetIds = new Set(targets.map((target) => target.targetId));
    const runtimeRefs = targets.flatMap((target) => {
      const discoveredTarget = discovered.inspection.proposedTargets.find((item) => item.targetId === target.targetId);
      const applicationRef = applicationRefs.find((item) => item.applicationId === target.applicationId);
      return discoveredTarget === undefined || applicationRef === undefined ? [] : [{ targetId: target.targetId,
        applicationId: target.applicationId, recipeDigest: applicationRef.recipe?.recipeDigest ?? null,
        sourceRefs: applicationRef.sourceRefs, runtimeProfileId: discoveredTarget.runtimeProfileId, accountProfileId: target.accountProfileId }];
    });
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
      const manifestPath = application?.sourcePaths.find((path) => /(^|\/)package\.json$/i.test(path));
      const source = manifestPath === undefined ? undefined : inspectionSourceByPath.get(manifestPath);
      return source === undefined || !applications.has(target.applicationId) ? [] : [{ applicationId: target.applicationId,
        profileId: target.accountProfileId, sourcePath: source.path, sourceSha256: source.sha256 }];
    }).filter((item, index, values) => values.findIndex((candidate) => candidate.applicationId === item.applicationId && candidate.profileId === item.profileId) === index).slice(0, 32);
    const context: FeatureE2EPlanningContext = {
      status: "available", source: { origin: sourceOrigin, commitSha: snapshot.commitSha, treeSha: snapshot.treeSha,
        candidateDigest: snapshot.candidate.digest, preparedCommitStatus: preparedCommitSha === null ? "UNKNOWN" : "MATCHED", preparedCommitSha,
        currentCheckoutUnverified: identity.origin === "approved-setup" },
      baselineScenarioIds: policy.baselineScenarioIds, targets, applicationRefs, runtimeRefs, portableOperations, mockFixtures: mockFixtures.slice(0, 32), accountContextRefs,
    };
    if (Buffer.byteLength(canonicalJson(context), "utf8") > MAX_PLANNING_CONTEXT_BYTES) {
      return { status: "unknown", reason: "source-backed planning references exceed the bounded prompt context" };
    }
    return context;
  } catch {
    return { status: "unknown", reason: "the prepared source snapshot could not be independently inspected" };
  }
}
