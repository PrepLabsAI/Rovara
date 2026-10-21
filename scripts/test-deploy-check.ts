// The pure half of `test-deploy --check`: what is wrong with a TEST installation before a deploy or a demo.
//
// Four classes of problem were found only live in the M1.2 demo, and this finds each of them from facts a read-only gatherer
// collects: control-plane Lambdas left on old code, an IAM grant head needs that the deployed role lacks, READY catalog rows that
// expired or changed state, and a runner or worker that does not match this build. Nothing here reads or writes anything.
import { WORKER_INVOCATION_FEATURES } from "../packages/contracts/src/protocol.js";

/** A CloudFormation template as far as the check reads it. Structurally the same as test-deploy's `CfnTemplate`. */
export interface CheckTemplate {
  Resources?: Record<string, { Type?: string; Properties?: Record<string, unknown>; [key: string]: unknown }>;
  [key: string]: unknown;
}

export type FindingKind =
  | "stale-lambda"
  | "iam-missing-grant"
  | "iam-extra-grant"
  | "lambda-env-missing"
  | "catalog-not-ready"
  | "catalog-expiring"
  | "runner-image-mismatch"
  | "worker-feature-missing"
  | "model-route-not-approved"
  | "model-access-unverified";

/** The worker feature string for `agent` steps (M1.4). A running worker must list it on /ping before an agent step can be dispatched to it. */
export const AGENT_STEPS_FEATURE = "task.workflowE2EAgentSteps.v1";

/** The e2e model route as head pins it (decision D1): Bedrock through the worker's instance role, no fallback. */
export interface E2EModelRoute {
  routeId: string;
  modelId: string;
  /** An application inference profile ARN when the route uses one; null for a model or system-defined profile id. */
  inferenceProfileArn: string | null;
}
/** Replaced by the broker's route registry once Task 4.2 lands; until then head's route is this constant. */
export const E2E_MODEL_ROUTE: E2EModelRoute = { routeId: "rovara-e2e-default", modelId: "us.anthropic.claude-haiku-5-5", inferenceProfileArn: null };
/** A route that is not approved is a warning until Task 4.9 approves it at setup; 4.9 flips this to "error". */
const ROUTE_NOT_APPROVED_SEVERITY: Finding["severity"] = "warning";
/** Converse is authorized by bedrock:InvokeModel and ConverseStream by bedrock:InvokeModelWithResponseStream (Bedrock API reference, Converse). */
const ROUTE_INVOKE_ACTIONS = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"] as const;

export interface PolicyStatement {
  Effect?: unknown;
  Action?: unknown;
  NotAction?: unknown;
  Resource?: unknown;
  NotResource?: unknown;
  Condition?: unknown;
  [key: string]: unknown;
}

export interface Finding {
  kind: FindingKind;
  /** A warning never fails the check. */
  severity: "error" | "warning";
  /** What it is about: a logical ID, a catalog row key or `runner`. */
  subject: string;
  /** The subject without CDK's hash, for people. */
  label: string;
  message: string;
  /** iam-*: the role, and the policy of head (missing) or of the deployment (extra) that holds the grant. */
  roleLogicalId?: string;
  policyLogicalId?: string;
  /** iam-missing-grant: the statements a Tier 3 request needs, holding only what the deployed role lacks. */
  statements?: PolicyStatement[];
  /** lambda-env-missing: the environment variable names; worker-feature-missing: the feature strings. */
  missing?: string[];
}

/** One row of the E2E feature-verifier catalog, as read from the state table. */
export interface CatalogRowFact {
  /** `PROFILE#<profile>#web` or `PROFILE#<profile>#api`; other rows of the catalog are ignored. */
  sk: string;
  state: string;
  expiresAt: string;
}

/** What the qualified runner's status object says, and the deployed `ExecutorImageUri` to compare it with. */
export interface RunnerFacts {
  deployedExecutorImage?: string | undefined;
  /** The executor image the runner was qualified with. */
  executorImage?: string | undefined;
  /** The feature strings the runner's worker answered on /ping. Absent when the runner was qualified before it reported them. */
  invocationFeatures?: readonly string[] | undefined;
  /** The feature strings this head needs. WORKER_INVOCATION_FEATURES unless given. */
  requiredFeatures?: readonly string[] | undefined;
}

