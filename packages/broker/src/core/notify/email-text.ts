// The words of an attention email (lane P4; the hosted product's `attentionEmail`). The core writes every word: the tasks (title, status sentence, link), how to change the setting and how to stop these
// emails. Nothing else: no task content beyond the title, no secret, no address but the recipient's own (the adapter puts it in the envelope).
import { EMAIL_BODY_MAX_BYTES, EMAIL_SUBJECT_MAX } from "@agentx/contracts";

export interface EmailLine { title: string; status: string; link?: string | undefined; /** `upkeep_paused` for a nightly upkeep notice and `setup_broken` for a repair notice (a project, not a task). */ kind?: string | undefined }

/** Links the surface that serves the pages supplies; each must be a plain https link or it is left out. */
export interface AttentionEmailLinks {
  /** Where the person changes how they are told. */
  settings?: string | undefined;
  /** A link that stops these emails (also the mail client's own unsubscribe offer). */
  unsubscribe?: string | undefined;
  /** The page that lists everything waiting (shown with "and N more"). */
  home?: string | undefined;
}

/** A link as an email carries it: a plain https link without a user name, or undefined. */
export function plainHttpsLink(value: string | undefined): string | undefined {
  if (value === undefined || value.length > 2_000 || /[\s<>\p{Cc}]/u.test(value)) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export type AttentionEmailKind = "attention" | "done" | "digest" | "notice";

export function attentionEmail(lines: readonly EmailLine[], more: number, kind: AttentionEmailKind, links: AttentionEmailLinks = {}): { subject: string; text: string; unsubscribeUrl?: string } {
  const count = lines.length + more;
  const upkeepOnly = lines.filter((line) => line.kind === "upkeep_paused").length;
  const setupOnly = lines.filter((line) => line.kind === "setup_broken").length;
  const upkeep = upkeepOnly + setupOnly;
  const onlyUpkeep = upkeepOnly > 0 && upkeepOnly === lines.length && more === 0;
  const onlySetup = setupOnly > 0 && setupOnly === lines.length && more === 0;
  const tasks = `${String(count)} ${upkeep > 0 ? (count === 1 ? "item" : "items") : count === 1 ? "task" : "tasks"}`;
  const subject = kind === "notice" ? "Rovara: a notice for you" : kind === "digest" ? `Rovara digest: ${tasks}` : kind === "done" ? `Rovara: ${tasks} finished` : onlyUpkeep ? "Rovara: nightly upkeep needs your attention" : onlySetup ? "Rovara: a project's setup needs your attention" : `Rovara: ${tasks} ${count === 1 ? "needs" : "need"} your attention`;
  const heading = kind === "notice" ? "A notice from Rovara:" : kind === "digest" ? "Your Rovara digest:" : kind === "done" ? (count === 1 ? "A task finished in Rovara:" : "These tasks finished in Rovara:") : onlyUpkeep ? "Nightly upkeep needs your attention in Rovara:" : onlySetup ? "A project's setup needs your attention in Rovara:" : upkeep > 0 ? "These items need your attention in Rovara:" : count === 1 ? "A task needs your attention in Rovara:" : "These tasks need your attention in Rovara:";
  const home = plainHttpsLink(links.home), settings = plainHttpsLink(links.settings), unsubscribe = plainHttpsLink(links.unsubscribe);
  const tail = [
    "",
    ...(settings === undefined ? [] : [`Change how you're notified: ${settings}`]),
    ...(unsubscribe === undefined ? [] : [`Stop these emails: ${unsubscribe}`]),
  ];
  const body = [
    heading,
    "",
    ...lines.flatMap((line) => { const link = plainHttpsLink(line.link); return [`- ${line.title}: ${line.status}`, ...(link === undefined ? [] : [`  ${link}`])]; }),
    ...(more > 0 ? [`- and ${String(more)} more${home === undefined ? "" : `: ${home}`}`] : []),
  ].join("\n");
  // The body is cut to the port's limit with the links to change or stop kept whole.
  const end = tail.length > 1 ? tail.join("\n") : "";
  const room = EMAIL_BODY_MAX_BYTES - new TextEncoder().encode(end).length - 8;
  let text = body;
  while (new TextEncoder().encode(text).length > room) text = `${[...text].slice(0, Math.floor([...text].length * 0.9)).join("")}…`;
  return { subject: [...subject].slice(0, EMAIL_SUBJECT_MAX).join(""), text: `${text}${end === "" ? "" : `\n${end}`}`, ...(unsubscribe === undefined ? {} : { unsubscribeUrl: unsubscribe }) };
}
