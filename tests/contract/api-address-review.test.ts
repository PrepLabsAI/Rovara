// Reviewer tests (Opus review of the address stack lane, 2026-11-24): the health-alarm exemption covers ONLY alarms inside the address stack.
import { App, Stack, aws_cloudwatch as cloudwatch } from "aws-cdk-lib";
import { describe, expect, it } from "vitest";
import { ApiAddressStack } from "../../infra/lib/api-address.js";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

const stray = (scope: Stack, name: string) =>
  new cloudwatch.Alarm(scope, "Stray", { alarmName: name, metric: new cloudwatch.Metric({ namespace: "X", metricName: "Y" }), threshold: 1, evaluationPeriods: 1 });

describe("the address stack's exemption from the health-alarm check", () => {
  it("lets the address stack's own expiry alarm through when it sits in the same app as the control plane", () => {
    const app = new App();
    new ControlPlaneStack(app, "ReviewControlPlane", { naming: environmentNaming("staging") });
    new ApiAddressStack(app, "ReviewAddress", { naming: { env: "staging" }, domainName: "api.staging.example.com" });
    expect(() => app.synth()).not.toThrow();
  });

  it("still refuses an unlisted alarm in another stack of an app that has an address stack", () => {
    const app = new App();
    new ControlPlaneStack(app, "ReviewControlPlane", { naming: environmentNaming("staging") });
    new ApiAddressStack(app, "ReviewAddress", { naming: { env: "staging" }, domainName: "api.staging.example.com" });
    stray(new Stack(app, "OtherStack"), "agentx-staging-address-cert-expiry");
    expect(() => app.synth()).toThrow(/health probe does not read alarm OtherStack\/Stray/u);
  });
});
