// CI services detector (test services D2; design test-services.md 3.2). What a project's own CI starts beside its tests is the strongest sign of what the tests expect: GitHub Actions `services:` in workflow jobs,
// GitLab CI `services:` (top level, `default:` and per job), and the secondary images of a CircleCI job. Reads the same fields as the compose reader: image family and major version, the NAMES of the settings,
// ports, whether a health check is set. A value is never copied; the options text of a GitHub service is only searched for flags Rovara refuses (`--privileged`, `--network host`, `--cap-add`, `--device`) and for
// `--health-cmd`, and none of it is kept. YAML is read under `safe-yaml.ts`'s limits. Nothing is run.
import { awsServicesFromList, candidate, DEPENDENCY_SKIP_DIRS, familyFromImage, mergeCandidates, safeEnvName } from "./dependency-candidates.js";
import { ownEntries, ownGet, pairOf, parseSafeYaml, YAML_REFUSAL_WORDS } from "./safe-yaml.js";
import type { DependencyCandidate, DependencyHints, DependencyRefusedField, Detector } from "./types.js";
import { isAlias, isMap, isScalar, isSeq } from "yaml";

const GITHUB_WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/u;
const GITLAB_FILE = /(?:^|\/)\.gitlab-ci(?:\.[A-Za-z0-9_-]+)?\.ya?ml$/u;
const CIRCLE_FILE = /^\.circleci\/config\.ya?ml$/u;
export const CI_MAX_FILES = 30;
const MAX_JOBS = 200;
const MAX_SERVICES_PER_JOB = 32;

function namesOf(environment: unknown): string[] {
  const names = Array.isArray(environment)
    ? environment.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.split("=")[0]!)
    : ownEntries(environment).map(([name]) => name);
  return [...new Set(names.slice(0, 100).map((name) => safeEnvName(name)).filter((name): name is string => name !== undefined))];
}

function portsOf(ports: unknown): number[] {
  const found: number[] = [];
  for (const entry of Array.isArray(ports) ? ports.slice(0, 32) : []) {
    const container = typeof entry === "number" ? String(entry) : typeof entry === "string" ? entry.split("/")[0]!.split(":").at(-1) : undefined;
    const port = container !== undefined && /^\d{1,5}$/u.test(container) ? Number(container) : undefined;
    if (port !== undefined && port >= 1 && port <= 65_535 && !found.includes(port)) found.push(port);
  }
  return found.slice(0, 8);
}

/** The docker options text of a GitHub service, searched (never kept) for the flags Rovara refuses and for a health command. */
function optionFlags(options: unknown): { refused: DependencyRefusedField[]; health: boolean } {
  const refused: DependencyRefusedField[] = [];
  if (typeof options !== "string" || options.length > 2_000) return { refused, health: false };
  const tokens = options.split(/\s{1,40}/u).filter((token) => token !== "");
  const has = (flag: string): boolean => tokens.some((token) => token === flag || token.startsWith(`${flag}=`));
  const value = (flag: string): string | undefined => { const at = tokens.findIndex((token) => token === flag || token.startsWith(`${flag}=`)); return at < 0 ? undefined : tokens[at]!.includes("=") ? tokens[at]!.split("=")[1] : tokens[at + 1]; };
  if (has("--privileged")) refused.push("privileged");
  for (const flag of ["--network", "--net"]) if (value(flag)?.startsWith("host") === true) refused.push("host_network");
  if (value("--pid")?.startsWith("host") === true) refused.push("host_pid");
  if (value("--ipc")?.startsWith("host") === true) refused.push("host_ipc");
  if (has("--cap-add")) refused.push("cap_add");
  if (has("--device")) refused.push("devices");
  for (const flag of ["-v", "--volume", "--mount"]) if (has(flag)) { refused.push("host_volume"); if (tokens.some((token) => token.includes("docker.sock"))) refused.push("docker_socket"); }
  return { refused: [...new Set(refused)], health: has("--health-cmd") };
}

interface ServiceInput { image: unknown; environment: unknown; ports: unknown; health: boolean; refused: DependencyRefusedField[]; line: number }

interface Out { candidates: DependencyCandidate[]; unknown: number; unnamedEmulator: number }

function addService(out: Out, path: string, input: ServiceInput): void {
  const image = familyFromImage(input.image);
  if (image === undefined) { out.unknown += 1; return; }
  const env = namesOf(input.environment);
  const ports = portsOf(input.ports);
  const hints: DependencyHints = {
    ...(image.version === undefined ? {} : { version: image.version }),
    ...(env.length === 0 ? {} : { envNames: env }),
    ...(ports.length === 0 ? {} : { ports }),
    ...(input.health ? { hasHealthcheck: true } : {}),
    ...(input.refused.length === 0 ? {} : { refused: input.refused }),
    seenBy: ["ci"],
  };
  if (image.localstack === true) {
    // A local AWS emulator image names the AWS services it fakes; each is a dependency of its own.
    const emulatorHints: DependencyHints = { ...hints };
    delete emulatorHints.version;
    const services = awsServicesFromList(ownGet(input.environment, "SERVICES"));
    if (services.length === 0) out.unnamedEmulator += 1;
    for (const service of services) out.candidates.push(candidate(`aws:${service}`, "declared", { path, line: input.line }, emulatorHints));
    return;
  }
  out.candidates.push(candidate(image.family, "declared", { path, line: input.line }, hints));
}