export interface CheckInput {
  headTemplate: CheckTemplate;
  deployedTemplate: CheckTemplate;
  /** Deployed `CodeSha256` (base64) by logical ID. */
  lambdaCodeShas: Readonly<Record<string, string>>;
  /** The head build's zip sha256 (base64) by logical ID: the Lambdas to check are exactly these. */
  builtZipShas: Readonly<Record<string, string>>;
  catalogRows: readonly CatalogRowFact[];
  /** Undefined when no qualified runner could be found. */
  runnerFacts: RunnerFacts | undefined;
  now: Date;
  /** The commit being checked. With a deployed revision that is this commit, the deployed code is current whatever its zip hash. */
  headRevision?: string | undefined;
  /**
   * By Lambda: whether anything its bundle is built from changed between the revision its deployed code was uploaded from and head.
   * False is unchanged, true is changed, undefined (or no entry) is unknown. Only read for a Lambda whose zip differs from head's.
   */
  inputsChanged?: Readonly<Record<string, boolean | undefined>> | undefined;
  /** The e2e model route and what the account, the registry and the worker's role say about it. Undefined skips the route checks. */
  modelRoute?: ModelRouteCheck | undefined;
}

/** What `bedrock get-foundation-model-availability` says about one foundation model. */
export interface ModelAvailabilityFact {
  modelId: string;
  authorizationStatus?: string | undefined;
  entitlementAvailability?: string | undefined;
  regionAvailability?: string | undefined;
  /** The agreement's status (`agreementAvailability.status`). */
  agreementStatus?: string | undefined;
}

/** The read-only Bedrock control-plane answer for the route's model: never an invocation. */
export type ModelAccessFacts =
  /** The profile could not read it (AccessDenied on the Get/List call, a network or CLI failure): neither available nor unavailable. */
  | { state: "unverifiable"; reason: string }
  /** Bedrock does not know the model or profile in this account and region. */
  | { state: "not-found"; detail: string }
  /** Bedrock answered. `profileStatus` is set when the route names an inference profile; `models` are the foundation models behind it (or the model itself). */
  | { state: "checked"; profileStatus?: string | undefined; models: ModelAvailabilityFact[] };

export interface ModelRouteCheck {
  route: E2EModelRoute;
  /** Whether the broker's registry holds an approved revision of the route; `unreadable` when it could not be asked. */
  approval: { approved: boolean } | { unreadable: string };
  access: ModelAccessFacts;
  /** The worker instance role's grants (from the deployed foundation stack's template) against the ARNs the route invokes. */
  iam: {
    foundationTemplate: CheckTemplate;
    roleLogicalId: string;
    resources: readonly string[];
    scope: { partition: string; region: string; accountId: string };
  };
}

export interface CheckResult {
  ok: boolean;
  findings: Finding[];
}

const EXPIRY_WINDOW_MS = 24 * 3_600_000;
const CATALOG_KINDS = ["web", "api"] as const;

/** A logical ID without CDK's 8-hex hash and its `Function` or `ServiceRole[DefaultPolicy]` suffix: `SessionsSteps3B98DD2B` is `SessionsSteps`. */
export function findingLabel(logicalId: string): string {
  return logicalId
    .replace(/ServiceRoleDefaultPolicy[0-9A-F]{8}$/, "")
    .replace(/ServiceRole[0-9A-F]{8}$/, "")
    .replace(/[0-9A-F]{8}$/, "")
    .replace(/Function$/, "");
}

export function evaluateTestDeployCheck(input: CheckInput): CheckResult {
  const findings: Finding[] = [
    ...staleLambdas(input),
    ...evaluateIamDrift(input.headTemplate, input.deployedTemplate),
    ...evaluateEnvironmentDrift(input.headTemplate, input.deployedTemplate),
    ...catalogFindings(input.catalogRows, input.now),
    ...runnerFindings(input.runnerFacts),
    ...(input.modelRoute === undefined ? [] : routeFindings(input.modelRoute)),
  ];
  return { ok: findings.every((finding) => finding.severity !== "error"), findings };
}

/**
 * What proves a deployed Lambda runs a test-deploy artifact: its S3Key is `test-deploy/<revision>/<logicalId>-<zip sha256 hex>.zip` and that
 * hash is the CodeSha256 the function reports (base64). The revision is the commit the artifact was built from.
 */
export function parseDeployedCodeKey(s3Key: string | undefined, logicalId: string, codeSha256: string): { revision: string } | { problem: string } {
  if (s3Key === undefined) return { problem: "its template has no literal S3Key to show where the running code came from" };
  const match = /^test-deploy\/([0-9a-f]{7,40})\/([A-Za-z0-9]+)-([0-9a-f]{64})\.zip$/.exec(s3Key);
  if (match === null || match[2] !== logicalId) return { problem: `its S3Key ${s3Key} is not a test-deploy artifact of ${logicalId}` };
  if (Buffer.from(match[3] ?? "", "hex").toString("base64") !== codeSha256) return { problem: `the sha256 in its S3Key ${s3Key} is not the CodeSha256 ${codeSha256} it runs` };
  return { revision: match[1] ?? "" };
}

