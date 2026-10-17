// FR-040: agentx project add, and init's first-project step. Every new project runs on EC2 workers
// (ec2-ebs), bound with the foundation's launch template and subnets. The definition is also
// written to <config dir>/<name>.yaml, the file agentx admin project register --file takes, so
// connector add can build the next revision from it. The file holds no secret: the repository's
// credential is a reference (the built-in GitHub App's ref), never a token.
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import { verifyE2ESetupProposal } from "@agentx/broker/e2e/discovery";
import {
  AgentXError, AgentXErrorCodeSchema, ProjectDefinitionSchema, RegistrationPreflightSchema, E2EPolicySchema, E2ESetupProposalSchema, agentXError, canonicalJson, environmentStackName,
  type ConnectorPreflight, type Ec2RuntimeBinding, type ProjectDefinition, type E2EPolicy, type E2ESetupProposal,
} from "@agentx/contracts";
import { listCredentials } from "../admin/credential.js";
import { cliRuntimeBinding, registerProject } from "../admin/register.js";
import { readJsonResponse, serverError } from "../admin/http.js";
import { loadProjectConfig } from "../config.js";
import { recordRegisteredLoopEnrollment } from "../loop/enrollment-cli.js";
import type { StackOutputs } from "../deploy/parameters.js";
import type { Prompter } from "../init/prompts.js";
import {
  agentxRepositoryName, commandLine, parseCommandLine, proposeCommands, BUILD_FILES, SETUP_TIMEOUT, TEST_TIMEOUT, type RepositoryInfo, type RepositorySnapshot,
} from "./project-files.js";
import type { AdminSession, SetupServices } from "./services.js";

export const DEFAULT_INSTRUCTIONS = "Delegate every repository read, edit, build, and test to the remote AgentX worker.";
const LAUNCH_TEMPLATE_OUTPUT = "Ec2WorkerLaunchTemplateId";
const SUBNETS_OUTPUT = "Ec2WorkerSubnets";
const VOLUME_SIZE_GIB = "20";
const VOLUME_TYPE = "gp3";

export function ec2Binding(outputs: StackOutputs | undefined, stackName: string): Ec2RuntimeBinding {
  if (outputs === undefined) {
    throw agentXError("CONFIG_INVALID", `stack ${stackName} does not exist in this account and region; check --env and --region, or finish agentx init first`);
  }
  const launchTemplateId = outputs[LAUNCH_TEMPLATE_OUTPUT];
  const subnets = outputs[SUBNETS_OUTPUT];
  for (const [name, value] of [[LAUNCH_TEMPLATE_OUTPUT, launchTemplateId], [SUBNETS_OUTPUT, subnets]] as const) {
    if (value === undefined) {
      throw agentXError("CONFIG_INVALID", `stack ${stackName} has no ${name} output; upgrade the environment to a release with EC2 workers, then run this again`);
    }
  }
  return cliRuntimeBinding("ec2-ebs", { launchTemplateId: launchTemplateId!, subnets: subnets!, volumeSizeGib: VOLUME_SIZE_GIB, volumeType: VOLUME_TYPE });
}

export async function builtInGitHubRef(session: AdminSession, fetchImplementation: typeof fetch): Promise<string> {
  const listed = (await listCredentials(session, fetchImplementation)) as { credentials?: Array<{ ref?: unknown; type?: unknown; builtIn?: unknown }> };
  const ref = listed.credentials?.find((entry) => entry.builtIn === true && entry.type === "github-app")?.ref;
  if (typeof ref !== "string") throw agentXError("RUNTIME_UNAVAILABLE", "the control plane lists no GitHub App credential; check the control-plane stack's GitHubAppId parameter");
  return ref;
}

export function projectFilePath(configDir: string, name: string): string {
  return join(configDir, `${name}.yaml`);
}

