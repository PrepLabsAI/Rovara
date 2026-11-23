// Private packages P2a: the install container's `docker run` arguments are built by ONE function and checked by an exact allow-list assertion, value by value. An agent sandbox can never be given the token folder.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertSetupSandboxRunArgs } from "../../packages/worker/src/setup-agent.js";
import {
  INSTALL_LABEL, assertInstallContainerArgs, installContainerArgs, installContainerName, installEnvironment, installNetworkAddresses, installNetworkCreateArgs, installNetworkName, installNetworkSlot, installRepositoryKey,
  type InstallContainerInput,
} from "../../packages/worker/src/private-install-container.js";
import { taskSandboxRunArgs } from "../../packages/worker/src/task-sandbox.js";

const ROOT = "/mnt/workspace";
const base = (extra: Partial<InstallContainerInput> = {}): InstallContainerInput => ({
  operationId: "op-1", repository: "web", workspace: "0123456789abcdef", image: "registry.example/worker@sha256:" + "a".repeat(64), rootPath: ROOT, repositoryDirectory: `${ROOT}/repo/web`, manager: "npm",
  secretsDirectory: "/run/rovara-install/aaaaaaaaaaaaaaaa", hostCpus: 8, hostMemoryBytes: 16 * 1024 ** 3, ...extra,
});
const flag = (args: readonly string[], name: string): string[] => args.flatMap((value, index) => (value === name ? [args[index + 1]!] : []));
const refuses = (args: readonly string[], input = base()) => expect(() => assertInstallContainerArgs(args, input)).toThrow(/did not start|refused to start the package install container/u);

describe("installContainerArgs", () => {
  it("is exactly the plan's shape and passes its own assertion", () => {
    const input = base();
    const args = installContainerArgs(input);
    expect(() => assertInstallContainerArgs(args, input)).not.toThrow();
    expect(args[0]).toBe("run");
    expect(args).toContain("--rm");
    expect(args).toContain("--read-only");
    expect(flag(args, "--log-driver")).toEqual(["none"]);
    expect(flag(args, "--cap-drop")).toEqual(["ALL"]);
    expect(flag(args, "--security-opt")).toEqual(["no-new-privileges"]);
    expect(flag(args, "--user")).toEqual(["1000:1000"]);
    expect(flag(args, "--ulimit")).toEqual(["core=0"]);
    expect(flag(args, "--pids-limit")).toEqual(["512"]);
    expect(flag(args, "--network")).toEqual([installNetworkName("op-1")]);
    expect(flag(args, "--volume")).toEqual([`${ROOT}/repo/web:${ROOT}/repo/web:rw`, `${ROOT}/.agentx-pkgcache/npm:${ROOT}/.agentx-pkgcache/npm:rw`, "/run/rovara-install/aaaaaaaaaaaaaaaa:/run/rovara-install:ro"]);
    expect(flag(args, "--tmpfs")).toHaveLength(2);
    expect(args.slice(args.indexOf("--") + 1, args.indexOf("--") + 3)).toEqual(["/usr/local/bin/npm", "ci"]);
    expect(flag(args, "--entrypoint")).toEqual(["/usr/bin/tini"]);
  });

  it("the token folder is mounted read-only into this container and no other, and no secret is in any argument", () => {
    const token = `ghp_${randomBytes(24).toString("base64url")}`;
    for (const input of [base(), base({ manager: "yarn1" }), base({ derivedNpmrc: true })]) {
      const args = installContainerArgs(input);
      expect(args.join("\n")).not.toContain(token);
      expect(flag(args, "--volume").filter((value) => value.includes("/run/rovara-install")).every((value) => value.endsWith(":ro"))).toBe(true);
      expect(args.some((value) => value.includes("docker.sock"))).toBe(false);
      expect(args).not.toContain("--env-file");
      expect(args).not.toContain("--privileged");
      expect(flag(args, "--network")).not.toContain("host");
    }
  });

  it("mounts the derived .npmrc over the repository's, read-only, only when asked (a file mount would create an empty one)", () => {
    const withCopy = installContainerArgs(base({ derivedNpmrc: true }));
    expect(flag(withCopy, "--volume")).toContain(`/run/rovara-install/aaaaaaaaaaaaaaaa/${installRepositoryKey("op-1", "web")}.npmrc:${ROOT}/repo/web/.npmrc:ro`);
    expect(flag(installContainerArgs(base()), "--volume").some((value) => value.endsWith("/.npmrc:ro"))).toBe(false);
  });

  it("the environment is a fixed list of non-secret names; NODE_ENV is emptied so the dev dependencies are installed", () => {
    for (const manager of ["npm", "yarn1"] as const) {
      const environment = installEnvironment(ROOT, manager);
      expect(environment).toContain("NODE_ENV=");
      expect(environment).toContain("NODE_OPTIONS=");
      expect(environment).toContain("YARN_IGNORE_PATH=1");
      expect(environment).toContain("npm_config_logs_max=0");
      expect(environment).toContain("npm_config_userconfig=/run/rovara-install/npmrc");
      expect(environment.some((entry) => /token|secret|password|auth/iu.test(entry.split("=")[0]!))).toBe(false);
    }
    expect(installEnvironment(ROOT, "yarn1")).toContain(`YARN_CACHE_FOLDER=${ROOT}/.agentx-pkgcache/yarn1`);
    expect(installEnvironment(ROOT, "npm")).toContain(`npm_config_cache=${ROOT}/.agentx-pkgcache/npm`);
  });

  it("names are derived by hashing: no id or repository string reaches a docker option", () => {
    expect(installContainerName("op-1", "web")).toMatch(/^rovara-install-[0-9a-f]{12}$/u);
    expect(installContainerName("op-1", "web")).not.toBe(installContainerName("op-1", "api"));
    expect(installNetworkName("op-1")).toMatch(/^rovara-install-[0-9a-f]{12}$/u);
    const weird = installContainerArgs(base({ repository: "web; rm -rf /" }));
    expect(weird.join(" ")).not.toContain("rm -rf");
  });
});

