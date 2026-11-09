// L4 (S4 review): the ordinary publication paths stage the work tree with `git add --all`. Each leaves the Python user site out, as the candidate snapshot does (isolated-git.ts).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CANDIDATE_EXCLUDE_PYTHON_USER_SITE_PATHSPEC } from "../../packages/worker/src/isolated-git.js";

const source = (file: string) => readFileSync(new URL(`../../packages/worker/src/${file}`, import.meta.url), "utf8");

describe("ordinary publication leaves the Python user site out of what it stages", () => {
  it("names the same pathspec the candidate snapshot uses", () => {
    expect(CANDIDATE_EXCLUDE_PYTHON_USER_SITE_PATHSPEC).toBe(":(top,exclude,literal).agentx-python");
  });

  it.each(["publish.ts", "maintain-pull-request.ts"])("%s has no unrestricted `add --all`", (file) => {
    const text = source(file);
    const adds = text.match(/\["add", "--all"[^\]]*\]/gu) ?? [];
    expect(adds.length).toBeGreaterThan(0);
    for (const add of adds) expect(add).toContain("CANDIDATE_EXCLUDE_PYTHON_USER_SITE_PATHSPEC");
  });
});
