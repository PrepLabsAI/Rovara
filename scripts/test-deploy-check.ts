// The pure half of `test-deploy --check`: what is wrong with a TEST installation before a deploy or a demo.
//
// Four classes of problem were found only live in the M1.2 demo, and this finds each of them from facts a read-only gatherer
// collects: control-plane Lambdas left on old code, an IAM grant head needs that the deployed role lacks, READY catalog rows that
// expired or changed state, and a runner or worker that does not match this build. Nothing here reads or writes anything.
//
// M1.4 adds the e2e agent's model route, which follows the installation's provider (amendment A1): Bedrock through the worker's
// instance role, or Anthropic, OpenAI or OpenRouter through the provider key's Secrets Manager ARN. Nothing here calls a model, and
// nothing reads a secret: a key's validity and a customer-managed KMS key are reported as unverifiable (owner decision O6).
import { E2E_AGENT_BEDROCK_QUOTA_CODES, E2E_AGENT_RECOMMENDED_MODELS, eligibleE2EAgentModel } from "../packages/contracts/src/e2e-agent-models.js";
import { E2E_RUNTIME_GENERIC_RENEW_COMMAND, e2eRuntimeExpiryNotice } from "../packages/contracts/src/e2e-runtime-expiry.js";
import { KEYED_MODEL_PROVIDERS, SECRET_ARN_MAX_LENGTH, SECRET_ARN_PATTERN, isKeyedModelProvider, type KeyedModelProvider, type ModelProvider } from "../packages/contracts/src/model-providers.js";
import { WORKER_INVOCATION_FEATURES } from "../packages/contracts/src/protocol.js";
import { listPricesPerMillion } from "../packages/model-runtime/src/catalog.js";
import { DEFAULT_E2E_AGENT_MODELS, requireKeyedModel } from "../packages/model-runtime/src/config.js";

/** A CloudFormation template as far as the check reads it. Structurally the same as test-deploy's `CfnTemplate`. */
export interface CheckTemplate {
  Resources?: Record<string, { Type?: string; Properties?: Record<string, unknown>; [key: string]: unknown }>;
  [key: string]: unknown;
}

export type FindingKind =
  | "stale-lambda"
  | "iam-missing-grant"
  | "iam-extra-grant"
  | "iam-explicit-deny"
  | "lambda-env-missing"
  | "catalog-not-ready"
  | "catalog-expiring"
  | "runner-image-mismatch"
  | "worker-feature-missing"
  | "model-route-not-approved"
  | "model-access-unverified"
  | "model-agreement-missing"
  | "model-not-in-catalog"
  | "model-route-secret-missing"
  | "model-route-openrouter-allowlist"
  | "model-route-alias-refused"
  | "model-route-third-party-processor"
  | "model-route-choice-unsupported"
  | "model-route-not-tested"
  | "model-quota-zero"
  | "model-quota-unverified";

/** The worker feature string for `agent` steps (M1.4). A running worker must list it on /ping before an agent step can be dispatched to it. */
export const AGENT_STEPS_FEATURE = "task.workflowE2EAgentSteps.v1";

/** The e2e model route as head pins it (decision D1, amendment A1): the installation's provider and that provider's small model, no fallback. */
export interface E2EModelRoute {
  routeId: string;
  provider: ModelProvider;
  modelId: string;
}
export const E2E_MODEL_ROUTE_ID = "rovara-e2e-default";
/**
 * The route for an installation on `provider`: the model is the installation's choice (`worker-e2e-agent-model`, Task 4.10) when it made one, else
 * `DEFAULT_E2E_AGENT_MODELS[provider]`, which the worker pins at setup approval. Whether a choice is a model Rovara can use is judged apart (`e2eModelChoice`).
 */
export function deriveE2EModelRoute(provider: ModelProvider, chosenModel?: string): E2EModelRoute {
  return { routeId: E2E_MODEL_ROUTE_ID, provider, modelId: chosenModel ?? DEFAULT_E2E_AGENT_MODELS[provider] };
}

/**
 * What the installation's `worker-e2e-agent-model` setting says: no choice (absent, `none`, `default`), a model the table of eligible AI navigation models lists for the
 * provider and region, or one it does not (an error: the broker would derive no route from it).
 */
export function e2eModelChoice(provider: ModelProvider, setting: string | undefined, region: string): ModelChoiceFacts {
  const value = setting?.trim();
  if (value === undefined || value === "" || value === "none" || value === "default") return { state: "recommended" };
  if (value === E2E_AGENT_RECOMMENDED_MODELS[provider]) return { state: "recommended" };
  return eligibleE2EAgentModel(provider, value, region) === null ? { state: "unsupported", setting: value } : { state: "chosen", modelId: value };
}
/** TEST's route: TEST runs Bedrock. The gatherer derives the real one from the installation's `worker-model-provider` setting. */
export const E2E_MODEL_ROUTE: E2EModelRoute = deriveE2EModelRoute("amazon-bedrock");
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
  /** A warning never fails the check, and information (`info`) only tells what a read-only check cannot see. */
  severity: "error" | "warning" | "info";
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
  /** The exact command that qualifies the runtime again, for the findings that need it (RUN-3). A generic one with `<env>` and `<aws-profile>` is shown when it is not given. */
  renewCommand?: string | undefined;
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

/** A SSM worker setting as read: its value (undefined when the parameter does not exist), or why it could not be read. */
export type SettingFact = { state: "read"; value: string | undefined } | { state: "unverifiable"; reason: string };

/** The deployed IAM scope of a template: the pseudo parameters, and the stack's own parameter values for the control-plane template's Refs. */
export interface IamScope {
  partition: string;
  region: string;
  accountId: string;
  parameters?: Readonly<Record<string, string>> | undefined;
}

