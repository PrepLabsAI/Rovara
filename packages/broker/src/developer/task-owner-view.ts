// Web task channel (Q7): who owns a task, as the task view says it, so a client (Cloud) never has to guess the owner from the People list. The owner is the task's own person: the sign-in id
// the task was started under and the name it was started with (cleaned and capped like a People name). A record whose id is not a person's (the system owner of an automatic run) or that has no readable name shows no
// owner, never a made-up one. Read from the stored task record only, never from the request.
import { emailSafeName, isSystemOwnerId, redactAndCap, withoutEmailAddresses } from "@agentx/contracts";

export const TASK_OWNER_UNNAMED = "Unnamed member";
/** A person id as the hosted core keeps it (a 64-hex sign-in id there; a laptop owner has a short name). A system owner's id (`sysowner_...`) fits that shape but is no person: no owner shown. */
const PERSON_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export interface TaskOwnerView { developerId: string; name: string }

/** Addresses are hidden first and the cap comes last, so a cut can never leave half an address behind; a secret-shaped word is redacted either way. */
function capName(value: string): string | undefined {
  // `emailSafeName` cuts at 80 before it looks for an address, so the addresses go first, on a bounded slice.
  return emailSafeName(redactAndCap(withoutEmailAddresses(value.slice(0, 400)), 80).text);
}

export function taskOwnerView(task: { developerId?: unknown; developerName?: unknown }): TaskOwnerView | undefined {
  if (typeof task.developerId !== "string" || !PERSON_ID.test(task.developerId) || isSystemOwnerId(task.developerId)) return undefined;
  const name = typeof task.developerName === "string" ? capName(task.developerName) : undefined;
  return { developerId: task.developerId, name: name ?? TASK_OWNER_UNNAMED };
}