/** The repo paths a Lambda's bundle comes from: its source inputs (built workspace output mapped back to source), the lockfile for node_modules, and its extra files. */
export function sourcePathsFor(inputs: readonly string[], extraFiles: readonly string[]): string[] {
  const paths = new Set<string>(extraFiles);
  for (const input of inputs) {
    const built = /^(packages\/[^/]+)\/dist\/(.+)\.js$/.exec(input);
    if (input.startsWith("node_modules/")) paths.add("package-lock.json");
    else if (built !== null) {
      paths.add(`${built[1]}/src/${built[2]}.ts`);
      paths.add(`${built[1]}/package.json`);
    } else paths.add(input);
  }
  return [...paths].sort();
}

const sameCommit = (a: string, b: string) => a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a));

/**
 * Provenance first: the running code must be a test-deploy artifact whose key proves its hash. Then currency: the head build is the same zip,
 * or the artifact was built from head, or nothing its bundle comes from changed since. A build that is not byte-reproducible can therefore
 * still be current; code of unknown origin never is.
 */
function staleLambdas(input: CheckInput): Finding[] {
  return Object.entries(input.builtZipShas).flatMap(([logicalId, built]): Finding[] => {
    const deployed = input.lambdaCodeShas[logicalId];
    const stale = (message: string): Finding[] => [{ kind: "stale-lambda", severity: "error", subject: logicalId, label: findingLabel(logicalId), message }];
    if (deployed === undefined) return stale(`${logicalId} has no deployed code hash to compare with the head build (${built})`);
    if (deployed === built) return [];
    const code = input.deployedTemplate.Resources?.[logicalId]?.Properties?.Code as { S3Key?: unknown } | undefined;
    const provenance = parseDeployedCodeKey(typeof code?.S3Key === "string" ? code.S3Key : undefined, logicalId, deployed);
    if ("problem" in provenance) return stale(`${logicalId} runs code of unknown provenance, so it is stale: ${provenance.problem}`);
    const { revision } = provenance;
    if (input.headRevision !== undefined && sameCommit(revision, input.headRevision)) return [];
    const changed = input.inputsChanged?.[logicalId];
    if (changed === false) return [];
    return stale(changed === true
      ? `${logicalId} runs code built at ${revision.slice(0, 12)}, and its inputs changed since`
      : `${logicalId} runs code built at ${revision.slice(0, 12)}, and git cannot tell whether its inputs changed since (is that commit in this clone?)`);
  });
}

// ---------------------------------------------------------------------------------------------
// IAM drift
// ---------------------------------------------------------------------------------------------

/**
 * The text of a template value with what the drift audit normalizes taken out: the asset parameters (named after the code's hash)
 * and the hash of a Lambda version resource (which follows the code). Keys are sorted, so two spellings of one value are equal.
 */