/** The installation's provider as its `worker-model-provider` setting says, and so the route derived from it; or why it could not be read. */
export type RouteProviderFacts = { state: "known"; route: E2EModelRoute } | { state: "unverifiable"; reason: string };

/** amazon-bedrock: what Bedrock's control plane says about the route's model, and the worker role's grants (from the deployed foundation stack's template). */
export interface BedrockRouteFacts {
  access: ModelAccessFacts;
  /** The worker instance role's grants against the ARNs the route invokes: the inference profile and the foundation model in every Region it routes to. */
  iam: {
    foundationTemplate: CheckTemplate;
    roleLogicalId: string;
    resources: readonly string[];
    scope: IamScope;
  };
}

/** anthropic, openai, openrouter: the secret ARN setting, and the worker role's grants on it. Never the secret. */
export interface KeyedRouteFacts {
  secretArn: SettingFact;
  /** openrouter only: `worker-openrouter-providers`, the allowlist of upstream providers. */
  openRouterProviders?: SettingFact | undefined;
  iam: {
    foundationTemplate: CheckTemplate;
    /** The worker instance role in the foundation template, and its name as the deployed control-plane stack attaches policies to it. */
    roleLogicalId: string;
    roleName: string;
    /** The deployed control-plane template, which holds the `<constructPrefix>SecretRead` policies, and the stack's parameters for its Refs (in `scope`). */
    controlPlaneTemplate: CheckTemplate;
    scope: IamScope;
  };
}

/** The installation's choice of AI navigation model (Task 4.10): see `e2eModelChoice`; `unverifiable` when the setting could not be read. */
export type ModelChoiceFacts =
  | { state: "recommended" }
  | { state: "chosen"; modelId: string }
  | { state: "unsupported"; setting: string }
  | { state: "unverifiable"; reason: string };

/** One Bedrock tokens-per-minute quota: its code and value. */
export interface QuotaValue {
  code: string;
  tokensPerMinute: number;
}

/** The Bedrock tokens-per-minute quotas for the route's model: the cross-region (geographic) one and the global one; null where none matched. A lookup is a hint, never a state. */
export type QuotaFacts =
  | { state: "unverifiable"; reason: string }
  | { state: "read"; geographic: QuotaValue | null; global: QuotaValue | null };

export interface ModelRouteCheck {
  /** The installation's AI navigation model choice. Undefined (a check built before Task 4.10) is no choice. */
  choice?: ModelChoiceFacts | undefined;
  /** amazon-bedrock: the tokens-per-minute quotas of the route's model, read with servicequotas:ListServiceQuotas. Undefined skips the hint. */
  quota?: QuotaFacts | undefined;
  /** Whether a passing driving test (`E2E_MODEL_ROUTE_CANARY` row with `test: "driving/v1"`) exists for the exact definition the installation would approve. Undefined skips the check. */
  tested?: { tested: boolean } | { unreadable: string } | undefined;
  provider: RouteProviderFacts;
  /** Whether the broker's registry holds an approved revision of the route; `unreadable` when it could not be asked. */
  approval: { approved: boolean } | { unreadable: string };
  /** Present for amazon-bedrock. */
  bedrock?: BedrockRouteFacts | undefined;
  /** Present for a keyed provider. */
  keyed?: KeyedRouteFacts | undefined;
}

export interface CheckResult {
  ok: boolean;
  findings: Finding[];
}

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
    ...catalogFindings(input.catalogRows, input.now, input.renewCommand),
    ...runnerFindings(input.runnerFacts, input.renewCommand),
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
  return JSON.stringify(sorted(node, true));
}
/** The same without ARN-spelling normalization: what a person reads in a message. */
function plain(node: unknown): string {
  return JSON.stringify(sorted(node, false));
}
function sorted(node: unknown, normalize: boolean): unknown {
  const arn = normalize ? normalizedArn(node) : undefined;
  if (arn !== undefined) return arn;
  if (Array.isArray(node)) return node.map((item) => sorted(item, normalize));
  if (node !== null && typeof node === "object") {
    return Object.fromEntries(Object.entries(node).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, sorted(value, normalize)]));
  }
  if (typeof node === "string") return scrub(node);
  return node;
}
const scrub = (text: string): string => text.replace(/AssetParameters[0-9a-f]{64}/g, "AssetParameters<hash>").replace(/(CurrentVersion)[0-9A-Fa-f]{40}/g, "$1<hash>");

// ARN spellings. Head (`cdk synth`) and the deployed stack (the legacy synthesizer) can spell one ARN differently, and that gave
// false iam-missing-grant/iam-extra-grant pairs that blocked --apply until a person read them (Task 3.0, review m1). Only the comparison
// key is normalized, never the statements a Tier 3 request prints. Spellings that cannot be proven equal stay different: GetAtt Arn
// against a joined ARN, and a literal versioned function ARN.
type Part = string | { Ref: string } | Record<string, unknown>;
const PARTITION_REF = { Ref: "AWS::Partition" };

/** Fn::Sub as parts: `${AWS::Region}` and `${LogicalId}` are Refs and `${LogicalId.Attr}` a GetAtt; the array form and `${!escapes}` are left alone. */
function subParts(text: string): Part[] | undefined {
  if (text.includes("${!")) return undefined;
  const parts: Part[] = [];
  let last = 0;
  for (const match of text.matchAll(/\$\{([^}]+)\}/g)) {
    parts.push(text.slice(last, match.index));
    const [name = "", ...attribute] = match[1]?.split(".") ?? [];
    parts.push(attribute.length === 0 ? { Ref: name } : { "Fn::GetAtt": [name, attribute.join(".")] });
    last = (match.index ?? 0) + match[0].length;
  }
  parts.push(text.slice(last));
  return parts;
}

