// What the task sandbox container is started with: no host access, no extra privileges, only the project's folder.
import { describe, expect, it } from "vitest";
import { assertLocalTaskExecutionAllowed, taskSandboxRunArgs } from "../../packages/worker/src/task-sandbox.js";

const IMAGE = "registry.example.test/agentx/worker@sha256:" + "a".repeat(64);
const args = taskSandboxRunArgs({ name: "agentx-task-x", taskId: "task-1", image: IMAGE, rootPath: "/mnt/workspace", maskedPaths: ["/mnt/workspace/.agentx"] });

describe("the task sandbox's docker run arguments", () => {
  it("drop every capability and refuse new privileges", () => {
    expect(args[args.indexOf("--cap-drop") + 1]).toBe("ALL");
    expect(args[args.indexOf("--security-opt") + 1]).toBe("no-new-privileges");
  });

  it("never mount the Docker socket, and never add a group", () => {
    expect(args.join(" ")).not.toMatch(/docker\.sock|\/var\/run/u);
    expect(args).not.toContain("--group-add");
    expect(args.filter((arg) => arg === "--volume")).toEqual(["--volume"]);
    expect(args[args.indexOf("--volume") + 1]).toBe("/mnt/workspace:/mnt/workspace");
    expect(args.join(" ")).not.toMatch(/--privileged|--network[ =]host|--pid(?!s-limit)|--cap-add|--volumes-from|--device/u);
  });

  it("run as an unprivileged user with the image's init as PID 1", () => {
    expect(args[args.indexOf("--user") + 1]).toBe("1000:1000");
    expect(args.slice(args.indexOf(IMAGE) - 2)).toEqual(["--entrypoint", "/usr/bin/tini", IMAGE, "--", "sleep", "infinity"]);
  });
});

describe("the local shell on an EC2 worker", () => {
  it("is refused whatever asks for it, and whichever marker says the worker is EC2", () => {
    for (const marker of [{ AGENTX_RUNTIME: "ec2" }, { AGENTX_WORKER_PROCESS_SCOPE: "container" }]) {
      expect(() => assertLocalTaskExecutionAllowed({ ...marker, AGENTX_TASK_SHELL: "local" })).toThrowError(expect.objectContaining({ code: "RUNTIME_UNAVAILABLE" }));
      expect(() => assertLocalTaskExecutionAllowed(marker, { explicit: true })).toThrowError(expect.objectContaining({ code: "RUNTIME_UNAVAILABLE" }));
    }
  });
});
