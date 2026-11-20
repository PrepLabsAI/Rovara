// Lane L4-C B0: the whole pull request description of three representative tasks, stored as files so a person can read the real output and every later change to the layout shows as an exact diff.
// The bodies are rendered by the real functions (`workflowPullRequestBody`) from fixed inputs (tests/support/pr-body-scenarios.ts). To regenerate after an intended change, run with ROVARA_UPDATE_GOLDENS=1
// and read the diff of tests/fixtures/pr-body/*.md before committing it.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PULL_REQUEST_BODY_MAX_BYTES } from "../../packages/broker/src/core/proof/pull-request-body.js";
import { SCENARIOS } from "../support/pr-body-scenarios.js";

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/pr-body");

describe("golden pull request descriptions", () => {
  for (const { name, build } of SCENARIOS) {
    it(`${name}: the whole description is exactly the stored file`, () => {
      const { body } = build();
      const path = resolve(FIXTURES, `${name}.md`);
      if (process.env["ROVARA_UPDATE_GOLDENS"] === "1") {
        mkdirSync(FIXTURES, { recursive: true });
        writeFileSync(path, body);
      }
      expect(body).toBe(readFileSync(path, "utf8"));
    });
    it(`${name}: rendering twice gives the same text and stays inside the byte cap`, () => {
      const first = build().body;
      expect(build().body).toBe(first);
      expect(Buffer.byteLength(first, "utf8")).toBeLessThanOrEqual(PULL_REQUEST_BODY_MAX_BYTES);
    });
  }
});
