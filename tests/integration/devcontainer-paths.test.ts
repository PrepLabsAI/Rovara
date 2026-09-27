import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { devcontainerContextFile, devcontainerPaths, hostPath } from "../../packages/worker/src/devcontainer.js";
import { devcontainerFileTools } from "../../packages/worker/src/pi-session.js";

const target = { rootPath: "/mnt/workspace", workspaceFolder: "/mnt/workspace/repo/sample", configPath: "/mnt/workspace/repo/sample/.devcontainer/devcontainer.json" };
const started = (remoteWorkspaceFolder: string) => ({ containerId: "c", remoteUser: "node", remoteWorkspaceFolder });

describe("devcontainer paths", () => {
  it("pairs the repository's container folder with its host folder, unless they are the same or unknown", () => {
    expect(devcontainerPaths(target, started("/workspaces/sample"))).toEqual({ hostFolder: "/mnt/workspace/repo/sample", containerFolder: "/workspaces/sample" });
    expect(devcontainerPaths(target, started("/workspaces/sample/"))).toEqual({ hostFolder: "/mnt/workspace/repo/sample", containerFolder: "/workspaces/sample" });
    expect(devcontainerPaths(target, started("/mnt/workspace/repo/sample"))).toBeUndefined();
    expect(devcontainerPaths(target, started(""))).toBeUndefined();
    expect(devcontainerPaths(target, started("workspaces/sample"))).toBeUndefined();
  });

  it("resolves a path under the container folder to the host folder, and leaves every other path as given", () => {
    const paths = { hostFolder: "/mnt/workspace/repo/sample", containerFolder: "/workspaces/sample" };
    expect(hostPath(paths, "/workspaces/sample")).toBe("/mnt/workspace/repo/sample");
    expect(hostPath(paths, "/workspaces/sample/apps/backend/src/app.ts")).toBe("/mnt/workspace/repo/sample/apps/backend/src/app.ts");
    expect(hostPath(paths, "/workspaces/sample-other/a.ts")).toBe("/workspaces/sample-other/a.ts");
    expect(hostPath(paths, "/mnt/workspace/repo/sample/a.ts")).toBe("/mnt/workspace/repo/sample/a.ts");
    expect(hostPath(paths, "repo/sample/a.ts")).toBe("repo/sample/a.ts");
    expect(devcontainerContextFile(paths).content).toContain("Inside the devcontainer it is also at /workspaces/sample.");
  });
});

describe("pi's file tools in a devcontainer workspace", () => {
  it("read, write, edit and ls act on the host files when given the container path", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "agentx-paths-")));
    const hostFolder = join(root, "repo/sample");
    await mkdir(join(hostFolder, "src"), { recursive: true });
    await writeFile(join(hostFolder, "src/app.ts"), "export const port = 3001;\n");
    const tools = new Map(devcontainerFileTools(root, { hostFolder, containerFolder: "/workspaces/sample" }).map((tool) => [tool.name, tool]));
    expect([...tools.keys()].sort()).toEqual(["edit", "find", "grep", "ls", "read", "write"]);
    const run = async (name: string, params: Record<string, unknown>) => {
      const result = await tools.get(name)!.execute("call", params, undefined, undefined, undefined as never);
      return result.content.map((part) => ("text" in part ? part.text : "")).join("");
    };

    expect(await run("read", { path: "/workspaces/sample/src/app.ts" })).toContain("export const port = 3001;");
    await run("write", { path: "/workspaces/sample/src/notes.ts", content: "export const notes = [];\n" });
    expect(await readFile(join(hostFolder, "src/notes.ts"), "utf8")).toBe("export const notes = [];\n");
    await run("edit", { path: "/workspaces/sample/src/app.ts", edits: [{ oldText: "3001", newText: "3002" }] });
    expect(await readFile(join(hostFolder, "src/app.ts"), "utf8")).toBe("export const port = 3002;\n");
    expect(await run("ls", { path: "/workspaces/sample/src" })).toMatch(/app\.ts[\s\S]*notes\.ts/);
    // The host path keeps working too.
    expect(await run("read", { path: join(hostFolder, "src/notes.ts") })).toContain("export const notes = [];");
  });
});
