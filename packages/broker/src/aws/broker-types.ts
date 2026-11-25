// Shared AWS broker record shapes, dependency interfaces, and protocol constants (extracted from aws/broker.ts).
import { e2ePrivateTransferMaxBytes } from "@agentx/verifier";
import { type AdminChangeOutcome, type ClientRepositoriesResponse, type CodeBuildCheckResult, type DeveloperRequester, type E2ESourceSnapshot, type Ec2RuntimeBinding, IMPLICIT_COMPANY_ID, type ModelIdentifier, type OfferedAgentModels, OrgIdSchema, type ProjectDefinition } from "@agentx/contracts";
import type { SlackRequester } from "./slack-broker-events.js";
import type { RuntimeBinding } from "./lambda.js";
import type { BrokerCoreRoot } from "./core-engine-root.js";
import type { TokenSigner } from "../developer/tokens.js";
import type { SlackWorkspaceAccess } from "./slack-person.js";
import type { CompanyMembershipReader } from "./company-check.js";
import type { SlackInstallWiring } from "./slack-company-install.js";
import type { SlackChannelWiring } from "./slack-channel-link.js";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { S3Client } from "@aws-sdk/client-s3";
import type { RepositoryGrantService } from "../repository-access.js";
import type { GitHubAppCredentialProvider } from "../github-app.js";
import type { E2EAgentInstallation } from "../e2e/model-route-registry.js";
import type { GithubInstallationBindings } from "./github-credentials.js";
import type { LinearWebhookWiring } from "./linear-app-webhook.js";
import type { CodeBuildGateway } from "../codebuild.js";
import type { ChannelAdapterConfiguration } from "./channel-adapters.js";
import type { DeveloperApiConfiguration } from "./developer-routes.js";
import type { LiveRepositoryInstallation } from "./client-project-create.js";
import type { CompanyReadsConfiguration } from "./hosted-wiring.js";
import type { ChatGptConnections } from "../chatgpt/connections.js";
import type { GitHubMcpDependencies } from "../github-mcp.js";
import type { CatalogCache } from "@agentx/gateway";
import type { ScopeDiscovery } from "./connector-routes.js";
import type { ConnectorCredentialsConfiguration, CredentialRegistry } from "./credentials.js";
import type { TurnRecordExport } from "./turns.js";
import type { ConnectorType } from "./connector-types.js";
import type { AdminReadDependencies } from "./admin-reads.js";


import type { EvalBatchDependencies } from "./eval-batch.js";





export const MAX_ARTIFACT_BYTES = 5_000_000;

export const MAX_SETUP_PROPOSAL_BYTES = 24 * 1024 * 1024;

// This derived ceiling bounds only the chunked private carrier; each report,
// frame, literal, record, and admitted group keeps its existing component limit.
export const MAX_SETUP_EVIDENCE_BYTES = e2ePrivateTransferMaxBytes(64, 4);

/** This path keeps one project namespace; the E2E account and day-budget rows it shares with the ports-based core sit under Code's one company, as Cloud's do under an org. */
export const LEGACY_E2E_COMPANY = OrgIdSchema.parse(IMPLICIT_COMPANY_ID);

export const SETUP_ARTIFACT_CHUNK_BYTES = 64 * 1024;

export const EVENT_TRANSACTION_CHUNK = 80;

/**
 * The capture policy a new setup proposal and its approval carry (owner decision D3, as amended by Ruling CJ): screenshots of failed cases and downloads; no video, and no
 * traces (deferred past M1.3, because a Playwright trace keeps session tokens that cannot be scrubbed reliably). The executor keeps screenshots only for failed cases and
 * only inside a fixed budget (Task 3.6).
 * A project whose setup was approved earlier keeps the policy it was approved with (its stored all-false policy is read as written), so it gets screenshots only after its
 * setup is approved again. A proposal made before this default existed is no longer approvable ("propose the setup again"), though a decision already recorded for it is still
 * answered as an idempotent retry.
 */
export const PROJECT_SETUP_CAPTURE_POLICY = Object.freeze({ screenshots: true, traces: false, video: false, downloads: true });

/** R2-F1 review M1: a named company's project with a setup change waiting for approval takes no other revision until that change is decided. */
export const NAMED_COMPANY_CANDIDATE_WAITING = "a setup change for this project is waiting for approval; approve or decline it before registering another revision";

export interface RegisteredProjectRecord {
  pk: string;
  sk: string;
  entityType: "PROJECT";
  companyId?: string;
  definition: ProjectDefinition;
  runtimeBinding: RuntimeBinding;
  registeredBy: string;
  registeredAt: string;
  setupApproval?: { proposalRef: string; proposalSha256: string; candidateDigest: string; decision: "approve" | "decline" };
}

