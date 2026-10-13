import { createHash } from "node:crypto";
import * as ts from "typescript";
import { E2EScenarioBundleSchema, E2EExecutionPlanSchema, canonicalJson, verifyE2ESourceSnapshot, type CandidateManifest, type E2EExecutionPlan, type E2EExpectedCase, type E2EPolicy, type E2EScenario, type E2EScenarioBundle, type E2ESourceSnapshot } from "@agentx/contracts";
import { inspectE2ERepository } from "@agentx/broker/e2e/discovery";
import { selectE2EExecutionPlan, type E2EPlanSelectionInput } from "@agentx/broker/e2e/execution-plan";
import { E2E_CANDIDATE_RESPONSE_PROTOCOL, type E2ECompiledInventory } from "./identity.js";
import { emitE2ECompilationFiles, e2ePortableOperationDescriptorDigest, type E2ECompilerPurpose, type E2EOperationRegistration } from "./templates.js";
import { assertPlanSubset } from "./selection.js";

export type E2EImmutableCompilationContext = Readonly<{
  selectionInput: E2EPlanSelectionInput;
  executionPlan: E2EExecutionPlan;
  group: E2EExecutionPlan["groups"][number];
  purpose: E2ECompilerPurpose;
  registeredOperations: readonly E2EOperationRegistration[];
  approvedSemanticDelta: Readonly<{ schemaVersion: "portable-export-delta/v1"; id: string; responseProtocol: typeof E2E_CANDIDATE_RESPONSE_PROTOCOL; selectors: readonly Readonly<{ operationId: string; callableSelector: E2EOperationRegistration["callableSelector"] }>[]; digest: string }>;
}>;
export type E2ECompiledSuite = Readonly<{ bundle: E2EScenarioBundle; files: ReadonlyMap<string, string>; inventory: E2ECompiledInventory; expectedConfigDigest: string; expectedCases: readonly E2EExpectedCase[]; caseBindings: ReadonlyMap<string, { compilerCaseIdentity: string; candidateResponseScope: string; requestProtocol: string; operationId: string; accountProfileId: string; requestedTargetId: string; packageExportSubpath: string; moduleSpecifier: string; callableSelector: E2EOperationRegistration["callableSelector"]; descriptorDigest: string }>; selectionPacketPath: string }>;