describe("assertInstallContainerArgs refuses anything that is not the install container", () => {
  const input = base();
  const good = installContainerArgs(input);
  const without = (name: string, arity: number): string[] => { const at = good.indexOf(name); return [...good.slice(0, at), ...good.slice(at + 1 + arity)]; };
  const replaced = (name: string, value: string): string[] => good.map((entry, index) => (good[index - 1] === name ? value : entry));
  const withExtra = (...extra: string[]): string[] => [...good.slice(0, 1), ...extra, ...good.slice(1)];

  it.each([
    ["the host network", replaced("--network", "host")],
    ["a network that is not this operation's", replaced("--network", "agentx-task")],
    ["a missing --log-driver none", without("--log-driver", 1)],
    ["another log driver", replaced("--log-driver", "awslogs")],
    ["a writable root", without("--read-only", 0)],
    ["a capability", withExtra("--cap-add", "NET_ADMIN")],
    ["a kept capability list", replaced("--cap-drop", "NET_RAW")],
    ["--privileged", withExtra("--privileged")],
    ["an env file", withExtra("--env-file", "/etc/agentx/worker.env")],
    ["an extra env", withExtra("--env", "SECRET=1")],
    ["an extra mount", withExtra("--volume", "/:/host:rw")],
    ["the docker socket", withExtra("--volume", "/var/run/docker.sock:/var/run/docker.sock")],
    ["a token folder that is writable", good.map((entry) => (entry.endsWith("/run/rovara-install:ro") ? entry.replace(/:ro$/u, ":rw") : entry))],
    ["root", replaced("--user", "0:0")],
    ["a missing core limit", without("--ulimit", 1)],
    ["a missing init", replaced("--entrypoint", "/bin/sh")],
    ["a weakened security option", replaced("--security-opt", "seccomp=unconfined")],
    ["a pid namespace of the host", withExtra("--pid", "host")],
    ["a device", withExtra("--device", "/dev/fuse")],
    ["a different command", [...good.slice(0, good.indexOf("--") + 1), "/bin/sh", "-c", "env"]],
    ["a changed flag of the command", [...good.slice(0, -1), "--ignore-scripts=false"]],
    ["an extra command argument", [...good, "--scripts-prepend-node-path"]],
    ["a changed image", good.map((entry) => (entry === input.image ? "evil.example/image:latest" : entry))],
    ["not a docker run", ["exec", ...good.slice(1)]],
  ])("%s", (_label, args) => {
    refuses(args, input);
  });

  it("a different repository, operation or directory than the one asked for is refused", () => {
    refuses(good, base({ repository: "api" }));
    refuses(good, base({ operationId: "op-2" }));
    refuses(good, base({ repositoryDirectory: `${ROOT}/repo/other` }));
    refuses(good, base({ derivedNpmrc: true }));
  });

  it("memory and cpu limits are checked by shape", () => {
    refuses(withExtra("--memory", "100000000000000000"), input);
    refuses(replaced("--cpus", "all"), input);
  });
});

