import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { CANDIDATE_EXCLUDE_PYTHON_USER_SITE_PATHSPEC } from "../../packages/worker/src/isolated-git.js";
import { SANDBOX_PYTHON_USER_BASE_DIRECTORY } from "../../packages/worker/src/task-sandbox.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("the candidate snapshot leaves the Python user site out (C67)", () => {
  it("excludes the folder the sandbox makes", () => {
    expect(CANDIDATE_EXCLUDE_PYTHON_USER_SITE_PATHSPEC).toBe(`:(top,exclude,literal)${SANDBOX_PYTHON_USER_BASE_DIRECTORY}`);
  });

});