export function compileE2EScenarios(bundleInput: E2EScenarioBundle, effectiveTargets: E2EExecutionPlan["effectiveTargets"], group: E2EExecutionPlan["groups"][number], immutableCompilationContext: E2EImmutableCompilationContext): E2ECompiledSuite {
  const bundle = E2EScenarioBundleSchema.parse(bundleInput);
  if (immutableCompilationContext === null || typeof immutableCompilationContext !== "object") throw new Error("immutable compilation context is mandatory");
  const selection = immutableCompilationContext.selectionInput;
  const expectedCandidate: CandidateManifest = selection.expectedCandidate;
  const sourceSnapshot: E2ESourceSnapshot = selection.sourceSnapshot;
  verifyE2ESourceSnapshot(sourceSnapshot, expectedCandidate);
  if (selection.candidateDigest !== expectedCandidate.digest || bundle.planDigest !== selection.planDigest || canonicalJson(bundle.scenarios) !== canonicalJson(selection.scenarios)) throw new Error("bundle does not match the approved candidate and plan assignments");
  const derivedPlan = E2EExecutionPlanSchema.parse(selectE2EExecutionPlan(selection));
  if (canonicalJson(derivedPlan) !== canonicalJson(E2EExecutionPlanSchema.parse(immutableCompilationContext.executionPlan))) throw new Error("supplied execution plan differs from fresh shared planner derivation");
  assertPlanSubset(derivedPlan, effectiveTargets, group);
  const assignedGroup = derivedPlan.groups.find((candidate) => candidate.groupId === group.groupId)!;
  const discovered = inspectE2ERepository(sourceSnapshot, expectedCandidate);
  const operations = new Map(discovered.portableOperations.map((operation) => [operation.operationId, operation]));
  const deltaBody = { schemaVersion: immutableCompilationContext.approvedSemanticDelta?.schemaVersion, id: immutableCompilationContext.approvedSemanticDelta?.id, responseProtocol: immutableCompilationContext.approvedSemanticDelta?.responseProtocol, selectors: immutableCompilationContext.approvedSemanticDelta?.selectors };
  if (!immutableCompilationContext.approvedSemanticDelta || createHash("sha256").update(canonicalJson(deltaBody)).digest("hex") !== immutableCompilationContext.approvedSemanticDelta.digest) throw new Error("approved portable semantic delta identity is missing or does not match its content");
  if (canonicalJson(immutableCompilationContext.approvedSemanticDelta.responseProtocol) !== canonicalJson(E2E_CANDIDATE_RESPONSE_PROTOCOL)) throw new Error("candidate-process response protocol is outside the accepted versioned scope");
  const snapshotSources = new Map(sourceSnapshot.sources.map((item) => [item.path, item]));
  for (const registration of immutableCompilationContext.registeredOperations) {
    const operation = operations.get(registration.operationId);
    if (!operation || operation.applicationId !== registration.applicationId || operation.exportName !== registration.packageExportSubpath) throw new Error("registered operation identity is not in the verified source inventory");
    const manifest = snapshotSources.get(operation.manifestPath);
    const source = operation.sourceRefs[0];
    if (!manifest || !source) throw new Error("registered operation has no verified manifest or source reference");
    let manifestData: unknown;
    try { manifestData = JSON.parse(Buffer.from(manifest.bytes).toString("utf8")); } catch { throw new Error("verified package manifest is invalid JSON"); }
    const packageExports = (manifestData as { exports?: unknown }).exports;
    const exportTarget = packageExports !== null && typeof packageExports === "object" ? (packageExports as Record<string, unknown>)[registration.packageExportSubpath] : undefined;
    const packageDirectory = operation.manifestPath.includes("/") ? operation.manifestPath.slice(0, operation.manifestPath.lastIndexOf("/")) : ".";
    const derivedSpecifier = packageDirectory === "." ? `./${source.path}` : `./${source.path.slice(packageDirectory.length + 1)}`;
    if (typeof exportTarget !== "string" || exportTarget !== derivedSpecifier || registration.moduleSpecifier !== exportTarget) throw new Error("package subpath, module source, and actual manifest export target do not agree");
    if (registration.descriptorDigest !== e2ePortableOperationDescriptorDigest(registration, source)) throw new Error("operation descriptor digest does not bind the verified source and response protocol identities");
    const sourceBytes = snapshotSources.get(source.path)?.bytes;
    if (!sourceBytes || !sourceDeclaresCallable(Buffer.from(sourceBytes).toString("utf8"), source.path, registration.callableSelector)) throw new Error("registered callable selector is not declared by the verified source module");
    const approvedSelector = immutableCompilationContext.approvedSemanticDelta.selectors.find((item) => item.operationId === registration.operationId);
    if (!approvedSelector || canonicalJson(approvedSelector.callableSelector) !== canonicalJson(registration.callableSelector)) throw new Error("callable selector is not explicitly included in the approved semantic delta");
  }
  const ids = new Set(assignedGroup.expectedCases.map((item) => item.scenarioId));
  const scenarios = bundle.scenarios.filter((scenario) => ids.has(scenario.scenarioId));
  const emitted = emitE2ECompilationFiles({ expectedCases: assignedGroup.expectedCases, scenarios, group: assignedGroup, plan: derivedPlan, bundleDigest: bundle.bundleDigest, registrations: immutableCompilationContext.registeredOperations, purpose: immutableCompilationContext.purpose });
  return Object.freeze({ bundle, files: emitted.files, inventory: emitted.inventory, expectedConfigDigest: emitted.expectedConfigDigest, expectedCases: Object.freeze([...assignedGroup.expectedCases]), caseBindings: emitted.caseBindings, selectionPacketPath: ".agentx/e2e/selection-packet.json" });
}

export type { E2EPolicy, E2EScenario };

function sourceDeclaresCallable(source: string, path: string, selector: E2EOperationRegistration["callableSelector"]): boolean {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const scriptKind = extension === "tsx" ? ts.ScriptKind.TSX : extension === "jsx" ? ts.ScriptKind.JSX : extension === "js" || extension === "mjs" || extension === "cjs" ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind);
  if (((file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics).length > 0) return false;
  let hasDefault = false;
  const named = new Set<string>();
  for (const statement of file.statements) {
    if (ts.isExportAssignment(statement)) {
      if (!statement.isExportEquals) hasDefault = true;
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) for (const element of statement.exportClause.elements) named.add(element.name.text);
      continue;
    }
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) ?? [] : [];
    if (!modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) hasDefault = true;
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      if (statement.name) named.add(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) named.add(declaration.name.text);
    }
  }
  return selector.kind === "default" ? hasDefault : named.has(selector.exportName);
}
