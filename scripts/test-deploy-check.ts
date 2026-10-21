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
  | "catalog-not-ready"
  | "catalog-expiring"
  | "runner-image-mismatch"
  | "worker-feature-missing";

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
  /** worker-feature-missing: the feature strings. */
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
    ...catalogFindings(input.catalogRows, input.now),
    ...runnerFindings(input.runnerFacts),
  ];
  return { ok: findings.every((finding) => finding.severity !== "error"), findings };
}

function staleLambdas(input: CheckInput): Finding[] {
  return Object.entries(input.builtZipShas).flatMap(([logicalId, built]) => {
    const deployed = input.lambdaCodeShas[logicalId];
    if (deployed === built) return [];
    const message = deployed === undefined
      ? `${logicalId} has no deployed code hash to compare with the head build (${built})`
      : `${logicalId} runs ${deployed}, but the head build is ${built}`;
    return [{ kind: "stale-lambda", severity: "error", subject: logicalId, label: findingLabel(logicalId), message } satisfies Finding];
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
    const missing = (facts.requiredFeatures ?? WORKER_INVOCATION_FEATURES).filter((feature) => !have.has(feature));
    if (missing.length > 0) findings.push(runner("worker-feature-missing", `the running worker lacks ${missing.join(", ")} (its /ping does not list them)`, { missing: [...missing] }));
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
