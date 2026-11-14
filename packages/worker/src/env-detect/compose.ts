// Compose detector (test services D1; design test-services.md 3.2). Reads `docker-compose*.y*ml` and `compose*.y*ml`, and the compose files a dev container names, and reports what the services are: image family and
// major version, the NAMES of the settings they take (never a value), ports, whether there is a health check, init scripts that sit in the repository, and what each waits for.
//
// Rovara never runs a compose file as written. A field it would refuse is FLAGGED on the candidate (`hints.refused`), so a person sees it and the later build step can act on it: `privileged`, host networking /
// pid / ipc, a mount from the host (including the Docker socket), `cap_add`, `devices`, and `build:` (a service built from the project's own files; the later walled build handles it).
// Safe by construction: the YAML is read under `safe-yaml.ts`'s limits; a file that breaks them is skipped with a fixed-words note; a path a dev container names is joined inside the repository or not read at all
// (a `..` that leaves it, an absolute path, a home or variable path); only paths the reader was given are read, so a link the caller skipped is never followed.
import { candidate, dirname, DEPENDENCY_SKIP_DIRS, awsServicesFromList, familyFromImage, joinInside, mergeCandidates, safeEnvName, slug } from "./dependency-candidates.js";
import { ownEntries, ownGet, pairOf, parseSafeYaml, YAML_REFUSAL_WORDS } from "./safe-yaml.js";
import { type DependencyCandidate, type DependencyHints, type DependencyRefusedField, type Detector, type RepositoryReader } from "./types.js";
import { isMap, isScalar } from "yaml";

const COMPOSE_FILE = /(?:^|\/)(?:docker-compose|compose)[^/]*\.ya?ml$/u;
const DEVCONTAINER_FILE = /(?:^|\/)(?:\.devcontainer\/(?:[^/]+\/)?devcontainer\.json|\.devcontainer\.json)$/u;
export const COMPOSE_MAX_FILES = 12;
export const COMPOSE_MAX_SERVICES = 200;
const MAX_PORTS = 8;

/** JSON with comments and trailing commas (the dev container format) as plain JSON text: comments and trailing commas are blanked outside strings. Never evaluates anything. */
export function stripJsonc(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (inString) {
      out += char;
      if (char === "\\") { out += text[i + 1] ?? ""; i += 1; } else if (char === "\"") inString = false;
    } else if (char === "\"") { inString = true; out += char; }
    else if (char === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i += 1; out += "\n"; }
    else if (char === "/" && text[i + 1] === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) { if (text[i] === "\n") out += "\n"; i += 1; } i += 1; }
    else out += char;
  }
  return out.replace(/,(\s{0,40}[}\]])/gu, "$1");
}

/** The compose files the dev containers of the repository name, joined inside the repository and present in the path list. */
async function devContainerComposeFiles(repo: RepositoryReader): Promise<string[]> {
  const found: string[] = [];
  for (const path of repo.paths.filter((candidatePath) => DEVCONTAINER_FILE.test(candidatePath) && !DEPENDENCY_SKIP_DIRS.test(candidatePath)).slice(0, 6)) {
    const text = await repo.read(path);
    if (text === undefined) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(stripJsonc(text)); } catch { continue; }
    const named = ownGet(parsed, "dockerComposeFile");
    for (const reference of typeof named === "string" ? [named] : Array.isArray(named) ? named : []) {
      if (typeof reference !== "string") continue;
      const joined = joinInside(dirname(path), reference);
      if (joined !== undefined && repo.paths.includes(joined)) found.push(joined);
    }
  }
  return found;
}

const isHostSource = (source: string): boolean => /^(?:\/|\.|~|\$)/u.test(source) || /^[A-Za-z]:[\\/]/u.test(source);
const truthy = (value: unknown): boolean => value === true || (typeof value === "string" && value.trim().toLowerCase() === "true");
const hostMode = (value: unknown): boolean => typeof value === "string" && /^host\b/u.test(value.trim());

