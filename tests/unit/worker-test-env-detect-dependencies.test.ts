// Slice 1, s1-sealed T2: the dependency candidates the detectors (D1-D7) found ride in the setup draft (`TestEnvDraft.dependencies`, test-env-detect.ts). They are candidates, never an environment: the draft's
// environment carries none, the broker chooses a backing, and a person approves. A candidate that cannot be listed never costs the draft itself.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_ENV_CANDIDATE_MAX, TEST_ENV_DRAFT_MAX_BYTES, TestEnvDraftSchema, type TestEnvDraft } from "@agentx/contracts";
import type { runDetectorsGuarded } from "../../packages/worker/src/env-detect/guarded.js";
import type { Detection, DependencyCandidate } from "../../packages/worker/src/env-detect/types.js";
import { detectTestEnvironment } from "../../packages/worker/src/test-env-detect.js";

type Guarded = typeof runDetectorsGuarded;
/** When set, the real detector pass runs and then this changes what it found (a crafted candidate no real file produces). */
let tamper: ((detection: Detection) => void) | undefined;
vi.mock("../../packages/worker/src/env-detect/guarded.js", async (importOriginal) => {
  const actual = await importOriginal<{ runDetectorsGuarded: Guarded }>();
  const guarded: Guarded = async (...args: Parameters<Guarded>) => {
    const detection = await actual.runDetectorsGuarded(...args);
    tamper?.(detection);
    return detection;
  };
  return { ...actual, runDetectorsGuarded: guarded };
});

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "te-detect-deps-")); tamper = undefined; });
afterEach(async () => { tamper = undefined; await rm(root, { recursive: true, force: true }); });

async function write(path: string, text: string) { await mkdir(join(root, path, ".."), { recursive: true }); await writeFile(join(root, path), text); }
const PYTEST = "[tool.pytest.ini_options]\naddopts = \"-q\"\n";
const repo = (name: string, over: Record<string, unknown> = {}) => ({ name, path: name, defaultBranch: "main", ...over });
const PASSWORD = "Sup3rSecretPw9";
const COMPOSE = [
  "services:",
  "  db:",
  "    image: postgres:16.4-alpine",
  "    environment:",
  `      POSTGRES_PASSWORD: ${PASSWORD}`,
  "      POSTGRES_DB: app",
  "    ports:",
  '      - "127.0.0.1:5432:5432"',
  "    volumes:",
  "      - ./db/init.sql:/docker-entrypoint-initdb.d/init.sql",
  "  cache:",
  "    image: redis:7",
  "",
].join("\n");

const candidate = (over: Partial<DependencyCandidate> = {}): DependencyCandidate => ({ family: "postgres", kind: "database", evidence: [{ path: "docker-compose.yml", line: 3 }], strength: "declared", hints: {}, ...over });
const draftOf = async (repositories = [repo("svc")]): Promise<TestEnvDraft> => (await detectTestEnvironment({ rootPath: root, repositories }))!;

describe("dependency candidates in the draft", () => {
  it("lists what the detectors found, with workspace-relative evidence, and the draft still parses", async () => {
    await write("svc/pyproject.toml", PYTEST);
    await write("svc/docker-compose.yml", COMPOSE);
    await write("svc/db/init.sql", "create table t (id int);\n");
    const draft = await draftOf();
    expect(TestEnvDraftSchema.safeParse(draft).success).toBe(true);
    const found = draft.dependencies!;
    expect(found.map((item) => item.family).sort()).toEqual(["postgres", "redis"]);
    const postgres = found.find((item) => item.family === "postgres")!;
    expect(postgres).toMatchObject({ kind: "database", strength: "declared", hints: { version: "16" } });
    // Where it was seen is a path a person can open from the workspace root, not from the repository.
    expect(postgres.evidence.every((entry) => entry.path.startsWith("svc/"))).toBe(true);
    expect(postgres.evidence.some((entry) => entry.path === "svc/docker-compose.yml")).toBe(true);
    expect(postgres.hints.initFiles).toEqual(["svc/db/init.sql"]);
    expect(postgres.hints.envNames).toEqual(expect.arrayContaining(["POSTGRES_PASSWORD", "POSTGRES_DB"]));
  });

  it("they are candidates only: the draft's environment carries no dependency, and no value read from a file reaches it", async () => {
    await write("svc/pyproject.toml", PYTEST);
    await write("svc/docker-compose.yml", COMPOSE);
    const draft = await draftOf();
    expect(draft.environment.dependencies).toBeUndefined();
    expect(draft.environment.services).toEqual([]);
    expect(JSON.stringify(draft)).not.toContain(PASSWORD);
  });

  it("a repository with none gives today's draft: no `dependencies` key at all", async () => {
    await write("svc/pyproject.toml", PYTEST);
    await write("svc/requirements.txt", "pytest\n");
    const draft = await draftOf();
    expect(Object.keys(draft)).not.toContain("dependencies");
    expect(JSON.stringify(draft)).not.toContain("dependencies");
  });

  it("merges one family seen in two repositories into one candidate, each sighting under its own repository", async () => {
    await write("api/pyproject.toml", PYTEST);
    await write("api/docker-compose.yml", "services:\n  db:\n    image: postgres:16\n");
    await write("worker/pyproject.toml", PYTEST);
    await write("worker/docker-compose.yml", "services:\n  db:\n    image: postgres:16\n");
    const draft = await draftOf([repo("api"), repo("worker")]);
    const postgres = draft.dependencies!.filter((item) => item.family === "postgres");
    expect(postgres).toHaveLength(1);
    expect(postgres[0]!.evidence.map((entry) => entry.path).sort()).toEqual(["api/docker-compose.yml", "worker/docker-compose.yml"]);
  });

  it("a repository with a pull request head checked out adds no candidate (default branch only)", async () => {
    await write("svc/pyproject.toml", PYTEST);
    await write("pr/pyproject.toml", PYTEST);
    await write("pr/docker-compose.yml", "services:\n  db:\n    image: mongo:7\n");
    const draft = await draftOf([repo("svc"), repo("pr", { checkedOut: { pullRequest: 7, headSha: "a".repeat(40) } })]);
    expect(draft.dependencies).toBeUndefined();
  });
});