function canonical(node: unknown): string {
  return JSON.stringify(sorted(node));
}
function sorted(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sorted);
  if (node !== null && typeof node === "object") {
    return Object.fromEntries(Object.entries(node).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, sorted(value)]));
  }
  if (typeof node === "string") return node.replace(/AssetParameters[0-9a-f]{64}/g, "AssetParameters<hash>").replace(/(CurrentVersion)[0-9A-Fa-f]{40}/g, "$1<hash>");
  return node;
}
function list(value: unknown): unknown[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

interface Grant {
  key: string;
  effect: unknown;
  condition: unknown;
  action: unknown;
  resource: unknown;
  policyLogicalId: string;
}

/** One grant per effect, condition, action and resource of a statement: statement grouping and order do not matter. */
function grantsOf(policyLogicalId: string, statements: readonly PolicyStatement[]): Grant[] {
  return statements.flatMap((statement) => {
    const actions = statement.NotAction === undefined ? list(statement.Action) : [{ NotAction: statement.NotAction }];
    const resources = statement.NotResource === undefined ? list(statement.Resource) : [{ NotResource: statement.NotResource }];
    return actions.flatMap((action) => resources.map((resource) => ({
      key: canonical({ effect: statement.Effect, condition: statement.Condition ?? null, action, resource }),
      effect: statement.Effect,
      condition: statement.Condition,
      action,
      resource,
      policyLogicalId,
    })));
  });
}

interface PolicySource {
  policyLogicalId: string;
  roleLogicalIds: string[];
  statements: PolicyStatement[];
}

function policyName(inline: unknown): string | undefined {
  const name = (inline as { PolicyName?: unknown } | null)?.PolicyName;
  return typeof name === "string" ? name : undefined;
}

/** Every policy document of the template with the roles it is attached to: AWS::IAM::Policy and ManagedPolicy, and a role's own inline policies. */
function policySources(template: CheckTemplate): PolicySource[] {
  const roleIds = (value: unknown) => list(value).flatMap((role) => (role !== null && typeof role === "object" && typeof (role as { Ref?: unknown }).Ref === "string" ? [(role as { Ref: string }).Ref] : []));
  const statementsOf = (document: unknown): PolicyStatement[] => list((document as { Statement?: unknown } | undefined)?.Statement) as PolicyStatement[];
  return Object.entries(template.Resources ?? {}).flatMap(([logicalId, resource]): PolicySource[] => {
    const properties = resource.Properties ?? {};
    if (resource.Type === "AWS::IAM::Policy" || resource.Type === "AWS::IAM::ManagedPolicy") {
      return [{ policyLogicalId: logicalId, roleLogicalIds: roleIds(properties.Roles), statements: statementsOf(properties.PolicyDocument) }];
    }
    if (resource.Type === "AWS::IAM::Role") {
      return list(properties.Policies).map((inline, index) => ({
        policyLogicalId: `${logicalId}/Policies/${policyName(inline) ?? index}`,
        roleLogicalIds: [logicalId],
        statements: statementsOf((inline as { PolicyDocument?: unknown }).PolicyDocument),
      }));
    }
    return [];
  });
}

/** The grants of each role, pooled over every policy attached to it. */
function grantsByRole(template: CheckTemplate): Map<string, Map<string, Grant>> {
  const byRole = new Map<string, Map<string, Grant>>();
  for (const source of policySources(template)) {
    const grants = grantsOf(source.policyLogicalId, source.statements);
    for (const role of source.roleLogicalIds) {
      const pool = byRole.get(role) ?? new Map<string, Grant>();
      for (const grant of grants) if (!pool.has(grant.key)) pool.set(grant.key, grant);
      byRole.set(role, pool);
    }
  }
  return byRole;
}

/** The statements that grant exactly `grants`: grants sharing an effect, condition and action are joined by resource, then actions with equal resources are joined. */
function statementsFor(grants: readonly Grant[]): PolicyStatement[] {
  const byAction = new Map<string, { effect: unknown; condition: unknown; action: unknown; resources: Map<string, unknown> }>();
  for (const grant of grants) {
    const key = canonical({ effect: grant.effect, condition: grant.condition ?? null, action: grant.action });
    const entry = byAction.get(key) ?? { effect: grant.effect, condition: grant.condition, action: grant.action, resources: new Map<string, unknown>() };
    entry.resources.set(canonical(grant.resource), grant.resource);
    byAction.set(key, entry);
  }
  const merged = new Map<string, { effect: unknown; condition: unknown; actions: unknown[]; resources: unknown[] }>();
  for (const entry of byAction.values()) {
    const resources = [...entry.resources.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
    const key = canonical({ effect: entry.effect, condition: entry.condition ?? null, resources });
    const existing = merged.get(key);
    if (existing) existing.actions.push(entry.action);
    else merged.set(key, { effect: entry.effect, condition: entry.condition, actions: [entry.action], resources });
  }
  return [...merged.values()].map((entry): PolicyStatement => {
    const plain = (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) && ("NotAction" in value || "NotResource" in value);
    const [action] = entry.actions;
    const [resource] = entry.resources;
    return {
      Effect: entry.effect,
      ...(entry.actions.length === 1 && plain(action) ? action as object : { Action: entry.actions.length === 1 ? action : entry.actions }),
      ...(entry.resources.length === 1 && plain(resource) ? resource as object : { Resource: entry.resources }),
      ...(entry.condition === undefined ? {} : { Condition: entry.condition }),
    };
  });
}

/**
 * Head's grants that the deployed role lacks (errors) and the deployed role's grants that head no longer has (warnings), role by role.
 * A grant is an effect, condition, action and resource, so a reordered or regrouped statement is not a difference. Wildcards are
 * not expanded: a deployed `ssm:*` does not stand in for a head `ssm:GetParameters`.
 */
export function evaluateIamDrift(headTemplate: CheckTemplate, deployedTemplate: CheckTemplate): Finding[] {
  const head = grantsByRole(headTemplate);
  const deployed = grantsByRole(deployedTemplate);
  const findings: Finding[] = [];
  for (const roleLogicalId of [...head.keys()].sort()) {
    const has = deployed.get(roleLogicalId) ?? new Map<string, Grant>();
    const missing = [...(head.get(roleLogicalId)?.values() ?? [])].filter((grant) => !has.has(grant.key));
    for (const policyLogicalId of [...new Set(missing.map((grant) => grant.policyLogicalId))].sort()) {
      const grants = missing.filter((grant) => grant.policyLogicalId === policyLogicalId);
      const statements = statementsFor(grants);
      findings.push({
        kind: "iam-missing-grant", severity: "error", subject: policyLogicalId, label: findingLabel(roleLogicalId), roleLogicalId, policyLogicalId, statements,
        message: `${policyLogicalId} of ${roleLogicalId} lacks ${grants.length} grant(s) head needs: ${grants.map((grant) => `${canonical(grant.action)} on ${canonical(grant.resource)}`).join("; ")}`,
      });
    }
  }
  for (const roleLogicalId of [...deployed.keys()].sort()) {
    const wanted = head.get(roleLogicalId) ?? new Map<string, Grant>();
    const extra = [...(deployed.get(roleLogicalId)?.values() ?? [])].filter((grant) => !wanted.has(grant.key));
    for (const policyLogicalId of [...new Set(extra.map((grant) => grant.policyLogicalId))].sort()) {
      const grants = extra.filter((grant) => grant.policyLogicalId === policyLogicalId);
      findings.push({
        kind: "iam-extra-grant", severity: "warning", subject: policyLogicalId, label: findingLabel(roleLogicalId), roleLogicalId, policyLogicalId, statements: statementsFor(grants),
        message: `${policyLogicalId} of ${roleLogicalId} holds ${grants.length} grant(s) head no longer has: ${grants.map((grant) => `${canonical(grant.action)} on ${canonical(grant.resource)}`).join("; ")}`,
      });
    }
  }
  return findings;
}

/**
 * The environment variables head's Lambdas have that the deployed ones lack. A code-only change set never changes Environment, so new code
 * that reads one deploys and then fails at runtime, as the IAM gap did: this needs a stack update first. Only names are compared (values
 * can be intrinsics), and only for a function both templates have.
 */
export function evaluateEnvironmentDrift(headTemplate: CheckTemplate, deployedTemplate: CheckTemplate): Finding[] {
  const names = (resource: { Properties?: Record<string, unknown> } | undefined): string[] | undefined => {
    if (resource === undefined) return undefined;
    const variables = (resource.Properties?.Environment as { Variables?: Record<string, unknown> } | undefined)?.Variables;
    return Object.keys(variables ?? {});
  };
  return Object.entries(headTemplate.Resources ?? {}).flatMap(([logicalId, resource]): Finding[] => {
    if (resource.Type !== "AWS::Lambda::Function") return [];
    const deployedResource = deployedTemplate.Resources?.[logicalId];
    const have = new Set(names(deployedResource));
    const missing = (names(resource) ?? []).filter((name) => deployedResource !== undefined && !have.has(name)).sort();
    if (missing.length === 0) return [];
    return [{
      kind: "lambda-env-missing", severity: "error", subject: logicalId, label: findingLabel(logicalId), missing,
      message: `${logicalId} lacks the environment variable(s) ${missing.join(", ")} that head sets; this needs a control-plane stack update (cdk deploy, or a reviewed guarded change set that edits Environment), because a code-only change set cannot add Environment`,
    }];
  });
}

/** The role each Lambda function of a template runs as. */
export function lambdaRoleIds(template: CheckTemplate): Record<string, string> {
  const roles: Record<string, string> = {};
  for (const [logicalId, resource] of Object.entries(template.Resources ?? {})) {
    if (resource.Type !== "AWS::Lambda::Function") continue;
    const role = resource.Properties?.Role as { "Fn::GetAtt"?: unknown } | undefined;
    const attribute = role?.["Fn::GetAtt"];
    if (Array.isArray(attribute) && typeof attribute[0] === "string") roles[logicalId] = attribute[0];
  }
  return roles;
}

// ---------------------------------------------------------------------------------------------
// Catalog and runner
// ---------------------------------------------------------------------------------------------

function catalogFindings(rows: readonly CatalogRowFact[], now: Date): Finding[] {
  const findings: Finding[] = [];
  for (const kind of CATALOG_KINDS) {
    const kindRows = rows.filter((row) => row.sk.endsWith(`#${kind}`));
    if (kindRows.length === 0) {
      findings.push({ kind: "catalog-not-ready", severity: "error", subject: `#${kind}`, label: kind, message: `the catalog has no #${kind} row, so no ${kind} check can run` });
      continue;
    }
    for (const row of kindRows) {
      if (row.state !== "READY") {
        findings.push({ kind: "catalog-not-ready", severity: "error", subject: row.sk, label: kind, message: `${row.sk} is ${row.state}, not READY` });
        continue;
      }
      const left = Date.parse(row.expiresAt) - now.getTime();
      if (Number.isNaN(left)) findings.push({ kind: "catalog-not-ready", severity: "error", subject: row.sk, label: kind, message: `${row.sk} has an unreadable expiry ${row.expiresAt}` });
      else if (left < EXPIRY_WINDOW_MS) {
        findings.push({
          kind: "catalog-expiring", severity: "error", subject: row.sk, label: kind,
          message: left <= 0 ? `${row.sk} expired at ${row.expiresAt}` : `${row.sk} expires at ${row.expiresAt}, in ${(left / 3_600_000).toFixed(1)} hours`,
        });
      }
    }
  }
  return findings;
}

/** The digest of an image reference (`...@sha256:<hex>`), or undefined for a tag. */
function imageDigest(reference: string | undefined): string | undefined {
  return reference === undefined ? undefined : /@(sha256:[0-9a-f]{64})$/.exec(reference)?.[1];
}

/** What the qualification hook's status.json says about the runner; anything that is not that object reads as no status. */
export interface RunnerStatus {
  state: string;
  reason: string;
  executorImage?: string;
  invocationFeatures?: string[];
}
export function parseRunnerStatus(text: string): RunnerStatus | undefined {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const status = value as Record<string, unknown>;
  if (typeof status.state !== "string" || typeof status.reason !== "string") return undefined;
  const features = status.invocationFeatures;
  return {
    state: status.state,
    reason: status.reason,
    ...(typeof status.executorImage === "string" ? { executorImage: status.executorImage } : {}),
    ...(Array.isArray(features) && features.every((feature) => typeof feature === "string") ? { invocationFeatures: features } : {}),
  };
}

function runnerFindings(facts: RunnerFacts | undefined): Finding[] {
  const findings: Finding[] = [];
  const runner = (kind: "runner-image-mismatch" | "worker-feature-missing", message: string, extra: Partial<Finding> = {}): Finding =>
    ({ kind, severity: "error", subject: "runner", label: "runner", message, ...extra });
  if (facts === undefined) {
    return [
      runner("runner-image-mismatch", "no qualified runner status was found, so its executor image cannot be compared with the deployed ExecutorImageUri"),
      runner("worker-feature-missing", "no qualified runner status was found, so the worker's features are unknown"),
    ];
  }
  const deployed = imageDigest(facts.deployedExecutorImage);
  const running = imageDigest(facts.executorImage);
  if (deployed === undefined) findings.push(runner("runner-image-mismatch", "the deployed ExecutorImageUri is not pinned by digest, so the runner's image cannot be compared with it"));
  else if (running === undefined) findings.push(runner("runner-image-mismatch", "the runner's status does not report an executor image digest; qualify the runner again"));
  else if (running !== deployed) findings.push(runner("runner-image-mismatch", `the runner has executor image ${running}, but ExecutorImageUri is ${deployed}`));
  if (facts.invocationFeatures === undefined) {
    findings.push(runner("worker-feature-missing", "the runner's status does not report the worker's features; qualify the runner again", { missing: [] }));
  } else {
    const have = new Set(facts.invocationFeatures);
    const required = facts.requiredFeatures ?? [...new Set<string>([...WORKER_INVOCATION_FEATURES, AGENT_STEPS_FEATURE])];
    const missing = required.filter((feature) => !have.has(feature));
    if (missing.length > 0) findings.push(runner("worker-feature-missing", `the running worker lacks ${missing.join(", ")} (its /ping does not list them)`, { missing: [...missing] }));
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------
// The e2e model route (M1.4): approval, Bedrock access and the worker role's grants. All from reads; nothing invokes a model.
// ---------------------------------------------------------------------------------------------

function routeFindings(check: ModelRouteCheck): Finding[] {
  const { route } = check;
  const finding = (kind: "model-route-not-approved" | "model-access-unverified", severity: Finding["severity"], message: string): Finding =>
    ({ kind, severity, subject: route.routeId, label: route.routeId, message });
  const findings: Finding[] = [];
  if ("unreadable" in check.approval) {
    findings.push(finding("model-route-not-approved", ROUTE_NOT_APPROVED_SEVERITY, `route ${route.routeId} has no readable approval, so it cannot be called approved: ${check.approval.unreadable}`));
  } else if (!check.approval.approved) {
    findings.push(finding("model-route-not-approved", ROUTE_NOT_APPROVED_SEVERITY, `route ${route.routeId} (${route.modelId}) has no approved revision in the broker's route registry; agent steps stay unavailable until setup approves it`));
  }
  const problem = modelAccessProblem(route, check.access);
  if (problem !== undefined) findings.push(finding("model-access-unverified", "error", problem));
  findings.push(...routeGrantFindings(check.iam, route));
  return findings;
}

/** Why the route's model cannot be called as available in this account and region, or undefined when Bedrock says it is. */
function modelAccessProblem(route: E2EModelRoute, access: ModelAccessFacts): string | undefined {
  const model = route.inferenceProfileArn ?? route.modelId;
  if (access.state === "unverifiable") return `model ${model} is unverifiable here, which is not a pass: ${access.reason}`;
  if (access.state === "not-found") return `model ${model} is not listed as available in this account and region: ${access.detail}`;
  const problems: string[] = [];
  if (access.profileStatus !== undefined && access.profileStatus !== "ACTIVE") problems.push(`the inference profile is ${access.profileStatus}, not ACTIVE`);
  if (access.models.length === 0) problems.push("Bedrock lists no foundation model behind it");
  for (const model of access.models) {
    const bad: string[] = [];
    if (model.authorizationStatus !== "AUTHORIZED") bad.push(`authorization ${model.authorizationStatus ?? "unknown"}`);
    if (model.entitlementAvailability !== "AVAILABLE") bad.push(`entitlement ${model.entitlementAvailability ?? "unknown"}`);
    if (model.regionAvailability !== "AVAILABLE") bad.push(`region availability ${model.regionAvailability ?? "unknown"}`);
    // NOT_AVAILABLE can mean the model needs no agreement; only a pending or failed one blocks.
    if (model.agreementStatus === "PENDING" || model.agreementStatus === "ERROR") bad.push(`agreement ${model.agreementStatus}`);
    if (bad.length > 0) problems.push(`${model.modelId}: ${bad.join(", ")}`);
  }
  return problems.length === 0 ? undefined : `model ${model} is not available to this account: ${problems.join("; ")}`;
}

type IamScope = ModelRouteCheck["iam"]["scope"];

/** The text of an ARN or action value, with the pseudo parameters of the deployed template filled in; undefined for anything else (GetAtt, an imported value). */
function resolveText(node: unknown, scope: IamScope): string | undefined {
  const pseudo: Record<string, string> = { "AWS::Partition": scope.partition, "AWS::Region": scope.region, "AWS::AccountId": scope.accountId };
  if (typeof node === "string") return node;
  if (node === null || typeof node !== "object") return undefined;
  const intrinsic = node as { Ref?: unknown; "Fn::Join"?: unknown; "Fn::Sub"?: unknown };
  if (typeof intrinsic.Ref === "string") return pseudo[intrinsic.Ref];
  const join = intrinsic["Fn::Join"];
  if (Array.isArray(join) && typeof join[0] === "string" && Array.isArray(join[1])) {
    const parts = join[1].map((part) => resolveText(part, scope));
    return parts.every((part) => part !== undefined) ? parts.join(join[0]) : undefined;
  }
  if (typeof intrinsic["Fn::Sub"] === "string") {
    const text = intrinsic["Fn::Sub"].replace(/\$\{(AWS::[A-Za-z]+)\}/g, (whole, name: string) => pseudo[name] ?? whole);
    return text.includes("${") ? undefined : text;
  }
  return undefined;
}

const globMatches = (pattern: string, value: string, flags = ""): boolean =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, flags).test(value);

/**
 * Whether one statement applies to `action` on `resource`: yes, no, or maybe when it cannot be told. A Condition is not evaluated, and a
 * resource written as something this cannot resolve (GetAtt, an import) has no text to match. An Allow that is conditional or unresolved
 * never counts as a grant (it errs toward alarm). A Deny that is conditional or unresolved while its action matches is "maybe": it might
 * block the call, so the caller must not report a pass.
 */
function statementMatch(statement: PolicyStatement, action: string, resource: string, scope: IamScope): "yes" | "no" | "maybe" {
  const actions = list(statement.NotAction ?? statement.Action).filter((value): value is string => typeof value === "string");
  const actionHit = actions.some((pattern) => globMatches(pattern, action, "i"));
  if (statement.NotAction === undefined ? !actionHit : actionHit) return "no";
  const resolved = list(statement.NotResource ?? statement.Resource).map((value) => resolveText(value, scope));
  const resourceHit = resolved.some((pattern) => pattern !== undefined && globMatches(pattern, resource));
  const resolvable = resolved.every((pattern) => pattern !== undefined);
  // NotResource applies to everything its patterns do not name; with an unresolved pattern it cannot be told.
  const resourceMatch: "yes" | "no" | "maybe" = statement.NotResource === undefined
    ? (resourceHit ? "yes" : resolvable ? "no" : "maybe")
    : (!resolvable ? "maybe" : resourceHit ? "no" : "yes");
  if (resourceMatch === "no") return "no";
  if (statement.Effect === "Allow") return resourceMatch === "yes" && statement.Condition === undefined ? "yes" : "no";
  return resourceMatch === "yes" && statement.Condition === undefined ? "yes" : "maybe";
}

/**
 * The findings for the worker instance role against the actions and ARNs the route invokes: an iam-missing-grant when it lacks some, and a
 * model-access-unverified when a conditional or unresolved Deny might block one it otherwise holds (that is unverifiable, never a pass).
 */
function routeGrantFindings(iam: ModelRouteCheck["iam"], route: E2EModelRoute): Finding[] {
  const sources = policySources(iam.foundationTemplate).filter((source) => source.roleLogicalIds.includes(iam.roleLogicalId));
  const statements = sources.flatMap((source) => source.statements);
  const verdict = (action: string, resource: string): "granted" | "missing" | "maybe-denied" => {
    const matches = statements.map((statement) => ({ statement, match: statementMatch(statement, action, resource, iam.scope) }));
    const allowed = matches.some(({ statement, match }) => statement.Effect === "Allow" && match === "yes");
    if (!allowed || matches.some(({ statement, match }) => statement.Effect === "Deny" && match === "yes")) return "missing";
    return matches.some(({ statement, match }) => statement.Effect === "Deny" && match === "maybe") ? "maybe-denied" : "granted";
  };
  const checked = iam.resources.map((resource) => ({ resource, verdicts: ROUTE_INVOKE_ACTIONS.map((action) => ({ action, verdict: verdict(action, resource) })) }));
  const findings: Finding[] = [];
  const lacking = checked.map((entry) => ({ resource: entry.resource, actions: entry.verdicts.filter((item) => item.verdict === "missing").map((item) => item.action) })).filter((entry) => entry.actions.length > 0);
  if (lacking.length > 0) {
    const byActions = new Map<string, { actions: string[]; resources: string[] }>();
    for (const entry of lacking) {
      const key = entry.actions.join(",");
      const group = byActions.get(key) ?? { actions: [...entry.actions], resources: [] };
      group.resources.push(entry.resource);
      byActions.set(key, group);
    }
    const holder = sources.find((source) => source.statements.some((statement) => statement.Sid === "BedrockModelInvocation")) ?? sources[0];
    const policyLogicalId = holder?.policyLogicalId ?? `${iam.roleLogicalId}DefaultPolicy`;
    findings.push({
      kind: "iam-missing-grant", severity: "error", subject: policyLogicalId, label: findingLabel(iam.roleLogicalId), roleLogicalId: iam.roleLogicalId, policyLogicalId,
      statements: [...byActions.values()].map((group): PolicyStatement => ({ Effect: "Allow", Action: group.actions.length === 1 ? group.actions[0] : group.actions, Resource: group.resources })),
      message: `${iam.roleLogicalId}, the worker instance role, lacks ${lacking.map((entry) => `${entry.actions.join(" and ")} on ${entry.resource}`).join("; ")}, which the e2e model route invokes`,
    });
  }
  const maybe = checked.filter((entry) => entry.verdicts.some((item) => item.verdict === "maybe-denied")).map((entry) => entry.resource);
  if (maybe.length > 0) {
    findings.push({
      kind: "model-access-unverified", severity: "error", subject: route.routeId, label: route.routeId,
      message: `whether ${iam.roleLogicalId}, the worker instance role, may invoke ${maybe.join("; ")} is unverifiable, which is not a pass: a Deny statement with a Condition or a resource this check cannot resolve might block it`,
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------

export function formatFindings(findings: readonly Finding[]): string {
  if (findings.length === 0) return "TEST deploy check: no findings.";
  const ordered = [...findings].sort((a, b) => Number(b.severity === "error") - Number(a.severity === "error"));
  const errors = findings.filter((finding) => finding.severity === "error").length;
  return [
    `TEST deploy check: ${errors} error(s), ${findings.length - errors} warning(s)`,
    ...ordered.map((finding) => `  ${finding.severity} ${finding.kind} ${finding.label}: ${finding.message}`),
  ].join("\n");
}

/** The text of a Tier 3 request for the grants head needs: the policy of each finding and the exact statements to add to it. */
export function tier3Request(findings: readonly Finding[]): string {
  return findings.filter((finding) => finding.kind === "iam-missing-grant").map((finding) =>
    `Add to ${finding.policyLogicalId ?? finding.subject} (role ${finding.roleLogicalId ?? "unknown"}):\n${JSON.stringify(finding.statements ?? [], null, 2)}`).join("\n\n");
}
