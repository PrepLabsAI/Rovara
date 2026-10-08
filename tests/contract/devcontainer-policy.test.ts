import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DOCKER_DATA_VISIBLE,
  containerProblems,
  devcontainerConfigRefusal,
  hostPathResolver,
  parseJsonc,
  type ContainerInspection,
} from "../../packages/worker/src/devcontainer-policy.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const context = { rootPath: "/mnt/workspace", workspaceFolder: "/mnt/workspace/repo/sample" };
const refusal = (config: Record<string, unknown>) => devcontainerConfigRefusal({ image: "node:22", ...config }, context);

describe("dev container settings AgentX refuses (docker containment)", () => {
  it.each([
    ["--privileged", ["--privileged"]],
    ["--privileged", ["--privileged=true"]],
    ["--pid", ["--pid=host"]],
    ["--pid", ["--pid", "container:other"]],
    ["--ipc=host", ["--ipc=host"]],
    ["--ipc=container:", ["--ipc", "container:other"]],
    ["--network=host", ["--network=host"]],
    ["--network=host", ["--net", "host"]],
    ["--network=container:", ["--network=container:other"]],
    ["--userns=host", ["--userns=host"]],
    ["--uts=host", ["--uts", "host"]],
    ["--cap-add", ["--cap-add", "SYS_ADMIN"]],
    ["--cap-add", ["--cap-add=NET_ADMIN"]],
    ["--cap-add", ["--cap-add", "SYS_PTRACE", "--cap-add", "SYS_ADMIN"]],
    ["--gpus", ["--gpus", "all"]],
    ["--security-opt", ["--security-opt", "seccomp=unconfined"]],
    ["--device", ["--device=/dev/kmsg"]],
    ["--volumes-from", ["--volumes-from", "other"]],
    ["a bind mount of /", ["-v", "/:/host"]],
    ["a bind mount of /", ["--volume=/:/host:ro"]],
    ["a bind mount of /var/run/docker.sock", ["-v", "/var/run/docker.sock:/var/run/docker.sock"]],
    ["a bind mount of /var/run/docker.sock", ["-itv/var/run/docker.sock:/s"]],
    ["a bind mount of /etc", ["--mount", "type=bind,source=/etc,target=/host-etc"]],
    ["a bind mount of /mnt/workspace/.docker", ["--mount=type=bind,src=/mnt/workspace/.docker,dst=/d"]],
    ["a bind mount of /mnt/workspace", ["-v", "/mnt/workspace:/w"]],
    ["a bind mount of ${localEnv:HOME}", ["-v", "${localEnv:HOME}:/home"]],
    ["a volume with driver options", ["--mount", "type=volume,source=x,target=/x,volume-opt=type=none,volume-opt=o=bind,volume-opt=device=/"]],
  ])("refuses runArgs with %s", (expected, runArgs) => {
    expect(refusal({ runArgs })).toBe(`runArgs ${expected}`);
  });

  it.each([
    ["privileged", { privileged: true }],
    ["capAdd", { capAdd: ["SYS_ADMIN"] }],
    ["capAdd", { capAdd: ["SYS_PTRACE", "NET_ADMIN"] }],
    ["build.options --network=host", { build: { dockerfile: "Dockerfile", options: ["--network=host"] } }],
    ["build.options --network=host", { build: { dockerfile: "Dockerfile", options: ["--network", "host"] } }],
    ["build.options --output", { build: { dockerfile: "Dockerfile", options: ["-o", "type=local,dest=/tmp/out"] } }],
    ["build.options --output", { build: { dockerfile: "Dockerfile", options: ["--output=type=tar,dest=out.tar"] } }],
    ["build.options --iidfile", { build: { dockerfile: "Dockerfile", options: ["--iidfile", "/tmp/id"] } }],
    ["build.options --allow", { build: { dockerfile: "Dockerfile", options: ["--allow", "network.host"] } }],
    ["build.options --secret", { build: { dockerfile: "Dockerfile", options: ["--secret", "id=x,src=/etc/hostname"] } }],
    ["build.options --build-context", { build: { dockerfile: "Dockerfile", options: ["--build-context", "x=/"] } }],
    ["build.options that are not a list of strings", { build: { dockerfile: "Dockerfile", options: "--network=host" } }],
    ["build.context outside the workspace (/)", { build: { dockerfile: "Dockerfile", context: "/" } }],
    ["build.context outside the workspace (/mnt)", { build: { dockerfile: "Dockerfile", context: "../../../.." } }],
    ["build.dockerfile outside the workspace (/etc/Dockerfile)", { build: { dockerfile: "/etc/Dockerfile" } }],
    ["build.dockerfile outside the workspace (${localEnv:HOME}/Dockerfile)", { build: { dockerfile: "${localEnv:HOME}/Dockerfile" } }],
    ["securityOpt", { securityOpt: ["apparmor=unconfined"] }],
    ["initializeCommand (it runs on the worker host)", { initializeCommand: "id" }],
    ["dockerComposeFile (Docker Compose dev containers)", { dockerComposeFile: "compose.yml", service: "app" }],
    ["mounts with a bind mount of /", { mounts: ["source=/,target=/host,type=bind"] }],
    ["mounts with a bind mount of /var/run/docker.sock", { mounts: [{ source: "/var/run/docker.sock", target: "/var/run/docker.sock", type: "bind" }] }],
    ["mounts with a bind mount of /etc", { mounts: ["source=${localWorkspaceFolder}/../../../../etc,target=/e,type=bind"] }],
    ["workspaceMount with a bind mount of /", { workspaceMount: "source=/,target=/workspaces/x,type=bind", workspaceFolder: "/workspaces/x" }],
  ])("refuses %s", (expected, config) => {
    expect(refusal(config)).toBe(expected);
  });

  it("allows an ordinary dev container: an image or a Dockerfile, features, harmless runArgs, and mounts inside the workspace or named volumes", () => {
    expect(refusal({})).toBeUndefined();
    expect(devcontainerConfigRefusal({
      build: { dockerfile: "Dockerfile", context: "..", options: ["--add-host", "db:10.0.0.2", "--build-arg", "A=1", "--pull"] },
      features: { "ghcr.io/devcontainers/features/node:1": {} },
      runArgs: ["--env", "CI=1", "-e", "A=b", "--cpus=2", "--memory", "4g", "--init", "--privileged=false", "--network=bridge", "--cap-add=SYS_PTRACE", "--cap-add", "sys_ptrace", "-v", "cache:/cache", "-v", "${localWorkspaceFolder}/.cache:/c"],
      mounts: ["source=node_modules,target=/w/node_modules,type=volume", { source: "${localWorkspaceFolder}/data", target: "/data", type: "bind" }, { type: "tmpfs", target: "/tmp/x" }],
      privileged: false,
      capAdd: ["SYS_PTRACE"],
      postCreateCommand: "npm ci",
      remoteUser: "node",
    }, context)).toBeUndefined();
  });

  it("follows every link in a bind mount source, including one whose target does not exist, and judges where it leads", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "agentx-policy-links-")));
    directories.push(root);
    const repo = join(root, "repo/sample");
    await mkdir(repo, { recursive: true });
    await symlink(`/agentx-missing-${randomUUID()}/data`, join(repo, "dangling"));
    await symlink(join(root, "repo/sample/not-yet"), join(repo, "inside"));
    await symlink("dangling", join(repo, "chained"));
    await mkdir(join(repo, "real"));
    const linked = { rootPath: root, workspaceFolder: repo, resolvePath: hostPathResolver(root) };
    const mountOf = (name: string) => devcontainerConfigRefusal({ image: "x", mounts: [`source=\${localWorkspaceFolder}/${name},target=/m,type=bind`] }, linked);
    expect(mountOf("dangling")).toBe(`mounts with a bind mount of ${join(repo, "dangling")}`);
    expect(mountOf("dangling/below")).toBe(`mounts with a bind mount of ${join(repo, "dangling/below")}`);
    expect(mountOf("chained")).toBe(`mounts with a bind mount of ${join(repo, "chained")}`);
    expect(mountOf("inside")).toBeUndefined();
    expect(mountOf("real/missing/deeper")).toBeUndefined();
    const resolvePath = hostPathResolver(root);
    expect(resolvePath(join(repo, "inside"))).toBe(join(repo, "not-yet"));
    expect(resolvePath(join(repo, "chained/x"))).toMatch(/^\/agentx-missing-[0-9a-f-]+\/data\/x$/u);
  });

  it("refuses a mount whose path cannot be checked", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "agentx-policy-unreadable-")));
    directories.push(root);
    const repo = join(root, "repo/sample");
    await mkdir(join(repo, "closed"), { recursive: true });
    await symlink("/", join(repo, "closed/link"));
    await chmod(join(repo, "closed"), 0o000);
    try {
      const resolvePath = hostPathResolver(root);
      expect(resolvePath(join(repo, "closed/link"))).toBe("/");
      expect(devcontainerConfigRefusal({ image: "x", mounts: ["source=${localWorkspaceFolder}/closed/link,target=/m,type=bind"] }, { rootPath: root, workspaceFolder: repo, resolvePath }))
        .toBe(`mounts with a bind mount of ${join(repo, "closed/link")}`);
    } finally {
      await chmod(join(repo, "closed"), 0o755);
    }
  });

  it("reads devcontainer.json with comments and trailing commas", () => {
    expect(parseJsonc('{\n  // a comment\n  "image": "node:22", /* another */\n  "x": "// not a comment",\n  "y": ["a", "b",],\n}\n'))
      .toEqual({ image: "node:22", x: "// not a comment", y: ["a", "b"] });
    expect(() => parseJsonc("{ nope }")).toThrow();
  });
});

