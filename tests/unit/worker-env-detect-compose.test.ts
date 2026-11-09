// Test services TS7 (D1): the compose and dev container compose reader, its safe YAML limits and the fields it flags as refused.
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { boundedReader, runDetectors } from "../../packages/worker/src/env-detect/index.js";
import { readCompose, stripJsonc } from "../../packages/worker/src/env-detect/compose.js";
import { parseSafeYaml, YAML_LIMITS } from "../../packages/worker/src/env-detect/safe-yaml.js";
import { listRepositoryFiles, readRepositoryFile } from "../../packages/worker/src/test-env-detect.js";

type Files = Record<string, string>;
async function detect(files: Files) {
  const bounded = boundedReader(Object.keys(files), (path) => Promise.resolve(files[path]));
  return runDetectors(bounded.reader, "svc");
}
const family = (detection: Awaited<ReturnType<typeof detect>>, id: string) => detection.dependencies?.find((item) => item.family === id);

// Fake secrets are built at runtime so no key-shaped string sits in this file.
const FAKE_PASSWORD = ["pw", "x".repeat(20), "Zq9"].join("-");
const FAKE_KEY = ["sk", "live", "A".repeat(24)].join("_");
// An upper-case key-shaped NAME (an AWS key id), which passes the plain name pattern and so needs the secret-shape check.
const FAKE_KEY_NAME = ["AK", "IA", "ABCDEFGHIJKLMNOP"].join("");

const COMPOSE = [
  "services:",
  "  db:",
  "    image: postgres:16.4-alpine",
  "    environment:",
  `      POSTGRES_PASSWORD: ${FAKE_PASSWORD}`,
  "      POSTGRES_DB: app",
  "    ports:",
  '      - "127.0.0.1:5432:5432"',
  "    healthcheck:",
  '      test: ["CMD", "pg_isready"]',
  "    volumes:",
  "      - ./db/init.sql:/docker-entrypoint-initdb.d/init.sql",
  "  cache:",
  "    image: redis:7",
  "  queue:",
  "    image: rabbitmq:3-management",
  "  api:",
  "    image: ghcr.io/acme/app:1.2",
  "    depends_on:",
  "      - db",
  "      - cache",
  "",
].join("\n");

