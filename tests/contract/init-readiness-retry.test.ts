// Exercise the real init command and page failure actions without opening a loopback listener.
import { expect, it, vi } from "vitest";
import { prepareDeployment } from "../../packages/cli/src/deploy/commands.js";
import type { InitCliDependencies } from "../../packages/cli/src/init/commands.js";
import type * as WizardServerModule from "../../packages/cli/src/init/ui/server.js";
import { harness, TERMINAL_FIRST_RUN } from "../support/init-ui-harness.js";
import { scriptedPrompter } from "../support/init-fakes.js";
import { installGatewayFixture } from "../support/install-gateway.js";

vi.mock("../../packages/cli/src/init/ui/server.js", async (importOriginal) => ({
  ...await importOriginal<typeof WizardServerModule>(),
  startWizardServer: async () => ({
    url: "http://127.0.0.1:1234/", port: 1234, token: "fixture",
    close: async () => undefined,
    mountManifest: () => { throw new Error("test setup: no GitHub step expected"); },
  }),
}));

installGatewayFixture();
const PAGE_SCRIPT = [...TERMINAL_FIRST_RUN.slice(0, -1), "create"];
const PAGE_ARGS = ["--ui", "--no-browser", "--stop-after", "access"];

function noWrites(h: Awaited<ReturnType<typeof harness>>) {
  expect(h.store.calls.filter(({ op }) => op !== "get" && op !== "list")).toEqual([]);
  expect([...h.secrets.values.keys()]).toEqual(["agentx/staging/slack"]);
  expect(h.deployer.requests).toEqual([]);
}

it("offers Try this step again for failed readiness preparation, prepares again and writes only after readiness passes", async () => {
  const h = await harness();
  const prompter = scriptedPrompter([...PAGE_SCRIPT, "retry"]);
  const choose = vi.spyOn(prompter, "choose");
  let attempts = 0;
  let cleanedUp = 0;
  let probes = 0;
  const prepare: InitCliDependencies["prepareDeployment"] = async (input) => {
    noWrites(h);
    expect(probes).toBe(0);
    attempts += 1;
    if (attempts === 1) throw new Error("npm ci exited with code 1");
    return { ...await prepareDeployment(input), cleanup: async () => { cleanedUp += 1; } };
  };
  vi.stubGlobal("fetch", async () => {
    if (probes === 0) noWrites(h);
    probes += 1;
    expect(attempts).toBe(2);
    return Response.json({ runPrice: { version: 1, admissionVersion: 1, snapshotVersion: 7 } });
  });
  expect(await h.run(PAGE_ARGS, { prompter, prepareDeployment: prepare })).toBe(0);
  expect(choose.mock.calls.find(([question]) => question === "The install stopped. What next?")?.[1]).toEqual([
    { value: "retry", label: "Try this step again" }, { value: "stop", label: "Stop for now" },
  ]);
  expect(prompter.remaining()).toBe(0);
  expect(attempts).toBe(2);
  expect(cleanedUp).toBe(1);
  expect(probes).toBeGreaterThan(0);
  expect(h.deployer.requests.map(({ part }) => part)).toEqual(["access"]);
  expect(h.store.calls.some(({ op }) => op === "put")).toBe(true);
});

it("refuses an unqualified selected artifact before any gateway probe or write", async () => {
  const h = await harness();
  const prompter = scriptedPrompter([...PAGE_SCRIPT, "stop"]);
  const transport = vi.fn(async () => Response.json({ ok: true }));
  vi.stubGlobal("fetch", transport);
  const prepare: InitCliDependencies["prepareDeployment"] = async (input) => {
    const prepared = await prepareDeployment(input);
    input.release.template = () => JSON.stringify({ Outputs: {} });
    return prepared;
  };
  expect(await h.run(PAGE_ARGS, { prompter, prepareDeployment: prepare })).not.toBe(0);
  expect(h.printed()).toContain("release must contain a price-serving broker");
  expect(transport).not.toHaveBeenCalled();
  noWrites(h);
});

it("keeps an unsigned gateway failure before every write even when stopped from the page", async () => {
  const h = await harness();
  const prompter = scriptedPrompter([...PAGE_SCRIPT, "stop"]);
  vi.stubGlobal("fetch", async () => { noWrites(h); return Response.json({ ok: true }); });
  expect(await h.run(PAGE_ARGS, { prompter })).not.toBe(0);
  expect(h.printed()).toContain("gateway must serve run prices");
  noWrites(h);
});

it("keeps terminal preparation failures non-interactive and before every write", async () => {
  const h = await harness();
  const prompter = scriptedPrompter(TERMINAL_FIRST_RUN);
  const prepare = vi.fn(async () => { throw new Error("synth failed"); });
  expect(await h.run(["--no-ui", "--stop-after", "access"], { prompter, prepareDeployment: prepare })).not.toBe(0);
  expect(prepare).toHaveBeenCalledOnce();
  expect(prompter.remaining()).toBe(0);
  expect(prompter.asked).not.toContain("The install stopped. What next?");
  noWrites(h);
});