export interface MembershipRecord {
  pk: string;
  sk: string;
  entityType: "MEMBERSHIP";
  ownerKey: string;
  projectName: string;
  role: "developer" | "administrator";
  grantId: string;
  /** Set when an administrator granted the access (the other grant paths record it too). */
  grantedBy?: { issuer: string; subject: string };
  grantedAt?: string;
}

export interface ProjectModelSelectionRecord {
  pk: string;
  sk: "SELECTION";
  entityType: "PROJECT_MODEL_SELECTION";
  model: ModelIdentifier;
  updatedAt: string;
  updatedBy: SlackRequester | DeveloperRequester;
}

export interface PullRequestRecord {
  pk: string;
  sk: string;
  entityType: "PULL_REQUEST";
  workspaceId: string;
  repository: string;
  repositoryUrl: string;
  number: number;
  url: string;
  state: "open" | "closed" | "merged";
  headBranch: string;
  baseBranch: string;
  expectedHeadCommit: string;
  title: string;
  body: string;
  /** Set when GitHub refused to open this pull request as a draft and it was opened as a normal one (INTG1). */
  draftRefused?: true;
  createdByOperationId: string;
  replacedBy?: number;
  replacementFor?: number;
  updatedAt: string;
}

export interface CodeBuildRecord {
  pk: string;
  sk: string;
  entityType: "CODEBUILD";
  workspaceId: string;
  operationId: string;
  fence: number;
  repository: string;
  gate: string;
  projectName: string;
  requestedSourceVersion: string;
  idempotencyToken: string;
  buildId: string;
  evidence: CodeBuildCheckResult;
  createdAt: string;
  updatedAt: string;
}