/** How to register the file's next revision by hand (F27): the whole command, binding flags too. */
function fileHeader(path: string, register?: { env: string; binding: Ec2RuntimeBinding }): string {
  const launchTemplate = register?.binding.launchTemplateId ?? "<the foundation's Ec2WorkerLaunchTemplateId>";
  const subnets = register?.binding.subnets.map((subnet) => `${subnet.availabilityZone}=${subnet.subnetId}`).join(",") ?? "<the foundation's Ec2WorkerSubnets>";
  const env = register === undefined ? "" : ` --env ${register.env}`;
  return [
    "# Registered by agentx. It holds no secret, only credential references.",
    "# To change the project, edit this file and raise revision, then either run agentx connector add",
    "# (which rebuilds it) or register it yourself:",
    `#   agentx admin project register${env} --file ${path} --deployment-mode ec2-ebs --launch-template-id ${launchTemplate} --subnets ${subnets}`,
    "",
  ].join("\n");
}

/** A project file that one environment's commands wrote, found by fileHeader's register line.
 * `error` marks a file that cannot be used: "unreadable" (it could not be read, so it may or may not
 * be this environment's; `errorCode` says why), or "invalid-yaml" (its register line names this
 * environment, but its YAML does not parse). Such a file has an empty definition and launch
 * template; callers report it rather than act on it. */
export interface EnvironmentProjectFile { path: string; name: string; launchTemplateId: string; definition: Record<string, unknown>; error?: "unreadable" | "invalid-yaml"; errorCode?: string }

/** fileHeader's register line; kept beside fileHeader so the reader and the writer change together (ruling F26). */
const REGISTER_LINE = /^#\s+agentx admin project register --env (\S+) --file .+? --deployment-mode ec2-ebs --launch-template-id (\S+)/m;

/** The project files environment `env` wrote in configDir (doctor and destroy read them). A file
 * without fileHeader's register line (hand-written) belongs to no environment. A missing directory
 * has none. */
