// Test services TS7-TS11: the dependency detectors as wired into the detector index. With no new family found the detection is today's, byte for byte; with one, candidates merge by family.
import { describe, expect, it } from "vitest";
import { DETECTORS, boundedReader, runDetectors } from "../../packages/worker/src/env-detect/index.js";

const NEW_DETECTORS = new Set(["compose", "ci", "env", "sdk", "test-fakes", "iac-resources"]);
type Files = Record<string, string>;

async function detect(files: Files, only?: (name: string) => boolean) {
  const list = DETECTORS as unknown as Array<(typeof DETECTORS)[number]>;
  const kept = list.filter((detector) => only === undefined || only(detector.name));
  const original = list.splice(0, list.length, ...kept);
  try {
    const bounded = boundedReader(Object.keys(files), (path) => Promise.resolve(files[path]));
    return await runDetectors(bounded.reader, "svc");
  } finally {
    list.splice(0, list.length, ...original);
  }
}

const TODAY: Record<string, Files> = {
  python: {
    "pyproject.toml": "[project]\nname = \"x\"\n[tool.pytest.ini_options]\naddopts = \"-q\"\n[tool.ruff]\nline-length = 100\n",
    "requirements.txt": "boto3==1.35.0\npytest==8.0.0\n",
    "tests/test_a.py": "def test_a(): pass\n",
    "config/app.yaml": "scorer:\n  fallback: https://rules.partners-internal.net/v1\n",
  },
  node: { "package.json": '{"scripts":{"test":"vitest","lint":"eslint ."}}', "package-lock.json": "{}", "src/a.ts": "export const a = 1;\n" },
  iac: { "cdk.json": "{}", "template.yaml": "AWSTemplateFormatVersion: '2010-09-09'\nResources: {}\n" },
  empty: { "README.md": "hello" },
};

describe("the detector index", () => {
  it.each(Object.keys(TODAY))("%s repository: with no new family found, the detection is exactly what the old detectors give", async (name) => {
    const files = TODAY[name]!;
    const withNew = await detect(files);
    const withoutNew = await detect(files, (detectorName) => !NEW_DETECTORS.has(detectorName));
    expect(JSON.stringify(withNew)).toBe(JSON.stringify(withoutNew));
    expect(Object.hasOwn(withNew, "dependencies")).toBe(false);
  });

  it("adds candidates, merged by family with every sighting's evidence and the strongest strength", async () => {
    const detection = await detect({ "docker-compose.yml": "services:\n  db: { image: postgres:16 }\n", "compose.override.yml": "services:\n  db: { image: postgres:16, ports: ['5432:5432'] }\n" });
    expect(detection.dependencies).toHaveLength(1);
    expect(detection.dependencies![0]).toMatchObject({ family: "postgres", strength: "declared", hints: { ports: [5432], version: "16" } });
    expect(detection.dependencies![0]!.evidence.map((entry) => entry.path)).toEqual(["docker-compose.yml", "compose.override.yml"]);
  });
});