describe("compose services", () => {
  it("reports each service's family, major version, setting names, ports, health check, init file and where it was seen", async () => {
    const detection = await detect({ "docker-compose.yml": COMPOSE, "db/init.sql": "select 1;" });
    const db = family(detection, "postgres")!;
    expect(db).toMatchObject({ family: "postgres", kind: "database", strength: "declared", evidence: [{ path: "docker-compose.yml", line: 2 }] });
    expect(db.hints).toMatchObject({ version: "16", envNames: ["POSTGRES_PASSWORD", "POSTGRES_DB"], ports: [5432], hasHealthcheck: true, initFiles: ["db/init.sql"], seenBy: ["compose"] });
    expect(family(detection, "redis")).toMatchObject({ kind: "cache", hints: { version: "7" }, evidence: [{ path: "docker-compose.yml", line: 13 }] });
    expect(family(detection, "rabbitmq")).toMatchObject({ kind: "queue", hints: { version: "3" } });
    expect(detection.dependencies).toHaveLength(3);
    expect(detection.notes.join(" ")).toContain("1 compose service uses an image Rovara has no catalog entry for");
  });

  it("recognises the other catalog families and a registry or digest on the image", () => {
    const text = ["services:", "  a: { image: 'registry.example.com:5000/team/mysql:8.0.36' }", "  b: { image: 'mongo@sha256:" + "a".repeat(64) + "' }", "  c: { image: 'bitnami/kafka:3.7' }", "  d: { image: 'opensearchproject/opensearch:2' }", "  e: { image: 'valkey/valkey:8' }", ""].join("\n");
    const { candidates } = readCompose("compose.yaml", text, []);
    expect(candidates.map((item) => [item.family, item.hints.version])).toEqual([["mysql", "8"], ["mongodb", undefined], ["kafka", "3"], ["opensearch", "2"], ["redis", "8"]]);
  });

  it("never copies a value: no password, key or image credential reaches the output", async () => {
    const text = ["services:", "  db:", `    image: postgres:16`, "    environment:", `      - POSTGRES_PASSWORD=${FAKE_PASSWORD}`, `      - API_TOKEN=${FAKE_KEY}`, "    command: [\"--secret\", \"" + FAKE_PASSWORD + "\"]", ""].join("\n");
    const detection = await detect({ "docker-compose.yml": text });
    const out = JSON.stringify(detection);
    expect(out).not.toContain(FAKE_PASSWORD);
    expect(out).not.toContain(FAKE_KEY);
    expect(family(detection, "postgres")!.hints.envNames).toEqual(["POSTGRES_PASSWORD", "API_TOKEN"]);
  });

  it("drops a setting NAME that is itself shaped like a key", () => {
    const text = `services:\n  db:\n    image: postgres\n    environment:\n      ${FAKE_KEY_NAME}: oops\n      OK_NAME: 1\n`;
    const { candidates } = readCompose("compose.yml", text, []);
    expect(candidates[0]!.hints.envNames).toEqual(["OK_NAME"]);
    expect(JSON.stringify(candidates)).not.toContain(FAKE_KEY_NAME);
  });

  it("takes the AWS services a local emulator image lists, each as its own dependency", () => {
    const text = ["services:", "  aws:", "    image: localstack/localstack:3", "    environment:", "      SERVICES: s3, sqs,ddb", "  bare:", "    image: localstack/localstack", ""].join("\n");
    const { candidates, notes } = readCompose("compose.yml", text, []);
    expect(candidates.map((item) => item.family)).toEqual(["aws:s3", "aws:sqs", "aws:dynamodb"]);
    expect(notes.join(" ")).toContain("without naming its services");
  });

  it("finds compose files in subfolders, reads compose*.yml names, and skips vendored folders", async () => {
    const detection = await detect({ "deploy/compose.test.yaml": "services:\n  r: { image: redis }\n", "node_modules/x/docker-compose.yml": "services:\n  p: { image: postgres }\n" });
    expect(detection.dependencies?.map((item) => item.family)).toEqual(["redis"]);
  });

  it("gives no dependencies and no new keys for a repository without compose files", async () => {
    const detection = await detect({ "package.json": '{"scripts":{"test":"vitest"}}', "package-lock.json": "{}" });
    expect(Object.hasOwn(detection, "dependencies")).toBe(false);
  });
});

describe("fields Rovara refuses are flagged, not applied", () => {
  const flagged = (service: string) => readCompose("compose.yml", `services:\n  s:\n    image: postgres:16\n${service}`, []).candidates[0]!.hints.refused;
  it.each([
    ["privileged", "    privileged: true\n", "privileged"],
    ["a quoted true", '    privileged: "true"\n', "privileged"],
    ["host network", "    network_mode: host\n", "host_network"],
    ["host pid", "    pid: host\n", "host_pid"],
    ["host ipc", "    ipc: host\n", "host_ipc"],
    ["added capabilities", "    cap_add: [NET_ADMIN]\n", "cap_add"],
    ["devices", "    devices: ['/dev/fuse:/dev/fuse']\n", "devices"],
    ["a host mount", "    volumes: ['/data:/var/lib/postgresql/data']\n", "host_volume"],
    ["a relative host mount", "    volumes: ['./data:/var/lib/postgresql/data']\n", "host_volume"],
    ["a long-form bind mount", "    volumes:\n      - type: bind\n        source: ./d\n        target: /d\n", "host_volume"],
    ["the Docker socket", "    volumes: ['/var/run/docker.sock:/var/run/docker.sock']\n", "docker_socket"],
    ["a build", "    build: .\n", "build"],
    ["a build with a context map", "    build:\n      context: ./x\n", "build"],
  ])("flags %s", (_label, field, expected) => {
    expect(flagged(field)).toContain(expected);
  });
  it("does not flag a named volume, a false privileged, or plain host-less network modes", () => {
    expect(flagged("    privileged: false\n    network_mode: bridge\n    volumes: ['pgdata:/var/lib/postgresql/data']\n")).toBeUndefined();
  });
  it("reports a build-only service under its compose name, and the Docker socket also as a host mount", () => {
    const { candidates } = readCompose("compose.yml", "services:\n  My_App:\n    build: ./app\n  d:\n    image: redis\n    volumes: ['/var/run/docker.sock:/var/run/docker.sock:ro']\n", []);
    expect(candidates[0]).toMatchObject({ family: "my-app", kind: "other", hints: { refused: ["build"] } });
    expect(candidates[1]!.hints.refused).toEqual(expect.arrayContaining(["docker_socket", "host_volume"]));
  });
  it("adds a note saying the flagged fields are not applied", async () => {
    const detection = await detect({ "docker-compose.yml": "services:\n  s:\n    image: redis\n    privileged: true\n  b:\n    build: .\n" });
    expect(detection.notes.join(" ")).toContain("is flagged and not applied");
    expect(detection.notes.join(" ")).toContain("built later, in a walled area");
  });
  it("only records an init script when it is a repository file, never one outside it", () => {
    const text = "services:\n  db:\n    image: postgres\n    volumes:\n      - ../../etc/passwd:/docker-entrypoint-initdb.d/a.sql\n      - /abs/b.sql:/docker-entrypoint-initdb.d/b.sql\n      - ./ok.sql:/docker-entrypoint-initdb.d/c.sql\n";
    expect(readCompose("compose.yml", text, ["ok.sql"]).candidates[0]!.hints.initFiles).toEqual(["ok.sql"]);
  });
});

