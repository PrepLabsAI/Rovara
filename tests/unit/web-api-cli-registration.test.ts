import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, webApiRuntimeInstallProposalSha256 } from "../../packages/contracts/src/index.js";
import { submitRuntimeInstallProposal } from "../../packages/cli/src/admin/runtime-installation.js";
import { qualifyInstalledWebApiRuntime } from "../../packages/verifier/src/install-qualification.js";
import { fakeLinuxEnvironment, fakeProbeRunner, privateEvidenceRoot, webApiChallenge, WEB_API_FIXTURE_NOW } from "../support/web-api-qualification.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("admin runtime-installation register for a web/API proposal", () => {
  it("submits the exact proposal and its own digest, without demanding the standard P0 shape", async () => {
    const proposal = await qualifyInstalledWebApiRuntime({ challenge: webApiChallenge(WEB_API_FIXTURE_NOW), evidenceRoot: await privateEvidenceRoot(),
      runProbe: fakeProbeRunner().runProbe, environment: fakeLinuxEnvironment(WEB_API_FIXTURE_NOW) });
    const dir = await mkdtemp(join(tmpdir(), "web-api-register-")); dirs.push(dir);
    await writeFile(join(dir, "proposal.json"), `${canonicalJson(proposal)}\n`);
    const sent: { url: string; body: { proposal: unknown; proposalSha256: string } }[] = [];
    const fetcher = (async (url: string, init: { body: string }) => {
      sent.push({ url, body: JSON.parse(init.body) as never });
      return new Response(JSON.stringify({ requestId: "r1", ok: true }), { status: 201, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    await submitRuntimeInstallProposal({ controlPlaneUrl: "https://control.example.test", accessToken: "token", proposalFile: join(dir, "proposal.json") }, fetcher);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://control.example.test/v1/admin/runtime-installation/registrations");
    expect(sent[0]!.body.proposalSha256).toBe(webApiRuntimeInstallProposalSha256(proposal));
    expect(canonicalJson(sent[0]!.body.proposal)).toBe(canonicalJson(proposal));
  });

  it("refuses a v2 file that is not a READY web/API qualification before sending anything", async () => {
    const dir = await mkdtemp(join(tmpdir(), "web-api-register-")); dirs.push(dir);
    await writeFile(join(dir, "proposal.json"), JSON.stringify({ schemaVersion: "runtime-installation-proposal/v2", state: "PARKED" }));
    let sent = 0;
    const fetcher = (async () => { sent += 1; return new Response("{}"); }) as unknown as typeof fetch;
    await expect(submitRuntimeInstallProposal({ controlPlaneUrl: "https://control.example.test", accessToken: "token", proposalFile: join(dir, "proposal.json") }, fetcher)).rejects.toThrow();
    expect(sent).toBe(0);
  });
});
