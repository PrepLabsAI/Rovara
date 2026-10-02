// packages/broker/src/developer/change-messages.ts
// Spec 025 E13: the Slack Confirm message and its edited form. The message goes only to the
// planning admin's own linked Slack user, so it shows the effect that names a private channel they
// are a member of when there is one (R4, owner Q7 as extended), else the ID-only effect. The effect
// is already redacted by the broker; it is redacted again and escaped for Slack here, since it can
// quote a channel's name. Pure: no Slack call, no log.
import { ADMIN_CHANGE_CANCEL_ACTION, ADMIN_CHANGE_CONFIRM_ACTION, redactText, type PendingChange } from "@agentx/contracts";

/** Slack's limit on a section block's text. */
const SECTION_MAX = 3_000;
const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const safe = (text: string) => escape(redactText(text));

/** A section within Slack's limit; a cut never leaves half an escape such as `&am`. */
function section(text: string): { type: "section"; text: { type: "mrkdwn"; text: string } } {
  const cut = text.length <= SECTION_MAX ? text : `${text.slice(0, SECTION_MAX - 3).replace(/&[a-z]{0,3}$/, "")}...`;
  return { type: "section", text: { type: "mrkdwn", text: cut } };
}

function minutesLeft(from: number, until: string): string {
  const minutes = Math.max(1, Math.ceil((Date.parse(until) - from) / 60_000));
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

const shownEffect = (change: PendingChange) => safe(change.confirmationEffect ?? change.effect);

export function adminChangeMessage(change: PendingChange, now: number): { text: string; blocks: unknown[] } {
  const intro = "AgentX needs your confirmation for a change you asked for.";
  const effect = shownEffect(change);
  const footer = `It expires in ${minutesLeft(now, change.expiresAt)}. Confirm applies it at once; Cancel drops it.`;
  return {
    text: `${intro}\n\n${effect}\n\n${footer}`,
    blocks: [
      section(intro),
      section(effect),
      section(footer),
      { type: "actions", block_id: "agentx_admin_change", elements: [
        { type: "button", action_id: ADMIN_CHANGE_CONFIRM_ACTION, style: "primary", text: { type: "plain_text", text: "Confirm" }, value: change.changeId },
        { type: "button", action_id: ADMIN_CHANGE_CANCEL_ACTION, text: { type: "plain_text", text: "Cancel" }, value: change.changeId },
      ] },
    ],
  };
}

/** #217: an expired change's message, whether the expiry edit or a later press recorded it. */
export const EXPIRED_OUTCOME = "Expired; nothing was changed. Ask again if you still want it.";

/** #217: the edit at expiry of a change nobody answered: the same text as a recorded expiry, with no buttons. */
export function adminChangeExpiredMessage(change: PendingChange): { text: string; blocks: unknown[] } {
  const effect = shownEffect(change);
  return { text: `${effect}\n\n${EXPIRED_OUTCOME}`, blocks: [section(effect), section(EXPIRED_OUTCOME)] };
}

/** The edited message once the change ended, with no buttons; undefined while it has not ended. */
export function adminChangeOutcomeMessage(change: PendingChange): { text: string; blocks: unknown[] } | undefined {
  let outcome: string;
  switch (change.status) {
    case "applied": outcome = `Applied${change.pressedBy === undefined ? "" : `, confirmed by <@${change.pressedBy}>`}.`; break;
    case "declined": outcome = "Cancelled; nothing was changed."; break;
    case "expired": outcome = EXPIRED_OUTCOME; break;
    case "failed": outcome = `It was not applied: ${safe(change.error?.message ?? "it could not be applied; check the state, then ask again")}`; break;
    default: return undefined;
  }
  const effect = shownEffect(change);
  return { text: `${effect}\n\n${outcome}`, blocks: [section(effect), section(outcome)] };
}
