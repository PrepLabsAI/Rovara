// The public images CI pulls, and how it gets them without hitting a public registry's anonymous rate limit (GitHub's shared runner IPs do: `toomanyrequests: Rate exceeded`).
// Each image is pinned by digest (.github/ci-images.json). The Mirror CI images workflow copies it, digest for digest, to ghcr.io/<owner>/rovara-ci/<name>, and CI pulls from
// there with GITHUB_TOKEN (no cloud credentials), falling back to the upstream registry only when the mirror copy is missing or keeps failing. Either way the image is tagged with a
// local alias (localhost/rovara-ci/<name>:<12 hex of the digest>) after its digest is checked, and the tests and the Dockerfile build use that alias, so nothing later pulls again.
// Node runs this file directly, so it imports only Node's own modules and uses only syntax Node can strip.
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

export interface CiImage { name: string; upstream: string; digest: string }

export const MANIFEST_PATH = ".github/ci-images.json";
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const NAME = /^[a-z][a-z0-9-]*$/;

export function parseManifest(text: string): CiImage[] {
  const parsed = JSON.parse(text) as { images?: unknown };
  if (!Array.isArray(parsed.images) || parsed.images.length === 0) throw new Error("ci-images.json lists no images");
  const seen = new Set<string>();
  return parsed.images.map((raw: unknown) => {
    const { name, upstream, digest } = raw as Partial<CiImage>;
    if (typeof name !== "string" || !NAME.test(name)) throw new Error(`bad CI image name ${String(name)}`);
    if (seen.has(name)) throw new Error(`CI image ${name} is listed twice`);
    seen.add(name);
    if (typeof digest !== "string" || !DIGEST.test(digest)) throw new Error(`CI image ${name} is not pinned by a sha256 digest`);
    if (typeof upstream !== "string" || !/^[a-z0-9.-]+(:[0-9]+)?\/[a-z0-9._/-]+:[A-Za-z0-9._-]+$/.test(upstream)) throw new Error(`CI image ${name} needs a registry/repository:tag upstream`);
    return { name, upstream, digest };
  });
}

export const loadManifest = (path = MANIFEST_PATH): CiImage[] => parseManifest(readFileSync(path, "utf8"));
/** The ref the rest of the repository pins: the upstream tag and its digest. */
export const pinnedRef = (image: CiImage): string => `${image.upstream}@${image.digest}`;
/**
 * The ref the Dockerfile FROM lines and tests use inside CI: no registry involved, so nothing can pull it again. It lives under `localhost/`, which no public registry serves
 * (a bare `rovara-ci/<name>` would resolve to Docker Hub, where someone else could publish it).
 */
export const localAlias = (image: CiImage): string => `localhost/rovara-ci/${image.name}:${image.digest.slice("sha256:".length, "sha256:".length + 12)}`;
/** The environment variable that hands the alias to the tests (tests/support/ci-images.ts reads it). */
export const aliasEnvName = (name: string): string => `ROVARA_CI_IMAGE_${name.toUpperCase().replace(/-/g, "_")}`;
/** The mirror copy of an image by digest. GHCR names are lower case. */
export const mirrorRef = (image: CiImage, owner: string): string => `ghcr.io/${owner.toLowerCase()}/rovara-ci/${image.name}@${image.digest}`;
/** The tag the mirror copy is created under (a registry cannot create a manifest without one); every pull is by digest. */
export const mirrorTagRef = (image: CiImage, owner: string): string => `ghcr.io/${owner.toLowerCase()}/rovara-ci/${image.name}:${image.upstream.slice(image.upstream.lastIndexOf(":") + 1)}`;

export interface RunResult { code: number; output: string }
export interface Deps {
  run: (command: string, args: string[]) => Promise<RunResult>;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  /** Waits between attempts; one more attempt than there are delays. */
  delaysMs?: number[];
}
export const DEFAULT_DELAYS_MS = [5_000, 15_000, 45_000];

/** A mirror pull that failed because the copy (or the right to read it) is not there: retrying will not help, the upstream is the next source. */
export const isMissingFromMirror = (output: string): boolean => /manifest unknown|name unknown|not found|denied|unauthorized|requires authentication/i.test(output);

async function pullWithRetry(ref: string, deps: Deps, giveUpWhenMissing: boolean): Promise<{ ok: boolean; why: string }> {
  const delays = deps.delaysMs ?? DEFAULT_DELAYS_MS;
  let why = "";
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    const result = await deps.run("docker", ["pull", "--quiet", ref]);
    if (result.code === 0) return { ok: true, why: "" };
    why = result.output.trim().split("\n").at(-1) ?? "";
    if (giveUpWhenMissing && isMissingFromMirror(result.output)) return { ok: false, why: `missing: ${why}` };
    if (attempt < delays.length) {
      deps.log(`docker pull ${ref} failed (attempt ${attempt + 1} of ${delays.length + 1}): ${why}; retrying in ${delays[attempt]! / 1000}s`);
      await deps.sleep(delays[attempt]!);
    }
  }
  return { ok: false, why };
}

