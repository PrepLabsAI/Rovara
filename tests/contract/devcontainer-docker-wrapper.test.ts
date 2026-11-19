// Lane L4-NETG (DEC 254zzz77): the docker program a gateway-mode worker hands the devcontainer CLI (packages/worker/ec2/devcontainer-docker.sh). It is run here against a fake docker that records its arguments.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const wrapper = readFileSync(new URL("../../packages/worker/ec2/devcontainer-docker.sh", import.meta.url), "utf8");

function run(args: string[], environment: Record<string, string>): { status: number | null; stderr: string; seen: string[] | undefined; env: Record<string, string> | undefined } {
  const dir = mkdtempSync(join(tmpdir(), "dc-docker-"));
  const fakeDocker = join(dir, "docker");
  const record = join(dir, "args.json");
  writeFileSync(fakeDocker, `#!/bin/bash\nnode -e 'const fs=require("fs");fs.writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)));fs.writeFileSync(process.argv[1]+".env", JSON.stringify(process.env))' "${record}" "$@"\n`);
  chmodSync(fakeDocker, 0o755);
  const script = join(dir, "wrapper.sh");
  writeFileSync(script, wrapper.split("/usr/local/bin/docker").join(fakeDocker));
  chmodSync(script, 0o755);
  const ran = spawnSync("bash", [script, ...args], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...environment } });
  return { status: ran.status, stderr: ran.stderr, seen: existsSync(record) ? (JSON.parse(readFileSync(record, "utf8")) as string[]) : undefined, env: existsSync(`${record}.env`) ? (JSON.parse(readFileSync(`${record}.env`, "utf8")) as Record<string, string>) : undefined };
}
const GATEWAY = { AGENTX_SANDBOX_NETWORK: "rovara-snet", AGENTX_SANDBOX_DNS: "172.28.250.2" };
const WALL = ["--network", "rovara-snet", "--dns", "172.28.250.2", "--cap-drop", "NET_RAW"];