export interface AwsBrokerDependencies {
  core?: BrokerCoreRoot;
  /** DEC 254zzz79 (3): the gateway's settings and the task-token signer, for the Slack service's model access (slack-model-access.ts). Absent: every company thread's model access is `unavailable`. */
  slackModelAccess?: { env: NodeJS.ProcessEnv; taskTokens: () => { signer: TokenSigner; issuer: string } | undefined };
  workspaces?: SlackWorkspaceAccess;
  companies?: CompanyMembershipReader;
  /** L2-2 PR 18c: the membership reader Slack company mode brings (slack-company-wiring.ts); given only to the company handler, never to the install team's legacy handler. */
  slackCompanies?: CompanyMembershipReader;
  /** Install workspace for the additive operator backfill; independent of sign-in being enabled. */
  slackWorkspaceLegacyTeamId?: string;
  /** L2-2 PR 18b: set only on the install team's legacy view (withoutSlackCompanyMode): another team's binding is "not bound" there. */
  slackInstallTeamOnly?: string;
  /**
   * DEC 254zzz80 (R2-F1): set only on the install team's legacy view while Slack company mode is on. The install team's company (its operator binding) picks where its channel
   * bindings are read (slack-person.ts slackBindingCompany): a NAMED company's own partition, else the legacy keys.
   */
  installTeamCompany?: (teamId: string) => Promise<string>;
  /**
   * DEC 254zzz80 (R2-F1): with `installTeamCompany`, the company path's own dependencies. A Slack start in the install team whose company is NAMED is that company's start
   * (startSlackWorkflow: the linked person, the company's binding and the core), never the single-workspace start, whose unscoped keys that company has none of.
   */
  installTeamCompanyMode?: { workspaces: SlackWorkspaceAccess; companies?: CompanyMembershipReader };
  /** Guided onboarding PR 4: Add to Slack's wiring (named environments with the company layer); absent, a Slack removal event is refused. */
  slackInstall?: SlackInstallWiring;
  /** Guided onboarding PR 5: channel links and /rovara (named environments with the company layer); absent, /rovara answers "not set up". */
  slackChannels?: SlackChannelWiring;
  /** Guided onboarding PR 5: where /rovara's "Sign in to Rovara first" links to; only an https address is used. */
  slackSignInUrl?: string;
  documentClient: DynamoDBDocumentClient;
  s3: S3Client;
  /** Starts deleting an ec2-ebs workspace's instance and volume (#84). */
  deleteEc2Session?: (workspaceId: string) => Promise<void>;
  tableName: string;
  artifactBucketName: string;
  issuer: string;
  adminClaim: string;
  adminValues: readonly string[];
  callbackSigningKey: string;
  repositoryGrants: RepositoryGrantService;
  githubPullRequests: Pick<GitHubAppCredentialProvider, "reconcilePullRequest" | "getPullRequest" | "updatePullRequest" | "verifyWebhookRepository"> & Partial<Pick<GitHubAppCredentialProvider, "installationIdFor" | "getRepositoryIdentity" | "getPullRequestChangedFiles" | "getPullRequestFilesPage" | "getPullRequestFeedback" | "getPullRequestMergeObservation" | "getCommitTree" | "getCommitParents" | "getBranchHead" | "getFileAtCommit">>;
  /** Trusted server-side source capture for setup discovery and exact-commit E2E planning context. */
  projectSetupSource?: { capture: (input: { repositoryUrl: string; ref: string }) => Promise<E2ESourceSnapshot> };
  /** Server-selected catalog namespace for an already configured setup verifier. */
  projectSetupRuntimeCatalogId?: string;
  /** Separate server-selected namespace for the already qualified portable feature verifier. */
  e2eFeatureRuntimeCatalogId?: string;
  /**
   * The installation's worker model settings (provider, a keyed provider's secret ARN, the OpenRouter allowlist, the region): what the AI browser-test agent's route is derived from at
   * setup approval and again at dispatch (M1.4 Task 4.2). Absent, or throwing, the route cannot be derived and agent steps stay unavailable with `agent-route-not-approved`.
   */
  e2eAgentInstallation?: () => Promise<E2EAgentInstallation>;
  /** Reads the GitHub webhook HMAC key from the configured GitHub App secret; `refresh` asks for a fresh read of the secret. */
  githubBindings?: GithubInstallationBindings;
  githubBindingInstallations?: {
    get(installationId: number): Promise<{ installationId: number; accountLogin: string } | undefined>;
    page(page: number): Promise<{ installations: Array<{ installationId: number; accountLogin: string }>; more: boolean }>;
  };
  githubWebhookSecret?: (options?: { refresh?: boolean }) => Promise<string>;
  /** Guided onboarding PR 7: the Linear OAuth app's webhooks (linear-app-webhook.ts). Absent: the route answers 404. */
  linearWebhook?: LinearWebhookWiring;
  /** How long a PR description update (D2) may take before it gives up without writing; 5 seconds when absent. */
  descriptionUpdateMaxMs?: number;
  /** Refuses, with CONFIG_INVALID, a repository its credential cannot reach; checked at registration. */
  checkRepositoryAccess?: (repository: { credentialRef: string; url: string }) => Promise<void>;
  codeBuild: CodeBuildGateway;
  slack?: SlackServiceConfiguration;
  /** Spec 062: channel adapters; absent unless the deployment turns them on, and /v1/admin/channels answers NOT_FOUND. */
  channelAdapters?: ChannelAdapterConfiguration;
  /** Spec 025 developer sign-in; absent when the deployment has none, and /v1/dev/* answers NOT_FOUND. */
  developer?: DeveloperApiConfiguration;
  /**
   * Spec 065b: what a project a sign-in client creates is built from: the GitHub App's credential and its view of a
   * repository, and the foundation's worker binding. Absent, POST /v1/dev/client/projects answers NOT_FOUND.
   */
  clientProjects?: {
    credentialRef: string;
    repositoryDefaults(url: string): Promise<{ owner: string; name: string; defaultBranch: string }>;
    /** The repositories the GitHub App can reach, for GET /v1/dev/client/repositories. */
    repositories(): Promise<ClientRepositoriesResponse["installations"]>;
    workerBinding(): Promise<Ec2RuntimeBinding>;
    /**
     * Guided onboarding PR 6: which installation serves a repository and whether it is suspended, read from GitHub now (no cache). Every create
     * checks it against the company's bindings; absent while bindings are on, the multi-repository and bulk creates refuse every repository.
     */
    repositoryInstallation?(url: string): Promise<LiveRepositoryInstallation>; /** gh-bindings: the company GitHub bindings for THESE routes only (`withClientGithubBindings`), used where a membership reader is wired. */ bindings?: GithubInstallationBindings;
  };
  /**
   * Lanes AU and EV: the company audit and event reads for a company administrator (`/v1/dev/client/company/*`): the company's document store, the host's company
   * resolver (membership) and a name lookup. Absent, both routes answer NOT_FOUND.
   */
  companyReads?: CompanyReadsConfiguration;
  /**
   * Spec 064: the legacy deployment's sign-in, for account linking only. Set instead of `developer`, so developer
   * tasks, sharing and admin changes stay off; /v1/dev/* and /review/* serve linking alone (routeLinkingRequest).
   */
  linking?: DeveloperApiConfiguration;
  /** Sign in with ChatGPT (#338): each developer's ChatGPT connection; absent without its key. */
  chatgpt?: ChatGptConnections;
  /**
   * DEC 254g: what the model gateway offers one company's agents (core-host/offered-models-http.ts `adminOfferedModelsFromEnvironment`), for an administrator's
   * `agentx config set coreEngine.agentModel`; absent without the gateway's origin.
   */
  coreOfferedModels?: (companyId: string) => Promise<OfferedAgentModels>;
  githubMcp?: GitHubMcpDependencies;
  catalogs: CatalogCache<ScopeDiscovery>;
  credentialRegistry?: CredentialRegistry;
  /** The administrator turn record export; absent when the deployment has no TurnRecords table. */
  turnRecords?: TurnRecordExport;
  /** The TurnRecords table developer task audit records go to (spec 025); absent when there is none. */
  turnRecordsTableName?: string;
  /** Connector types this deployment serves; the built-in types when absent. */
  connectorTypes?: Record<string, ConnectorType>;
  /** Spec 025 C14: the Slack threads table, read for a shared thread's waiting messages; absent in legacy. */
  slackThreadsTableName?: string;
  /** Spec 025 phase 25d: the admin read routes' injected probes and clock; the defaults serve production. */
  adminReads?: Partial<Pick<AdminReadDependencies, "me" | "health" | "now" | "log">>;
  /** Spec 025 phase 25e: the admin changes' method switch, clock and metric; the defaults serve production. */
  adminChanges?: { confirm?: { elicitation: boolean; slack: boolean }; now?: () => number; metric?: (outcome: AdminChangeOutcome) => void };
  /** Spec 043: SWE-bench runs; absent in a harness that does not exercise them. */
  swebench?: Pick<EvalBatchDependencies, "deployment" | "startExecution" | "stopBatchForThread" | "onRunEnded" | "now" | "estimateRunCostUsd">;
}