describe("the started dev container, checked as Docker ran it (docker containment)", () => {
  const ordinary: ContainerInspection = {
    HostConfig: { Privileged: false, CapAdd: null, SecurityOpt: null, PidMode: "", IpcMode: "private", NetworkMode: "bridge", UsernsMode: "", UTSMode: "", Devices: [], VolumesFrom: null },
    Mounts: [
      { Type: "bind", Source: "/mnt/workspace", Destination: "/mnt/workspace" },
      { Type: "volume", Source: "/mnt/workspace/.docker/volumes/agentx-docker-data-mask/_data", Destination: "/mnt/workspace/.docker" },
      { Type: "bind", Source: "/mnt/workspace/repo/sample", Destination: "/workspaces/sample" },
    ],
  };
  const checks = { rootPath: "/mnt/workspace", dockerDataPath: "/mnt/workspace/.docker" };

  it("accepts an ordinary one, including one allowed to trace its own processes (SYS_PTRACE)", () => {
    expect(containerProblems(ordinary, checks)).toEqual([]);
    expect(containerProblems({ ...ordinary, HostConfig: { ...ordinary.HostConfig, CapAdd: ["CAP_SYS_PTRACE"], CgroupnsMode: "private", DeviceRequests: null } }, checks)).toEqual([]);
  });

  it("finds what a feature or the image's own metadata granted, and the Docker data folder left visible", () => {
    const granted: ContainerInspection = {
      HostConfig: { ...ordinary.HostConfig, Privileged: true, CapAdd: ["SYS_PTRACE", "NET_ADMIN"], PidMode: "host", NetworkMode: "host", CgroupnsMode: "host", Devices: [{ PathOnHost: "/dev/fuse" }], DeviceRequests: [{ Count: -1 }] },
      Mounts: [
        { Type: "bind", Source: "/mnt/workspace", Destination: "/mnt/workspace" },
        { Type: "bind", Source: "/var/run/docker.sock", Destination: "/var/run/docker-host.sock" },
      ],
    };
    expect(containerProblems(granted, checks)).toEqual([
      "privileged", "--cap-add", "--pid", "--network=host", "--cgroupns=host", "--device", "--gpus", "a bind mount of /var/run/docker.sock", DOCKER_DATA_VISIBLE,
    ]);
    // A workspace without a Docker data folder (a developer machine) has nothing to hide.
    expect(containerProblems({ ...ordinary, Mounts: [ordinary.Mounts![0]!] }, { rootPath: "/mnt/workspace" })).toEqual([]);
  });
});
