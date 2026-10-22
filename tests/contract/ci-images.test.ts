import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { WEB_API_BUILD_IMAGE } from "../../packages/verifier/src/host/docker-application-host.js";
import {
  aliasEnvName, assertDigest, isMissingFromMirror, loadManifest, localAlias, mirrorImage, mirrorRef, mirrorTagRef, parseManifest, pinnedRef, pullImage, rewriteDockerfile,
  type CiImage, type Deps, type RunResult,
} from "../../scripts/ci-images.js";
import { DOCKER_25_DIND_IMAGE } from "../support/linux-dind.js";

const read = (path: string) => readFileSync(path, "utf8");
const images = loadManifest();
const byName = (name: string): CiImage => images.find((image) => image.name === name)!;
const OWNER = "PrepLabsAI";
interface Step { name?: string; run?: string; uses?: string; env?: Record<string, string> }

const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : [path];
});

/**
 * Every file whose image refs CI depends on: environments/<name>/Dockerfile, .github/workflows/*.yml, and everything under tests/linux, tests/support and tests/e2e
 * (fixtures and helpers included, so a new test that starts an image is covered without anyone remembering to list it), plus the production host's pin.
 */
function ciFiles(): string[] {
  return [
    ...readdirSync("environments").map((name) => join("environments", name, "Dockerfile")).filter((path) => { try { return statSync(path).isFile(); } catch { return false; } }),
    ...readdirSync(".github/workflows").filter((name) => /\.ya?ml$/.test(name)).map((name) => join(".github/workflows", name)),
    ...["tests/linux", "tests/support", "tests/e2e"].flatMap(walk).filter((path) => /\.(ts|tsx|js|mjs|json|ya?ml|sh)$|Dockerfile$/.test(path)),
    "packages/verifier/src/host/docker-application-host.ts",
  ];
}

/** Value-taking `docker run|create` flags, so the first positional argument (the image) can be told from a flag's value. */
const VALUE_FLAGS = new Set(["--name", "--network", "--net", "--network-alias", "--user", "-u", "--cap-drop", "--cap-add", "--security-opt", "--sysctl", "-v", "--volume", "--mount", "-e", "--env", "--env-file",
  "--dns", "--add-host", "--label", "-l", "--entrypoint", "--tmpfs", "--memory", "-m", "--cpus", "--pids-limit", "--platform", "--workdir", "-w", "--hostname", "-h", "--ulimit",
  "--shm-size", "--log-driver", "--restart", "--ip", "--group-add", "--device", "--publish", "-p", "--cidfile", "--stop-timeout", "--memory-swap", "--cpu-shares"]);
const LOCAL_IMAGE = /^(?:localhost\/|rovara-ci\/|rovara-e2e-executor:)/;