/** A Fn::Join or Fn::Sub as a flat list of parts (nested joins and subs flattened), or undefined for anything else. */
function flatParts(node: unknown): Part[] | undefined {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return undefined;
  const keys = Object.keys(node);
  if (keys.length !== 1) return undefined;
  const sub = (node as { "Fn::Sub"?: unknown })["Fn::Sub"];
  if (typeof sub === "string") return subParts(sub)?.flatMap((part) => flatParts(part) ?? [part]);
  const join = (node as { "Fn::Join"?: unknown })["Fn::Join"];
  if (!Array.isArray(join) || typeof join[0] !== "string" || !Array.isArray(join[1])) return undefined;
  const [delimiter, items] = join as [string, unknown[]];
  return items.flatMap((item, index): Part[] => {
    const inner = flatParts(item);
    const parts: Part[] = inner ?? [item as Part];
    return index === 0 || delimiter === "" ? parts : [delimiter, ...parts];
  });
}

function mergeStrings(parts: readonly Part[]): Part[] {
  const merged: Part[] = [];
  for (const part of parts) {
    const previous = merged[merged.length - 1];
    if (typeof part === "string" && typeof previous === "string") merged[merged.length - 1] = previous + part;
    else if (typeof part !== "string" || part !== "") merged.push(part);
  }
  return merged;
}

/** The canonical form of an ARN-like value: one flat Fn::Join of merged literals and intrinsics, with a literal `arn:aws:` written as `arn:` + Ref AWS::Partition. */
function normalizedArn(node: unknown): unknown {
  let parts: Part[] | undefined;
  if (typeof node === "string") {
    if (!node.startsWith("arn:aws:")) return undefined;
    parts = [node];
  } else parts = flatParts(node);
  if (parts === undefined) return undefined;
  let merged = mergeStrings(parts);
  const [first, ...rest] = merged;
  if (typeof first === "string" && first.startsWith("arn:aws:")) merged = mergeStrings(["arn:", PARTITION_REF, `:${first.slice("arn:aws:".length)}`, ...rest]);
  if (merged.length === 1 && typeof merged[0] === "string") return scrub(merged[0]);
  return { "Fn::Join": ["", merged.map((part) => (typeof part === "string" ? scrub(part) : sorted(part, true)))] };
}

/**
 * What the IAM comparison does not evaluate, for the check's notes. It compares policy documents template against template, so a role's
 * ManagedPolicyArns and PermissionsBoundary, resource policies (Lambda permissions, bucket and key policies) and out-of-band edits are
 * invisible to it (Task 3.0, review m1). The roles that attach managed policies or a boundary are named, because a change there is missed.
 */