/** The image under `ref` must carry the pinned digest among its repo digests (a pull by digest already checks the content; this checks what we tag). */
export async function assertDigest(ref: string, image: CiImage, deps: Deps): Promise<void> {
  const inspected = await deps.run("docker", ["image", "inspect", "--format", "{{json .RepoDigests}}", ref]);
  let digests: unknown = [];
  try { digests = JSON.parse(inspected.output.trim()); } catch { /* handled below */ }
  if (inspected.code !== 0 || !Array.isArray(digests) || !digests.some((entry) => typeof entry === "string" && entry.endsWith(`@${image.digest}`))) {
    throw new Error(`${ref} does not carry the pinned digest ${image.digest} for ${image.name}`);
  }
}

export type PullSource = "mirror" | "upstream";

/**
 * Pulls one image into the local daemon and tags the local alias. Order: the GHCR mirror (when an owner is known), then the upstream, each by digest with a bounded
 * retry and backoff. The alias is only tagged after the digest is checked; a digest mismatch is terminal.
 */
export async function pullImage(image: CiImage, owner: string | undefined, deps: Deps): Promise<{ alias: string; source: PullSource }> {
  const sources: { source: PullSource; ref: string }[] = [
    ...(owner ? [{ source: "mirror" as const, ref: mirrorRef(image, owner) }] : []),
    { source: "upstream" as const, ref: pinnedRef(image) },
  ];
  const failures: string[] = [];
  for (const { source, ref } of sources) {
    const pulled = await pullWithRetry(ref, deps, source === "mirror");
    if (!pulled.ok) {
      failures.push(`${source}: ${pulled.why}`);
      deps.log(`${image.name}: not pulled from the ${source} (${pulled.why})${source === "mirror" ? "; falling back to the upstream registry" : ""}`);
      continue;
    }
    await assertDigest(ref, image, deps);
    const alias = localAlias(image);
    const tagged = await deps.run("docker", ["tag", ref, alias]);
    if (tagged.code !== 0) throw new Error(`could not tag ${alias}: ${tagged.output.trim()}`);
    deps.log(`${image.name}: pulled from the ${source} as ${ref}; local alias ${alias}`);
    return { alias, source };
  }
  throw new Error(`could not pull ${image.name} (${pinnedRef(image)}): ${failures.join("; ")}`);
}