describe("dev container compose files", () => {
  it("reads the compose file a dev container names, including JSON with comments", async () => {
    const files = { ".devcontainer/devcontainer.json": '{\n // the stack\n "dockerComposeFile": ["../stack/dev.yml",], /* x */ "service": "app"\n}', "stack/dev.yml": "services:\n  db: { image: postgres:15 }\n" };
    const detection = await detect(files);
    expect(family(detection, "postgres")).toMatchObject({ evidence: [{ path: "stack/dev.yml", line: 2 }], hints: { version: "15" } });
  });
  it("does not read a path that leaves the repository, is absolute, or names the home folder or a variable", async () => {
    const paths = [".devcontainer/devcontainer.json", "etc/other.yml", ".devcontainer/etc/other.yml"];
    for (const bad of ["../../etc/other.yml", "/etc/other.yml", "~/other.yml", "${localWorkspaceFolder}/other.yml", "..\\\\etc\\\\other.yml"]) {
      const reader = boundedReader(paths, (path) => Promise.resolve(path === ".devcontainer/devcontainer.json" ? JSON.stringify({ dockerComposeFile: bad }) : "services:\n  db: { image: postgres }\n"));
      expect((await runDetectors(reader.reader, "svc")).dependencies).toBeUndefined();
    }
  });
  it("strips comments outside strings only", () => {
    expect(JSON.parse(stripJsonc('{"a": "http://x//y", /* c */ "b": [1,2,],}'))).toEqual({ a: "http://x//y", b: [1, 2] });
  });
});

