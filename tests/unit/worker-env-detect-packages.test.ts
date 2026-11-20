import { describe, expect, it } from "vitest";
import { detectWorkspacePackages } from "../../packages/worker/src/env-detect/packages.js";

describe("workspace package discovery foundation", () => {



  it("refuses a listed definition that cannot be loaded and never reads outside the inventory", async () => {
    const read: string[] = [];
    const result = await detectWorkspacePackages(["pnpm-workspace.yaml"], (path) => { read.push(path); return Promise.reject(new Error("private detail")); }, "repo");
    expect(result).toEqual({ kind: "unavailable", units: [], reason: "Workspace definitions could not be read." });
    expect(read).toEqual(["pnpm-workspace.yaml"]);
  });




});