interface Mount { source?: string; target?: string; bind: boolean }
function mountsOf(volumes: unknown): Mount[] {
  const mounts: Mount[] = [];
  for (const entry of Array.isArray(volumes) ? volumes.slice(0, 64) : []) {
    if (typeof entry === "string") {
      const parts = entry.split(":");
      if (parts.length === 1) mounts.push({ target: parts[0]!, bind: false });
      else mounts.push({ source: parts[0]!, target: parts[1]!, bind: isHostSource(parts[0]!) });
    } else {
      const source = ownGet(entry, "source");
      const target = ownGet(entry, "target");
      const type = ownGet(entry, "type");
      mounts.push({ ...(typeof source === "string" ? { source } : {}), ...(typeof target === "string" ? { target } : {}), bind: type === "bind" || (typeof source === "string" && isHostSource(source)) });
    }
  }
  return mounts;
}

function portsOf(ports: unknown): number[] {
  const found: number[] = [];
  for (const entry of Array.isArray(ports) ? ports.slice(0, 32) : []) {
    let container: string | undefined;
    if (typeof entry === "number") container = String(entry);
    else if (typeof entry === "string") container = entry.split("/")[0]!.split(":").at(-1);
    else { const target = ownGet(entry, "target"); container = typeof target === "number" ? String(target) : undefined; }
    const port = container !== undefined && /^\d{1,5}$/u.test(container) ? Number(container) : undefined;
    if (port !== undefined && port >= 1 && port <= 65_535 && !found.includes(port)) found.push(port);
  }
  return found.slice(0, MAX_PORTS);
}

/** `environment:` as a list of "K=V" or a map: the NAMES only, and for LocalStack's `SERVICES` the service ids it lists. A value is read for that one list and never kept. */
function environmentOf(environment: unknown): { names: string[]; services: string[] } {
  const names: string[] = [];
  let servicesValue: unknown;
  const take = (name: string, value: unknown): void => {
    const safe = safeEnvName(name);
    if (safe !== undefined) names.push(safe);
    if (name === "SERVICES") servicesValue = value;
  };
  if (Array.isArray(environment)) for (const entry of environment.slice(0, 200)) { if (typeof entry === "string") { const at = entry.indexOf("="); take(at < 0 ? entry : entry.slice(0, at), at < 0 ? undefined : entry.slice(at + 1)); } }
  else for (const [name, value] of ownEntries(environment).slice(0, 200)) take(name, value);
  return { names: [...new Set(names)], services: awsServicesFromList(servicesValue) };
}

function dependsOnOf(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : ownEntries(value).map(([name]) => name);
  return raw.map((name) => slug(name)).filter((name): name is string => name !== undefined).slice(0, 16);
}

export interface ComposeReading { candidates: DependencyCandidate[]; notes: string[]; unknownServices: number }

