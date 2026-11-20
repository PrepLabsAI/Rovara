// Test services TS8 (D2): the CI services reader (GitHub Actions, GitLab CI, CircleCI secondary images).
import { describe, expect, it } from "vitest";
import { boundedReader, runDetectors } from "../../packages/worker/src/env-detect/index.js";

type Files = Record<string, string>;
async function detect(files: Files) {
  const bounded = boundedReader(Object.keys(files), (path) => Promise.resolve(files[path]));
  return runDetectors(bounded.reader, "svc");
}
const FAKE_PASSWORD = ["pw", "q".repeat(22), "7"].join("-");

const GITHUB = [
  "name: ci",
  "on: [push]",
  "jobs:",
  "  test:",
  "    runs-on: ubuntu-latest",
  "    services:",
  "      postgres:",
  "        image: postgres:16",
  "        env:",
  `          POSTGRES_PASSWORD: ${FAKE_PASSWORD}`,
  "        ports:",
  "          - 5432:5432",
  "        options: >-",
  "          --health-cmd pg_isready",
  "          --health-interval 10s",
  "      cache:",
  "        image: redis:7-alpine",
  "        ports: ['6379/tcp']",
  "      app:",
  "        image: ghcr.io/acme/app:latest",
  "    steps:",
  "      - run: npm test",
  "",
].join("\n");

describe("GitHub Actions services", () => {
  it("flags options Rovara refuses and does not keep the options text", async () => {
    const text = "jobs:\n  t:\n    services:\n      db:\n        image: postgres\n        options: --privileged --network=host --cap-add NET_ADMIN --device /dev/fuse -v /var/run/docker.sock:/var/run/docker.sock --pid host --ipc host\n";
    const detection = await detect({ ".github/workflows/x.yaml": text });
    expect(detection.dependencies![0]!.hints.refused).toEqual(expect.arrayContaining(["privileged", "host_network", "cap_add", "devices", "host_volume", "docker_socket", "host_pid", "host_ipc"]));
    expect(JSON.stringify(detection)).not.toContain("docker.sock");
    expect(detection.notes.join(" ")).toContain("is flagged and not applied");
  });
  it("does not flag ordinary options, and ignores a job with no services, an expression image and non-workflow YAML", async () => {
    const text = "jobs:\n  a:\n    steps: []\n  t:\n    services:\n      db:\n        image: postgres:15\n        options: --health-cmd pg_isready\n      m:\n        image: ${{ matrix.image }}\n";
    const detection = await detect({ ".github/workflows/x.yml": text, "other/ci.yml": "jobs:\n  t:\n    services:\n      db: { image: redis }\n" });
    expect(detection.dependencies!.map((item) => item.family)).toEqual(["postgres"]);
    expect(detection.dependencies![0]!.hints.refused).toBeUndefined();
  });
  it("names the AWS services a local emulator service lists, and says so when it lists none", async () => {
    const text = "jobs:\n  t:\n    services:\n      aws:\n        image: localstack/localstack\n        env:\n          SERVICES: s3,sqs\n      aws2:\n        image: localstack/localstack\n";
    const detection = await detect({ ".github/workflows/x.yml": text });
    expect(detection.dependencies!.map((item) => item.family)).toEqual(["aws:s3", "aws:sqs"]);
    expect(detection.notes.join(" ")).toContain("without naming its services");
  });
});

describe("GitLab CI services", () => {
  it("reads top-level, default and per-job services in string and map form", async () => {
    const text = ["services:", "  - postgres:15", "default:", "  services:", "    - name: redis:7", "      alias: cache", "      variables:", `        REDIS_PASSWORD: ${FAKE_PASSWORD}`, "test:", "  script: [pytest]", "  services:", "    - name: mongo:6", "    - rabbitmq:3.12", ""].join("\n");
    const detection = await detect({ ".gitlab-ci.yml": text });
    expect(detection.dependencies!.map((item) => [item.family, item.hints.version, item.evidence[0]!.line])).toEqual([["postgres", "15", 2], ["redis", "7", 5], ["mongodb", "6", 12], ["rabbitmq", "3", 13]]);
    expect(detection.dependencies![1]!.hints.envNames).toEqual(["REDIS_PASSWORD"]);
    expect(JSON.stringify(detection)).not.toContain(FAKE_PASSWORD);
  });
  it("resolves anchors a template uses", async () => {
    const text = [".db: &db", "  - postgres:14", "test:", "  services: *db", ""].join("\n");
    expect((await detect({ ".gitlab-ci.yml": text })).dependencies!.map((item) => item.family)).toEqual(["postgres"]);
  });
});

describe("hostile CI files", () => {
  it("skips a file over the YAML limits with a fixed-words note and reads the others", async () => {
    const bomb = ['a: &a ["l","l","l","l","l","l","l","l","l"]', ...Array.from({ length: 8 }, (_, level) => `b${String(level)}: &b${String(level)} [${Array.from({ length: 9 }, () => `*${level === 0 ? "a" : `b${String(level - 1)}`}`).join(",")}]`)].join("\n");
    const detection = await detect({ ".github/workflows/a.yml": bomb, ".github/workflows/b.yml": GITHUB });
    expect(detection.dependencies!.map((item) => item.family)).toEqual(["postgres", "redis"]);
    expect(detection.notes.join(" ")).toContain("so it was not read");
  });
});