/**
 * What callers supply; the handler creates the per-container catalog cache when none is given, and
 * the credential registry from `connectorCredentials` unless one is injected, and the turn record
 * export from `turnRecordsTableName` unless one is injected.
 */
export type AwsBrokerInput = Omit<AwsBrokerDependencies, "catalogs"> & {
  /** Lane E2 step 6: the core engine's root (aws/core-engine-root.ts). Absent, or its switch off: the broker never reaches the core. */
  core?: BrokerCoreRoot;
  catalogs?: CatalogCache<ScopeDiscovery>;
  connectorCredentials?: ConnectorCredentialsConfiguration;
  turnRecordsTableName?: string;
};

export interface SlackServiceConfiguration {
  orchestratorRoleArn: string;
  memberWorkspaceLimit: number;
  organizationWorkspaceLimit: number;
}

/** A "." or ".." path segment, also percent-encoded (%2e in any case). */
export const DOT_SEGMENT = /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/i;

export const DEVELOPER_ROUTE_KEY = "ANY /v1/dev/{proxy+}";

/** Lane L12: the core's /v1/app/* routes (named environments only), with no API Gateway authorizer: the broker verifies the developer token itself, as on /v1/dev/*. */
export const CORE_APP_ROUTE_KEY = "ANY /v1/app/{proxy+}";

export const FEEDBACK_REVIEW_ROUTE_KEY = "ANY /review/{proxy+}";

/** What a chat agent is told about a project a sign-in client created; the project's administrators refine it later. */
export const CLIENT_PROJECT_INSTRUCTIONS = "Delegate every repository read, edit, shell command, build and test to the remote AgentX worker. Before reporting a change done, run the project's test commands.";

export const TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * DEC 254zzz98 (one rule): a project's grants live where its revisions live. Where the revision's key is picked by a company (registration's `revisionKeyFor(companyId)`,
 * a task of a named company), that company picks the grant's layout too: a NAMED company's own partition, else the legacy keys (company-layout.ts `grantKeyFor`). A LEGACY
 * revision's grant is always the legacy row (LEGACY_REVISION_GRANT), whatever company a stamped legacy row names. No separate company-layer check here.
 */
/**
 * DEC 254zzz98 (one rule; delta review M1): the grant beside a LEGACY revision (`PROJECT#<name>`, read by requireProject / requireLatestProject / the workflow paths) is the
 * legacy `MEMBER#<person>` row, whatever company a stamped legacy row names. Every legacy-revision reader, writer and fence (workspace preparation, thread workspaces, the
 * setup run's owner checks and terminal fence, requireMembership) keys its grant with this.
 */
export const LEGACY_REVISION_GRANT: undefined = undefined;
