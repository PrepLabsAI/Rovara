// SageMaker endpoint detector (SM4): the Runtime client in four languages, the Python SDK's endpoint classes, endpoint names in settings and infrastructure code, the signs of a model the project serves itself, and the
// doubles that mean the project's tests fake the endpoint themselves. Only names and fixed words leave the detector.
import { describe, expect, it } from "vitest";
import { TestEnvDependencyCandidateSchema } from "../../packages/contracts/src/index.js";
import { boundedReader, runDetectors } from "../../packages/worker/src/env-detect/index.js";

type Files = Record<string, string>;
async function detect(files: Files) {
  const bounded = boundedReader(Object.keys(files), (path) => Promise.resolve(files[path]));
  return runDetectors(bounded.reader, "service");
}
const candidateOf = async (files: Files) => (await detect(files)).dependencies?.find((item) => item.family === "aws:sagemaker-runtime");

describe("the SageMaker Python SDK", () => {
  it("reads Predictor, ModelBuilder and a local session, with the endpoint name of a Predictor", async () => {
    const found = await candidateOf({
      "ml/serve.py": "from sagemaker.predictor import Predictor\nfrom sagemaker.serve import ModelBuilder\nfrom sagemaker.local import LocalSession\n\np = Predictor(endpoint_name=\"churn-model\")\nm = ModelBuilder(model=x)\nm.deploy(instance_type=\"local\")\n",
    });
    expect(found?.hints).toMatchObject({ endpointNames: ["churn-model"], sagemakerSignals: ["predictor", "model_builder", "local_session"] });
    expect(found?.strength).toBe("used");
  });
});

describe("endpoint names in settings and infrastructure code", () => {
  it("reads a SageMaker setting, and a generic one only when the project uses SageMaker some other way", async () => {
    const found = await candidateOf({ ".env.example": "SAGEMAKER_ENDPOINT_NAME=from-env\nFRAUD_ENDPOINT_NAME=generic-one\nOTHER=1\n", "svc/a.py": "import boto3\nboto3.client('sagemaker-runtime').invoke_endpoint(EndpointName=NAME, Body=b)\n" });
    expect(found?.hints.endpointNames).toEqual(expect.arrayContaining(["from-env", "generic-one"]));
    expect(found?.hints.sagemakerSignals).toContain("endpoint_name_setting");
    // with no sign of SageMaker, a generic `*_ENDPOINT_NAME` is not an endpoint
    expect(await candidateOf({ ".env.example": "SEARCH_ENDPOINT_NAME=elastic-main\n" })).toBeUndefined();
  });
  it("does not take a value that is a reference or a flag", async () => {
    const found = await candidateOf({ "config.yaml": "sagemaker:\n  endpoint_name: ${ENDPOINT}\n  other_endpoint_name: true\n", "a.py": "import boto3\nboto3.client('sagemaker-runtime')\n" });
    expect(found?.hints.endpointNames).toBeUndefined();
  });
  it("reads a CloudFormation endpoint, as JSON or YAML, with a literal name", async () => {
    const yaml = "Resources:\n  Scorer:\n    Type: AWS::SageMaker::Endpoint\n    Properties:\n      EndpointName: cfn-scorer\n      EndpointConfigName: !Ref Config\n  Config:\n    Type: AWS::SageMaker::EndpointConfig\n    Properties:\n      EndpointConfigName: cfg\n";
    const json = JSON.stringify({ Resources: { Other: { Type: "AWS::SageMaker::Endpoint", Properties: { EndpointName: "cfn-json" } }, Noname: { Type: "AWS::SageMaker::Endpoint", Properties: {} } } });
    const found = await candidateOf({ "infra/template.yaml": yaml, "infra/other.json": json });
    expect(found).toMatchObject({ strength: "declared", hints: { sagemakerSignals: ["endpoint_in_iac"] } });
    expect(found?.hints.endpointNames?.slice().sort()).toEqual(["cfn-json", "cfn-scorer"]);
    expect(found?.hints.endpointNames).not.toContain("cfg");
  });
  it("reads a CDK endpoint in TypeScript and Python, and a Terraform one", async () => {
    const found = await candidateOf({
      "infra/stack.ts": "import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';\nnew sagemaker.CfnEndpoint(this, 'Ep', { endpointName: 'cdk-ts', endpointConfigName: cfg.attrEndpointConfigName });\n",
      "infra/stack.py": "from aws_cdk import aws_sagemaker as sagemaker\nsagemaker.CfnEndpoint(self, \"Ep\", endpoint_name=\"cdk-py\", endpoint_config_name=c)\n",
      "infra/main.tf": "resource \"aws_sagemaker_endpoint\" \"main\" {\n  name = \"tf-endpoint\"\n  endpoint_config_name = aws_sagemaker_endpoint_configuration.c.name\n}\n\nresource \"aws_sagemaker_endpoint\" \"dynamic\" {\n  name = var.endpoint_name\n}\n",
    });
    expect(found?.hints.endpointNames).toEqual(expect.arrayContaining(["cdk-ts", "cdk-py", "tf-endpoint"]));
    expect(found?.hints.endpointNames).toHaveLength(3);
    expect(found?.hints.sagemakerSignals).toEqual(["endpoint_in_iac"]);
  });
});

