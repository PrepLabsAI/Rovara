import { describe, expect, it } from "vitest";
import { boundedReader, runDetectors } from "../../packages/worker/src/env-detect/index.js";
import { readCompose, stripJsonc } from "../../packages/worker/src/env-detect/compose.js";
import { parseSafeYaml, YAML_LIMITS } from "../../packages/worker/src/env-detect/safe-yaml.js";

type Files = Record<string, string>;
async function detect(files: Files) {
  const bounded = boundedReader(Object.keys(files), (path) => Promise.resolve(files[path]));
  return runDetectors(bounded.reader, "svc");
}
const family = (detection: Awaited<ReturnType<typeof detect>>, id: string) => detection.dependencies?.find((item) => item.family === id);

// Fake secrets are built at runtime so no key-shaped string sits in this file.
const FAKE_PASSWORD = ["pw", "x".repeat(20), "Zq9"].join("-");

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

  it("takes the AWS services a local emulator image lists, each as its own dependency", () => {
    const text = ["services:", "  aws:", "    image: localstack/localstack:3", "    environment:", "      SERVICES: s3, sqs,ddb", "  bare:", "    image: localstack/localstack", ""].join("\n");
    const { candidates, notes } = readCompose("compose.yml", text, []);
    expect(candidates.map((item) => item.family)).toEqual(["aws:s3", "aws:sqs", "aws:dynamodb"]);
    expect(notes.join(" ")).toContain("without naming its services");
  });

});

describe("fields Rovara refuses are flagged, not applied", () => {
  const flagged = (service: string) => readCompose("compose.yml", `services:\n  s:\n    image: postgres:16\n${service}`, []).candidates[0]!.hints.refused;
  it.each([
    ["host network", "    network_mode: host\n", "host_network"],
    ["host pid", "    pid: host\n", "host_pid"],
    ["host ipc", "    ipc: host\n", "host_ipc"],
    ["added capabilities", "    cap_add: [NET_ADMIN]\n", "cap_add"],
    ["devices", "    devices: ['/dev/fuse:/dev/fuse']\n", "devices"],
    ["a long-form bind mount", "    volumes:\n      - type: bind\n        source: ./d\n        target: /d\n", "host_volume"],
    ["the Docker socket", "    volumes: ['/var/run/docker.sock:/var/run/docker.sock']\n", "docker_socket"],
  ])("flags %s", (_label, field, expected) => {
    expect(flagged(field)).toContain(expected);
  });
  it("does not flag a named volume, a false privileged, or plain host-less network modes", () => {
    expect(flagged("    privileged: false\n    network_mode: bridge\n    volumes: ['pgdata:/var/lib/postgresql/data']\n")).toBeUndefined();
  });
  it("adds a note saying the flagged fields are not applied", async () => {
    const detection = await detect({ "docker-compose.yml": "services:\n  s:\n    image: redis\n    privileged: true\n  b:\n    build: .\n" });
    expect(detection.notes.join(" ")).toContain("is flagged and not applied");
    expect(detection.notes.join(" ")).toContain("built later, in a walled area");
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
  it("does not let a __proto__ key or a custom tag change anything", () => {
    const text = "__proto__:\n  polluted: yes\nservices:\n  r:\n    image: redis\n    privileged: !!js/function 'function(){ throw 1 }'\n    environment: !!python/object/apply:os.system ['id']\n";
    const reading = readCompose("compose.yml", text, []);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(reading.candidates.map((item) => item.family)).toEqual(["redis"]);
    expect(reading.candidates[0]!.hints.refused).toBeUndefined();
  });
});

