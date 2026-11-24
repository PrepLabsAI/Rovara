// L4-DR (DEC 254z c): the setup snapshot contract and the drift comparison. Pure: every file class has its own proof, and "cannot tell" is never "no drift".
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SETUP_WATCH_CLASSES, SETUP_WATCH_WORDS, SetupSnapshotSchema, compareSetupSnapshot, isSetupWatchedPath, normalisedHosts, setupDriftWords, setupWatchClassOf,
  type CurrentSetupRepository, type SetupSnapshot,
} from "@agentx/contracts";

const id = (n: number): string => n.toString(16).padStart(40, "0");
/** A file's id depends on its path only, so adding or removing another file never changes it. */
const idOfPath = (path: string): string => createHash("sha1").update(path).digest("hex");
const COMMIT = "a".repeat(40);

/** One path per class, as a repository would hold it. */
const PER_CLASS: Record<(typeof SETUP_WATCH_CLASSES)[number], string> = {
  marker: "services/api/package.json",
  lockfile: "package-lock.json",
  compose: "docker-compose.yml",
  dockerfile: "services/api/Dockerfile",
  devcontainer: ".devcontainer/devcontainer.json",
  env_example: ".env.example",
  version: ".nvmrc",
  test_config: "vitest.config.ts",
  ci: ".github/workflows/ci.yml",
};

const snapshotOf = (paths: string[], extra: Partial<SetupSnapshot> = {}): SetupSnapshot => ({
  setupRevision: 3, takenAt: "2026-11-17T10:00:00.000Z", hosts: ["registry.npmjs.org"],
  repositories: [{ name: "app", commit: COMMIT, files: paths.map((path) => ({ path, id: idOfPath(path) })).sort((a, b) => (a.path < b.path ? -1 : 1)) }],
  ...extra,
});
const nowOf = (paths: string[], change: (files: Array<{ path: string; id: string }>) => void = () => undefined): CurrentSetupRepository[] => {
  const files = paths.map((path) => ({ path, id: idOfPath(path) }));
  change(files);
  return [{ name: "app", commit: "b".repeat(40), files }];
};
const ALL = Object.values(PER_CLASS);

