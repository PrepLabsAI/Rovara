// DEC 254zzz495 / N3: "Ready, no automated tests". The fact is an attribute of the project's approved revision ROW (beside `definition`, so an older release that parses the strict definition stays safe on rollback), is read fail-safe
// (only while the revision has no test command), is the control plane's alone, and can be carried by no registration body.
import { describe, expect, it } from "vitest";
import {
  NoAutomatedTestsSchema, ProjectDefinitionSchema, SETUP_NO_COMMANDS_WORDS, SETUP_READY_NO_TESTS_WORDS, SETUP_TEST_PLACES, StoredProjectDefinitionSchema, noAutomatedTestsOf, noAutomatedTestsOfRow, workerProjectDefinition,
} from "../../packages/contracts/src/index.js";

const FACT = { at: "2026-11-24T10:00:00.000Z", looked: ["tests_folder", "pytest_config"] as Array<"tests_folder" | "pytest_config"> };
const command = { cwd: "repo/web", executable: "npm", args: ["test"], timeoutSeconds: 600 };
const base = { name: "payments", revision: 3, orchestratorInstructions: "Delegate work.", repositories: [{ name: "web", url: "https://github.com/example/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "host-app" }], setup: [], readiness: [] };

describe("the no-automated-tests fact", () => {
  it("is when, and where the run looked as fixed words: nothing else, no free text, no extra key", () => {
    expect(NoAutomatedTestsSchema.parse(FACT)).toEqual(FACT);
    expect(NoAutomatedTestsSchema.safeParse({ at: FACT.at, looked: [] }).success).toBe(true);
    expect(NoAutomatedTestsSchema.safeParse({ at: "yesterday", looked: [] }).success).toBe(false);
    expect(NoAutomatedTestsSchema.safeParse({ at: FACT.at, looked: ["/etc/passwd"] }).success).toBe(false);
    expect(NoAutomatedTestsSchema.safeParse({ at: FACT.at, looked: ["tests_folder"], note: "x" }).success).toBe(false);
    expect(NoAutomatedTestsSchema.safeParse({ at: FACT.at }).success).toBe(false);
    expect(SETUP_TEST_PLACES).toEqual(["pytest_config", "tests_folder", "test_py_files", "conftest", "package_scripts", "js_test_files", "go_test_files", "java_src_test", "makefile", "ci_workflows", "readme"]);
  });
  it("is NOT a field of the project definition (rollback safety): the strict definition refuses it, so no registration body can carry it, and a definition parses as before", () => {
    expect(ProjectDefinitionSchema.parse(base)).not.toHaveProperty("noAutomatedTests");
    expect(ProjectDefinitionSchema.safeParse({ ...base, noAutomatedTests: FACT }).success).toBe(false);
    expect(StoredProjectDefinitionSchema.safeParse({ ...base, noAutomatedTests: FACT }).success).toBe(false);
  });
  it("is read from the revision ROW beside the definition, through its schema again: a row without it, or with one that does not read, has none", () => {
    expect(noAutomatedTestsOfRow({ definition: base, noAutomatedTests: FACT })).toEqual(FACT);
    expect(noAutomatedTestsOfRow({ definition: base })).toBeUndefined();
    expect(noAutomatedTestsOfRow({ definition: base, noAutomatedTests: { at: "yesterday", looked: [] } })).toBeUndefined();
    expect(noAutomatedTestsOfRow({ definition: base, noAutomatedTests: { at: FACT.at, looked: ["nope"] } })).toBeUndefined();
    expect(noAutomatedTestsOfRow(undefined)).toBeUndefined();
    expect(noAutomatedTestsOfRow("x")).toBeUndefined();
  });
  it("is read only while the revision has no test command (a revision that gains one is back under the tests-before-a-PR rule)", () => {
    expect(noAutomatedTestsOf({ readiness: [], noAutomatedTests: FACT })).toEqual(FACT);
    expect(noAutomatedTestsOf({ noAutomatedTests: FACT })).toEqual(FACT);
    expect(noAutomatedTestsOf({ readiness: [command], noAutomatedTests: FACT })).toBeUndefined();
    expect(noAutomatedTestsOf({ readiness: [] })).toBeUndefined();
  });
  it("never reaches a worker (it is not in the definition a worker is sent)", () => {
    expect(JSON.stringify(workerProjectDefinition(ProjectDefinitionSchema.parse(base)))).not.toContain("noAutomatedTests");
  });
  it("has fixed words for the two normal ends (the pull-request sentence is a later lane's)", () => {
    expect(SETUP_READY_NO_TESTS_WORDS.headline).toBe("Ready, no automated tests");
    expect(SETUP_READY_NO_TESTS_WORDS.body("payments")).toBe("Rovara installed payments and found no tests. Tasks run normally.");
    expect(SETUP_READY_NO_TESTS_WORDS.looked(["tests_folder", "makefile"])).toBe("Looked for tests in: tests_folder, makefile. None found.");
    expect(SETUP_NO_COMMANDS_WORDS.title).toBe("Rovara found no commands it could verify");
    expect(SETUP_NO_COMMANDS_WORDS.use).toBe("Use without setup or tests");
  });
});