describe("hostile YAML is refused or read safely", () => {
  const bomb = (levels: number): string => {
    const lines = ['a: &a ["lol","lol","lol","lol","lol","lol","lol","lol","lol"]'];
    for (let level = 1; level < levels; level += 1) lines.push(`${String.fromCharCode(97 + level)}: &${String.fromCharCode(97 + level)} [${Array.from({ length: 9 }, () => `*${String.fromCharCode(96 + level)}`).join(",")}]`);
    return lines.join("\n");
  };
  it("refuses a billion-laughs document without expanding it", () => {
    const started = Date.now();
    const result = parseSafeYaml(bomb(9));
    expect(result.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
    const reading = readCompose("compose.yml", `services:\n  x: { image: redis }\nx-bomb:\n${bomb(9).split("\n").map((line) => `  ${line}`).join("\n")}\n`, []);
    expect(reading.candidates).toEqual([]);
    expect(reading.notes.join(" ")).toContain("so it was not read");
  });
  it("refuses a chain of aliases more than 8 deep", () => {
    const lines = ["a: &a1 [x]"];
    for (let level = 2; level <= 10; level += 1) lines.push(`b${String(level)}: &a${String(level)} [*a${String(level - 1)}]`);
    expect(parseSafeYaml(lines.join("\n"))).toEqual({ ok: false, reason: "alias_depth" });
    expect(parseSafeYaml(lines.slice(0, 8).join("\n")).ok).toBe(true);
  });
  it("refuses too many anchors and too many aliases", () => {
    const anchors = Array.from({ length: YAML_LIMITS.maxAnchors + 1 }, (_, index) => `k${String(index)}: &x${String(index)} 1`).join("\n");
    expect(parseSafeYaml(anchors)).toEqual({ ok: false, reason: "too_many_anchors" });
    const aliases = ["base: &b 1", ...Array.from({ length: YAML_LIMITS.maxAliases + 1 }, (_, index) => `k${String(index)}: *b`)].join("\n");
    expect(parseSafeYaml(aliases)).toEqual({ ok: false, reason: "too_many_aliases" });
  });
  it("refuses a text over 256 KiB and one with more than 4 documents", () => {
    expect(parseSafeYaml(`a: ${"x".repeat(YAML_LIMITS.maxBytes)}`)).toEqual({ ok: false, reason: "too_large" });
    expect(parseSafeYaml(Array.from({ length: 6 }, () => "a: 1").join("\n---\n"))).toEqual({ ok: false, reason: "too_many_documents" });
  });
  it("refuses nesting deeper than 32 levels, a repeated key and a text that is not YAML", () => {
    expect(parseSafeYaml(`${"[".repeat(40)}${"]".repeat(40)}`)).toEqual({ ok: false, reason: "too_deep" });
    expect(parseSafeYaml("a: 1\na: 2\n")).toEqual({ ok: false, reason: "invalid" });
    expect(parseSafeYaml("a: [1, 2\n  b: }").ok).toBe(false);
  });
  it("reads only the first of several documents", () => {
    const reading = readCompose("compose.yml", "services:\n  r: { image: redis }\n---\nservices:\n  p: { image: postgres }\n", []);
    expect(reading.candidates.map((item) => item.family)).toEqual(["redis"]);
  });
  it("keeps an ordinary compose file's anchors and merge keys working", () => {
    const text = ["x-common: &common", "  image: postgres:16", "  environment: { POSTGRES_DB: app }", "services:", "  a:", "    <<: *common", "  b:", "    <<: *common", "    ports: ['5433:5432']", ""].join("\n");
    const { candidates } = readCompose("compose.yml", text, []);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({ family: "postgres", hints: { version: "16", envNames: ["POSTGRES_DB"] } });
  });
  it("does not let a __proto__ key or a custom tag change anything", () => {
    const text = "__proto__:\n  polluted: yes\nservices:\n  r:\n    image: redis\n    privileged: !!js/function 'function(){ throw 1 }'\n    environment: !!python/object/apply:os.system ['id']\n";
    const reading = readCompose("compose.yml", text, []);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(reading.candidates.map((item) => item.family)).toEqual(["redis"]);
    expect(reading.candidates[0]!.hints.refused).toBeUndefined();
  });
  it("skips a hostile file and still reads the next one", async () => {
    const detection = await detect({ "docker-compose.a.yml": bomb(9), "docker-compose.b.yml": "services:\n  r: { image: redis }\n" });
    expect(detection.dependencies?.map((item) => item.family)).toEqual(["redis"]);
    expect(detection.notes.join(" ")).toContain("expands to more than 20,000 values");
  });
  it("treats more than 200 services as the first 200", () => {
    const text = `services:\n${Array.from({ length: 250 }, (_, index) => `  s${String(index)}: { build: . }`).join("\n")}\n`;
    expect(readCompose("compose.yml", text, []).candidates).toHaveLength(200);
  });
});

describe("links are never followed", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "compose-link-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  it("a compose file or dev container that is a link to a file outside the checkout is not read", async () => {
    await mkdir(join(root, "svc", ".devcontainer"), { recursive: true });
    await mkdir(join(root, "outside"), { recursive: true });
    await writeFile(join(root, "outside", "compose.yml"), "services:\n  db: { image: postgres }\n");
    await writeFile(join(root, "outside", "devcontainer.json"), '{"dockerComposeFile":"x.yml"}');
    await symlink(join(root, "outside", "compose.yml"), join(root, "svc", "docker-compose.yml"));
    await symlink(join(root, "outside", "compose.yml"), join(root, "svc", ".devcontainer", "x.yml"));
    await symlink(join(root, "outside", "devcontainer.json"), join(root, "svc", ".devcontainer", "devcontainer.json"));
    await writeFile(join(root, "svc", "compose.real.yml"), "services:\n  r: { image: redis }\n");
    const directory = join(root, "svc");
    const paths = await listRepositoryFiles(directory);
    const bounded = boundedReader(paths, (path) => readRepositoryFile(directory, path));
    const detection = await runDetectors(bounded.reader, "svc");
    expect(detection.dependencies?.map((item) => item.family)).toEqual(["redis"]);
  });
});