describe("which files the snapshot watches", () => {
  it.each(Object.entries(PER_CLASS))("watches a %s file (%s) and classes it so", (watchClass, path) => {
    expect(setupWatchClassOf(path)).toBe(watchClass);
    expect(isSetupWatchedPath(path)).toBe(true);
  });

  it.each([
    ["Dockerfile.dev", "dockerfile"], ["api.dockerfile", "dockerfile"], ["compose.override.yaml", "compose"], ["docker-compose.prod.yml", "compose"], [".env.sample", "env_example"], [".env.development.example", "env_example"],
    ["example.env", "env_example"], ["yarn.lock", "lockfile"], ["pnpm-lock.yaml", "lockfile"], ["poetry.lock", "lockfile"], ["go.sum", "lockfile"], [".tool-versions", "version"], [".python-version", "version"],
    ["pytest.ini", "test_config"], ["playwright.config.mjs", "test_config"], ["jest.config.js", "test_config"], [".gitlab-ci.yml", "ci"], [".circleci/config.yml", "ci"], ["pyproject.toml", "marker"], ["go.mod", "marker"],
    [".devcontainer/Dockerfile", "devcontainer"], [".devcontainer.json", "devcontainer"],
  ])("watches %s as %s", (path, watchClass) => {
    expect(setupWatchClassOf(path)).toBe(watchClass);
  });

  it.each([
    "src/index.ts", "README.md", ".env", ".env.local", "secrets.env", "node_modules/left-pad/package.json", "vendor/acme/package.json", "third_party/x/Dockerfile", ".git/config", "docs/compose.md",
    "/abs/package.json", "a//package.json", "../package.json", "win\\package.json", "", ".github/workflows/readme.md", ".github/ci.yml",
  ])("does not watch %s", (path) => {
    expect(setupWatchClassOf(path)).toBeUndefined();
    expect(isSetupWatchedPath(path)).toBe(false);
  });

  it("has a watched example path for every class and a word for every class and for websites", () => {
    expect(Object.keys(PER_CLASS).sort()).toEqual([...SETUP_WATCH_CLASSES].sort());
    for (const watchClass of [...SETUP_WATCH_CLASSES, "websites" as const]) expect(SETUP_WATCH_WORDS[watchClass]).toMatch(/^[A-Za-z' ]+$/u);
  });

  it("a path too long to keep is not watched (the listing is then reported incomplete by the host adapter)", () => {
    expect(isSetupWatchedPath(`${"a/".repeat(130)}package.json`)).toBe(false);
  });
});

describe("the snapshot's shape", () => {
  it("parses a snapshot the broker wrote and refuses anything else", () => {
    expect(SetupSnapshotSchema.safeParse(snapshotOf(ALL)).success).toBe(true);
    expect(SetupSnapshotSchema.safeParse({ ...snapshotOf(ALL), extra: 1 }).success).toBe(false);
    expect(SetupSnapshotSchema.safeParse(snapshotOf(["src/index.ts"])).success).toBe(false);
    expect(SetupSnapshotSchema.safeParse({ ...snapshotOf(ALL), repositories: [] }).success).toBe(false);
    const two = snapshotOf(ALL);
    expect(SetupSnapshotSchema.safeParse({ ...two, repositories: [two.repositories[0], two.repositories[0]] }).success).toBe(false);
    expect(SetupSnapshotSchema.safeParse({ ...snapshotOf(ALL), repositories: [{ name: "app", commit: "not-a-sha", files: [] }] }).success).toBe(false);
    expect(SetupSnapshotSchema.safeParse({ ...snapshotOf(ALL), repositories: [{ name: "app", commit: COMMIT, files: [{ path: "package.json", id: "short" }] }] }).success).toBe(false);
  });
});

describe("comparing the approved snapshot with the code now", () => {
  it("is no drift when every watched file has the same id, whatever the commit", () => {
    expect(compareSetupSnapshot(snapshotOf(ALL), nowOf(ALL), ["registry.npmjs.org"])).toEqual({ drift: "none" });
  });

  it.each(Object.entries(PER_CLASS))("a changed %s file (%s) is a change of that class and only that class", (watchClass, path) => {
    const result = compareSetupSnapshot(snapshotOf(ALL), nowOf(ALL, (files) => { files.find((file) => file.path === path)!.id = id(999); }), ["registry.npmjs.org"]);
    expect(result).toEqual({ drift: "changed", classes: [watchClass] });
  });

  it.each(Object.entries(PER_CLASS))("a new %s file is a change of that class", (watchClass, path) => {
    const others = ALL.filter((candidate) => candidate !== path);
    const result = compareSetupSnapshot(snapshotOf(others), nowOf(others, (files) => { files.push({ path, id: id(500) }); }), ["registry.npmjs.org"]);
    expect(result).toEqual({ drift: "changed", classes: [watchClass] });
  });

  it.each(Object.entries(PER_CLASS))("a removed %s file is a change of that class", (watchClass, path) => {
    const others = ALL.filter((candidate) => candidate !== path);
    const result = compareSetupSnapshot(snapshotOf(ALL), nowOf(others), ["registry.npmjs.org"]);
    expect(result).toEqual({ drift: "changed", classes: [watchClass] });
  });

  it("a different set of allowed websites is a change, whatever their order or case", () => {
    expect(compareSetupSnapshot(snapshotOf(ALL), nowOf(ALL), ["registry.npmjs.org", "api.stripe.com"])).toEqual({ drift: "changed", classes: ["websites"] });
    expect(compareSetupSnapshot(snapshotOf(ALL), nowOf(ALL), [])).toEqual({ drift: "changed", classes: ["websites"] });
    expect(compareSetupSnapshot(snapshotOf(ALL, { hosts: ["a.test", "b.test"] }), nowOf(ALL), ["B.test", "a.TEST"])).toEqual({ drift: "none" });
    expect(normalisedHosts(["B.test", "a.test", "a.TEST"])).toEqual(["a.test", "b.test"]);
  });

  it("lists several changes once each, in the fixed order", () => {
    const result = compareSetupSnapshot(snapshotOf(ALL), nowOf(ALL, (files) => { for (const file of files) if (file.path === "Dockerfile" || file.path.endsWith("/Dockerfile") || file.path === "package-lock.json" || file.path.endsWith("ci.yml")) file.id = id(777); }), ["x.test"]);
    expect(result).toEqual({ drift: "changed", classes: ["lockfile", "dockerfile", "ci", "websites"] });
  });

  it("a source file that is not watched never matters (it is not even listed)", () => {
    expect(compareSetupSnapshot(snapshotOf(ALL), nowOf(ALL), ["registry.npmjs.org"])).toEqual({ drift: "none" });
  });

  it("cannot tell, and says so, for no snapshot, a snapshot that does not parse, an unreadable repository and other repositories", () => {
    expect(compareSetupSnapshot(undefined, nowOf(ALL), [])).toEqual({ drift: "unknown", reason: "no_snapshot" });
    expect(compareSetupSnapshot({ nonsense: true }, nowOf(ALL), [])).toEqual({ drift: "unknown", reason: "snapshot_unreadable" });
    expect(compareSetupSnapshot(snapshotOf(ALL), [{ name: "app", unreadable: true }], ["registry.npmjs.org"])).toEqual({ drift: "unknown", reason: "unreadable_repository" });
    expect(compareSetupSnapshot(snapshotOf(ALL), [{ name: "other", commit: "b".repeat(40), files: [] }], ["registry.npmjs.org"])).toEqual({ drift: "unknown", reason: "repositories_differ" });
    expect(compareSetupSnapshot(snapshotOf(ALL), [], ["registry.npmjs.org"])).toEqual({ drift: "unknown", reason: "repositories_differ" });
    // The host listed a path the snapshot would not watch: the comparison does not trust it.
    expect(compareSetupSnapshot(snapshotOf(ALL), nowOf([...ALL, "src/index.ts"]), ["registry.npmjs.org"])).toEqual({ drift: "unknown", reason: "snapshot_unreadable" });
  });

  it("an unreadable repository is unknown even when another one changed", () => {
    const snapshot = snapshotOf(ALL);
    snapshot.repositories.push({ name: "docs", commit: COMMIT, files: [] });
    const current: CurrentSetupRepository[] = [{ ...nowOf(ALL, (files) => { files[0]!.id = id(900); })[0]!, name: "app" }, { name: "docs", unreadable: true }];
    expect(compareSetupSnapshot(snapshot, current, ["registry.npmjs.org"])).toEqual({ drift: "unknown", reason: "unreadable_repository" });
  });

  it("compares each repository against its own files", () => {
    const snapshot = snapshotOf(["package.json"]);
    snapshot.repositories.push({ name: "web", commit: COMMIT, files: [{ path: "package.json", id: id(2) }] });
    const appId = idOfPath("package.json");
    const same: CurrentSetupRepository[] = [{ name: "app", commit: "c".repeat(40), files: [{ path: "package.json", id: appId }] }, { name: "web", commit: "c".repeat(40), files: [{ path: "package.json", id: id(2) }] }];
    expect(compareSetupSnapshot(snapshot, same, ["registry.npmjs.org"])).toEqual({ drift: "none" });
    // The second repository's file carries the first one's id: a change, even though the id exists in the other repository.
    const swapped: CurrentSetupRepository[] = [same[0]!, { name: "web", commit: "c".repeat(40), files: [{ path: "package.json", id: appId }] }];
    expect(compareSetupSnapshot(snapshot, swapped, ["registry.npmjs.org"])).toEqual({ drift: "changed", classes: ["marker"] });
  });
});

describe("the words", () => {
  it("names the classes in fixed words, in the fixed order, and never a path", () => {
    expect(setupDriftWords(["lockfile"])).toBe("dependency files");
    expect(setupDriftWords(["ci", "lockfile"])).toBe("dependency files and a CI workflow");
    expect(setupDriftWords(["websites", "dockerfile", "marker"])).toBe("the project's package files, a Dockerfile and the allowed addresses");
    expect(setupDriftWords([])).toBe("the project");
  });
});
