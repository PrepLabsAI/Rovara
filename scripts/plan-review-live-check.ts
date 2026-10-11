// The live check for deciding and commenting on the task page (spec 061 slice 2). It reads one deployed task page, and
// the page's state answer, as the signed-in reader, checks what can be checked from the page itself (the phone layout
// rules, the page script, controls hidden until it runs, a state answer with no names or text), then prints the
// hands-on list for a person to try on real phones and record in the slice's record file.
//
//   AGENTX_REVIEW_SESSION=<value of the __Host-agentx_review_session cookie> \
//     npx tsx scripts/plan-review-live-check.ts --page "https://<api>/review/<task ID>/task"
//
// Open the page from the task's Slack card first, as the task owner, so the sign-in is a review sign-in for that task.
// The cookie is read from the environment only and is never printed.
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

export interface LiveCheckResult { name: string; ok: boolean }

/** The style rules, squeezed of spaces, so a check does not depend on how the page formats them. */
function styles(html: string): string {
  return [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((match) => match[1]).join("").replace(/\s+/g, "");
}

/** What the page itself must carry for a phone and for its script, checked from the HTML the reader was served. */
export function pageChecks(html: string): LiveCheckResult[] {
  const css = styles(html);
  const viewport = /<meta name="viewport" content="([^"]*)">/.exec(html)?.[1]?.replace(/\s+/g, "") ?? "";
  const buttons = [...html.matchAll(/<button\b([^>]*)>(Approve|Request changes|Comment|Reply|Edit|Delete)<\/button>/g)];
  return [
    { name: "fits a phone screen", ok: viewport.includes("width=device-width") && viewport.includes("viewport-fit=cover") },
    { name: "the decide bar clears the home indicator", ok: css.includes("env(safe-area-inset-bottom)") },
    { name: "controls are thumb-sized", ok: css.includes("min-height:2.75rem") },
    { name: "the dialog is full screen on a phone", ok: /@media\(max-width:35rem\)\{dialog\{[^}]*width:100vw/.test(css) },
    { name: "long words wrap", ok: css.includes("overflow-wrap:anywhere") },
    { name: "the page script is on the page", ok: html.includes('id="agentx-page-data"') && (html.match(/<script nonce="/g) ?? []).length >= 2 },
    { name: "the controls are hidden until the script runs", ok: buttons.length > 0 && buttons.every((match) => /\bhidden\b/.test(match[1] ?? "")) },
  ];
}

const STATE_KEYS = new Set(["revision", "waiting", "stage", "documents", "commentSeq", "csrf"]);

/** The page's state answer (`api/state`): where the task stands and a fresh token, and nothing else. */
export function stateChecks(state: Record<string, unknown>): LiveCheckResult[] {
  return [
    { name: "says where the task stands", ok: typeof state.revision === "number" && typeof state.waiting === "boolean" && typeof state.stage === "string" && Array.isArray(state.documents) },
    { name: "carries a fresh token", ok: typeof state.csrf === "string" && /^[A-Za-z0-9_-]{32,64}$/.test(state.csrf) },
    { name: "carries only where the task stands", ok: Object.keys(state).every((key) => STATE_KEYS.has(key)) },
  ];
}

/** What a person tries by hand and records: each needs a real phone, a screen reader or a second person. */
export const LIVE_CHECKLIST: readonly string[] = [
  "iPhone, in Slack's in-app browser, at 390 px wide: answer a decision, post a comment with Ask AgentX to answer ticked, and Approve. Nothing scrolls sideways.",
  "Android in dark mode: the page, the comment threads and the Approve dialog are readable, and the bar sits above the system buttons.",
  "Keyboard only, on a laptop: Tab to the answers, pick one with the arrow keys, open Approve, and send it with Enter. Focus returns to the button after Cancel.",
  "VoiceOver on iPhone: the Approve dialog's title, its sections and the Send button are read out, and errors are announced.",
  "A second person in the channel opens the same page: they can comment and press Suggest this, the owner sees their suggestion, and they cannot approve.",
  "The Full path with one Request changes: requirements, design and coding plan, with one Request changes sending two comments; the next version shows AgentX's answer under each, and the card says how many it answered.",
];

/** The --page link, checked: https only (the review cookie is sent with every request) and a task page path. */
export function taskPageLink(value: string): URL {
  const page = new URL(value);
  if (page.protocol !== "https:") throw new Error("--page must be an https link: the review cookie is sent with every request");
  if (!/^\/review\/[0-9a-f-]{36}\/task$/i.test(page.pathname)) throw new Error("--page must be a task page link: https://<api>/review/<task ID>/task");
  return page;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { page: { type: "string" } } });
  const session = process.env.AGENTX_REVIEW_SESSION;
  if (values.page === undefined || session === undefined || session === "") {
    throw new Error("usage: AGENTX_REVIEW_SESSION=<review cookie> npx tsx scripts/plan-review-live-check.ts --page https://<api>/review/<task ID>/task");
  }
  const page = taskPageLink(values.page);
  const cookie = `__Host-agentx_review_session=${session}`;
  const served = await fetch(page, { headers: { cookie }, redirect: "manual" });
  if (served.status !== 200) throw new Error(`the task page answered ${served.status}; open it from the task's Slack card first, then copy the review cookie again`);
  const results = pageChecks(await served.text());
  const state = await fetch(new URL(`${page.pathname}/api/state`, page), { headers: { cookie } });
  if (state.status === 200) results.push(...stateChecks(await state.json() as Record<string, unknown>));
  else results.push({ name: `the page's state answer (it answered ${state.status})`, ok: false });
  for (const result of results) process.stdout.write(`${result.ok ? "ok  " : "FAIL"} ${result.name}\n`);
  process.stdout.write("\nTry by hand, and record each in the slice's record file:\n");
  for (const item of LIVE_CHECKLIST) process.stdout.write(`- [ ] ${item}\n`);
  if (results.some((result) => !result.ok)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`live check failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