/** The digest of the manifest a ref resolves to, or "" when it does not resolve. */
async function remoteDigest(ref: string, deps: Deps): Promise<string> {
  const inspected = await deps.run("docker", ["buildx", "imagetools", "inspect", ref, "--format", "{{json .Manifest.Digest}}"]);
  return inspected.code === 0 ? inspected.output.trim().replace(/"/g, "") : "";
}

/**
 * Copies one image to the mirror, keeping the index digest, and checks the copy by digest. A copy that is already there is left alone, so the workflow can run again.
 * `imagetools create` copies manifests and layers registry to registry, so the multi-architecture index is copied whole and its digest does not change.
 */
export async function mirrorImage(image: CiImage, owner: string, deps: Deps): Promise<"copied" | "present"> {
  if ((await remoteDigest(mirrorRef(image, owner), deps)) === image.digest) {
    deps.log(`${image.name}: ${mirrorRef(image, owner)} is already there`);
    return "present";
  }
  const delays = deps.delaysMs ?? DEFAULT_DELAYS_MS;
  for (let attempt = 0; ; attempt += 1) {
    const created = await deps.run("docker", ["buildx", "imagetools", "create", "--tag", mirrorTagRef(image, owner), pinnedRef(image)]);
    if (created.code === 0) break;
    const why = created.output.trim().split("\n").at(-1) ?? "";
    if (attempt >= delays.length) throw new Error(`could not copy ${pinnedRef(image)} to the mirror: ${why}`);
    deps.log(`copy of ${image.name} failed (attempt ${attempt + 1} of ${delays.length + 1}): ${why}; retrying in ${delays[attempt]! / 1000}s`);
    await deps.sleep(delays[attempt]!);
  }
  const copied = await remoteDigest(mirrorRef(image, owner), deps);
  if (copied !== image.digest) throw new Error(`the mirror copy of ${image.name} has digest ${copied === "" ? "(none)" : copied}, not the pinned ${image.digest}`);
  deps.log(`${image.name}: copied to ${mirrorRef(image, owner)}`);
  return "copied";
}

/**
 * The Dockerfile with every FROM of a pinned image pointed at its local alias, so `docker build` finds the base in the daemon and pulls nothing. Every FROM line must name
 * a pinned image; anything else is refused, so a base that is not mirrored cannot slip in. FROM is matched without regard to case, after any leading whitespace, and with LF or
 * CRLF line endings (each line keeps its own). `COPY/ADD --from=` and `RUN --mount=...,from=` may name only a build stage, never an image (anything with a `/` or `:`, or a name that
 * is not an earlier stage), because the builder would pull that image.
 */
export function rewriteDockerfile(text: string, images: CiImage[]): string {
  let rewritten = 0;
  const stages = new Set<string>();
  let stageIndex = 0;
  const lines = text.split("\n").map((raw) => {
    const cr = raw.endsWith("\r") ? "\r" : "";
    const line = cr === "" ? raw : raw.slice(0, -1);
    const from = /^(\s*FROM\s+(?:--\S+\s+)*)(\S+)(.*)$/i.exec(line);
    if (from) {
      const image = images.find((candidate) => from[2] === pinnedRef(candidate));
      if (!image) throw new Error(`the Dockerfile line "${line.trim()}" does not name a pinned CI image`);
      rewritten += 1;
      stages.add(String(stageIndex));
      stageIndex += 1;
      const alias = /^\s+AS\s+(\S+)/i.exec(from[3]!);
      if (alias) stages.add(alias[1]!.toLowerCase());
      return `${from[1]}${localAlias(image)}${from[3]}${cr}`;
    }
    const options = /^\s*(COPY|ADD|RUN)\s+((?:--\S+\s+)*)/i.exec(line);
    if (options) {
      const sources: string[] = [];
      for (const option of options[2]!.split(/\s+/).filter(Boolean)) {
        if (/^--from=/i.test(option) && options[1]!.toUpperCase() !== "RUN") sources.push(option.slice("--from=".length));
        if (/^--mount=/i.test(option) && options[1]!.toUpperCase() === "RUN") {
          for (const part of option.slice("--mount=".length).split(",")) if (/^from=/i.test(part)) sources.push(part.slice("from=".length));
        }
      }
      for (const source of sources) {
        const name = source.replace(/^["']|["']$/g, "");
        if (/[/:]/.test(name) || !stages.has(name.toLowerCase())) throw new Error(`the Dockerfile line "${line.trim()}" takes files from "${name}", which is not an earlier build stage (an image would be pulled)`);
      }
    }
    return raw;
  });
  if (rewritten === 0) throw new Error("the Dockerfile has no FROM line to rewrite");
  return lines.join("\n");
}

const spawnRun = (command: string, args: string[]): Promise<RunResult> => new Promise((resolve) => {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.on("error", (error) => resolve({ code: 127, output: `${output}${error.message}` }));
  child.on("close", (code) => resolve({ code: code ?? 1, output }));
});
const realDeps = (): Deps => ({ run: spawnRun, sleep: (ms) => new Promise((done) => setTimeout(done, ms)), log: (line) => process.stdout.write(`${line}\n`) });

function select(all: CiImage[], names: string[]): CiImage[] {
  if (names.length === 0) return all;
  return names.map((name) => {
    const found = all.find((image) => image.name === name);
    if (!found) throw new Error(`no CI image called ${name}; known: ${all.map((image) => image.name).join(", ")}`);
    return found;
  });
}

async function main(argv: string[]): Promise<number> {
  const [command, ...restArgs] = argv;
  const ownerFlag = restArgs.find((arg) => arg.startsWith("--owner="));
  const rest = restArgs.filter((arg) => arg !== ownerFlag);
  const all = loadManifest();
  const owner = (ownerFlag?.slice("--owner=".length) ?? process.env.GITHUB_REPOSITORY_OWNER)?.trim() || undefined;
  if (command === "pull") {
    const toGithubEnv = rest.includes("--github-env");
    const deps = realDeps();
    const lines: string[] = [];
    for (const image of select(all, rest.filter((arg) => arg !== "--github-env"))) {
      const { alias, source } = await pullImage(image, owner, deps);
      if (source === "upstream" && owner) process.stdout.write(`::warning title=CI image ${image.name}::pulled from the upstream registry, not the GHCR mirror; run the Mirror CI images workflow\n`);
      lines.push(`${aliasEnvName(image.name)}=${alias}`);
    }
    if (toGithubEnv) {
      if (!process.env.GITHUB_ENV) throw new Error("--github-env needs GITHUB_ENV");
      appendFileSync(process.env.GITHUB_ENV, `${lines.join("\n")}\n`);
    } else {
      process.stdout.write(`${lines.join("\n")}\n`);
    }
    return 0;
  }
  if (command === "mirror") {
    if (!owner) throw new Error("mirror needs GITHUB_REPOSITORY_OWNER");
    const deps = realDeps();
    for (const image of select(all, rest)) await mirrorImage(image, owner, deps);
    return 0;
  }
  if (command === "verify") {
    // Before `docker build`: each local alias must exist and carry the pinned digest, or the build would pull (or build on) something else.
    const deps = realDeps();
    for (const image of select(all, rest)) {
      await assertDigest(localAlias(image), image, deps);
      deps.log(`${image.name}: ${localAlias(image)} carries ${image.digest}`);
    }
    return 0;
  }
  if (command === "dockerfile") {
    const [from, to] = rest;
    if (!from || !to) throw new Error("usage: ci-images.ts dockerfile <in> <out>");
    writeFileSync(to, rewriteDockerfile(readFileSync(from, "utf8"), all));
    return 0;
  }
  throw new Error("usage: ci-images.ts pull [--github-env] [--owner=x] [name...] | mirror [--owner=x] [name...] | verify [name...] | dockerfile <in> <out>");
}

if (process.argv[1]?.endsWith("ci-images.ts")) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "ci-images failed"}\n`);
    process.exitCode = 1;
  });
}
