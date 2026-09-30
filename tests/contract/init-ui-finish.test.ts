// Spec 040 phase 3: each finishing step on the install page. The steps are the ones agentx init
// already runs (phase 15d2); these tests check what each shows on the page, and that a wait that
// fails can be tried again there, while the terminal path stops exactly as it did.
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { agentXError } from "@agentx/contracts";
import { writeEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { adminUserStep } from "../../packages/cli/src/init/finish-steps.js";
import type { WizardCard } from "../../packages/cli/src/init/ui/protocol.js";
import { initContext, progressHandle, scriptedPrompter, type TestInitContext } from "../support/init-fakes.js";
import { ADMIN_EMAIL, CONTROL_PLANE, fakeCognito, setupServices, STAGING_SETTINGS } from "../support/setup-fakes.js";

let context: TestInitContext | undefined;
afterEach(async () => { if (context !== undefined) await rm(context.home, { recursive: true, force: true }); context = undefined; });
const page = () => { const cards: WizardCard[] = []; return { cards, card: (card: WizardCard) => { cards.push(card); } }; };
const session = { controlPlaneUrl: CONTROL_PLANE, accessToken: "t" };
const TIMED_OUT = agentXError("OPERATION_INTERRUPTED", "the AgentX sign-in did not finish within 10 minutes; run agentx init again and finish signing in as the admin user in the browser");

describe("the admin user on the page (FR-050)", () => {
  it("shows the new admin user and the sign-in wait, then who signed in", async () => {
    const surface = page();
    context = initContext({ prompter: scriptedPrompter([ADMIN_EMAIL]), surface, setup: setupServices({ cognito: fakeCognito() }), adminSession: async () => session });
    await writeEnvironmentSettings(context.store, STAGING_SETTINGS);
    expect(await adminUserStep().run(context, progressHandle())).toEqual({ status: "done", note: `admin ${ADMIN_EMAIL}` });
    expect(surface.cards.map((card) => [card.id, card.status, card.lines])).toEqual([
      ["admin", "waiting", [
        `Created your admin user ${ADMIN_EMAIL}. Cognito emailed a temporary password to ${ADMIN_EMAIL}; you choose your own password when you first sign in.`,
        `Sign in to AgentX as ${ADMIN_EMAIL} in the tab the button opens. This page moves on by itself once you have.`,
      ]],
      ["admin", "ok", [`Signed in to AgentX as ${ADMIN_EMAIL}.`]],
    ]);
  });

  it("Review Focus 5: a sign-in that timed out can be tried again on the page", async () => {
    const surface = page();
    let sessions = 0;
    context = initContext({
      prompter: scriptedPrompter([ADMIN_EMAIL, true]), surface, setup: setupServices({ cognito: fakeCognito() }),
      adminSession: async () => { sessions += 1; if (sessions === 1) throw TIMED_OUT; return session; },
    });
    await writeEnvironmentSettings(context.store, STAGING_SETTINGS);
    await adminUserStep().run(context, progressHandle());
    expect(sessions).toBe(2);
    expect((context.prompter as ReturnType<typeof scriptedPrompter>).asked).toEqual(["Your email address, for your AgentX admin user", "Sign in again?"]);
    expect(surface.cards.find((card) => card.status === "failed")?.lines[0]).toBe("the AgentX sign-in did not finish within 10 minutes; run agentx init again and finish signing in as the admin user in the browser");
  });

  it("the terminal path stops on a timed-out sign-in, as before", async () => {
    context = initContext({ prompter: scriptedPrompter([ADMIN_EMAIL]), setup: setupServices({ cognito: fakeCognito() }), adminSession: async () => { throw TIMED_OUT; } });
    await writeEnvironmentSettings(context.store, STAGING_SETTINGS);
    await expect(adminUserStep().run(context, progressHandle())).rejects.toBe(TIMED_OUT);
    expect((context.prompter as ReturnType<typeof scriptedPrompter>).asked).toEqual(["Your email address, for your AgentX admin user"]);
  });
});