export async function environmentProjectFiles(configDir: string, env: string): Promise<EnvironmentProjectFile[]> {
  let entries: string[];
  try {
    entries = await readdir(configDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: EnvironmentProjectFile[] = [];
  for (const entry of entries.filter((name) => name.endsWith(".yaml")).sort()) {
    const path = join(configDir, entry);
    const stem = entry.slice(0, -".yaml".length);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      files.push({ path, name: stem, launchTemplateId: "", definition: {}, error: "unreadable", errorCode: (error as NodeJS.ErrnoException).code ?? "unknown" });
      continue;
    }
    const match = REGISTER_LINE.exec(text);
    if (match === null || match[1] !== env || match[2] === undefined) continue;
    let parsed: unknown;
    try { parsed = YAML.parse(text); } catch { parsed = undefined; }
    if (parsed === null || parsed === undefined || typeof parsed !== "object" || Array.isArray(parsed)) {
      files.push({ path, name: stem, launchTemplateId: match[2], definition: {}, error: "invalid-yaml" });
      continue;
    }
    const definition = parsed as Record<string, unknown>;
    files.push({ path, name: typeof definition.name === "string" ? definition.name : stem, launchTemplateId: match[2], definition });
  }
  return files;
}

export async function writeProjectFile(configDir: string, definition: ProjectDefinition, register?: { env: string; binding: Ec2RuntimeBinding }): Promise<string> {
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const path = projectFilePath(configDir, definition.name);
  await writeFile(path, fileHeader(path, register) + YAML.stringify(definition), { mode: 0o600 });
  return path;
}

export async function registerRevision(input: {
  env: string; session: AdminSession; definition: ProjectDefinition;
  services: Pick<SetupServices, "fetch" | "stackOutputs" | "configDir" | "loopHome">;
  setupApproval?: StoredSetupDecision;
  setupPolicy?: E2EPolicy;
}): Promise<{ revision: number; preflight: ConnectorPreflight[]; warnings: string[]; file: string }> {
  const foundation = environmentStackName(input.env, "foundation");
  const runtimeBinding = ec2Binding(await input.services.stackOutputs(foundation), foundation);
  const result = (await registerProject({ controlPlaneUrl: input.session.controlPlaneUrl, accessToken: input.session.accessToken, definition: input.definition, runtimeBinding, ...(input.setupApproval === undefined ? {} : { setupApproval: input.setupApproval }) }, input.services.fetch)) as Record<string, unknown>;
  const preflight = RegistrationPreflightSchema.safeParse(result.preflight);
  const warnings = Array.isArray(result.warnings) ? result.warnings.filter((entry): entry is string => typeof entry === "string") : [];
  if (input.setupApproval?.decision === "approve" && input.definition.e2e !== undefined) {
    if (result.setupRuntime === "QUEUED") warnings.push("E2E testing setup was queued; project registration is complete, but testing is not ready.");
    else if (result.setupRuntime === "UNAVAILABLE") warnings.push("E2E testing setup is unavailable; project registration is complete, but testing is not ready.");
    else warnings.push("E2E testing setup status is unknown; project registration is complete, but testing is not ready.");
  }
  if (input.services.loopHome !== undefined) {
    try {
      const enrollment = await recordRegisteredLoopEnrollment({ home: input.services.loopHome, env: input.env, controlPlaneUrl: input.session.controlPlaneUrl, definition: input.definition, response: result });
      if (!enrollment.recorded) warnings.push(`local Rovara enrollment is on hold (${enrollment.reasonCode}); publication stays held until registration is confirmed from its source checkout`);
    } catch (error) {
      warnings.push(`local Rovara enrollment could not be saved (${(error as Error).message}); publication stays held`);
    }
  }
  // Written only after the control plane accepted the revision, so the file never names a revision
  // that is not registered.
  const file = await writeProjectFile(input.services.configDir, input.definition, { env: input.env, binding: runtimeBinding });
  if (input.setupApproval !== undefined) {
    const policy = input.setupPolicy ?? input.definition.e2e;
    if (policy === undefined) throw agentXError("CONFIG_INVALID", "a stored setup decision cannot be saved without its source-backed E2E policy");
    await writeStoredSetupDecision({ configDir: input.services.configDir, env: input.env, session: input.session, definition: input.definition, policy, decision: input.setupApproval });
  }
  return { revision: input.definition.revision, preflight: preflight.success ? preflight.data.connectors : [], warnings, file };
}

const REPOSITORY_EXAMPLES = 5;

async function chooseRepository(repositories: RepositoryInfo[], prompter: Prompter, flag: string | undefined): Promise<RepositoryInfo> {
  if (repositories.length === 0) throw agentXError("CONFIG_INVALID", "the GitHub App sees no repositories; choose at least one in the app's installation settings, then run this again");
  const names = repositories.map((repo) => repo.fullName);
  const examples = names.slice(0, REPOSITORY_EXAMPLES).join(", ") + (names.length > REPOSITORY_EXAMPLES ? `, and ${names.length - REPOSITORY_EXAMPLES} more` : "");
  const wanted = flag ?? await prompter.choose<string>("Which repository is the first project's?", names.map((fullName) => ({ value: fullName, label: fullName })), {
    flag: "--repository", defaultValue: names[0]!,
    // With --yes (or no terminal) the first of several repositories is never guessed.
    unattendedRefusal: `the GitHub App sees ${names.length} repositories (for example ${examples}); pass --repository <owner/name> to choose the first project's`,
  });
  const found = repositories.find((repo) => repo.fullName.toLowerCase() === wanted.toLowerCase());
  if (found === undefined) {
    throw agentXError("CONFIG_INVALID", `the GitHub App cannot see ${wanted}; it sees ${names.join(", ")}. Add the repository to the app's installation, or choose one of those`);
  }
  return found;
}

/** The project already written for `name`, or undefined when there is no file for it. A file is
 * written only after its revision registers, so an existing file means the project exists. */
async function existingProject(configDir: string, name: string): Promise<ProjectDefinition | undefined> {
  const path = projectFilePath(configDir, name);
  try {
    await access(path);
  } catch {
    return undefined;
  }
  try {
    return await loadProjectConfig({ projectName: name, configDirectory: configDir });
  } catch {
    throw agentXError("CONFIG_INVALID", `a file already exists at ${path} that is not an AgentX project file; move it or choose another --project-name`);
  }
}

const cloneUrlOf = (fullName: string) => `https://github.com/${fullName}.git`.toLowerCase();

interface StoredSetupDecision { proposalRef: string; proposalSha256: string; decision: "approve" | "decline" }

interface LocalSetupDecisionRecord {
  schemaVersion: 1;
  env: string;
  controlPlaneUrl: string;
  projectName: string;
  repositoryUrl: string;
  policySha256: string;
  setupApproval: StoredSetupDecision;
}

function setupDecisionPath(configDir: string, projectName: string): string {
  return `${projectFilePath(configDir, projectName)}.setup-approval.json`;
}

function normalizedControlPlaneUrl(value: string): string {
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.search || url.hash) throw new Error("invalid control-plane URL");
    return url.href.replace(/\/$/, "");
  } catch {
    throw agentXError("CONFIG_INVALID", "the setup decision cannot be bound to an invalid control-plane URL");
  }
}