describe("an agent sandbox can never be given the token folder", () => {
  it("the setup sandbox's argument check refuses a /run/rovara-install mount in any form", () => {
    const options = { rootPath: ROOT };
    const sandbox = ["run", "--detach", "--name", "agentx-task-x", "--label", "agentx.task=x", "--network", "agentx-task", "--user", "1000:1000", "--pids-limit", "4096", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--volume", `${ROOT}:${ROOT}`, "--workdir", ROOT, "--entrypoint", "/usr/bin/tini", "image", "--", "sleep", "infinity"];
    expect(() => assertSetupSandboxRunArgs(sandbox, options)).not.toThrow();
    const insert = (...extra: string[]) => [...sandbox.slice(0, 1), ...extra, ...sandbox.slice(1)];
    for (const extra of [["--volume", "/run/rovara-install:/run/rovara-install:ro"], ["--volume", "/run:/run"], ["--mount", "type=bind,src=/run/rovara-install,dst=/x,readonly"], ["--tmpfs", "/run/rovara-install"]]) {
      expect(() => assertSetupSandboxRunArgs(insert(...extra), options)).toThrow();
    }
  });

  it("the task sandbox mounts the workspace and nothing else", () => {
    const args = taskSandboxRunArgs({ name: "n", taskId: "t", image: "i", rootPath: ROOT, maskedPaths: [`${ROOT}/.agentx`] });
    expect(flag(args, "--volume")).toEqual([`${ROOT}:${ROOT}`]);
    expect(args.join(" ")).not.toContain("rovara-install");
  });
});

describe("the install bridge", () => {
  it("is named rvbp<slot> so the boot firewall's rvb* walls apply, on its own /24 outside the setup runs' range, with no traffic between containers", () => {
    const addresses = installNetworkAddresses(installNetworkSlot("op-1"));
    expect(addresses.bridge).toMatch(/^rvbp[0-9]{1,3}$/u);
    expect(addresses.subnet).toMatch(/^172\.30\.[0-9]{1,3}\.0\/24$/u);
    const args = installNetworkCreateArgs("op-1", "0123456789abcdef", addresses);
    expect(args.slice(0, 3)).toEqual(["network", "create", "--driver"]);
    expect(args).toContain(`com.docker.network.bridge.name=${addresses.bridge}`);
    expect(args).toContain("com.docker.network.bridge.enable_icc=false");
    expect(args).not.toContain("--ipv6");
    expect(args.some((value) => value.startsWith(`${INSTALL_LABEL}=`))).toBe(true);
    expect(args.at(-1)).toBe(installNetworkName("op-1"));
  });

  it("a collision tries the next slot, and the slots stay in range", () => {
    const first = installNetworkSlot("op-1");
    expect(installNetworkSlot("op-1", 1)).toBe(first === 253 ? 1 : first + 1);
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const slot = installNetworkSlot("op-9", attempt);
      expect(slot).toBeGreaterThanOrEqual(1);
      expect(slot).toBeLessThanOrEqual(253);
    }
    expect(() => installNetworkAddresses(0)).toThrow();
    expect(() => installNetworkAddresses(254)).toThrow();
  });
});
