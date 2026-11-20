// Test services dependency detectors: hostile-input hardening (userinfo, odd names, IaC names).
// #1256: the 256 KiB timing sweep is in worker-env-detect-redos.test.ts (nightly, and in a pull request whose change reaches the detectors).
import { describe, expect, it } from "vitest";
import { boundedReader, runDetectors } from "../../packages/worker/src/env-detect/index.js";

type Files = Record<string, string>;
async function detect(files: Files) {
  const bounded = boundedReader(Object.keys(files), (path) => Promise.resolve(files[path]));
  return runDetectors(bounded.reader, "svc");
}
const family = (detection: Awaited<ReturnType<typeof detect>>, id: string) => detection.dependencies?.find((item) => item.family === id);

describe("test-side fake hosts never carry user information", () => {
  const user = ["jane", "doe"].join(".");
  const password = ["pw", "z".repeat(14), "5"].join("-");
  const jwtish = ["eyJ", "a".repeat(12)].join("") + "." + "b".repeat(12);
  it.each([
    ["responses.add", `import responses\nresponses.add(responses.GET, "https://${user}:${password}@api.partner.example.net/x")\n`, "tests/test_a.py"],
    ["requests_mock", `requests_mock.get("https://${user}@api.partner.example.net/x")\n`, "tests/test_b.py"],
    ["nock", `nock("https://${user}:${password}@api.partner.example.net").get("/x")\n`, "src/a.test.ts"],
    ["msw", `http.get("https://${jwtish}@api.partner.example.net/x", () => {})\n`, "src/b.test.ts"],
    ["a dotted token before the at sign", `nock("https://${jwtish}@host.example.net")\n`, "src/c.test.ts"],
  ])("%s", async (_label, text, path) => {
    const detection = await detect({ [path]: text });
    const out = JSON.stringify(detection);
    for (const secret of [user, password, jwtish, "partner"]) expect(out).not.toContain(secret);
    expect(detection.dependencies?.some((item) => item.family.startsWith("http:"))).toBeFalsy();
  });
});

describe("variable names must look like variable names", () => {
  it("keeps such a key out of a compose list entry and an env file", async () => {
    const pasted = ["HUNTER", "TWO", "PW", "1234567890"].join("");
    const compose = `services:\n  db:\n    image: postgres\n    environment:\n      - hunter2PW=x\n      - ${pasted}=y\n      - POSTGRES_DB=app\n`;
    const detection = await detect({ "docker-compose.yml": compose, ".env": `${pasted}=1\nhunter2PW=1\nREDIS_URL=1\n` });
    expect(family(detection, "postgres")!.hints.envNames).toEqual(["POSTGRES_DB"]);
    const out = JSON.stringify(detection);
    expect(out).not.toContain(pasted);
    expect(out).not.toContain("hunter2PW");
  });
});

describe("infrastructure resource names are carried, but never a key-shaped one", () => {
  const keyName = ["AK", "IA", "ABCDEFGHIJKLMNOP"].join("");
  it("falls back from a key-shaped physical name to the template's id, and drops a resource with neither (its service stays a candidate with no resource)", async () => {
    const template = `Resources:\n  Orders:\n    Type: AWS::SQS::Queue\n    Properties:\n      QueueName: ${keyName}\n  ${keyName}:\n    Type: AWS::SNS::Topic\n    Properties:\n      TopicName: ${keyName}\n`;
    const detection = await detect({ "template.yaml": template });
    expect(family(detection, "aws:sqs")!.hints.resources).toEqual([{ kind: "queue", name: "Orders" }]);
    expect(family(detection, "aws:sns")!.hints.resources).toBeUndefined();
    expect(JSON.stringify(detection)).not.toContain(keyName);
  });
  it("applies the same rule to Terraform and CDK names", async () => {
    const tf = `resource "aws_sqs_queue" "q" {\n  name = "${keyName}"\n}\n`;
    const cdk = `import { Queue } from "aws-cdk-lib/aws-sqs";\nnew Queue(this, "${keyName}", { queueName: "${keyName}" });\n`;
    const detection = await detect({ "main.tf": tf, "lib/stack.ts": cdk });
    expect(family(detection, "aws:sqs")!.hints.resources).toEqual([{ kind: "queue", name: "q" }]);
    expect(JSON.stringify(detection)).not.toContain(keyName);
  });
});