function policyDigest(value: E2EPolicy): string {
  return createHash("sha256").update(canonicalJson(E2EPolicySchema.parse(value)), "utf8").digest("hex");
}

function setupDecisionRecord(input: { env: string; session: AdminSession; definition: ProjectDefinition; policy: E2EPolicy; decision: StoredSetupDecision }): LocalSetupDecisionRecord {
  const repositoryUrl = input.definition.repositories[0]?.url;
  if (repositoryUrl === undefined || !/^[a-f0-9]{64}$/.test(input.decision.proposalSha256)
    || input.decision.proposalRef.length > 512 || !input.decision.proposalRef.startsWith("project-setup-proposals/")
    || (input.decision.decision !== "approve" && input.decision.decision !== "decline")) {
    throw agentXError("CONFIG_INVALID", "the stored setup decision is missing its project or source proposal binding");
  }
  return {
    schemaVersion: 1, env: input.env, controlPlaneUrl: normalizedControlPlaneUrl(input.session.controlPlaneUrl),
    projectName: input.definition.name, repositoryUrl: repositoryUrl.toLowerCase().replace(/\/$/, ""),
    policySha256: policyDigest(input.policy), setupApproval: input.decision,
  };
}

async function writeStoredSetupDecision(input: { configDir: string; env: string; session: AdminSession; definition: ProjectDefinition; policy: E2EPolicy; decision: StoredSetupDecision }): Promise<void> {
  await mkdir(input.configDir, { recursive: true, mode: 0o700 });
  await writeFile(setupDecisionPath(input.configDir, input.definition.name), `${JSON.stringify(setupDecisionRecord(input), null, 2)}\n`, { mode: 0o600 });
}

/** Reuses only the exact locally retained, non-secret decision context. The control plane still
 * authenticates the reference, owner, repository, and policy on every registration. */
export async function setupDecisionForRevision(input: { configDir: string; env: string; session: AdminSession; definition: ProjectDefinition }): Promise<StoredSetupDecision | undefined> {
  const path = setupDecisionPath(input.configDir, input.definition.name);
  let raw: string;
  try { raw = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (input.definition.e2e !== undefined) throw agentXError("CONFIG_INVALID", `project ${input.definition.name} has E2E policy but no local source-backed setup decision; obtain a fresh owner setup decision before registering a revision`);
      return undefined;
    }
    throw agentXError("CONFIG_INVALID", `the local setup decision for ${input.definition.name} cannot be read; obtain a fresh owner setup decision before registering a revision`);
  }
  if (Buffer.byteLength(raw, "utf8") > 16 * 1024) throw agentXError("CONFIG_INVALID", `the local setup decision for ${input.definition.name} is too large; obtain a fresh owner setup decision`);
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw agentXError("CONFIG_INVALID", `the local setup decision for ${input.definition.name} is invalid; obtain a fresh owner setup decision`);
  const record = parsed as Record<string, unknown>;
  const decision = record.setupApproval;
  if (Object.keys(record).sort().join(",") !== "controlPlaneUrl,env,policySha256,projectName,repositoryUrl,schemaVersion,setupApproval"
    || record.schemaVersion !== 1 || typeof record.env !== "string" || typeof record.controlPlaneUrl !== "string"
    || typeof record.projectName !== "string" || typeof record.repositoryUrl !== "string" || typeof record.policySha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(record.policySha256)
    || decision === null || typeof decision !== "object" || Array.isArray(decision)) {
    throw agentXError("CONFIG_INVALID", `the local setup decision for ${input.definition.name} is invalid; obtain a fresh owner setup decision`);
  }
  const storedDecision = decision as Record<string, unknown>;
  if (Object.keys(storedDecision).sort().join(",") !== "decision,proposalRef,proposalSha256"
    || typeof storedDecision.proposalRef !== "string" || storedDecision.proposalRef.length > 512
    || typeof storedDecision.proposalSha256 !== "string" || !/^[a-f0-9]{64}$/.test(storedDecision.proposalSha256)
    || (storedDecision.decision !== "approve" && storedDecision.decision !== "decline")) {
    throw agentXError("CONFIG_INVALID", `the local setup decision for ${input.definition.name} is invalid; obtain a fresh owner setup decision`);
  }
  // A decline created a non-E2E project. Subsequent ordinary revisions need no setup authority;
  // do not forward the old decline as if it were a continuing E2E policy decision.
  if (input.definition.e2e === undefined && storedDecision.decision === "decline") return undefined;
  const repositoryUrl = input.definition.repositories[0]?.url.toLowerCase().replace(/\/$/, "");
  let matches = record.env === input.env && record.controlPlaneUrl === normalizedControlPlaneUrl(input.session.controlPlaneUrl)
    && record.projectName === input.definition.name && record.repositoryUrl === repositoryUrl;
  matches &&= input.definition.e2e !== undefined && storedDecision.decision === "approve" && record.policySha256 === policyDigest(input.definition.e2e);
  if (!matches) throw agentXError("CONFIG_INVALID", `the saved setup decision for ${input.definition.name} no longer matches its project, environment, control plane, repository, or E2E policy; obtain a fresh owner setup decision before registering a revision`);
  return { proposalRef: storedDecision.proposalRef, proposalSha256: storedDecision.proposalSha256, decision: storedDecision.decision };
}

