import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DOCKER_DATA_VISIBLE,
  WORKER_STATE_VISIBLE,
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
    ["a bind mount of /var/run/docker.sock", ["-qv", "/var/run/docker.sock:/var/run/docker.sock"]],
    ["a bind mount of /", ["-qv", "/:/host"]],
    ["a bind mount of /", ["-dqv/:/host"]],
    ["a bind mount of /etc", ["--mount", "type=bind,source=/etc,target=/host-etc"]],
    ["a bind mount of /mnt/workspace/.docker", ["--mount=type=bind,src=/mnt/workspace/.docker,dst=/d"]],
    ["a bind mount of /mnt/workspace/.agentx", ["--mount=type=bind,src=/mnt/workspace/.agentx,dst=/d"]],
    ["a bind mount of /mnt/workspace/agent-sessions", ["-v", "/mnt/workspace/agent-sessions:/d"]],
    ["a bind mount of /mnt/workspace/.agentx-runtime/state", ["--mount=type=bind,src=/mnt/workspace/.agentx-runtime/state,dst=/d"]],
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
    ["build.context outside the repository folder (/)", { build: { dockerfile: "Dockerfile", context: "/" } }],
    ["build.context outside the repository folder (/mnt)", { build: { dockerfile: "Dockerfile", context: "../../../.." } }],
    ["build.context outside the repository folder (/mnt/workspace)", { build: { dockerfile: "Dockerfile", context: "../../.." } }],
    ["build.context outside the repository folder (/mnt/workspace/repo)", { build: { dockerfile: "Dockerfile", context: "../.." } }],
    ["build.context outside the repository folder (/mnt/workspace/.agentx)", { build: { dockerfile: "Dockerfile", context: "../../../.agentx" } }],
    ["build.context outside the repository folder (/mnt/workspace/repo/other)", { context: "../../other" }],
    ["build.dockerfile outside the repository folder (/etc/Dockerfile)", { build: { dockerfile: "/etc/Dockerfile" } }],
    ["build.dockerfile outside the repository folder (${localEnv:HOME}/Dockerfile)", { build: { dockerfile: "${localEnv:HOME}/Dockerfile" } }],
    // The build shares the Dockerfile's whole folder, so it must be inside the repository too: not the workspace root, not a sibling.
    ["build.dockerfile outside the repository folder (/mnt/workspace/Dockerfile)", { build: { dockerfile: "../../../Dockerfile" } }],
    ["build.dockerfile outside the repository folder (/mnt/workspace/repo/Dockerfile)", { dockerFile: "../../Dockerfile" }],
    ["build.dockerfile outside the repository folder (/mnt/workspace/repo/other/Dockerfile)", { build: { dockerfile: "../../other/Dockerfile" } }],
    ["build.dockerfile outside the repository folder (/mnt/workspace/.agentx/Dockerfile)", { build: { dockerfile: "../../../.agentx/Dockerfile" } }],
    // The CLI prefers the top-level spelling when both are present, so every spelling is checked.
    ["build.dockerfile outside the repository folder (/mnt/workspace/Dockerfile)", { dockerFile: "../../../Dockerfile", build: { dockerfile: "Dockerfile" } }],
    ["build.dockerfile outside the repository folder (/mnt/workspace/Dockerfile)", { dockerFile: "Dockerfile", build: { dockerfile: "../../../Dockerfile" } }],
    ["build.context outside the repository folder (/mnt/workspace)", { dockerFile: "Dockerfile", context: "../../..", build: { context: ".." } }],
    ["build.context outside the repository folder (/mnt/workspace)", { dockerFile: "Dockerfile", context: "..", build: { dockerfile: "Dockerfile", context: "../../.." } }],
    ["build.options --cache-from that is not an image or type=registry,ref=<image>", { build: { dockerfile: "Dockerfile", options: ["--cache-from", "type=local,src=/tmp/cache"] } }],
    ["build.options --cache-from that is not an image or type=registry,ref=<image>", { build: { dockerfile: "Dockerfile", options: ["--cache-from=type=local,src=cache"] } }],
    ["build.cacheFrom that is not an image or type=registry,ref=<image>", { build: { dockerfile: "Dockerfile", cacheFrom: "type=local,src=/tmp/cache" } }],
    ["build.cacheFrom that is not an image or type=registry,ref=<image>", { build: { dockerfile: "Dockerfile", cacheFrom: ["example.test/app:cache", "type=local,src=/tmp/cache"] } }],
    ["build.options --cache-from that is not an image or type=registry,ref=<image>", { build: { dockerfile: "Dockerfile", options: ['--cache-from', '"type=local",src=/tmp/cache'] } }],
    ["build.options --cache-from that is not an image or type=registry,ref=<image>", { build: { dockerfile: "Dockerfile", options: ["--cache-from", "type=registry,ref=example.test/app:cache,ref=/x"] } }],
    ["build.options --cache-from that is not an image or type=registry,ref=<image>", { build: { dockerfile: "Dockerfile", options: ["--cache-from", "type=gha"] } }],
    ["build.cacheFrom that is not an image or type=registry,ref=<image>", { build: { dockerfile: "Dockerfile", cacheFrom: '"type=local",src=/tmp/cache' } }],
    ["build.args BUILDKIT_SYNTAX", { build: { dockerfile: "Dockerfile", args: { BUILDKIT_SYNTAX: "example.test/frontend:1" } } }],
    ["build.args BUILDKIT_SYNTAX", { build: { dockerfile: "Dockerfile", args: { buildkit_syntax: "example.test/frontend:1" } } }],
    ["build.options --build-arg BUILDKIT_SYNTAX", { build: { dockerfile: "Dockerfile", options: ["--build-arg", "BUILDKIT_SYNTAX=example.test/frontend:1"] } }],
    ["build.options --build-arg BUILDKIT_SYNTAX", { build: { dockerfile: "Dockerfile", options: ["--build-arg=BUILDKIT_SYNTAX=example.test/frontend:1"] } }],
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

  const OWN = "/mnt/workspace/repo/sample/x";
  const MOUNT_FORMS: Array<[string, string, unknown]> = [
    // Each reads differently in Docker's parser than in a simple split, so the strict form refuses it.
    ["a mount with a setting given twice (source)", `type=bind,source=${OWN},src=/etc,target=/t`, undefined],
    ["a mount with a setting given twice (source)", `type=bind,src=${OWN},source=/etc,target=/t`, undefined],
    ["a mount with a setting given twice (target)", `type=bind,source=${OWN},target=/t,dst=/u`, undefined],
    ["a mount with a setting given twice (type)", `type=volume,type=bind,source=/etc,target=/t`, undefined],
    ["a mount with a quote", '"type=bind","source=/etc","target=/t"', undefined],
    ["a mount with a quote", `type=bind,source="${OWN}",target=/t`, undefined],
    ["a mount with the setting bind-propagation", `type=bind,source=${OWN},target=/t,bind-propagation=shared`, undefined],
  ];
  it.each(MOUNT_FORMS)("refuses a mount string with %s (%s) in mounts, workspaceMount and runArgs", (expected, text) => {
    expect(refusal({ mounts: [text] })).toBe(`mounts with ${expected}`);
    expect(refusal({ workspaceMount: text })).toBe(`workspaceMount with ${expected}`);
    expect(refusal({ runArgs: ["--mount", text] })).toBe(`runArgs ${expected}`);
    expect(refusal({ runArgs: [`--mount=${text}`] })).toBe(`runArgs ${expected}`);
  });

  it("refuses an object mount with a comma or a quote in a field, or a setting it does not know", () => {
    const bind = { type: "bind", source: OWN, target: "/t" };
    expect(refusal({ mounts: [{ ...bind, target: "/t,src=/etc" }] })).toBe("mounts with a mount with a comma or a quote in a field");
    expect(refusal({ mounts: [{ ...bind, source: `${OWN}",x` }] })).toBe("mounts with a mount with a comma or a quote in a field");
    expect(refusal({ mounts: [{ ...bind, type: 'bind"' }] })).toBe("mounts with a mount with a comma or a quote in a field");
    expect(refusal({ mounts: [{ ...bind, src: "/etc" }] })).toBe("mounts with a mount with the setting src");
    expect(refusal({ mounts: [bind] })).toBeUndefined();
  });

  it("allows a bind mount only inside the repository folder, or a named volume", () => {
    expect(refusal({ mounts: [`type=bind,source=${OWN},target=/t`, "type=volume,source=cache,target=/c", "type=tmpfs,target=/tmp/x", "type=bind,source=${localWorkspaceFolder},target=/w,readonly"] })).toBeUndefined();
    expect(refusal({ mounts: ["type=bind,source=/mnt/workspace/repo/other,target=/o"] })).toBe("mounts with a bind mount of /mnt/workspace/repo/other");
    expect(refusal({ runArgs: ["-v", "/mnt/workspace/repo/other:/o"] })).toBe("runArgs a bind mount of /mnt/workspace/repo/other");
  });

  it.each([
    ["containerEnv", { containerEnv: { SECRET: "${localEnv:SECRET}" } }],
    ["remoteEnv", { remoteEnv: { PATH: "${localEnv:PATH}:/x" } }],
    ["a key", { containerEnv: { "${localEnv:KEY}": "x" } }],
    ["a list", { postCreateCommand: ["echo", "${localEnv:TOKEN}"] }],
    ["the env spelling", { containerEnv: { A: "${env:HOME}" } }],
    ["a nested value", { customizations: { tool: { deep: [{ value: "x-${localEnv:A}-y" }] } } }],
  ])("refuses ${localEnv} in %s, which would copy the worker's environment into the container", (_where, config) => {
    expect(refusal(config)).toBe("a ${localEnv} reference (it would copy the worker's environment into the container)");
  });

  it("allows an ordinary dev container: an image or a Dockerfile, features, harmless runArgs, and mounts inside the workspace or named volumes", () => {
    expect(refusal({})).toBeUndefined();
    // A build context is the repository folder or below it.
    for (const folder of ["..", ".", "../src", "${localWorkspaceFolder}/docker"]) expect(refusal({ build: { dockerfile: "Dockerfile", context: folder } }), folder).toBeUndefined();
    // A Dockerfile is in the repository folder or below it, and ordinary build arguments are fine.
    for (const file of ["Dockerfile", "../Dockerfile", "../docker/Dockerfile", "${localWorkspaceFolder}/Dockerfile"]) expect(refusal({ build: { dockerfile: file } }), file).toBeUndefined();
    expect(refusal({ build: { dockerfile: "Dockerfile", args: { VARIANT: "22" }, options: ["--build-arg", "A=1"] } })).toBeUndefined();
    // Both spellings, each inside the repository folder, and a cache taken from an image.
    expect(refusal({ dockerFile: "Dockerfile", context: "..", build: { dockerfile: "../Dockerfile", context: ".", cacheFrom: ["example.test/app:cache", "type=registry,ref=example.test/app:cache"], options: ["--cache-from", "example.test/app:cache"] } })).toBeUndefined();
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
    // The worker's own folders of the workspace must be hidden too, or task code could write what the worker trusts.
    const hidden = { rootPath: "/mnt/workspace", dockerDataPath: "/mnt/workspace/.docker", maskedPaths: ["/mnt/workspace/.agentx", "/mnt/workspace/agent-sessions"] };
    expect(containerProblems(ordinary, hidden)).toEqual([WORKER_STATE_VISIBLE]);
    const maskedState: ContainerInspection = { ...ordinary, Mounts: [...ordinary.Mounts!, ...["/mnt/workspace/.agentx", "/mnt/workspace/agent-sessions"].map((Destination) => ({ Type: "tmpfs", Destination }))] };
    expect(containerProblems(maskedState, hidden)).toEqual([]);
    // A workspace without a Docker data folder (a developer machine) has nothing to hide.
    expect(containerProblems({ ...ordinary, Mounts: [ordinary.Mounts![0]!] }, { rootPath: "/mnt/workspace" })).toEqual([]);
  });
});
