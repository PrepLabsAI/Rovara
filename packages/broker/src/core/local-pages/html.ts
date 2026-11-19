// Lane L8: the small HTML the local pages are made of. Every value is escaped here; model and reviewer text is redacted first and shown as plain text,
// so a link in it is never a link. There is no script on any page (the policy forbids one), only links and forms.
import { redactText } from "@agentx/contracts";
import { TASK_PAGE_STYLE } from "../../aws/task-page-assets.js";

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" };

/** Text made safe for an element or a quoted attribute. Anything that is not text, a number or a boolean is empty. */
export function esc(value: unknown): string {
  return (typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "").replace(/[&<>"']/g, (character) => ENTITIES[character] ?? character);
}

/** Text from a model, a reviewer or the repository: secrets redacted, then escaped. */
export const untrusted = (value: unknown): string => esc(typeof value === "string" ? redactText(value) : "");

/** A link on a page, only when it is plain https with no credentials (a pull request on the code host). Anything else is shown as text. */
export function externalLink(url: unknown, label: string): string {
  if (typeof url === "string" && url.length <= 2048) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:" && parsed.username === "" && parsed.password === "") return `<a href="${esc(parsed.href)}" rel="noreferrer noopener">${esc(label)}</a>`;
    } catch { /* shown as text */ }
  }
  return esc(label);
}

const EXTRA_STYLE = String.raw`
nav.pages{display:flex;gap:1rem;flex-wrap:wrap;border-bottom:1px solid var(--line);padding-bottom:.5rem;margin-bottom:1rem}
.panel{border:1px solid var(--line);background:var(--panel);border-radius:.5rem;padding:.75rem 1rem;margin:1rem 0}
form.decide{display:grid;gap:.5rem}
textarea{width:100%;min-height:5rem;font:inherit;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:.4rem;padding:.4rem}
button{font:inherit;padding:.4rem .9rem;border-radius:.4rem;border:1px solid var(--line);background:var(--panel);color:var(--fg);cursor:pointer}
button.primary{background:var(--focus);color:#fff;border-color:var(--focus)}
button.danger{border-color:var(--bad);color:var(--bad)}
.row{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center}
.notice{border-left:4px solid var(--warn);padding:.4rem .8rem;background:var(--panel)}
.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}
table{border-collapse:collapse;width:100%}th,td{border:1px solid var(--line);padding:.35rem .5rem;text-align:left;vertical-align:top}
figure{margin:0 0 1rem}figure img{max-width:100%;height:auto;border:1px solid var(--line)}
`;

/** The one policy of every page: its style by nonce, images from this origin only, forms to this origin only, and no script, frame, font or connection at all. */
export const pagePolicy = (nonce: string): string =>
  `default-src 'none'; style-src 'nonce-${nonce}'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;

export function layout(input: { title: string; nonce: string; base: string; body: string; notice?: string }): string {
  return [
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    "<meta name=\"referrer\" content=\"same-origin\"><meta name=\"robots\" content=\"noindex, nofollow\">",
    `<title>${esc(input.title)}</title>`,
    `<style nonce="${esc(input.nonce)}">${TASK_PAGE_STYLE}${EXTRA_STYLE}</style></head><body>`,
    `<nav class="pages" aria-label="Rovara pages"><a href="${esc(input.base)}/">Waiting for you</a><a href="${esc(input.base)}/how-we-work">How we work</a><a href="${esc(input.base)}/lessons">Lessons</a><a href="${esc(input.base)}/tokens">Script tokens</a><a href="${esc(input.base)}/connections">Connections</a><a href="${esc(input.base)}/models">Models</a><a href="${esc(input.base)}/second-review">Second review</a><a href="${esc(input.base)}/chat">Chat</a><a href="${esc(input.base)}/setup">Set up a project</a></nav>`,
    input.notice === undefined ? "" : `<p class="notice" role="status">${esc(input.notice)}</p>`,
    input.body,
    "</body></html>",
  ].join("");
}