export function iamEvaluationNotes(headTemplate: CheckTemplate, deployedTemplate: CheckTemplate): string[] {
  const attaching = (template: CheckTemplate): string[] => Object.entries(template.Resources ?? {})
    .filter(([, resource]) => resource.Type === "AWS::IAM::Role" && (list(resource.Properties?.ManagedPolicyArns).length > 0 || resource.Properties?.PermissionsBoundary !== undefined))
    .map(([logicalId]) => logicalId);
  const roles = [...new Set([...attaching(headTemplate), ...attaching(deployedTemplate)])].sort();
  return [
    "IAM note: the grants are compared as policy documents, template against template. A role's ManagedPolicyArns and PermissionsBoundary, resource policies and out-of-band edits to the deployed roles are not evaluated.",
    // Most Lambda roles attach the basic execution policy, so the list is bounded.
    ...(roles.length === 0 ? [] : [`IAM note: ${roles.length} role(s) attach managed policies or a permissions boundary, so a change there is not seen: ${roles.slice(0, 5).join(", ")}${roles.length > 5 ? `, and ${roles.length - 5} more` : ""}`]),
  ];
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
        message: `${policyLogicalId} of ${roleLogicalId} lacks ${grants.length} grant(s) head needs: ${grants.map((grant) => `${plain(grant.action)} on ${plain(grant.resource)}`).join("; ")}`,
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
        message: `${policyLogicalId} of ${roleLogicalId} holds ${grants.length} grant(s) head no longer has: ${grants.map((grant) => `${plain(grant.action)} on ${plain(grant.resource)}`).join("; ")}`,
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

function catalogFindings(rows: readonly CatalogRowFact[], now: Date, renewCommand?: string): Finding[] {
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
      // Within 24 hours (or already expired, or unreadable) it fails the check; within 48 hours it warns (RUN-3). Either names the time and the command that renews it.
      const notice = e2eRuntimeExpiryNotice({ subject: row.sk, expiresAt: row.expiresAt, now: now.getTime(), renewCommand });
      if (notice === undefined) continue;
      const unreadable = Number.isNaN(Date.parse(row.expiresAt));
      findings.push({ kind: unreadable ? "catalog-not-ready" : "catalog-expiring", severity: notice.severity, subject: row.sk, label: kind, message: notice.message });
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

function runnerFindings(facts: RunnerFacts | undefined, renewCommand?: string): Finding[] {
  const findings: Finding[] = [];
  // An image or feature mismatch means the qualification no longer stands for what is deployed: the way on is the same renewal (RUN-3).
  const renew = `; renew it with: ${renewCommand ?? E2E_RUNTIME_GENERIC_RENEW_COMMAND}`;
  const runner = (kind: "runner-image-mismatch" | "worker-feature-missing", message: string, extra: Partial<Finding> = {}): Finding =>
    ({ kind, severity: "error", subject: "runner", label: "runner", message: `${message}${renew}`, ...extra });
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
// The e2e model route (M1.4, amendment A1): approval, then what the installation's provider needs. All from reads; nothing invokes a model
// and nothing reads a secret.
// ---------------------------------------------------------------------------------------------

type Maker = (kind: FindingKind, severity: Finding["severity"], message: string) => Finding;

function routeFindings(check: ModelRouteCheck): Finding[] {
  const finding: Maker = (kind, severity, message) => ({ kind, severity, subject: E2E_MODEL_ROUTE_ID, label: E2E_MODEL_ROUTE_ID, message });
  const findings: Finding[] = [];
  const known = check.provider.state === "known" ? check.provider.route : undefined;
  const routeText = known === undefined ? `route ${E2E_MODEL_ROUTE_ID}` : `route ${E2E_MODEL_ROUTE_ID} (${known.provider} ${known.modelId})`;
  if ("unreadable" in check.approval) {
    findings.push(finding("model-route-not-approved", ROUTE_NOT_APPROVED_SEVERITY, `${routeText} has no readable approval, so it cannot be called approved: ${check.approval.unreadable}`));
  } else if (!check.approval.approved) {
    findings.push(finding("model-route-not-approved", ROUTE_NOT_APPROVED_SEVERITY, `${routeText} has no approved revision in the broker's route registry; agent steps stay unavailable until setup approves it`));
  }
  if (check.provider.state === "unverifiable") {
    findings.push(finding("model-access-unverified", "error", `the installation's model provider is unverifiable, which is not a pass: ${check.provider.reason}`));
    return findings;
  }
  const { route } = check.provider;
  if (check.choice?.state === "unverifiable") {
    findings.push(finding("model-access-unverified", "error", `the installation's AI navigation model setting is unverifiable, which is not a pass: ${check.choice.reason}`));
    return findings;
  }
  if (check.choice?.state === "unsupported") {
    findings.push(finding("model-route-choice-unsupported", "error",
      `worker-e2e-agent-model is ${JSON.stringify(check.choice.setting)}, which is not a model Rovara can use with ${providerLabel(route.provider)} in this region, so the broker derives no AI navigation route from it; set a listed model, or default, with agentx config set models.e2eAgent`));
    return findings;
  }
  if (check.tested !== undefined) {
    const untested = "unreadable" in check.tested ? `could not be read (${check.tested.unreadable})` : check.tested.tested ? undefined : "has no passing driving test on this installation";
    if (untested !== undefined) {
      findings.push(finding("model-route-not-tested", "warning", `${routeText} ${untested}; AI navigation steps will not run until the driving test passes (agentx project model-check test)`));
    }
  }
  if (check.quota !== undefined) findings.push(...quotaFindings(route, check.quota, finding));
  // An OpenRouter alias is refused on its own finding; asking the catalog about it would only repeat that.
  const alias = route.provider === "openrouter" && isOpenRouterAlias(route.modelId);
  const catalog = alias ? undefined : catalogProblem(route);
  if (catalog !== undefined) findings.push(finding("model-not-in-catalog", "error", catalog));
  if (route.provider === "amazon-bedrock") {
    if (check.bedrock === undefined) findings.push(finding("model-access-unverified", "error", `Bedrock's answer for ${route.modelId} was not gathered, which is not a pass`));
    else findings.push(...bedrockFindings(route, check.bedrock, finding));
  } else if (check.keyed === undefined) {
    findings.push(finding("model-access-unverified", "error", `the ${KEYED_MODEL_PROVIDERS[route.provider].label} secret setting and the worker role's grants were not gathered, which is not a pass`));
  } else {
    findings.push(...keyedFindings(route, route.provider, check.keyed, finding));
  }
  return findings;
}

const providerLabel = (provider: ModelProvider): string => (isKeyedModelProvider(provider) ? KEYED_MODEL_PROVIDERS[provider].label : "Amazon Bedrock");

const quotaText = (name: string, quota: QuotaValue | null): string => (quota === null ? `${name} no matching quota` : `${name} ${quota.tokensPerMinute.toLocaleString("en-US")} (${quota.code})`);

/**
 * The Bedrock tokens-per-minute limits of the route's model, as a hint and never an error: a 0 for the route's own scope is a warning that names both scopes and their codes
 * (a Bedrock quota of 0 refuses every call at once, which TEST showed for Haiku 5.5), and a lookup that was denied or found nothing is information.
 */
function quotaFindings(route: E2EModelRoute, quota: QuotaFacts, finding: Maker): Finding[] {
  if (route.provider !== "amazon-bedrock") return [];
  if (quota.state === "unverifiable") return [finding("model-quota-unverified", "info", `the Bedrock tokens-per-minute limit for ${route.modelId} could not be read (${quota.reason}); a limit of 0 would show at the driving test instead`)];
  const own = route.modelId.startsWith("global.") ? "global" : "geographic";
  if (quota.geographic === null && quota.global === null) {
    return [finding("model-quota-unverified", "info", `no Bedrock tokens-per-minute quota was found for ${route.modelId} by code or by name; a limit of 0 would show at the driving test instead`)];
  }
  const owned = quota[own];
  if (owned === null || owned.tokensPerMinute !== 0) return [];
  return [finding("model-quota-zero", "warning",
    `the Bedrock limit for ${route.modelId} in ${own === "global" ? "the Global scope" : "this geography"} is 0 tokens per minute (${owned.code}), so Bedrock refuses every call; ${quotaText("US-only/geographic limit", quota.geographic)}; ${quotaText("Global limit", quota.global)}; raise the limit, or choose another model with agentx config set models.e2eAgent`)];
}

/**
 * Matches the quota rows a `service-quotas list-service-quotas --service-code bedrock` read returned (`[code, name, value]`) to a route's model: by the pinned codes of
 * `E2E_AGENT_BEDROCK_QUOTA_CODES` when the model is listed there, else by name ("Cross-region model inference tokens per minute for <model name>" and the "Global ..." one,
 * <model name> being the catalog's label without its scope). A quota that matches nothing is null: never a state.
 */
export function matchBedrockQuotas(rows: ReadonlyArray<readonly [string, string, number]>, route: E2EModelRoute, label: string | undefined): { geographic: QuotaValue | null; global: QuotaValue | null } {
  const foundation = route.modelId.replace(/^(us-gov|us|eu|apac|global|jp|au|in|ca)\./, "");
  const pinned = E2E_AGENT_BEDROCK_QUOTA_CODES[foundation];
  const model = (label ?? "").replace(/\s*\((?:US|Global|EU|APAC|JP|AU|IN|CA)[^)]*\)\s*$/i, "").trim().toLowerCase();
  const find = (code: string | null | undefined, prefix: string): QuotaValue | null => {
    const byCode = code === null || code === undefined ? undefined : rows.find((row) => row[0] === code);
    const byName = byCode !== undefined || model === "" ? byCode : rows.find((row) => { const name = row[1].toLowerCase(); return name.startsWith(prefix) && name.slice(prefix.length).includes(model); });
    return byName === undefined ? null : { code: byName[0], tokensPerMinute: byName[2] };
  };
  return {
    geographic: find(pinned?.geographic, "cross-region model inference tokens per minute for "),
    global: find(pinned?.global, "global cross-region model inference tokens per minute for "),
  };
}

/** A router alias, not a model: `~` aliases (`~anthropic/claude-haiku-latest`) and `openrouter/` routers (`openrouter/auto`). Pi's catalog refuses both. */
const isOpenRouterAlias = (modelId: string): boolean => modelId.startsWith("~") || modelId.startsWith("openrouter/");

/** Why the pinned pi catalog does not know the route's default model, or undefined when it does. */
function catalogProblem(route: E2EModelRoute): string | undefined {
  const text = `${route.provider} model ${route.modelId} is not in the installed pi catalog, so the e2e agent cannot be routed to it; update AgentX or choose another default`;
  try {
    if (isKeyedModelProvider(route.provider)) requireKeyedModel(route.provider, route.modelId);
    else if (listPricesPerMillion({ provider: route.provider, modelId: route.modelId }) === undefined) return text;
    return undefined;
  } catch {
    return text;
  }
}

// ---- amazon-bedrock ----

function bedrockFindings(route: E2EModelRoute, bedrock: BedrockRouteFacts, finding: Maker): Finding[] {
  const findings: Finding[] = [];
  const problem = modelAccessProblem(route, bedrock.access);
  if (problem !== undefined) findings.push(finding("model-access-unverified", "error", problem));
  const agreement = agreementProblem(bedrock.access);
  if (agreement !== undefined) findings.push(finding("model-agreement-missing", "error", agreement));
  findings.push(...routeGrantFindings(bedrock.iam, route));
  return findings;
}

/** Why the route's model cannot be called as available in this account and region, or undefined when Bedrock says it is. The agreement is judged apart (M4-U). */
function modelAccessProblem(route: E2EModelRoute, access: ModelAccessFacts): string | undefined {
  const model = route.modelId;
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
    if (bad.length > 0) problems.push(`${model.modelId}: ${bad.join(", ")}`);
  }
  return problems.length === 0 ? undefined : `model ${model} is not available to this account: ${problems.join("; ")}`;
}

/**
 * Ruling M4-U: the agreement must be AVAILABLE. Live TEST showed anthropic.claude-haiku-5-5 AUTHORIZED, entitled and available in the
 * Region, yet an invocation was denied because agreementAvailability.status was NOT_AVAILABLE. Any other status (PENDING, ERROR, NOT_AVAILABLE,
 * or none reported) is an error, which overrides the earlier review's "do not tighten".
 */
function agreementProblem(access: ModelAccessFacts): string | undefined {
  if (access.state !== "checked") return undefined;
  const problems = access.models.filter((model) => model.agreementStatus !== "AVAILABLE")
    .map((model) => `${model.modelId}: agreement ${model.agreementStatus ?? "unknown"}`);
  return problems.length === 0 ? undefined
    : `the model agreement is not AVAILABLE, so Bedrock denies invocation even though the model reads as authorized (${problems.join("; ")}); accept the model's agreement in this account first`;
}

type IamVerdict = "granted" | "missing" | "denied" | "maybe-denied";

/** Whether the statements allow `action` on `resource`: a definite Deny, no matching Allow, a Deny that might match, or granted. */
function iamVerdict(statements: readonly PolicyStatement[], action: string, resource: string, scope: IamScope): IamVerdict {
  const classified = statements.map((statement) => classifyStatement(statement, action, resource, scope));
  if (classified.some(({ effect, match }) => effect === "deny" && match === "yes")) return "denied";
  if (!classified.some(({ effect, match }) => effect === "allow" && match === "yes")) return "missing";
  return classified.some(({ effect, match }) => effect === "deny" && match === "maybe") ? "maybe-denied" : "granted";
}

/**
 * The findings for the worker instance role against the actions and ARNs the route invokes: an iam-missing-grant when it lacks some, and a
 * model-access-unverified when a conditional or unresolved Deny might block one it otherwise holds (that is unverifiable, never a pass).
 * Both actions are needed on the inference profile and on the foundation model in every Region it routes to: pi streams through
 * ConverseStream, which bedrock:InvokeModelWithResponseStream authorizes.
 */
function routeGrantFindings(iam: BedrockRouteFacts["iam"], route: E2EModelRoute): Finding[] {
  const sources = policySources(iam.foundationTemplate).filter((source) => source.roleLogicalIds.includes(iam.roleLogicalId));
  const statements = sources.flatMap((source) => source.statements);
  const checked = iam.resources.map((resource) => ({ resource, verdicts: ROUTE_INVOKE_ACTIONS.map((action) => ({ action, verdict: iamVerdict(statements, action, resource, iam.scope) })) }));
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
  const denied = checked.flatMap((entry) => entry.verdicts.filter((item) => item.verdict === "denied").map((item) => `${item.action} on ${entry.resource}`));
  if (denied.length > 0) {
    findings.push({
      kind: "iam-explicit-deny", severity: "error", subject: iam.roleLogicalId, label: findingLabel(iam.roleLogicalId), roleLogicalId: iam.roleLogicalId,
      message: `${iam.roleLogicalId}, the worker instance role, is explicitly denied ${denied.join("; ")} by a Deny statement in its policies; adding an Allow cannot override a Deny, so remove or narrow the Deny (route ${route.modelId})`,
    });
  }
  const maybe = checked.filter((entry) => entry.verdicts.some((item) => item.verdict === "maybe-denied")).map((entry) => entry.resource);
  if (maybe.length > 0) {
    findings.push({
      kind: "model-access-unverified", severity: "error", subject: E2E_MODEL_ROUTE_ID, label: E2E_MODEL_ROUTE_ID,
      message: `whether ${iam.roleLogicalId}, the worker instance role, may invoke ${maybe.join("; ")} is unverifiable, which is not a pass: a Deny statement with a Condition or a resource this check cannot resolve might block it (route ${route.modelId})`,
    });
  }
  return findings;
}

// ---- anthropic, openai, openrouter ----

/** A worker setting that holds nothing: the stack writes "none" for an unset optional value. */
const settingUnset = (value: string | undefined): boolean => value === undefined || value.trim() === "" || value === "none";

function keyedFindings(route: E2EModelRoute, provider: KeyedModelProvider, keyed: KeyedRouteFacts, finding: Maker): Finding[] {
  const { label, constructPrefix } = KEYED_MODEL_PROVIDERS[provider];
  const findings: Finding[] = [];
  const secret = keyed.secretArn;
  if (secret.state === "unverifiable") {
    findings.push(finding("model-access-unverified", "error", `whether the ${label} secret ARN is set is unverifiable, which is not a pass: ${secret.reason}`));
  } else if (settingUnset(secret.value)) {
    findings.push(finding("model-route-secret-missing", "error", `the ${label} secret ARN setting is not set, so the e2e agent has no key to call ${route.modelId} with`));
  } else if (secret.value === undefined || secret.value.length > SECRET_ARN_MAX_LENGTH || !SECRET_ARN_PATTERN.test(secret.value)) {
    // The setting is never echoed: a malformed value might be a key pasted in place of its ARN.
    findings.push(finding("model-route-secret-missing", "error", `the ${label} secret ARN setting is not a well-formed Secrets Manager secret ARN, so the e2e agent has no key to call ${route.modelId} with`));
  } else {
    findings.push(...secretGrantFindings(keyed.iam, secret.value, constructPrefix, label));
  }
  if (provider === "openrouter") findings.push(...openRouterFindings(route, keyed, finding));
  findings.push(
    finding("model-access-unverified", "info", `whether the ${label} key is valid and has credit cannot be checked without a model call, which this check never makes; it shows at the model canary, or at runtime as UNKNOWN model-unavailable`),
    finding("model-access-unverified", "info", `a granted verdict covers only the policy statements in the deployed templates; still unverifiable are the role's managed policies, permissions boundaries, service control policies (SCPs), the ${label} secret's resource policy, and a customer-managed KMS key (kms:Decrypt), none of which can be evaluated from the ARN alone: this check reads no secret metadata or value (owner O6)`),
  );
  return findings;
}

/** The control-plane template's policies that apply to the worker role (by the name the stack attaches them to), skipping a policy whose condition is off or unknown. */
function controlPlaneWorkerPolicies(template: CheckTemplate, roleName: string, scope: IamScope): Array<{ policyLogicalId: string; statements: PolicyStatement[] }> {
  const conditions = (template.Conditions ?? {}) as Record<string, unknown>;
  return Object.entries(template.Resources ?? {}).flatMap(([logicalId, resource]) => {
    if (resource.Type !== "AWS::IAM::Policy" && resource.Type !== "AWS::IAM::ManagedPolicy") return [];
    const enabled = typeof resource.Condition === "string" ? conditionHolds({ Condition: resource.Condition }, conditions, scope) : true;
    if (enabled === false) return [];
    const roles = list(resource.Properties?.Roles).map((value) => resolveText(value, scope));
    if (!roles.includes(roleName)) return [];
    const statements = list((resource.Properties?.PolicyDocument as { Statement?: unknown } | undefined)?.Statement) as PolicyStatement[];
    if (enabled === true) return [{ policyLogicalId: logicalId, statements }];
    // The condition cannot be resolved: an Allow of the policy grants nothing, but a Deny of it might block the call (M4-AB).
    return [{ policyLogicalId: logicalId, statements: statements.filter((statement) => statement?.Effect !== "Allow").map((statement) => ({ ...statement, Condition: { unresolvedPolicyCondition: resource.Condition } })) }];
  });
}

/** CloudFormation conditions as far as the read policies use them (Fn::Not, Fn::Equals, Fn::And, Fn::Or, Condition); undefined when it cannot be told. */
function conditionHolds(expression: unknown, conditions: Record<string, unknown>, scope: IamScope, depth = 0): boolean | undefined {
  if (depth > 8 || expression === null || typeof expression !== "object") return undefined;
  const node = expression as Record<string, unknown>;
  if (typeof node.Condition === "string") return conditionHolds(conditions[node.Condition], conditions, scope, depth + 1);
  const operands = (key: string) => (Array.isArray(node[key]) ? node[key] as unknown[] : undefined);
  const not = operands("Fn::Not");
  if (not?.length === 1) { const value = conditionHolds(not[0], conditions, scope, depth + 1); return value === undefined ? undefined : !value; }
  const equals = operands("Fn::Equals");
  if (equals?.length === 2) {
    const [left, right] = equals.map((operand) => resolveText(operand, scope));
    return left === undefined || right === undefined ? undefined : left === right;
  }
  for (const [key, all] of [["Fn::And", true], ["Fn::Or", false]] as const) {
    const items = operands(key);
    if (items === undefined) continue;
    const values = items.map((item) => conditionHolds(item, conditions, scope, depth + 1));
    if (values.some((value) => value === !all)) return !all;
    return values.every((value) => value === all) ? all : undefined;
  }
  return undefined;
}

/**
 * The worker instance role must be allowed secretsmanager:GetSecretValue on the secret's ARN by the statements the deployed templates give it:
 * the foundation stack's policies on the role, and the control-plane stack's `<constructPrefix>SecretRead` policy (attached to the role by name,
 * and enabled only while the stack's ARN parameter is not empty). It is a static read of templates; no secret is touched.
 */
function secretGrantFindings(iam: KeyedRouteFacts["iam"], arn: string, constructPrefix: string, label: string): Finding[] {
  const foundation = policySources(iam.foundationTemplate).filter((source) => source.roleLogicalIds.includes(iam.roleLogicalId));
  const control = controlPlaneWorkerPolicies(iam.controlPlaneTemplate, iam.roleName, iam.scope);
  const statements = [...foundation.flatMap((source) => source.statements), ...control.flatMap((policy) => policy.statements)];
  const verdict = iamVerdict(statements, "secretsmanager:GetSecretValue", arn, iam.scope);
  if (verdict === "granted") return [];
  if (verdict === "denied") {
    return [{
      kind: "iam-explicit-deny", severity: "error", subject: iam.roleLogicalId, label: findingLabel(iam.roleLogicalId), roleLogicalId: iam.roleLogicalId,
      message: `${iam.roleLogicalId}, the worker instance role, is explicitly denied secretsmanager:GetSecretValue on ${arn}, the ${label} key the e2e model route reads, by a Deny statement in its policies; adding an Allow cannot override a Deny, so remove or narrow the Deny`,
    }];
  }
  if (verdict === "maybe-denied") {
    return [{
      kind: "model-access-unverified", severity: "error", subject: E2E_MODEL_ROUTE_ID, label: E2E_MODEL_ROUTE_ID,
      message: `whether ${iam.roleLogicalId}, the worker instance role, may read the ${label} secret ${arn} is unverifiable, which is not a pass: a Deny statement with a Condition or a resource this check cannot resolve might block it`,
    }];
  }
  const policyLogicalId = `${constructPrefix}SecretRead`;
  return [{
    kind: "iam-missing-grant", severity: "error", subject: policyLogicalId, label: findingLabel(iam.roleLogicalId), roleLogicalId: iam.roleLogicalId, policyLogicalId,
    statements: [{ Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: [arn] }],
    message: `${iam.roleLogicalId}, the worker instance role, is not allowed secretsmanager:GetSecretValue on ${arn}, the ${label} key the e2e model route reads (${constructPrefix}SecretRead is missing, disabled, or on another role)`,
  }];
}

function openRouterFindings(route: E2EModelRoute, keyed: KeyedRouteFacts, finding: Maker): Finding[] {
  const findings: Finding[] = [];
  if (isOpenRouterAlias(route.modelId)) {
    findings.push(finding("model-route-alias-refused", "error", `${route.modelId} is a router alias, not a model: the route must pin a specific model ID`));
  } else {
    const upstream = route.modelId.includes("/") ? route.modelId.slice(0, route.modelId.indexOf("/")) : undefined;
    const providers = keyed.openRouterProviders;
    if (providers?.state === "unverifiable") {
      findings.push(finding("model-access-unverified", "error", `whether the OpenRouter provider allowlist excludes ${upstream ?? "the model's upstream"} is unverifiable, which is not a pass: ${providers.reason}`));
    } else if (upstream !== undefined && providers !== undefined && !settingUnset(providers.value)) {
      const allowed = (providers.value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
      if (!allowed.some((entry) => entry === upstream || entry.startsWith(`${upstream}/`))) {
        findings.push(finding("model-route-openrouter-allowlist", "error", `worker-openrouter-providers is set to ${allowed.join(",")}, which excludes ${upstream}, the upstream of ${route.modelId}; OpenRouter would find no provider for it (no fallbacks are allowed)`));
      }
    }
  }
  findings.push(finding("model-route-third-party-processor", "warning", "OpenRouter is a third-party data processor: the agent's redacted synthetic page text goes through it (data collection deny, no fallbacks and required parameters are pinned by the route); decision D8's consent must cover it, and the default model stays provisional until a canary records the model OpenRouter serves (owner O4, O5)"));
  return findings;
}


/**
 * The text of an ARN, role or action value, with the pseudo parameters of the deployed template and the stack's own parameter values filled
 * in; undefined for anything else (GetAtt, an imported value, a Ref to a resource).
 */
function resolveText(node: unknown, scope: IamScope): string | undefined {
  const pseudo: Record<string, string | undefined> = { "AWS::Partition": scope.partition, "AWS::Region": scope.region, "AWS::AccountId": scope.accountId };
  if (typeof node === "string") return node;
  if (node === null || typeof node !== "object") return undefined;
  const intrinsic = node as { Ref?: unknown; "Fn::Join"?: unknown; "Fn::Sub"?: unknown; "Fn::Select"?: unknown; "Fn::Split"?: unknown };
  if (typeof intrinsic.Ref === "string") return pseudo[intrinsic.Ref] ?? scope.parameters?.[intrinsic.Ref];
  const select = intrinsic["Fn::Select"];
  if (Array.isArray(select) && select.length === 2) {
    const index = Number(typeof select[0] === "object" ? resolveText(select[0], scope) : select[0]);
    const items = resolveList(select[1], scope);
    return Number.isInteger(index) && items !== undefined ? items[index] : undefined;
  }
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

/** A list value: a literal list of resolvable texts, or Fn::Split of a resolvable text. */
function resolveList(node: unknown, scope: IamScope): string[] | undefined {
  if (Array.isArray(node)) {
    const items = node.map((item) => resolveText(item, scope));
    return items.every((item) => item !== undefined) ? items : undefined;
  }
  const split = (node as { "Fn::Split"?: unknown } | null)?.["Fn::Split"];
  if (Array.isArray(split) && typeof split[0] === "string") {
    const text = resolveText(split[1], scope);
    return text === undefined ? undefined : text.split(split[0]);
  }
  return undefined;
}

const globMatches = (pattern: string, value: string, flags = ""): boolean =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, flags).test(value);

/**
 * What one statement does to `action` on `resource`: its effect, and whether it applies (yes, no, or maybe when it cannot be told).
 * A Condition is not evaluated, and a resource written as something this cannot resolve (GetAtt, an import) has no text to match.
 * An Allow that is conditional or unresolved never counts as a grant (it errs toward alarm). A Deny that is conditional or unresolved
 * while its action matches is "maybe": it might block the call, so the caller must not report a pass.
 *
 * Ruling M4-AB: every shape this cannot parse is a maybe-Deny, never a skipped statement. That is a statement whose Effect is not
 * literally "Allow" or "Deny" (a statement wrapped in Fn::If has none) and a Deny whose Action or NotAction has an entry that is not a
 * string. An Allow with a non-string NotAction entry grants nothing (the entry might exclude the action).
 */
function classifyStatement(statement: PolicyStatement, action: string, resource: string, scope: IamScope): { effect: "allow" | "deny"; match: "yes" | "no" | "maybe" } {
  if (statement === null || typeof statement !== "object" || (statement.Effect !== "Allow" && statement.Effect !== "Deny")) return { effect: "deny", match: "maybe" };
  const effect = statement.Effect === "Allow" ? "allow" : "deny";
  const patterns = list(statement.NotAction ?? statement.Action);
  const actions = patterns.filter((value): value is string => typeof value === "string");
  const unparsedAction = actions.length !== patterns.length;
  const actionHit = actions.some((pattern) => globMatches(pattern, action, "i"));
  let actionMatch: "yes" | "no" | "maybe";
  if (statement.NotAction === undefined) actionMatch = actionHit ? "yes" : unparsedAction ? "maybe" : "no";
  else actionMatch = unparsedAction ? "maybe" : actionHit ? "no" : "yes";
  if (actionMatch === "no") return { effect, match: "no" };
  const resolved = list(statement.NotResource ?? statement.Resource).map((value) => resolveText(value, scope));
  const resourceHit = resolved.some((pattern) => pattern !== undefined && globMatches(pattern, resource));
  const resolvable = resolved.every((pattern) => pattern !== undefined);
  // NotResource applies to everything its patterns do not name; with an unresolved pattern it cannot be told.
  const resourceMatch: "yes" | "no" | "maybe" = statement.NotResource === undefined
    ? (resourceHit ? "yes" : resolvable ? "no" : "maybe")
    : (!resolvable ? "maybe" : resourceHit ? "no" : "yes");
  if (resourceMatch === "no") return { effect, match: "no" };
  const definite = actionMatch === "yes" && resourceMatch === "yes" && statement.Condition === undefined;
  if (effect === "allow") return { effect, match: definite ? "yes" : "no" };
  return { effect, match: definite ? "yes" : "maybe" };
}

// ---------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------

export function formatFindings(findings: readonly Finding[]): string {
  if (findings.length === 0) return "TEST deploy check: no findings.";
  const rank: Record<Finding["severity"], number> = { error: 0, warning: 1, info: 2 };
  const ordered = [...findings].sort((a, b) => rank[a.severity] - rank[b.severity]);
  const count = (severity: Finding["severity"]) => findings.filter((finding) => finding.severity === severity).length;
  return [
    `TEST deploy check: ${count("error")} error(s), ${count("warning")} warning(s)${count("info") > 0 ? `, ${count("info")} info` : ""}`,
    ...ordered.map((finding) => `  ${finding.severity} ${finding.kind} ${finding.label}: ${finding.message}`),
  ].join("\n");
}

/** The text of a Tier 3 request for the grants head needs: the policy of each finding and the exact statements to add to it. */
export function tier3Request(findings: readonly Finding[]): string {
  return findings.filter((finding) => finding.kind === "iam-missing-grant").map((finding) =>
    `Add to ${finding.policyLogicalId ?? finding.subject} (role ${finding.roleLogicalId ?? "unknown"}):\n${JSON.stringify(finding.statements ?? [], null, 2)}`).join("\n\n");
}