describe("model signs", () => {
  it("names a model archive, an inference script and an inference image, once the project calls an endpoint", async () => {
    const found = await candidateOf({
      "app/client.py": "import boto3\nboto3.client('sagemaker-runtime')\n",
      "model/model.tar.gz": "",
      "model/code/inference.py": "import torch\n\ndef model_fn(model_dir):\n    return 1\n\ndef predict_fn(data, model):\n    return 2\n",
      "model/Dockerfile": "FROM registry.example.test/ml/pytorch-inference:2.1-cpu\nCOPY . /opt/ml/model\n",
    });
    expect(found?.hints.sagemakerSignals).toEqual(expect.arrayContaining(["model_archive", "inference_script", "inference_image"]));
  });
});

describe("tests that fake the endpoint", () => {
  const app = { "app/score.py": "import boto3\nc = boto3.client('sagemaker-runtime')\nc.invoke_endpoint(EndpointName='fraud-scorer', Body=b)\n" };
  it("marks the candidate when the tests stub, mock or replay the client", async () => {
    for (const test of [
      "from botocore.stub import Stubber\nimport boto3\ndef test_a():\n    s = Stubber(boto3.client('sagemaker-runtime'))\n",
      "from moto import mock_aws\n@mock_aws\ndef test_a():\n    invoke_endpoint\n",
      "import { mockClient } from 'aws-sdk-client-mock';\nimport { SageMakerRuntimeClient } from '@aws-sdk/client-sagemaker-runtime';\nmockClient(SageMakerRuntimeClient);\n",
      "from unittest.mock import patch\n@patch('app.score.runtime.invoke_endpoint')\ndef test_a(m):\n    pass\n",
    ]) {
      const found = await candidateOf({ ...app, "tests/test_score.py": test });
      expect(found?.hints.fakedByTests).toBe(true);
    }
  });
});

describe("what the detector carries", () => {
  it("reports only names and fixed words, in a candidate the draft's contract accepts, and keeps the legacy service entry", async () => {
    const detection = await detect({ "app/score.py": "import boto3\nboto3.client('sagemaker-runtime').invoke_endpoint(EndpointName=\"fraud-scorer\", Body=b)\n", ".env.example": "SAGEMAKER_ENDPOINT_NAME=fraud-scorer\nSAGEMAKER_ROLE=hunter2-hunter2-hunter2\n" });
    const found = detection.dependencies!.find((item) => item.family === "aws:sagemaker-runtime")!;
    expect(TestEnvDependencyCandidateSchema.safeParse(found).success).toBe(true);
    expect(JSON.stringify(found)).not.toContain("hunter2");
    expect(detection.services.map((item) => item.value)).toEqual([{ kind: "sagemaker_runtime", target: "fraud-scorer" }]);
  });
});

// Fail, never hang: a backtracking pattern blocks the thread, so no test timeout can stop it (a cubic Dockerfile pattern hung CI shard 3/4 on
// PR #485 inside the hostile-input suite's 1 h timeout). So this grows each hostile file in steps and stops at the first step over its bar: a
// slow pattern fails at a small size, in seconds. Linear work at 64 KiB takes a few ms; the quadratic `^\s*` shapes took seconds there.
describe("the detector stays fast on hostile files, and a slow pattern fails rather than hangs", () => {
  // #1124: the release build (CodeBuild) sets CODEBUILD_BUILD_ID, not CI, and is as busy as a CI runner, so it gets the CI bar too.
  const ON_CI = (process.env["CI"] !== undefined && process.env["CI"] !== "" && process.env["CI"] !== "false") || (process.env["CODEBUILD_BUILD_ID"] ?? "") !== "";
  const BAR_MS = ON_CI ? 1_000 : 250;
  const SIZES = [1_024, 4_096, 16_384, 65_536];
  const CALLER = { "app/score.py": "import boto3\nimport sagemaker\nruntime = boto3.client('sagemaker-runtime')\nruntime.invoke_endpoint(EndpointName='m')\n" };
  const PATHS = ["Dockerfile", "inference.py", "app/main.py", "src/a.ts", "Main.java", "main.go", "tests/test_a.py", "config/app.yml", ".env", "settings.json", "main.tf", "template.yaml", "lib/stack.ts"];
  // what lets each reader get past its early exits, then a filler that makes a backtracking pattern work hard
  const LEADS = ["", "sagemaker aws-cdk CfnEndpoint( AWS::SageMaker::Endpoint\nresource \"aws_sagemaker_endpoint\" \"x\" {\n", "FROM ", "EXPOSE 8080\nCMD ", "endpoint_name", "SAGEMAKER_ENDPOINT="];
  const FILLERS: Record<string, string> = { newlines: "\n", "space-newline": " \n", spaces: " ", "tab-newline": "\t\n", word: "a", dash: "-", quote: "\"", "from-line": "FROM a\n", "def-line": "def \n", "name-line": "name = \n" };
  for (const path of PATHS) {
    it(path, async () => {
      // the first slow case ends the test: one is enough to fail, and each further one would cost seconds more
      let slow: string | undefined;
      search: for (const lead of LEADS) {
        for (const [label, unit] of Object.entries(FILLERS)) {
          for (const size of SIZES) {
            const body = lead + unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
            const started = performance.now();
            await detect({ ...CALLER, [path]: body });
            const took = performance.now() - started;
            if (took > BAR_MS) { slow = `${JSON.stringify(lead.slice(0, 20))}+${label} at ${String(size)} bytes: ${String(Math.round(took))} ms`; break search; }
          }
        }
      }
      expect(slow).toBeUndefined();
    }, 120_000);
  }
});
