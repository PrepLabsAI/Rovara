// Lane L4-NETG (DEC 254zzz77): the docker program a gateway-mode worker hands the devcontainer CLI (packages/worker/ec2/devcontainer-docker.sh). It is run here against a fake docker that records its arguments.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const wrapper = readFileSync(new URL("../../packages/worker/ec2/devcontainer-docker.sh", import.meta.url), "utf8");

function run(args: string[], environment: Record<string, string>): { status: number | null; stderr: string; seen: string[] | undefined } {
  const dir = mkdtempSync(join(tmpdir(), "dc-docker-"));
  const fakeDocker = join(dir, "docker");
  const record = join(dir, "args.json");
  writeFileSync(fakeDocker, `#!/bin/bash\nnode -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))' "${record}" "$@"\n`);
  chmodSync(fakeDocker, 0o755);
  const script = join(dir, "wrapper.sh");
  writeFileSync(script, wrapper.split("/usr/local/bin/docker").join(fakeDocker));
  chmodSync(script, 0o755);
  const ran = spawnSync("bash", [script, ...args], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...environment } });
  return { status: ran.status, stderr: ran.stderr, seen: existsSync(record) ? (JSON.parse(readFileSync(record, "utf8")) as string[]) : undefined };
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

  it("the worker image has no buildx plugin (the devcontainer CLI must find none and use the classic builder, the only one that takes the walled network)", () => {
    expect(readFileSync(new URL("../../environments/base/Dockerfile", import.meta.url), "utf8")).not.toMatch(/buildx/iu);
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
