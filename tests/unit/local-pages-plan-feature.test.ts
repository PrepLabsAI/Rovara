// Lead 4 PCF on the laptop's plan page: the feature line of a waiting coding plan, the owner's "Change" and "No feature" forms, what each form may send (a feature id of this shape, or none), the token bound to
// which form was drawn (one form cannot be replayed as the other), and the same line drawn for a reader who may not change it (no form).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalPagesServer, type LocalPagesServer } from "../../packages/broker/src/core/local-pages/index.js";
import { TASK, fakeWorld, formBody, planView, raw, type FakeWorld } from "../support/local-pages-fakes.js";

let server: LocalPagesServer;
let world: FakeWorld;
let base: string;
const FT_ONE = `ft_${"1".repeat(20)}`, FT_TWO = `ft_${"2".repeat(20)}`;

beforeEach(async () => {
  world = fakeWorld();
  server = await createLocalPagesServer({ data: world.data, actions: world.actions });
  base = `/s/${server.sessions.mint().token}`;
});
afterEach(async () => { await server.close(); });

const host = () => new URL(server.origin).host;
const get = (path: string) => raw(server.origin, { path, headers: { host: host() } });
const post = (path: string, fields: Record<string, string>) => raw(server.origin, { method: "POST", path, body: formBody(fields), headers: { host: host(), origin: server.origin, "content-type": "application/x-www-form-urlencoded" } });
const decode = (text: string) => text.replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
/** Every form whose action ends `/feature`, as drawn now (each draw makes fresh tokens): its fields, hidden and the first select's name. */
async function featureForms() {
  const page = (await get(`${base}/plan/${TASK}`)).body;
  return [...page.matchAll(/<form[^>]*action="([^"]+\/feature)"[^>]*>([\s\S]*?)<\/form>/g)].map((match) => {
    const fields: Record<string, string> = {};
    for (const input of (match[2] ?? "").matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) fields[decode(input[1] ?? "")] = decode(input[2] ?? "");
    return { action: decode(match[1] ?? ""), fields, html: match[2] ?? "" };
  });
}
const feature = (over: Partial<NonNullable<ReturnType<typeof planView>["feature"]>> = {}) => ({ line: "Feature: Checkout v2 (from the Linear parent)", featureId: FT_ONE, canChange: true, choices: [{ id: FT_ONE, name: "Checkout v2" }, { id: FT_TWO, name: "Billing" }], ...over });

describe("the plan page's feature line", () => {

  it("a reader who may not change it sees the line and no form; a page with no feature view has no section", async () => {
    world.data.plan = planView({ feature: feature({ canChange: false, choices: [] }) });
    const page = (await get(`${base}/plan/${TASK}`)).body;
    expect(page).toContain("Feature: Checkout v2");
    expect(await featureForms()).toHaveLength(0);
    world.data.plan = planView();
    expect((await get(`${base}/plan/${TASK}`)).body).not.toContain("plan-feature");
  });
});

describe("the plan page's feature forms", () => {
  beforeEach(() => { world.data.plan = planView({ feature: feature() }); });

  it("Change sends the chosen feature id with the revision the person read; No feature sends null", async () => {
    let [pick] = await featureForms();
    const changed = await post(pick!.action, { ...pick!.fields, feature: FT_TWO });
    expect(changed.status).toBe(303);
    expect(String(changed.headers.location)).toContain("n=featured");
    expect(world.actions.calls.filter((call) => call.name === "planFeature").at(-1)?.input).toEqual({ taskId: TASK, revision: 3, featureId: FT_TWO });
    const [, none] = await featureForms();
    expect((await post(none!.action, none!.fields)).status).toBe(303);
    expect(world.actions.calls.filter((call) => call.name === "planFeature").at(-1)?.input).toEqual({ taskId: TASK, revision: 3, featureId: null });
    // the notice is a fixed sentence
    const after = (await get(`${base}/plan/${TASK}?n=featured`)).body;
    expect(after).toContain("The feature is saved.");
    [pick] = await featureForms();
    expect(pick).toBeDefined();
  });

  it("the form's token is for the form that was drawn: the Change token cannot send None, the None token cannot send a feature, and a token works once", async () => {
    const [pick, none] = await featureForms();
    const before = world.actions.calls.length;
    const asNone = await post(pick!.action, { ...pick!.fields, feature: "none" });
    expect(String(asNone.headers.location)).toContain("n=form");
    const asPick = await post(none!.action, { ...none!.fields, feature: FT_TWO });
    expect(String(asPick.headers.location)).toContain("n=form");
    expect(world.actions.calls.length).toBe(before);
    const fresh = (await featureForms())[0]!;
    expect(String((await post(fresh.action, { ...fresh.fields, feature: FT_ONE })).headers.location)).toContain("n=featured");
    expect(String((await post(fresh.action, { ...fresh.fields, feature: FT_ONE })).headers.location)).toContain("n=form");
  });

  it("refuses a feature value that is not an id or none, and a revision that is not a number, without calling the action", async () => {
    const [pick] = await featureForms();
    const before = world.actions.calls.length;
    for (const [feature_, revision] of [["", "3"], ["ft_short", "3"], ["../x", "3"], [FT_ONE.toUpperCase(), "3"], [FT_ONE, "three"], [`${FT_ONE} `, "3"]] as const) {
      const answer = await post(pick!.action, { ...pick!.fields, feature: feature_, revision });
      expect(String(answer.headers.location), `${feature_}|${revision}`).toContain("n=invalid");
    }
    expect(world.actions.calls.length).toBe(before);
  });
});