async function setupRequest(session: AdminSession, fetchImplementation: typeof fetch, path: string, body: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> {
  const response = await fetchImplementation(`${session.controlPlaneUrl.replace(/\/$/, "")}${path}`, {
    method: "POST", headers: { authorization: `Bearer ${session.accessToken}`, "content-type": "application/json" }, body: JSON.stringify(body),
    ...(timeoutMs === undefined ? {} : { signal: AbortSignal.timeout(timeoutMs) }),
  });
  const { ok, status, body: result } = await readJsonResponse(response);
  if (!ok) {
    const { code, message } = serverError(result);
    const parsedCode = AgentXErrorCodeSchema.safeParse(code);
    const fallback = status >= 500 ? "RUNTIME_UNAVAILABLE" : "CONFIG_INVALID";
    const responseCode = status === 401 ? "AUTH_REQUIRED" : status === 403 ? "FORBIDDEN" : parsedCode.success ? parsedCode.data : fallback;
    throw agentXError(responseCode, `${path} failed with HTTP ${status}${message ? `: ${message}` : ""}`);
  }
  if (result === undefined || result === null || typeof result !== "object" || Array.isArray(result)) throw agentXError("CONFIG_INVALID", `${path} returned a malformed successful response`);
  return result as Record<string, unknown>;
}

function validateSetupProposalResponse(value: Record<string, unknown>): { proposal: E2ESetupProposal; policy: E2EPolicy; proposalRef: string; proposalSha256: string } {
  const proposal = E2ESetupProposalSchema.parse(value.proposal);
  const policy = E2EPolicySchema.parse(value.policy);
  if (typeof value.proposalRef !== "string" || !/^project-setup-proposals\/[a-f0-9]{64}\/[a-f0-9]{64}\.json$/.test(value.proposalRef)
    || typeof value.proposalSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.proposalSha256)
    || value.proposalRef !== `project-setup-proposals/${value.proposalRef.split("/")[1]}/${value.proposalSha256}.json`
    || value.candidateDigest !== proposal.candidateDigest || policy.targets.length !== proposal.targets.length
    || proposal.targets.some((target) => !policy.targets.some((configured) => JSON.stringify(configured) === JSON.stringify(target)))) {
    throw agentXError("RUNTIME_UNAVAILABLE", "control plane returned an unbound source-backed setup proposal");
  }
  return { proposal, policy, proposalRef: value.proposalRef, proposalSha256: value.proposalSha256 };
}

/** What this rerun asks for that the existing project does not have. Only the answers given are
 * compared (the repository, and any command flags); nothing is asked again and nothing is fetched. */