function readGithub(path: string, text: string, out: Out, notes: string[]): void {
  const parsed = parseSafeYaml(text);
  if (!parsed.ok) { notes.push(`A CI file ${YAML_REFUSAL_WORDS[parsed.reason]}, so it was not read.`); return; }
  const safe = parsed.value;
  const jobs = pairOf(safe.document.contents, "jobs");
  if (jobs === undefined || !isMap(jobs.value)) return;
  for (const job of jobs.value.items.slice(0, MAX_JOBS)) {
    if (!isMap(job.value)) continue;
    const services = pairOf(job.value, "services");
    if (services === undefined || !isMap(services.value)) continue;
    for (const service of services.value.items.slice(0, MAX_SERVICES_PER_JOB)) {
      if (!isScalar(service.key)) continue;
      const value = safe.toPlain(service.value);
      const flags = optionFlags(ownGet(value, "options"));
      addService(out, path, { image: ownGet(value, "image"), environment: ownGet(value, "env"), ports: ownGet(value, "ports"), health: flags.health, refused: flags.refused, line: safe.lineOf(service.key) });
    }
  }
}

function readGitlab(path: string, text: string, out: Out, notes: string[]): void {
  const parsed = parseSafeYaml(text);
  if (!parsed.ok) { notes.push(`A CI file ${YAML_REFUSAL_WORDS[parsed.reason]}, so it was not read.`); return; }
  const safe = parsed.value;
  const root = safe.document.contents;
  if (!isMap(root)) return;
  const lists: Array<{ node: unknown }> = [];
  for (const entry of root.items.slice(0, MAX_JOBS)) {
    if (!isScalar(entry.key) || typeof entry.key.value !== "string") continue;
    if (entry.key.value === "services") lists.push({ node: entry.value });
    else if (isMap(entry.value)) {
      const services = pairOf(entry.value, "services");
      if (services !== undefined) lists.push({ node: services.value });
    }
  }
  for (const { node: listed } of lists) {
    const node = isAlias(listed) ? listed.resolve(safe.document) : listed;
    if (!isSeq(node)) continue;
    for (const item of node.items.slice(0, MAX_SERVICES_PER_JOB)) {
      const value = safe.toPlain(item);
      const line = safe.lineOf(item);
      if (typeof value === "string") addService(out, path, { image: value, environment: undefined, ports: undefined, health: false, refused: [], line });
      else addService(out, path, { image: ownGet(value, "name"), environment: ownGet(value, "variables"), ports: undefined, health: false, refused: [], line });
    }
  }
}

function readCircle(path: string, text: string, out: Out, notes: string[]): void {
  const parsed = parseSafeYaml(text);
  if (!parsed.ok) { notes.push(`A CI file ${YAML_REFUSAL_WORDS[parsed.reason]}, so it was not read.`); return; }
  const safe = parsed.value;
  const jobs = pairOf(safe.document.contents, "jobs");
  if (jobs === undefined || !isMap(jobs.value)) return;
  for (const job of jobs.value.items.slice(0, MAX_JOBS)) {
    if (!isMap(job.value)) continue;
    const docker = pairOf(job.value, "docker");
    // The first image of a CircleCI job runs the steps; the others are the services beside it.
    if (docker === undefined || !isSeq(docker.value)) continue;
    for (const item of docker.value.items.slice(1, MAX_SERVICES_PER_JOB + 1)) {
      const value = safe.toPlain(item);
      addService(out, path, { image: ownGet(value, "image"), environment: ownGet(value, "environment"), ports: undefined, health: false, refused: [], line: safe.lineOf(item) });
    }
  }
}

export const detectCiServices: Detector = async ({ repo }) => {
  const files = repo.paths.filter((path) => !DEPENDENCY_SKIP_DIRS.test(path) && (GITHUB_WORKFLOW.test(path) || GITLAB_FILE.test(path) || CIRCLE_FILE.test(path))).slice(0, CI_MAX_FILES);
  if (files.length === 0) return {};
  const out: Out = { candidates: [], unknown: 0, unnamedEmulator: 0 };
  const notes: string[] = [];
  for (const path of files) {
    const text = await repo.read(path);
    if (text === undefined) continue;
    if (GITHUB_WORKFLOW.test(path)) readGithub(path, text, out, notes);
    else if (GITLAB_FILE.test(path)) readGitlab(path, text, out, notes);
    else readCircle(path, text, out, notes);
  }
  if (out.candidates.some((item) => (item.hints.refused ?? []).length > 0)) notes.push("A CI service asks for something Rovara refuses to give a test container (privileged mode, host networking, a mount from the host, added capabilities or devices). It is flagged and not applied.");
  if (out.unnamedEmulator > 0) notes.push("A CI file starts a local AWS emulator without naming its services, so no AWS service was inferred from it.");
  if (out.unknown > 0) notes.push(`${String(out.unknown)} CI ${out.unknown === 1 ? "service uses an image" : "services use images"} Rovara has no catalog entry for; ${out.unknown === 1 ? "it was" : "they were"} not turned into dependencies.`);
  const dependencies = mergeCandidates(out.candidates);
  return dependencies.length === 0 && notes.length === 0 ? {} : { ...(dependencies.length === 0 ? {} : { dependencies }), notes };
};