/** Reads one compose file's text. Pure: `repoPaths` is only used to find init scripts that really are in the repository. */
export function readCompose(path: string, text: string, repoPaths: readonly string[]): ComposeReading {
  const out: ComposeReading = { candidates: [], notes: [], unknownServices: 0 };
  const parsed = parseSafeYaml(text);
  if (!parsed.ok) { out.notes.push(`A compose file ${YAML_REFUSAL_WORDS[parsed.reason]}, so it was not read.`); return out; }
  const safe = parsed.value;
  const services = pairOf(safe.document.contents, "services");
  if (services === undefined || !isMap(services.value)) return out;
  for (const pair of services.value.items.slice(0, COMPOSE_MAX_SERVICES)) {
    if (!isScalar(pair.key) || typeof pair.key.value !== "string") continue;
    const name = pair.key.value;
    const service = safe.toPlain(pair.value);
    if (service === null || typeof service !== "object" || Array.isArray(service)) continue;
    const evidence = { path, line: safe.lineOf(pair.key) };
    const image = familyFromImage(ownGet(service, "image"));
    const refused: DependencyRefusedField[] = [];
    if (truthy(ownGet(service, "privileged"))) refused.push("privileged");
    if (hostMode(ownGet(service, "network_mode"))) refused.push("host_network");
    if (hostMode(ownGet(service, "pid"))) refused.push("host_pid");
    if (hostMode(ownGet(service, "ipc"))) refused.push("host_ipc");
    const capAdd = ownGet(service, "cap_add");
    if (Array.isArray(capAdd) && capAdd.length > 0) refused.push("cap_add");
    const devices = ownGet(service, "devices");
    if (Array.isArray(devices) && devices.length > 0) refused.push("devices");
    const build = ownGet(service, "build");
    if (build !== undefined && build !== null && build !== false) refused.push("build");
    const initFiles: string[] = [];
    for (const mount of mountsOf(ownGet(service, "volumes"))) {
      if (mount.source?.includes("docker.sock") === true || mount.target?.includes("docker.sock") === true) refused.push("docker_socket");
      if (mount.bind) {
        refused.push("host_volume");
        if (mount.source !== undefined && mount.target?.startsWith("/docker-entrypoint-initdb.d") === true) {
          const joined = joinInside(dirname(path), mount.source);
          if (joined !== undefined && repoPaths.includes(joined)) initFiles.push(joined);
        }
      }
    }
    const environment = environmentOf(ownGet(service, "environment"));
    const ports = portsOf(ownGet(service, "ports"));
    const dependsOn = dependsOnOf(ownGet(service, "depends_on"));
    const hints: DependencyHints = {
      ...(image?.version === undefined ? {} : { version: image.version }),
      ...(environment.names.length === 0 ? {} : { envNames: environment.names }),
      ...(ports.length === 0 ? {} : { ports }),
      ...(ownGet(service, "healthcheck") === undefined ? {} : { hasHealthcheck: true }),
      ...(initFiles.length === 0 ? {} : { initFiles: [...new Set(initFiles)].slice(0, 4) }),
      ...(dependsOn.length === 0 ? {} : { dependsOn }),
      ...(refused.length === 0 ? {} : { refused: [...new Set(refused)] }),
      seenBy: ["compose"],
    };
    if (image?.localstack === true) {
      // A local AWS emulator image names the AWS services it fakes; each is a dependency of its own.
      const emulatorHints: DependencyHints = { ...hints };
      delete emulatorHints.version;
      for (const service of environment.services) out.candidates.push(candidate(`aws:${service}`, "declared", evidence, emulatorHints));
      if (environment.services.length === 0) out.notes.push("A compose file starts a local AWS emulator without naming its services, so no AWS service was inferred from it.");
      continue;
    }
    if (image !== undefined) out.candidates.push(candidate(image.family, "declared", evidence, hints));
    else if (refused.includes("build")) {
      // A service built from the project's own files: the later build step decides. It is reported under its compose name.
      const family = slug(name);
      if (family !== undefined) out.candidates.push(candidate(family, "declared", evidence, hints, "other"));
    } else out.unknownServices += 1;
  }
  return out;
}

export const detectCompose: Detector = async ({ repo }) => {
  const files = [...new Set([...repo.paths.filter((path) => COMPOSE_FILE.test(path) && !DEPENDENCY_SKIP_DIRS.test(path)), ...(await devContainerComposeFiles(repo))])].slice(0, COMPOSE_MAX_FILES);
  if (files.length === 0) return {};
  const found: DependencyCandidate[] = [];
  const notes: string[] = [];
  let unknown = 0;
  for (const path of files) {
    const text = await repo.read(path);
    if (text === undefined) continue;
    const reading = readCompose(path, text, repo.paths);
    found.push(...reading.candidates);
    notes.push(...reading.notes);
    unknown += reading.unknownServices;
  }
  if (found.some((item) => item.hints.refused?.includes("build") === true)) notes.push("A compose file builds a service from the project's own files. Rovara does not run compose files as written; a service built in the project is built later, in a walled area, during setup only.");
  if (found.some((item) => (item.hints.refused ?? []).some((field) => field !== "build"))) notes.push("A compose file asks for something Rovara refuses to give a test container (privileged mode, host networking, a mount from the host, the Docker socket, added capabilities or devices). It is flagged and not applied.");
  if (unknown > 0) notes.push(`${String(unknown)} compose ${unknown === 1 ? "service uses an image" : "services use images"} Rovara has no catalog entry for; ${unknown === 1 ? "it was" : "they were"} not turned into dependencies.`);
  const dependencies = mergeCandidates(found);
  return dependencies.length === 0 && notes.length === 0 ? {} : { ...(dependencies.length === 0 ? {} : { dependencies }), notes };
};