function differences(existing: ProjectDefinition, wanted: { repositoryUrl?: string; setupCommand?: string; testCommand?: string }): string[] {
  const repository = existing.repositories[0];
  const typed = (line: string, timeout: number) => (line.trim() === "" ? [] : [parseCommandLine(line, repository?.path ?? ".", timeout)]);
  const found: string[] = [];
  if (wanted.repositoryUrl !== undefined && repository?.url.toLowerCase() !== wanted.repositoryUrl.toLowerCase()) found.push("repository");
  if (wanted.setupCommand !== undefined && !isDeepStrictEqual(typed(wanted.setupCommand, SETUP_TIMEOUT), existing.setup)) found.push("setup command");
  if (wanted.testCommand !== undefined && !isDeepStrictEqual(typed(wanted.testCommand, TEST_TIMEOUT), existing.readiness)) found.push("test command");
  return found;
}

export async function addProject(input: {
  env: string; session: AdminSession; githubToken: string; prompter: Prompter; write: (line: string) => void;
  services: Pick<SetupServices, "fetch" | "repositories" | "stackOutputs" | "configDir">;
  flags: { projectName?: string; repository?: string; setupCommand?: string; testCommand?: string };
  /** A source-verified proposal and policy for the single normal project-setup confirmation. */
  e2eSetup?: { proposal: E2ESetupProposal; policy: E2EPolicy; snapshot: RepositorySnapshot };
  /** The install page's project card (spec 040 phase 3): told the repository once it is chosen. */
  onRepository?: (fullName: string) => void;
}): Promise<{ name: string; revision: number; file: string }> {
  const { prompter, flags } = input;
  const configDir = input.services.configDir;
  const nameProblem = (value: string) => (/^[a-z][a-z0-9-]{0,62}$/.test(value) ? undefined : "a project name is 1 to 63 lowercase letters, digits and hyphens, starting with a letter");
  if (flags.projectName !== undefined && nameProblem(flags.projectName) !== undefined) {
    throw agentXError("CONFIG_INVALID", `--project-name ${JSON.stringify(flags.projectName)} is not valid; ${nameProblem(flags.projectName)}`);
  }
  // The name comes first when it is given, so an unchanged rerun asks GitHub and the control plane
  // nothing. Otherwise its default is the chosen repository's name.
  let repository: RepositoryInfo | undefined;
  const chosenRepository = async () => {
    const picked = await chooseRepository(await input.services.repositories.list(input.githubToken), prompter, flags.repository);
    input.onRepository?.(picked.fullName);
    return picked;
  };
  let name = flags.projectName;
  if (name === undefined) {
    repository = await chosenRepository();
    name = await prompter.ask("Project name", { flag: "--project-name", defaultValue: agentxRepositoryName(repository.name), validate: nameProblem });
  }

  // A rerun (init resumed after a crash, or the same command typed again) registers no second
  // revision when nothing changed, and never silently replaces a project with different settings.
  const existing = await existingProject(configDir, name);
  if (existing !== undefined) {
    const file = projectFilePath(configDir, name);
    const wantedUrl = repository?.cloneUrl ?? (flags.repository === undefined ? undefined : cloneUrlOf(flags.repository));
    const changed = differences(existing, {
      ...(wantedUrl === undefined ? {} : { repositoryUrl: wantedUrl }),
      ...(flags.setupCommand === undefined ? {} : { setupCommand: flags.setupCommand }),
      ...(flags.testCommand === undefined ? {} : { testCommand: flags.testCommand }),
    });
    if (changed.length === 0) {
      input.write(`Project ${name} is already registered (revision ${existing.revision}) with these settings; nothing to change. Its file is ${file}.`);
      return { name, revision: existing.revision, file };
    }
    throw agentXError("CONFIG_INVALID", `project ${name} already exists (${file}) with a different ${changed.join(" and ")}; to change it, edit that file, raise its revision, and register it as its header says, or choose another --project-name`);
  }

  repository ??= await chosenRepository();
  const repoName = agentxRepositoryName(repository.name);
  const cwd = `repo/${repoName}`;
  const source = repository;
  let trustedSetup: ReturnType<typeof validateSetupProposalResponse> | undefined;
  let setupProposalResponse: Record<string, unknown> | undefined;
  let setupDiscoveryNotice: string | undefined;
  try {
    setupProposalResponse = await setupRequest(input.session, input.services.fetch, "/v1/admin/projects/setup-proposals", {
      repositoryUrl: source.cloneUrl, ref: source.defaultBranch,
    }, 65_000);
  } catch (error) {
    // This route is optional exploration, so unusable discovery can be quarantined while ordinary
    // setup proceeds. Authentication and authorization remain hard failures. Never expose provider
    // text or accept malformed discovery as E2E policy.
    if (error instanceof AgentXError && (error.code === "AUTH_REQUIRED" || error.code === "FORBIDDEN")) throw error;
    if (!(error instanceof AgentXError)
      && !(error instanceof TypeError)
      && !(error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError"))) throw error;
    setupDiscoveryNotice = error instanceof AgentXError && error.code === "CONFIG_INVALID"
      ? "Testing exploration not done: source-backed proposal was malformed or unbound; E2E evidence remains unknown."
      : "Testing exploration not done: source capture exceeded its time or size bound, or the discovery service was unavailable; E2E evidence remains unknown.";
  }
  if (setupProposalResponse !== undefined) {
    try { trustedSetup = validateSetupProposalResponse(setupProposalResponse); }
    catch {
      setupDiscoveryNotice = "Testing exploration not done: source-backed proposal was malformed or unbound; E2E evidence remains unknown.";
    }
  }
  let setupProposal = trustedSetup?.proposal;
  const e2ePolicy = trustedSetup?.policy;
  let setupApproval: StoredSetupDecision | undefined;
  if (input.e2eSetup !== undefined) {
    if (trustedSetup === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "locally supplied E2E setup evidence requires a fresh trusted server proposal");
    const candidateProposal = E2ESetupProposalSchema.parse(input.e2eSetup.proposal);
    const policy = E2EPolicySchema.parse(input.e2eSetup.policy);
    const snapshot = input.e2eSetup.snapshot;
    if (snapshot.candidate.digest !== candidateProposal.candidateDigest || snapshot.candidate.repositories.length !== 1 || snapshot.candidate.repositories[0]?.repositoryId !== source.fullName) {
      throw agentXError("CONFIG_INVALID", "E2E setup proposal must match this repository's immutable candidate snapshot");
    }
    let verifiedProposal: E2ESetupProposal;
    try { verifiedProposal = verifyE2ESetupProposal(candidateProposal, snapshot, snapshot.candidate); }
    catch (error) { throw agentXError("CONFIG_INVALID", `E2E setup proposal failed source verification: ${error instanceof Error ? error.message : "invalid source evidence"}`); }
    if (candidateProposal.targets.length !== policy.targets.length || candidateProposal.targets.some((target) => !policy.targets.some((configured) => JSON.stringify(configured) === JSON.stringify(target)))) {
      throw agentXError("CONFIG_INVALID", "E2E setup policy targets must match the source-backed proposal");
    }
    setupProposal = verifiedProposal;
    if (verifiedProposal.candidateDigest !== trustedSetup.proposal.candidateDigest || !isDeepStrictEqual(policy, trustedSetup.policy)) {
      throw agentXError("CONFIG_INVALID", "locally supplied setup evidence differs from the trusted server proposal");
    }
  }
  const files = input.e2eSetup === undefined
    ? Object.fromEntries(await Promise.all(BUILD_FILES.map(async (file) => [file, await input.services.repositories.file(input.githubToken, source.fullName, file)] as const)))
    : Object.fromEntries(BUILD_FILES.map((file) => [file, input.e2eSetup!.snapshot.sources.find((item) => item.path === file)?.bytes ? Buffer.from(input.e2eSetup!.snapshot.sources.find((item) => item.path === file)!.bytes).toString("utf8") : undefined] as const));
  const proposed = proposeCommands(files, cwd);
  let setup = proposed.setup;
  let readiness = proposed.readiness;
  let e2eAccepted = false;
  const typed = (line: string, timeout: number) => (line.trim() === "" ? [] : [parseCommandLine(line, cwd, timeout)]);
  // Explicit command flags remain the user's selected ordinary project commands. They do not
  // replace or suppress the source-backed E2E proposal; the separate confirmation below still
  // records the owner's approve/decline decision for that proposal.
  if (flags.setupCommand !== undefined) setup = typed(flags.setupCommand, SETUP_TIMEOUT);
  if (flags.testCommand !== undefined) readiness = typed(flags.testCommand, TEST_TIMEOUT);
  if (setupProposal !== undefined && e2ePolicy !== undefined && trustedSetup !== undefined) {
    const targetSummary = setupProposal.targets.map((target) => target.kind + ":" + target.targetId).join(", ") || "no targets detected";
    const mockSummary = setupProposal.missingInputs.filter((item) => item.disposition === "mock-substitutable").map((item) => item.kind).join(", ") || "none detected";
    const blockerSummary = setupProposal.missingInputs.filter((item) => item.disposition === "blocking").map((item) => item.reason).join("; ") || "none";
    input.write(setupProposal.missingInputs.length === 0 ? "Detected source-backed E2E setup." : "Detected source-backed E2E setup with unresolved inputs: " + blockerSummary);
    const commandSummary = "setup: " + setup.map(commandLine).join("; ") + "; readiness: " + readiness.map(commandLine).join("; ");
    e2eAccepted = await prompter.confirm("Use this project setup plan? (" + commandSummary + "; targets: " + targetSummary + "; mock substitutions: " + mockSummary + "; unresolved inputs: " + blockerSummary + ")", { defaultValue: true });
    if (!e2eAccepted) { setup = []; readiness = []; }
    const decision = e2eAccepted ? "approve" : "decline";
    const approval = await setupRequest(input.session, input.services.fetch, "/v1/admin/projects/setup-approvals", {
      projectName: name, proposalRef: trustedSetup.proposalRef, proposalSha256: trustedSetup.proposalSha256, decision,
    });
    if (approval.proposalRef !== trustedSetup.proposalRef || approval.proposalSha256 !== trustedSetup.proposalSha256 || approval.decision !== decision) {
      throw agentXError("RUNTIME_UNAVAILABLE", "control plane returned a mismatched immutable setup decision");
    }
    setupApproval = { proposalRef: trustedSetup.proposalRef, proposalSha256: trustedSetup.proposalSha256, decision };
  } else {
    input.write(proposed.basis.length === 0
      ? `No build file AgentX knows in ${repository.fullName}. AgentX will propose checks for each task; you can add project checks later.`
      : proposed.basis.map((line) => `Proposed from ${line}`).join("\n"));
    const summary = `setup: ${setup.map(commandLine).join("; ") || "none"}; test: ${readiness.map(commandLine).join("; ") || "none"}`;
    if (proposed.basis.length === 0 || !(await prompter.confirm(`Use these commands? (${summary})`, { defaultValue: true }))) {
      setup = typed(await prompter.ask("Setup command (empty for none)", { flag: "--setup-command", defaultValue: setup.map(commandLine)[0] ?? "" }), SETUP_TIMEOUT);
      readiness = typed(await prompter.ask("Test command (empty to let AgentX propose checks per task)", { flag: "--test-command", defaultValue: readiness.map(commandLine)[0] ?? "" }), TEST_TIMEOUT);
    }
  }
  const definition = ProjectDefinitionSchema.parse({
    name, revision: 1,
    repositories: [{ name: repoName, url: repository.cloneUrl, path: cwd, defaultBranch: repository.defaultBranch, credentialRef: await builtInGitHubRef(input.session, input.services.fetch) }],
    setup, readiness, orchestratorInstructions: DEFAULT_INSTRUCTIONS,
    ...(e2eAccepted && e2ePolicy !== undefined ? { e2e: e2ePolicy } : {}),
  });
  const registered = await registerRevision({ env: input.env, session: input.session, definition, services: input.services,
    ...(setupApproval === undefined || e2ePolicy === undefined ? {} : { setupApproval, setupPolicy: e2ePolicy }) });
  input.write(`Registered project ${name}, revision 1, on EC2 workers. Its file is ${registered.file}.`);
  if (setupDiscoveryNotice !== undefined) input.write(setupDiscoveryNotice);
  for (const warning of registered.warnings) input.write(`Warning: ${warning}`);
  return { name, revision: 1, file: registered.file };
}
