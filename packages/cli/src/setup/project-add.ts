// FR-040: agentx project add, and init's first-project step. Every new project runs on EC2 workers
// (ec2-ebs), bound with the foundation's launch template and subnets. The definition is also
// written to <config dir>/<name>.yaml, the file agentx admin project register --file takes, so
// connector add can build the next revision from it. The file holds no secret: the repository's
// credential is a reference (the built-in GitHub App's ref), never a token.
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import {
  ProjectDefinitionSchema, RegistrationPreflightSchema, agentXError, environmentStackName,
  type ConnectorPreflight, type Ec2RuntimeBinding, type ProjectDefinition,
} from "@agentx/contracts";
import { listCredentials } from "../admin/credential.js";
import { cliRuntimeBinding, registerProject } from "../admin/register.js";
import { loadProjectConfig } from "../config.js";
import type { StackOutputs } from "../deploy/parameters.js";
import type { Prompter } from "../init/prompts.js";
import {
  agentxRepositoryName, commandLine, parseCommandLine, proposeCommands, BUILD_FILES, SETUP_TIMEOUT, TEST_TIMEOUT, type RepositoryInfo,
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
  services: Pick<SetupServices, "fetch" | "stackOutputs" | "configDir">;
}): Promise<{ revision: number; preflight: ConnectorPreflight[]; warnings: string[]; file: string }> {
  const foundation = environmentStackName(input.env, "foundation");
  const runtimeBinding = ec2Binding(await input.services.stackOutputs(foundation), foundation);
  const result = (await registerProject({ controlPlaneUrl: input.session.controlPlaneUrl, accessToken: input.session.accessToken, definition: input.definition, runtimeBinding }, input.services.fetch)) as Record<string, unknown>;
  const preflight = RegistrationPreflightSchema.safeParse(result.preflight);
  const warnings = Array.isArray(result.warnings) ? result.warnings.filter((entry): entry is string => typeof entry === "string") : [];
  // Written only after the control plane accepted the revision, so the file never names a revision
  // that is not registered.
  const file = await writeProjectFile(input.services.configDir, input.definition, { env: input.env, binding: runtimeBinding });
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
  const files = Object.fromEntries(await Promise.all(BUILD_FILES.map(async (file) => [file, await input.services.repositories.file(input.githubToken, source.fullName, file)] as const)));
  const proposed = proposeCommands(files, cwd);
  let setup = proposed.setup;
  let readiness = proposed.readiness;
  const typed = (line: string, timeout: number) => (line.trim() === "" ? [] : [parseCommandLine(line, cwd, timeout)]);
  if (flags.setupCommand !== undefined || flags.testCommand !== undefined) {
    if (flags.setupCommand !== undefined) setup = typed(flags.setupCommand, SETUP_TIMEOUT);
    if (flags.testCommand !== undefined) readiness = typed(flags.testCommand, TEST_TIMEOUT);
  } else {
    input.write(proposed.basis.length === 0
      ? `No build file AgentX knows in ${repository.fullName}, so no command is proposed.`
      : proposed.basis.map((line) => `Proposed from ${line}`).join("\n"));
    const summary = `setup: ${setup.map(commandLine).join("; ") || "none"}; test: ${readiness.map(commandLine).join("; ") || "none"}`;
    if (proposed.basis.length === 0 || !(await prompter.confirm(`Use these commands? (${summary})`, { defaultValue: true }))) {
      setup = typed(await prompter.ask("Setup command (empty for none)", { flag: "--setup-command", defaultValue: setup.map(commandLine)[0] ?? "" }), SETUP_TIMEOUT);
      readiness = typed(await prompter.ask("Test command (empty for none)", { flag: "--test-command", defaultValue: readiness.map(commandLine)[0] ?? "" }), TEST_TIMEOUT);
    }
  }
  const definition = ProjectDefinitionSchema.parse({
    name, revision: 1,
    repositories: [{ name: repoName, url: repository.cloneUrl, path: cwd, defaultBranch: repository.defaultBranch, credentialRef: await builtInGitHubRef(input.session, input.services.fetch) }],
    setup, readiness, orchestratorInstructions: DEFAULT_INSTRUCTIONS,
  });
  const registered = await registerRevision({ env: input.env, session: input.session, definition, services: input.services });
  input.write(`Registered project ${name}, revision 1, on EC2 workers. Its file is ${registered.file}.`);
  return { name, revision: 1, file: registered.file };
}