describe("the devcontainer docker wrapper", () => {
  it("puts the internal network, the gateway as the only name server and no NET_RAW on `docker run` and `docker create`, in front of what the CLI asked for", () => {
    const asked = ["--sig-proxy=false", "-a", "STDOUT", "--mount", "type=bind,source=/mnt/workspace/a b,target=/mnt/workspace/a b", "--label", "x=y z", "--entrypoint", "/bin/sh", "image:tag", "-c", "echo 'hi there'"];
    for (const verb of ["run", "create"]) {
      const result = run([verb, ...asked], GATEWAY);
      expect(result.status, result.stderr).toBe(0);
      expect(result.seen).toEqual([verb, ...WALL, ...asked]);
    }
    for (const verb of ["run", "create"]) expect(run(["container", verb, ...asked], GATEWAY).seen).toEqual([verb, ...WALL, ...asked]);
  });

  it("passes every other command through untouched (pull, exec, inspect, rm, volume, container ls, image ls, start)", () => {
    for (const args of [["pull", "img"], ["image", "ls"], ["builder", "prune"], ["start", "c"], ["exec", "-i", "c", "sh"], ["inspect", "--type", "container", "c"], ["rm", "--force", "--volumes", "c"], ["volume", "rm", "v"], ["container", "ls"], ["ps"], ["version"], []]) {
      const result = run(args, GATEWAY);
      expect(result.status, args.join(" ")).toBe(0);
      expect(result.seen, args.join(" ")).toEqual(args);
    }
  });

  // Lane L4-NETG2 (DEC 254zzz90): the image build (Dockerfile RUN, features' install.sh) is walled the same way.
  it("puts the internal network on `docker build` (also `image build` and `builder build`), in front of what the CLI asked for, and adds nothing else", () => {
    const asked = ["-f", "/tmp/Dockerfile.extended", "--build-arg", "A=b c", "-t", "img:tag", "--label", "x=y", "/ctx dir"];
    for (const verb of [["build"], ["image", "build"], ["builder", "build"]]) {
      const result = run([...verb, ...asked], GATEWAY);
      expect(result.status, result.stderr).toBe(0);
      expect(result.seen).toEqual(["build", "--network", "rovara-snet", ...asked]);
    }
  });

  it("refuses a build that names its own network, in any spelling, and runs nothing", () => {
    for (const own of [["--network", "host"], ["--network=host"], ["--net", "bridge"], ["--net=bridge"], ["--network", "rovara-snet"], ["--network"]]) {
      for (const verb of [["build"], ["image", "build"]]) {
        const result = run([...verb, "-t", "x", ...own, "."], GATEWAY);
        expect(result.status, own.join(" ")).toBe(125);
        expect(result.seen).toBeUndefined();
      }
    }
    // An option that merely starts like it is not the network option.
    expect(run(["build", "--network-alias-nothing=1", "."], GATEWAY).status).toBe(0);
  });

  it("refuses buildx outright (BuildKit takes no named network, so a buildx build could not be walled): the devcontainer CLI then finds no buildx and uses the classic builder", () => {
    for (const args of [["buildx", "version"], ["buildx", "build", "--load", "."], ["buildx", "bake"], ["buildx", "create"]]) {
      const result = run(args, GATEWAY);
      expect(result.status, args.join(" ")).toBe(125);
      expect(result.seen).toBeUndefined();
    }
  });

  it("refuses a leading global option (-H, --context, --config), which could point docker somewhere that is not walled", () => {
    for (const args of [["-H", "tcp://x:1", "build", "."], ["--context", "other", "run", "image"], ["--config", "/tmp/c", "build", "."], ["-D", "ps"]]) {
      const result = run(args, GATEWAY);
      expect(result.status, args.join(" ")).toBe(125);
      expect(result.seen).toBeUndefined();
    }
  });

  // BATCH b20 (#1105 against #1081): the worker image now carries the buildx plugin (the saved-environment builder's own pinned rootless builder), so the old guard "the image has no plugin" became "no path of a devcontainer or verifier build can reach buildx or
  // BuildKit". Each channel is a test below, and the walled-network guarantee (a build's RUN steps have only the gateway for a way out) rests on all of them: BuildKit cannot take a named network, so a build that reached it would not be walled.
  describe("no devcontainer build can reach buildx or BuildKit (the image has the plugin, so the wrapper must keep every build on the classic builder)", () => {
    const BUILD_VERBS: string[][] = [["build"], ["image", "build"], ["builder", "build"]];

    it("CHANNEL environment: DOCKER_BUILDKIT is 0 whatever the caller exported, and every BUILDX_* and BUILDKIT_* variable is gone, for a build and for every other command", () => {
      const hostile = { DOCKER_BUILDKIT: "1", BUILDX_BUILDER: "evil", BUILDX_NO_DEFAULT_ATTESTATIONS: "0", BUILDX_GIT_INFO: "1", BUILDKIT_PROGRESS: "plain", BUILDKIT_HOST: "tcp://10.0.0.1:1234", BUILDKIT_STEP_LOG_MAX_SIZE: "1" };
      for (const verb of [...BUILD_VERBS, ["run"], ["create"], ["pull"], ["exec"], ["inspect"], ["ps"]]) {
        const result = run([...verb, "-t", "x", "img"], { ...GATEWAY, ...hostile });
        expect(result.status, verb.join(" ")).toBe(0);
        expect(result.env!["DOCKER_BUILDKIT"], verb.join(" ")).toBe("0");
        expect(Object.keys(result.env!).filter((name) => name.startsWith("BUILDX_") || name.startsWith("BUILDKIT_")), verb.join(" ")).toEqual([]);
      }
      // Unset by the caller: still 0.
      expect(run(["build", "."], GATEWAY).env!["DOCKER_BUILDKIT"]).toBe("0");
    });

    it("CHANNEL flag: the buildx-only options are refused in every spelling, for every spelling of the build command, and nothing runs", () => {
      const flags = ["--builder", "--load", "--push", "--output", "-o", "--cache-to", "--attest", "--provenance", "--sbom", "--secret", "--ssh", "--allow", "--build-context", "--call", "--check", "--metadata-file", "--no-cache-filter", "--annotation"];
      for (const verb of BUILD_VERBS) {
        for (const flag of flags) {
          for (const spelled of [[flag], [`${flag}=x`], [flag, "x"]]) {
            const result = run([...verb, "-t", "x", ...spelled, "."], GATEWAY);
            expect(result.status, `${verb.join(" ")} ${spelled.join(" ")}`).toBe(125);
            expect(result.seen).toBeUndefined();
          }
        }
      }
      // An ordinary classic build option is not caught by the list.
      expect(run(["build", "--build-arg", "A=b", "--label", "x=y", "--target", "dev", "--no-cache", "--pull", "-f", "Dockerfile", "."], GATEWAY).status).toBe(0);
    });

    it("CHANNEL docker config: a config with an `aliases` entry (docker buildx install) refuses every build, wherever DOCKER_CONFIG or HOME points; a config without one does not", () => {
      const dir = mkdtempSync(join(tmpdir(), "dc-config-"));
      writeFileSync(join(dir, "config.json"), JSON.stringify({ aliases: { builder: "buildx" } }));
      for (const verb of BUILD_VERBS) {
        const viaConfig = run([...verb, "."], { ...GATEWAY, DOCKER_CONFIG: dir });
        expect(viaConfig.status, verb.join(" ")).toBe(125);
        expect(viaConfig.seen).toBeUndefined();
      }
      const home = mkdtempSync(join(tmpdir(), "dc-home-"));
      mkdirSync(join(home, ".docker"));
      writeFileSync(join(home, ".docker", "config.json"), '{ "aliases" : { "builder" : "buildx" } }');
      expect(run(["build", "."], { ...GATEWAY, HOME: home }).status).toBe(125);
      // Spellings docker's JSON decoder accepts for the same key: another case, a \u escape.
      for (const text of ['{ "Aliases": { "builder": "buildx" } }', '{ "ALIASES": {} }', '{ "\\u0061liases": { "builder": "buildx" } }']) {
        const odd = mkdtempSync(join(tmpdir(), "dc-config-odd-"));
        writeFileSync(join(odd, "config.json"), text);
        expect(run(["build", "."], { ...GATEWAY, DOCKER_CONFIG: odd }).status, text).toBe(125);
      }
      // Commands that do not build are not affected by the alias.
      expect(run(["run", "image"], { ...GATEWAY, DOCKER_CONFIG: dir }).status).toBe(0);
      const plain = mkdtempSync(join(tmpdir(), "dc-config-ok-"));
      writeFileSync(join(plain, "config.json"), JSON.stringify({ auths: { "example.com": {} }, credsStore: "ecr-login" }));
      expect(run(["build", "."], { ...GATEWAY, DOCKER_CONFIG: plain }).status).toBe(0);
    });

    it("CHANNEL subcommand: `docker buildx ...` is refused for every verb a newer devcontainer CLI could use, and nothing runs", () => {
      for (const args of [["buildx", "build", "."], ["buildx", "bake"], ["buildx", "version"], ["buildx", "create", "--use"], ["buildx", "use", "x"], ["buildx", "install"], ["buildx"]]) {
        const result = run(args, GATEWAY);
        expect(result.status, args.join(" ")).toBe(125);
        expect(result.seen).toBeUndefined();
      }
    });

    it("CHANNEL source: the only code that runs buildx is the saved-environment builder (rootless, pinned, --network none, never through this wrapper); no devcontainer, verifier, worker-runtime or broker source names it", () => {
      const root = new URL("../../packages", import.meta.url).pathname;
      const files: string[] = [];
      const walk = (dir: string): void => {
        for (const name of readdirSync(dir)) {
          if (name === "node_modules" || name === "dist") continue;
          const full = join(dir, name);
          if (statSync(full).isDirectory()) walk(full);
          else if (/\.(ts|tsx|js|mjs|cjs|sh)$/u.test(name) && !/\.d\.ts$/u.test(name)) files.push(full);
        }
      };
      walk(root);
      const naming = files.filter((file) => /["'`]buildx["'`]|docker-buildx|--builder\b|DOCKER_BUILDKIT\s*=\s*["']?1|docker buildx/u.test(readFileSync(file, "utf8"))).map((file) => relative(root, file)).sort();
      // (The ec2 boot scripts are scanned too, comments included: the wrapper names buildx to refuse it, and nothing else may.)
      expect(naming).toEqual(["worker/ec2/devcontainer-docker.sh", "worker/src/saved-env/build.ts"]);
      // And the wrapper itself never runs the real docker with a buildx verb: the one case that names it refuses.
      for (const line of wrapper.split("\n").filter((entry) => /REAL_DOCKER/u.test(entry))) expect(line, line).not.toMatch(/(?<![_\w])buildx(?![_\w])/u);
      expect(wrapper).toMatch(/\n {2}buildx\) echo [^\n]*exit 125 ;;/u);
    });

    it("the saved-environment builder is NOT routed through the wrapper (it sits outside the devcontainer path): the wrapper is only ever handed to the devcontainer CLI", () => {
      const savedEnv = readFileSync(new URL("../../packages/worker/src/saved-env/build.ts", import.meta.url), "utf8");
      expect(savedEnv).not.toContain("devcontainer-docker");
      expect(savedEnv).not.toContain("DEVCONTAINER_GATEWAY_DOCKER");
      const users = readdirSync(new URL("../../packages/worker/src", import.meta.url).pathname).filter((name) => name.endsWith(".ts")).filter((name) => readFileSync(join(new URL("../../packages/worker/src", import.meta.url).pathname, name), "utf8").includes("DEVCONTAINER_GATEWAY_DOCKER"));
      expect(users).toEqual(["devcontainer.ts"]);
    });
  });

  it("FAILS CLOSED: without the network or the name server in the environment, or with a value that is not a plain network name and an IPv4 address, no docker command runs at all", () => {
    for (const environment of [{}, { AGENTX_SANDBOX_NETWORK: "rovara-snet" }, { AGENTX_SANDBOX_DNS: "172.28.250.2" }, { AGENTX_SANDBOX_NETWORK: "rovara-snet", AGENTX_SANDBOX_DNS: "dns.example.com" },
      { AGENTX_SANDBOX_NETWORK: "--privileged", AGENTX_SANDBOX_DNS: "172.28.250.2" }, { AGENTX_SANDBOX_NETWORK: "a b", AGENTX_SANDBOX_DNS: "172.28.250.2" }, { AGENTX_SANDBOX_NETWORK: "rovara-snet", AGENTX_SANDBOX_DNS: "172.28.250.2 --dns 8.8.8.8" }]) {
      for (const args of [["run", "image"], ["create", "image"], ["build", "."], ["image", "build", "."], ["exec", "c"], ["ps"]]) {
        const result = run(args, environment);
        expect(result.status, JSON.stringify(environment) + args.join(" ")).toBe(125);
        expect(result.seen).toBeUndefined();
      }
    }
  });
});