describe("a candidate that cannot be listed never costs the draft", () => {
  beforeEach(async () => { await write("svc/pyproject.toml", PYTEST); await write("svc/requirements.txt", "pytest\n"); });

  it("drops the one the contract refuses, keeps the others and the draft, and says so in a fixed sentence", async () => {
    tamper = (detection) => {
      detection.dependencies = [
        candidate({ family: "postgres" }),
        candidate({ family: "redis", kind: "cache", evidence: [{ path: "x".repeat(600), line: 1 }] }),
        candidate({ family: "http:not a host", kind: "http_api" }),
        candidate({ family: "mysql", hints: { ports: [70_000] } }),
      ];
    };
    const draft = await draftOf();
    expect(TestEnvDraftSchema.safeParse(draft).success).toBe(true);
    expect(draft.dependencies!.map((item) => item.family)).toEqual(["postgres"]);
    expect(draft.notes.join(" ")).toMatch(/3 dependencies the detectors found could not be listed/u);
    expect(draft.environment.repos[0]!.checks.length).toBeGreaterThan(0);
  });

  it("a candidate with no evidence, or whose evidence leaves the repository, is not listed", async () => {
    tamper = (detection) => {
      detection.dependencies = [
        candidate({ family: "postgres", evidence: [] }),
        candidate({ family: "redis", kind: "cache", evidence: [{ path: "../outside/compose.yml", line: 1 }] }),
        candidate({ family: "mysql", evidence: [{ path: "docker-compose.yml", line: 1 }, { path: "/etc/passwd", line: 2 }] }),
      ];
    };
    const draft = await draftOf();
    // The third keeps its one good sighting.
    expect(draft.dependencies!.map((item) => [item.family, item.evidence.map((entry) => entry.path)])).toEqual([["mysql", ["svc/docker-compose.yml"]]]);
    expect(JSON.stringify(draft)).not.toContain("outside");
    expect(JSON.stringify(draft)).not.toContain("passwd");
  });

  it("lists at most the contract's maximum", async () => {
    tamper = (detection) => {
      detection.dependencies = Array.from({ length: TEST_ENV_CANDIDATE_MAX + 20 }, (_unused, index) => candidate({ family: `svc-${String(index)}`, kind: "other" }));
    };
    const draft = await draftOf();
    expect(draft.dependencies!.length).toBeLessThanOrEqual(TEST_ENV_CANDIDATE_MAX);
  });

  it("leaves the candidates out, not the draft, when they would make it too large for the broker", async () => {
    tamper = (detection) => {
      // Each candidate is valid and several KiB; the list as a whole pushes the draft over its cap.
      detection.dependencies = Array.from({ length: TEST_ENV_CANDIDATE_MAX }, (_unused, index) => candidate({
        family: `big-${String(index)}`, kind: "other",
        evidence: Array.from({ length: 8 }, (_e, at) => ({ path: `dir-${"d".repeat(250)}/f-${String(index)}-${String(at)}.yml`, line: at + 1 })),
        hints: { dependsOn: Array.from({ length: 16 }, (_d, at) => `n${"x".repeat(60)}${String(at)}`), initFiles: [] },
      }));
    };
    const draft = await draftOf();
    expect(Buffer.byteLength(JSON.stringify(draft))).toBeLessThanOrEqual(TEST_ENV_DRAFT_MAX_BYTES);
    expect(draft.dependencies).toBeUndefined();
    expect(draft.notes.join(" ")).toMatch(/left out to keep the draft small/u);
    expect(draft.environment.repos[0]!.checks.length).toBeGreaterThan(0);
  });

  it("never reads a detection whose dependencies are not a list", async () => {
    tamper = (detection) => { (detection as { dependencies?: unknown }).dependencies = "nope"; };
    const draft = await draftOf();
    expect(draft.dependencies).toBeUndefined();
    expect(draft.environment.repos[0]!.checks.length).toBeGreaterThan(0);
  });
});
