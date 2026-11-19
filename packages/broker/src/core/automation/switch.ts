// Automation (chains, triggers, automatic runs, custom agents) is built in the core but kept hidden: it starts paid work with no person present, so it is off until the owner of the install switches it on.
//
// The switch is not a stored setting that a route, an assistant's tool or a script token can change. The install reads it once, when `rovara up` starts (the owner's own act: an option or the
// environment of the process that runs it), and hands the core this seam. Off, nothing in this folder runs: no schedule is subscribed, no hook is answered, no route or page is mounted, and the
// commands answer as they did before the feature existed. A hosted product fills the same seam from its own deployment's flag.
import { agentXError } from "@agentx/contracts";

/** Whether automation is on for this install. Read on every use, so a product whose flag can change does not need a restart. */
export interface AutomationSwitch {
  enabled(): boolean | Promise<boolean>;
}

/** The default: off. */
export const AUTOMATION_OFF: AutomationSwitch = { enabled: () => false };

/** A switch that holds the value it was built with (what `rovara up` builds from the owner's option). */
export function fixedAutomationSwitch(on: boolean): AutomationSwitch {
  return { enabled: () => on };
}

/** The words every surface uses while automation is off: the same as for any feature this install does not have. */
export const AUTOMATION_OFF_MESSAGE = "That is not on this install yet: Rovara on this computer does not do it. It comes with a later release.";

/** True only when the switch says on. A switch that throws is off: a doubt never starts paid work. */
export async function automationIsOn(automation: AutomationSwitch | undefined): Promise<boolean> {
  if (automation === undefined) return false;
  try {
    return (await automation.enabled()) === true;
  } catch {
    return false;
  }
}

/** The refusal an entry point gives while automation is off (the same answer as an unknown route's feature note, so an off install shows nothing new). */
export async function requireAutomation(automation: AutomationSwitch | undefined): Promise<void> {
  if (!(await automationIsOn(automation))) throw agentXError("NOT_AVAILABLE_HERE", AUTOMATION_OFF_MESSAGE);
}