/** Image refs passed to `docker run|pull|create` (shell form or the `("run", ...)` argument-list form) that are neither digest-pinned nor a local image. */
export function bareImageRefs(text: string): string[] {
  const found: string[] = [];
  const check = (verb: string, tokens: string[], quotedOnly: boolean) => {
    let skipNext = false;
    for (const token of tokens) {
      if (skipNext) { skipNext = false; continue; }
      if (token.startsWith("-") || /^["']-/.test(token)) { skipNext = verb !== "pull" && VALUE_FLAGS.has(token.replace(/^["']|["']$/g, "")); continue; }
      // The first positional is the image. A variable or constant (APP_NODE_IMAGE) or a template/shell expansion is checked where it is defined.
      if (quotedOnly ? !/^["'`]/.test(token) : token.startsWith("$")) return;
      const ref = token.replace(/^["'`]|["'`]$/g, "");
      // Prose such as "docker pull failed" in a message is not an image ref.
      if (ref === "" || ref.includes("${") || ref.startsWith("$") || !/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/.test(ref)) return;
      if (!/@sha256:[0-9a-f]{64}$/.test(ref) && !LOCAL_IMAGE.test(ref)) found.push(ref);
      return;
    }
  };
  for (const match of text.matchAll(/\bdocker\s+(run|pull|create)\b([^\n|;&]*)/g)) check(match[1]!, match[2]!.trim().split(/\s+/).filter(Boolean), false);
  // Argument-list form: docker("run", ...), runDocker("pull", ...), execFileAsync("docker", ["create", ...]); not npm's ["run", "script"].
  for (const match of text.matchAll(/(?:\b\w*[dD]ocker\w*\(|["']docker["']\s*,\s*\[)\s*["'](run|pull|create)["']\s*,([\s\S]{0,800})/g)) {
    // Strings, template literals and identifier/call expressions, in order; the image is the first quoted positional after the flags.
    const tokens = match[2]!.match(/`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z_$][\w$.]*(?:\([^()]*\))?/g) ?? [];
    check(match[1]!, tokens, true);
  }
  return found;
}
const REGISTRY_REF = /(?:public\.ecr\.aws|docker\.io|ghcr\.io|quay\.io|gcr\.io|registry\.k8s\.io|registry-1\.docker\.io)\/[A-Za-z0-9._/-]+(?::[A-Za-z0-9._-]+)?(?:@sha256:[0-9a-f]{64})?/g;

describe("the public images CI pulls are all digest-pinned, and every one is mirrored", () => {
  it("lists images pinned by a sha256 digest, with an upstream tag", () => {
    expect(images.map((image) => image.name).sort()).toEqual(["docker-dind", "node-build"]);
    for (const image of images) {
      expect(image.digest, image.name).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(pinnedRef(image), image.name).toMatch(/^[a-z0-9./-]+:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/);
    }
    expect(() => parseManifest(JSON.stringify({ images: [{ name: "x", upstream: "public.ecr.aws/a/b:1", digest: "latest" }] }))).toThrow(/digest/);
    expect(() => parseManifest(JSON.stringify({ images: [{ name: "x", upstream: "public.ecr.aws/a/b", digest: `sha256:${"a".repeat(64)}` }] }))).toThrow(/upstream/);
    expect(() => parseManifest(JSON.stringify({ images: [] }))).toThrow(/no images/);
  });

  it("keeps each digest exactly where it is pinned today (moving one needs a deliberate change in both places)", () => {
    expect(pinnedRef(byName("node-build"))).toBe(WEB_API_BUILD_IMAGE);
    expect(pinnedRef(byName("node-build"))).toBe("public.ecr.aws/docker/library/node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5");
    expect(pinnedRef(byName("docker-dind"))).toBe(DOCKER_25_DIND_IMAGE);
    expect(pinnedRef(byName("docker-dind"))).toBe("public.ecr.aws/docker/library/docker:25.0.5-dind@sha256:b41d0183012e2334aacd4e0b8e339b89246c4fdb7eada6cc86b0355f41328549");
    for (const dockerfile of ["environments/base/Dockerfile", "environments/slack/Dockerfile", "environments/e2e-executor/Dockerfile"]) {
      for (const from of read(dockerfile).match(/^\s*FROM\s.*$/gim) ?? []) expect(from, dockerfile).toContain(pinnedRef(byName("node-build")));
    }
  });

  it("finds no image ref in the workflows, Dockerfiles or Linux tests that is unpinned or missing from the mirror list", () => {
    const pinned = new Set(images.map(pinnedRef));
    const seen = new Set<string>();
    for (const file of ciFiles()) {
      for (const ref of read(file).match(REGISTRY_REF) ?? []) {
        // The product's own release images (public.ecr.aws/agentx/...) appear in fixtures; CI never pulls them.
        if (/^public\.ecr\.aws\/agentx\//.test(ref)) continue;
        // The mirror workflow and ci.yml may name the mirror's own host in prose; a ref under ghcr.io/<owner>/rovara-ci is the mirror, not a source.
        if (/^ghcr\.io\/[^/]+\/rovara-ci\//.test(ref)) continue;
        expect(ref, `${file} names ${ref}`).toMatch(/@sha256:[0-9a-f]{64}$/);
        expect(pinned.has(ref), `${file} names ${ref}, which .github/ci-images.json does not list (so the mirror would not carry it)`).toBe(true);
        seen.add(ref);
      }
    }
    // Both images are really referenced, so the list has no dead entry.
    expect([...seen].sort()).toEqual([...pinned].sort());
  });

  it("finds every FROM CI builds, and every image a Linux test starts, among the pinned images (no bare tag such as node:22 or alpine)", () => {
    const pinned = new Set(images.map(pinnedRef));
    for (const file of ciFiles()) {
      const stages = new Set<string>();
      for (const line of read(file).match(/^\s*FROM\s.*$/gim) ?? []) {
        const words = line.trim().split(/\s+/).filter((word) => !word.startsWith("--"));
        expect(pinned.has(words[1]!) || stages.has(words[1]!.toLowerCase()) || LOCAL_IMAGE.test(words[1]!), `${file}: ${line}`).toBe(true);
        if (words[2]?.toLowerCase() === "as" && words[3]) stages.add(words[3].toLowerCase());
      }
      // The production host is only here for its pin (checked above); its messages mention "docker run" in prose and its images arrive as parameters.
      if (file.startsWith("packages/")) continue;
      expect(bareImageRefs(read(file)), `${file} passes a bare (unpinned) image to docker run, pull or create`).toEqual([]);
    }
    const ci = read(".github/workflows/ci.yml");
    expect(ci).not.toMatch(/^\s*(container|services):/m);
    expect(ci).not.toMatch(/docker (pull|run|create)\b/);
  });

  it("mirrors every listed image, digest for digest, under ghcr.io/<owner>/rovara-ci/<name> in lower case", async () => {
    const calls: string[][] = [];
    const present = new Set<string>();
    const deps: Deps = {
      sleep: async () => undefined, log: () => undefined, delaysMs: [0],
      async run(_command, args) {
        calls.push(args);
        if (args[2] === "inspect") {
          const ref = args[3]!;
          return present.has(ref) ? { code: 0, output: `"${ref.slice(ref.indexOf("@") + 1)}"\n` } : { code: 1, output: "manifest unknown" };
        }
        // imagetools create --tag <mirror tag> <pinned upstream ref>: the copy keeps the source's digest.
        if (args[2] === "create") for (const image of images) if (args[5] === pinnedRef(image)) present.add(mirrorRef(image, OWNER));
        return { code: 0, output: "" };
      },
    };
    for (const image of images) {
      expect(await mirrorImage(image, OWNER, deps)).toBe("copied");
      expect(mirrorRef(image, OWNER)).toBe(`ghcr.io/preplabsai/rovara-ci/${image.name}@${image.digest}`);
    }
    const creates = calls.filter((args) => args[2] === "create");
    expect(creates).toHaveLength(images.length);
    for (const image of images) expect(creates.some((args) => args[5] === pinnedRef(image) && args[4] === mirrorTagRef(image, OWNER)), image.name).toBe(true);
    // A second run leaves existing copies alone.
    for (const image of images) expect(await mirrorImage(image, OWNER, deps)).toBe("present");
    expect(calls.filter((args) => args[2] === "create")).toHaveLength(images.length);
  });

  it("fails the mirror when the copy does not carry the pinned digest, and retries a failed copy only a bounded number of times", async () => {
    const image = byName("node-build");
    const wrong: Deps = { sleep: async () => undefined, log: () => undefined, delaysMs: [0],
      run: async (_command, args) => (args[2] === "inspect" ? (args[3]!.endsWith(image.digest) ? { code: 0, output: `"sha256:${"f".repeat(64)}"` } : { code: 1, output: "" }) : { code: 0, output: "" }) };
    // Before the copy nothing is there (inspect fails), after it a different digest answers: refused.
    let copied = false;
    const drift: Deps = { ...wrong, run: async (command, args) => { if (args[2] === "create") { copied = true; return { code: 0, output: "" }; } return copied ? wrong.run(command, args) : { code: 1, output: "" }; } };
    await expect(mirrorImage(image, OWNER, drift)).rejects.toThrow(/not the pinned/);
    let attempts = 0;
    const failing: Deps = { sleep: async () => undefined, log: () => undefined, delaysMs: [0, 0, 0],
      run: async (_command, args) => { if (args[2] === "create") { attempts += 1; return { code: 1, output: "toomanyrequests: Rate exceeded" }; } return { code: 1, output: "" }; } };
    await expect(mirrorImage(image, OWNER, failing)).rejects.toThrow(/could not copy/);
    expect(attempts).toBe(4);
  });
});

describe("pulling a pinned image in CI", () => {
  const image = byName("docker-dind");
  const OK: RunResult = { code: 0, output: "" };
  const RATE: RunResult = { code: 1, output: "Error response from daemon: toomanyrequests: Rate exceeded" };
  const MISSING: RunResult = { code: 1, output: "Error response from daemon: manifest unknown" };
  const harness = (script: (args: string[], pulled: string[]) => RunResult) => {
    const pulls: string[] = []; const tags: string[][] = []; const sleeps: number[] = []; const logs: string[] = [];
    const deps: Deps = {
      sleep: async (ms) => { sleeps.push(ms); }, log: (line) => logs.push(line),
      async run(_command, args) {
        if (args[0] === "pull") { pulls.push(args.at(-1)!); return script(args, pulls); }
        if (args[0] === "image") { const ref = args.at(-1)!; return { code: 0, output: JSON.stringify([`${ref.slice(0, ref.indexOf("@"))}@${image.digest}`]) }; }
        if (args[0] === "tag") { tags.push(args.slice(1)); return OK; }
        throw new Error(`unexpected ${args.join(" ")}`);
      },
    };
    return { deps, pulls, tags, sleeps, logs };
  };

  it("pulls from the GHCR mirror by digest first, tags the local alias, and never touches the upstream when the mirror answers", async () => {
    const h = harness(() => OK);
    const result = await pullImage(image, OWNER, h.deps);
    expect(result).toEqual({ alias: localAlias(image), source: "mirror" });
    expect(h.pulls).toEqual([mirrorRef(image, OWNER)]);
    expect(h.tags).toEqual([[mirrorRef(image, OWNER), localAlias(image)]]);
    expect(localAlias(image)).toBe("localhost/rovara-ci/docker-dind:b41d0183012e");
    expect(aliasEnvName("docker-dind")).toBe("ROVARA_CI_IMAGE_DOCKER_DIND");
  });

  it("falls back to the upstream, by the same digest, at once when the mirror copy is missing, so the first run before the mirror exists works", async () => {
    const h = harness((args) => (args.at(-1)!.startsWith("ghcr.io/") ? MISSING : OK));
    const result = await pullImage(image, OWNER, h.deps);
    expect(result.source).toBe("upstream");
    expect(h.pulls).toEqual([mirrorRef(image, OWNER), pinnedRef(image)]);
    expect(h.sleeps).toEqual([]);
    expect(h.tags).toEqual([[pinnedRef(image), localAlias(image)]]);
    expect(isMissingFromMirror("denied: permission_denied: read_package")).toBe(true);
    expect(isMissingFromMirror("toomanyrequests: Rate exceeded")).toBe(false);
  });

  it("retries a rate-limited pull with backoff, 4 attempts in all per source, then moves to the upstream and gives up with both reasons", async () => {
    const h = harness(() => RATE);
    h.deps.delaysMs = [1, 2, 3];
    await expect(pullImage(image, OWNER, h.deps)).rejects.toThrow(/mirror: .*Rate exceeded; upstream: .*Rate exceeded/);
    expect(h.pulls.filter((ref) => ref.startsWith("ghcr.io/"))).toHaveLength(4);
    expect(h.pulls.filter((ref) => ref.startsWith("public.ecr.aws/"))).toHaveLength(4);
    expect(h.sleeps).toEqual([1, 2, 3, 1, 2, 3]);
    expect(h.tags).toEqual([]);
  });

  it("recovers when a rate-limited pull succeeds on a later attempt", async () => {
    let calls = 0;
    const h = harness(() => (++calls < 3 ? RATE : OK));
    expect(await pullImage(image, OWNER, h.deps)).toEqual({ alias: localAlias(image), source: "mirror" });
    expect(h.pulls).toHaveLength(3);
    expect(h.sleeps).toHaveLength(2);
  });

  it("pulls from the upstream alone when no owner is known (a local run)", async () => {
    const h = harness(() => OK);
    expect((await pullImage(image, undefined, h.deps)).source).toBe("upstream");
    expect(h.pulls).toEqual([pinnedRef(image)]);
  });

  it("refuses to tag an image that does not carry the pinned digest", async () => {
    const h = harness(() => OK);
    const other = h.deps.run;
    h.deps.run = async (command, args) => (args[0] === "image" ? { code: 0, output: JSON.stringify([`x@sha256:${"e".repeat(64)}`]) } : other(command, args));
    await expect(pullImage(image, OWNER, h.deps)).rejects.toThrow(/does not carry the pinned digest/);
    expect(h.tags).toEqual([]);
  });
});

describe("the executor image build uses the pulled copy", () => {
  it("rewrites every FROM of the executor Dockerfile to the local alias of the same digest, and nothing else", () => {
    const original = read("environments/e2e-executor/Dockerfile");
    const rewritten = rewriteDockerfile(original, images);
    const alias = localAlias(byName("node-build"));
    expect(rewritten.match(/^FROM .*$/gm)).toEqual([`FROM ${alias} AS build`, `FROM ${alias}`]);
    expect(rewritten.replaceAll(alias, pinnedRef(byName("node-build")))).toBe(original);
  });

  it("refuses a base that is not a pinned CI image", () => {
    expect(() => rewriteDockerfile("FROM node:22 AS build\n", images)).toThrow(/does not name a pinned CI image/);
    expect(() => rewriteDockerfile("FROM public.ecr.aws/docker/library/node:22.23.2-bookworm-slim\n", images)).toThrow(/does not name a pinned CI image/);
    expect(() => rewriteDockerfile("RUN true\n", images)).toThrow(/no FROM/);
  });

  const node = pinnedRef(byName("node-build"));
  const alias = localAlias(byName("node-build"));

  it("matches FROM without regard to case or leading whitespace, so a lower-case or indented FROM cannot hide a base", () => {
    expect(rewriteDockerfile(`from ${node} as build\n  From --platform=linux/arm64 ${node}\n\tFROM ${node}\n`, images)).toBe(`from ${alias} as build\n  From --platform=linux/arm64 ${alias}\n\tFROM ${alias}\n`);
    expect(() => rewriteDockerfile(`FROM ${node}\nfrom node:22\n`, images)).toThrow(/does not name a pinned CI image/);
    expect(() => rewriteDockerfile(`FROM ${node}\n   from alpine\n`, images)).toThrow(/does not name a pinned CI image/);
  });

  it("keeps each line's own ending, CRLF or LF, and still sees a FROM on a CRLF line", () => {
    const mixed = `FROM ${node} AS build\r\nRUN true\nFROM ${node}\r\nCOPY --from=build /a /b\r\n`;
    expect(rewriteDockerfile(mixed, images)).toBe(mixed.replaceAll(node, alias));
    expect(() => rewriteDockerfile(`FROM ${node}\r\nFROM node:22\r\n`, images)).toThrow(/does not name a pinned CI image/);
  });

  it("refuses COPY --from and RUN --mount from= that name an image instead of a build stage", () => {
    const head = `FROM ${node} AS build\n`;
    expect(rewriteDockerfile(`${head}FROM ${node}\nCOPY --from=build /a /b\nCOPY --from=0 /a /b\nRUN --mount=type=bind,from=build,target=/x true\n`, images)).toContain(alias);
    for (const bad of ["COPY --from=alpine:3.20 /a /b", "copy --from=docker.io/library/alpine /a /b", "ADD --from=ghcr.io/x/y /a /b", "  COPY --chown=1:1 --from=busybox:1 /a /b",
      "RUN --mount=type=bind,from=alpine:3,target=/x true", "run --mount=from=ghcr.io/x/y,target=/x true", "COPY --from=nostage /a /b"]) {
      expect(() => rewriteDockerfile(`${head}${bad}\r\n`, images), bad).toThrow(/not an earlier build stage/);
    }
  });

  it("uses an alias no public registry can serve, and verifies the alias carries the pinned digest before the build", async () => {
    expect(alias).toMatch(/^localhost\/rovara-ci\/node-build:[0-9a-f]{12}$/);
    const deps = (output: string, code = 0): Deps => ({ run: async () => ({ code, output }), sleep: async () => undefined, log: () => undefined });
    await expect(assertDigest(alias, byName("node-build"), deps(JSON.stringify([`ghcr.io/x/y@${byName("node-build").digest}`])))).resolves.toBeUndefined();
    await expect(assertDigest(alias, byName("node-build"), deps(JSON.stringify([`ghcr.io/x/y@sha256:${"e".repeat(64)}`])))).rejects.toThrow(/does not carry the pinned digest/);
    await expect(assertDigest(alias, byName("node-build"), deps("Error: No such image", 1))).rejects.toThrow(/does not carry the pinned digest/);
    const build = (YAML.parse(read(".github/workflows/ci.yml")) as { jobs: Record<string, Job> }).jobs["linux-runtime"]!.steps.find((step) => (step.run ?? "").includes("docker build"))!.run!;
    expect(build.indexOf("ci-images.ts verify node-build")).toBeGreaterThanOrEqual(0);
    expect(build.indexOf("ci-images.ts verify node-build")).toBeLessThan(build.indexOf("docker build"));
  });
});

describe("the bare-image detector", () => {
  it("flags unpinned images given to docker run, pull and create, and passes pinned, local and variable ones", () => {
    expect(bareImageRefs("docker pull node:22")).toEqual(["node:22"]);
    expect(bareImageRefs("  docker run --rm -v /a:/b --name x alpine sh")).toEqual(["alpine"]);
    expect(bareImageRefs('docker("create", "--name", "x", "busybox:1")')).toEqual(["busybox:1"]);
    expect(bareImageRefs('docker("run", "-d", "--pull=never", "ubuntu:24.04", "sleep")')).toEqual(["ubuntu:24.04"]);
    expect(bareImageRefs(`docker run --rm ${"public.ecr.aws/docker/library/node:22@sha256:" + "a".repeat(64)} node`)).toEqual([]);
    expect(bareImageRefs('docker("run", "--rm", "--pull=never", APP_NODE_IMAGE, "node", "-e", serve)')).toEqual([]);
    expect(bareImageRefs("docker run -t rovara-e2e-executor:ci true")).toEqual([]);
    expect(bareImageRefs('docker run "$IMAGE" true')).toEqual([]);
  });
});

interface Job { permissions?: Record<string, string>; steps: Step[] }

describe("the workflows", () => {
  const ci = YAML.parse(read(".github/workflows/ci.yml")) as { permissions?: Record<string, string>; jobs: Record<string, Job> };
  const mirror = YAML.parse(read(".github/workflows/mirror-ci-images.yml")) as { on: unknown; permissions: Record<string, string>; jobs: Record<string, Job> };

  it("logs in to GHCR with GITHUB_TOKEN (read only) and pulls the images before anything builds or starts a container, with no cloud credentials", () => {
    const job = ci.jobs["linux-runtime"]!;
    expect(job.permissions).toEqual({ contents: "read", packages: "read" });
    const runs = job.steps.map((step) => step.run ?? "");
    const at = (needle: string) => runs.findIndex((run) => run.includes(needle));
    expect(job.steps.find((step) => (step.run ?? "").includes("docker login ghcr.io"))?.env).toEqual({ REGISTRY_TOKEN: "${{ secrets.GITHUB_TOKEN }}" });
    expect(at("docker login ghcr.io")).toBeGreaterThanOrEqual(0);
    expect(at("docker login ghcr.io")).toBeLessThan(at("scripts/ci-images.ts pull --github-env"));
    expect(at("scripts/ci-images.ts pull --github-env")).toBeLessThan(at("docker build"));
    expect(at("scripts/ci-images.ts pull --github-env")).toBeLessThan(at("npx vitest run tests/linux"));
    expect(at("docker build")).toBeLessThan(at("npx vitest run tests/linux"));
    expect(runs[at("docker build")]).toContain("ci-images.ts dockerfile environments/e2e-executor/Dockerfile");
    expect(runs[at("docker build")]).not.toContain("-f environments/");
    const text = read(".github/workflows/ci.yml") + read(".github/workflows/mirror-ci-images.yml");
    expect(text).not.toMatch(/aws-actions|configure-aws-credentials|AWS_ACCESS_KEY|AWS_SECRET|role-to-assume/);
    expect(job.steps.some((step) => (step.uses ?? "").startsWith("aws-actions/"))).toBe(false);
  });

  it("is read-only by default; only linux-runtime (packages: read) and live-aws (OIDC) widen it, each in its own permissions", () => {
    expect(ci.permissions).toEqual({ contents: "read" });
    const widened = Object.entries(ci.jobs).filter(([, job]) => job.permissions !== undefined).map(([name, job]) => [name, job.permissions]);
    expect(widened).toEqual([["linux-runtime", { contents: "read", packages: "read" }], ["live-aws", { "id-token": "write", contents: "read" }]]);
  });

  it("runs the mirror by hand only, with packages: write and no cloud credentials, over the whole list", () => {
    expect(mirror.on).toEqual({ workflow_dispatch: null });
    expect(mirror.permissions).toEqual({ contents: "read", packages: "write" });
    const runs = mirror.jobs.mirror!.steps.map((step) => step.run ?? "");
    expect(runs.some((run) => run.includes("docker login ghcr.io"))).toBe(true);
    // No image name argument: every listed image is copied.
    expect(runs).toContain("node scripts/ci-images.ts mirror");
  });
});

describe("the Docker 25 daemon never pulls from a registry", () => {
  it("is given the build image from the runner's daemon (docker save | docker load, identity checked), never by a docker pull", () => {
    const test = read("tests/linux/e2e-docker25-dns.test.ts");
    expect(test).toContain("dind.load(BUILD_IMAGE, WEB_API_BUILD_IMAGE)");
    expect(test).not.toMatch(/"pull"/);
    const dind = read("tests/support/linux-dind.ts");
    expect(dind).toContain('docker save "$1" | docker exec -i "$2" docker load');
    expect(dind).toContain("did not arrive in the dind daemon with the layers of the outer image");
    expect(dind).not.toMatch(/"pull"/);
  });

  it("pulls in no Linux test or helper except through the one retrying, digest-checking helper", () => {
    for (const file of ciFiles().filter((path) => /^tests\/(linux\/|support\/linux-|e2e\/m1-)/.test(path))) {
      expect(read(file), file).not.toMatch(/["']pull["']|docker pull/);
    }
    expect(read("tests/linux/e2e-network-walls.test.ts")).toContain("ensureLocalImage(APP_NODE_IMAGE, WEB_API_BUILD_IMAGE)");
  });
});
