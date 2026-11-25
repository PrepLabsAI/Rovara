// TE-H1 slice 2 (DEC 241c, DEC 241 Cloud seam): the laptop's setting is an optional recipe in the owner's own config, read fail-closed; Cloud refuses the callback with fixed words.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BROWSER_EVIDENCE_NOT_ON_CLOUD, PluginConfigSchema, type PluginConfig } from "../../packages/contracts/src/index.js";
import { browserEvidenceRecipeOf } from "../../packages/broker/src/local/isolation/browser-evidence-setting.js";
import { BROWSER_EVIDENCE_CALLBACK_ACTION, refuseBrowserEvidenceOnCloud } from "../../packages/broker/src/aws/browser-evidence-seam.js";

const RECIPE = { startCommand: "npm run start", port: 4321, readyPath: "/health", framework: "nextjs", routes: [{ path: "/checkout", files: ["src/checkout/**"] }], mask: [".account"] };
const config = (projectSettings: unknown) => PluginConfigSchema.parse({ version: 1, plugins: [], projectSettings });

describe("the laptop setting", () => {
  it("is the project's own recipe in the owner's config, as the owner wrote it", () => {
    expect(browserEvidenceRecipeOf(config({ "my-app": { browserEvidence: RECIPE } }), "my-app")).toEqual(RECIPE);
  });

  it("is off for every other case: no config, no settings, no entry, no recipe, no project name, another project", () => {
    const given = config({ "my-app": { browserEvidence: RECIPE }, "quiet-app": { sandboxModelHosts: "deny" }, "empty-app": {} });
    for (const [settings, project] of [[undefined, "my-app"], [{}, "my-app"], [given, undefined], [given, "quiet-app"], [given, "empty-app"], [given, "other"], [given, ""]] as const) {
      expect(browserEvidenceRecipeOf(settings as Pick<PluginConfig, "projectSettings"> | undefined, project), String(project)).toBeUndefined();
    }
    expect(browserEvidenceRecipeOf(undefined, "my-app")).toBeUndefined();
  });

  it("is read fail-closed: a value the schema refuses (even from an object that never went through the config parser) is no recipe, and nothing is repaired", () => {
    const bad = [{ ...RECIPE, port: 80 }, { ...RECIPE, extra: true }, { ...RECIPE, startCommand: "a\nb" }, { ...RECIPE, routes: [{ path: "https://evil.example/", files: ["x"] }] }, { ...RECIPE, startCommand: "" }, "npm start", 5, null, [], { }];
    for (const recipe of bad) expect(browserEvidenceRecipeOf({ projectSettings: { "my-app": { browserEvidence: recipe } } } as unknown as Pick<PluginConfig, "projectSettings">, "my-app"), JSON.stringify(recipe)).toBeUndefined();
    // The config parser itself refuses the same values, so a mistake is found when the file is read.
    for (const recipe of bad.slice(0, 5)) expect(PluginConfigSchema.safeParse({ version: 1, plugins: [], projectSettings: { "my-app": { browserEvidence: recipe } } }).success, JSON.stringify(recipe)).toBe(false);
    // Only an own key counts: nothing is read through the prototype.
    const inherited = Object.create({ "my-app": { browserEvidence: RECIPE } }) as Pick<PluginConfig, "projectSettings">["projectSettings"];
    expect(browserEvidenceRecipeOf({ projectSettings: inherited }, "my-app")).toBeUndefined();
    const sneaky = { projectSettings: { "my-app": Object.create({ browserEvidence: RECIPE }) as object } } as unknown as Pick<PluginConfig, "projectSettings">;
    expect(browserEvidenceRecipeOf(sneaky, "my-app")).toBeUndefined();
    const throwing = { get projectSettings(): never { throw new Error("boom"); } } as Pick<PluginConfig, "projectSettings">;
    expect(browserEvidenceRecipeOf(throwing, "my-app")).toBeUndefined();
  });
});

describe("Cloud", () => {
  it("answers the browser-evidence callback with one fixed sentence and lets every other action pass", () => {
    expect(BROWSER_EVIDENCE_CALLBACK_ACTION).toBe("browser-evidence");
    expect(() => refuseBrowserEvidenceOnCloud("browser-evidence")).toThrow(BROWSER_EVIDENCE_NOT_ON_CLOUD);
    try { refuseBrowserEvidenceOnCloud("browser-evidence"); } catch (error) { expect(error).toMatchObject({ code: "NOT_FOUND" }); }
    // Slice 3: the sign-in action is refused with the same sentence, and nothing near its name passes for it.
    expect(() => refuseBrowserEvidenceOnCloud("browser-evidence-sign-in")).toThrow(BROWSER_EVIDENCE_NOT_ON_CLOUD);
    for (const action of ["events", "artifacts", "result", "e2e-evidence", "browser-evidence2", "browser-evidence-sign-in2", "browser-evidence-sign", ""]) expect(() => refuseBrowserEvidenceOnCloud(action), action).not.toThrow();
  });
  it("is wired into Cloud's callback route before the capability is judged (the route is listed and the refusal is called)", () => {
    const source = readFileSync("packages/broker/src/aws/broker.ts", "utf8");
    // D1-2: the old workflow engine's callbacks (e2e-evidence and the others) are gone from the route; browser-evidence is still listed.
    expect(source).toContain("|result|browser-evidence|");
    expect(source).toMatch(/if \(!token\) throw agentXError\("CALLBACK_FORBIDDEN", "callback capability is required"\); refuseBrowserEvidenceOnCloud\(action\);/u);
  });
});
