// The install page's design system (owner request of 2026-10-01; spec 048 FR-001 and FR-008): the
// type scale, spacing, color tokens for light and dark, and the component classes every screen
// uses. One stylesheet, served from 127.0.0.1 under style-src 'self': no web font, image or CDN.
// Text pairs meet WCAG AA (4.5:1) and field borders and focus 3:1, in both modes
// (tests/contract/init-ui-design.test.ts).

export const BASE_TOKENS: Readonly<Record<string, string>> = {
  "font": "ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, sans-serif",
  "mono": "ui-monospace, SFMono-Regular, Menlo, Consolas, \"Liberation Mono\", monospace",
  "text-xs": ".8125rem",
  "text-sm": ".875rem",
  "text-md": "1rem",
  "text-lg": "1.125rem",
  "text-xl": "1.375rem",
  "text-2xl": "1.75rem",
  "space-1": ".25rem",
  "space-2": ".5rem",
  "space-3": ".75rem",
  "space-4": "1rem",
  "space-5": "1.5rem",
  "space-6": "2rem",
  "space-7": "3rem",
  "radius-sm": "6px",
  "radius": "10px",
  "radius-lg": "14px",
};

export type ColorToken =
  "shadow" | "bg" | "surface" | "surface-2" | "border" | "border-strong" | "field-border" | "text" | "text-2" | "accent" | "accent-hover" | "accent-soft" | "on-accent" | "ok" | "ok-bg" | "wait" | "wait-bg" | "bad" | "bad-bg" | "focus";

export const COLOR_TOKENS: { readonly light: Readonly<Record<ColorToken, string>>; readonly dark: Readonly<Record<ColorToken, string>> } = {
  light: {
    "shadow": "0 1px 2px rgba(16, 24, 40, .06), 0 1px 3px rgba(16, 24, 40, .08)",
    "bg": "#f5f6f8",
    "surface": "#ffffff",
    "surface-2": "#f0f2f5",
    "border": "#dde2e8",
    "border-strong": "#c3cad4",
    "field-border": "#7b8594",
    "text": "#18212c",
    "text-2": "#4b5666",
    "accent": "#2b55c9",
    "accent-hover": "#2348ad",
    "accent-soft": "#e8eefc",
    "on-accent": "#ffffff",
    "ok": "#1d7044",
    "ok-bg": "#e5f3ea",
    "wait": "#8a4f00",
    "wait-bg": "#fdf0d9",
    "bad": "#b42318",
    "bad-bg": "#fdecea",
    "focus": "#2b55c9",
  },
  dark: {
    "shadow": "0 1px 2px rgba(0, 0, 0, .4)",
    "bg": "#0e1318",
    "surface": "#151b23",
    "surface-2": "#1c242f",
    "border": "#2a3441",
    "border-strong": "#3a4656",
    "field-border": "#6f7b8c",
    "text": "#e6eaf0",
    "text-2": "#a9b3c1",
    "accent": "#86a8ff",
    "accent-hover": "#a3bdff",
    "accent-soft": "#1b2744",
    "on-accent": "#0b1220",
    "ok": "#63cf92",
    "ok-bg": "#11301f",
    "wait": "#f2b65e",
    "wait-bg": "#33250d",
    "bad": "#ff8f85",
    "bad-bg": "#3b1613",
    "focus": "#86a8ff",
  },
};

/** Every class the page's HTML and module may use; Task 16's test holds them to this list. */
export const PAGE_CLASSES = [
  "top", "time-left", "layout", "rail", "phase", "phase-title", "phase-status", "phase-time", "steps", "step", "elapsed", "step-of",
  "card", "status", "question", "why", "hint", "note", "error", "field", "field-label", "choices", "buttons", "button", "primary",
  "command", "checks", "chip", "hidden",
  "recommended", "advanced", "group", "field-link",
  "done", "now", "waiting", "coming", "stopped", "running", "ok", "failed", "info", "pending", "skipped",
] as const;

const block = (tokens: Readonly<Record<string, string>>, indent: string): string =>
  Object.entries(tokens).map(([name, value]) => `${indent}--${name}: ${value};`).join("\n");

const COMPONENTS = `* { box-sizing: border-box; }
body { background: var(--bg); color: var(--text); font: var(--text-md)/1.55 var(--font); margin: 0; }
.hidden { display: none !important; }
.sr-only { clip: rect(0 0 0 0); height: 1px; overflow: hidden; position: absolute; white-space: nowrap; width: 1px; }
.top { align-items: center; background: var(--surface); border-bottom: 1px solid var(--border); display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-5); justify-content: space-between; padding: var(--space-3) var(--space-5); }
.top h1 { font-size: var(--text-lg); font-weight: 650; letter-spacing: -.01em; margin: 0; }
.top p { color: var(--text-2); font-size: var(--text-sm); margin: 0; }
.time-left { background: var(--accent-soft); border-radius: 999px; color: var(--text) !important; font-weight: 600; padding: var(--space-1) var(--space-3); }
.layout > * { min-width: 0; }
.layout { display: grid; gap: var(--space-5); grid-template-columns: 1fr; margin: 0 auto; max-width: 70rem; padding: var(--space-5); }
@media (min-width: 52rem) { .layout { gap: var(--space-6); grid-template-columns: 16rem minmax(0, 1fr); } .rail { position: sticky; top: var(--space-5); align-self: start; } }
.rail ol { counter-reset: phase; list-style: none; margin: 0; padding: 0; }
.rail li.phase { border-radius: var(--radius); counter-increment: phase; margin-bottom: var(--space-1); padding: var(--space-3) var(--space-3) var(--space-3) 3rem; position: relative; }
.rail li.phase::before { align-items: center; background: var(--surface); border: 2px solid var(--border-strong); border-radius: 50%; color: var(--text-2); content: counter(phase); display: flex; font-size: var(--text-sm); font-weight: 650; height: 1.75rem; justify-content: center; left: var(--space-3); position: absolute; top: var(--space-3); width: 1.75rem; }
.rail li.phase.done::before { background: var(--ok); border-color: var(--ok); color: var(--surface); content: "\\2713"; }
.rail li.phase.now, .rail li.phase.waiting, .rail li.phase.stopped { background: var(--surface); box-shadow: var(--shadow); }
.rail li.phase.now::before, .rail li.phase.waiting::before { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
.rail li.phase.stopped::before { background: var(--bad); border-color: var(--bad); color: var(--surface); content: "!"; }
.phase-title { display: block; font-weight: 600; }
.phase-time { color: var(--text-2); display: block; font-size: var(--text-xs); }
.chip, .phase-status { border-radius: 999px; display: inline-block; font-size: var(--text-xs); font-weight: 600; line-height: 1.4; margin-top: var(--space-1); padding: .1rem var(--space-2); }
.phase.done .phase-status, .chip.ok { background: var(--ok-bg); color: var(--ok); }
.phase.now .phase-status, .chip.now { background: var(--accent-soft); color: var(--accent); }
.phase.waiting .phase-status, .chip.waiting { background: var(--wait-bg); color: var(--wait); }
.phase.stopped .phase-status, .chip.failed { background: var(--bad-bg); color: var(--bad); }
.phase.coming .phase-status, .chip.coming { background: var(--surface-2); color: var(--text-2); }
.rail ul.steps { font-size: var(--text-sm); list-style: none; margin: var(--space-2) 0 0; padding: 0; }
.rail ul.steps li { color: var(--text-2); padding: .15rem 0; }
.rail ul.steps li.running, .rail ul.steps li.waiting { color: var(--text); font-weight: 600; }
.rail ul.steps li.failed { color: var(--bad); font-weight: 600; }
.rail .step.pending, .rail .step.done, .rail .step.skipped { color: var(--text-2); }
.elapsed { color: var(--text-2); font-weight: 400; }
.rail details { color: var(--text-2); font-size: var(--text-sm); margin-top: var(--space-1); }
.step-of { color: var(--text-2); font-size: var(--text-sm); font-weight: 600; letter-spacing: .02em; margin: 0 0 var(--space-3); }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow); margin-bottom: var(--space-4); padding: var(--space-5); }
.card h2 { font-size: var(--text-lg); font-weight: 650; margin: 0 0 var(--space-2); }
.card h3 { color: var(--text-2); font-size: var(--text-sm); font-weight: 650; margin: var(--space-4) 0 var(--space-1); }
.card p { margin: 0 0 var(--space-2); }
.card.status { border-left-width: 4px; }
.card.status.ok { border-left-color: var(--ok); }
.card.status.waiting { border-left-color: var(--wait); }
.card.status.running, .card.status.info { border-left-color: var(--accent); }
.card.status.failed { background: var(--bad-bg); border-color: var(--bad); border-left-color: var(--bad); }
.question { border-color: var(--border-strong); }
.question h2 { font-size: var(--text-xl); font-weight: 650; letter-spacing: -.01em; line-height: 1.3; }
.why { color: var(--text-2); margin: 0 0 var(--space-3); }
.hint, .note { color: var(--text-2); font-size: var(--text-sm); margin: var(--space-1) 0 0; }
.error { color: var(--bad); font-size: var(--text-sm); font-weight: 600; margin: var(--space-2) 0 0; }
.field { margin-bottom: var(--space-4); }
.field-label { display: block; font-weight: 600; margin-bottom: var(--space-1); }
input[type=text], input[type=password], textarea { background: var(--surface); border: 1px solid var(--field-border); border-radius: var(--radius-sm); color: var(--text); font: inherit; min-height: 2.75rem; padding: var(--space-2) var(--space-3); width: 100%; }
input[aria-invalid=true] { border-color: var(--bad); }
textarea { font-family: var(--mono); font-size: var(--text-sm); min-height: 8rem; }
.choices { display: grid; gap: var(--space-2); margin-bottom: var(--space-3); }
.choices label { align-items: flex-start; border: 1px solid var(--field-border); border-radius: var(--radius); cursor: pointer; display: flex; gap: var(--space-3); padding: var(--space-3); }
.choices label:has(input:checked) { background: var(--accent-soft); border-color: var(--accent); }
.choices input { accent-color: var(--accent); margin-top: .3rem; }
.recommended { background: var(--accent-soft); border-radius: var(--radius); padding: var(--space-4) var(--space-5); margin: 0 0 var(--space-5); }
.recommended h3 { font-size: var(--text-lg); margin: 0 0 var(--space-2); }
.recommended ul { margin: 0; padding-left: var(--space-5); }
.advanced { border-top: 1px solid var(--border); margin-top: var(--space-5); padding-top: var(--space-4); }
.advanced > summary { cursor: pointer; font-weight: 600; min-height: 2.75rem; display: flex; align-items: center; }
.group { border: 1px solid var(--border); border-radius: var(--radius); padding: var(--space-3) var(--space-4); margin: var(--space-4) 0; }
.group legend { font-weight: 600; padding: 0 var(--space-2); }
.field select { min-height: 2.75rem; width: 100%; border: 1px solid var(--field-border); border-radius: var(--radius-sm); background: var(--surface); color: var(--text); padding: 0 var(--space-3); font: inherit; }
.field select:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.field-link { color: var(--accent); }
.buttons { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-top: var(--space-4); }
#failure-actions + details, .buttons + details { margin-top: var(--space-4); }
button, a.button { align-items: center; background: var(--surface); border: 1px solid var(--field-border); border-radius: var(--radius-sm); color: var(--text); cursor: pointer; display: inline-flex; font: inherit; font-weight: 600; gap: var(--space-2); min-height: 2.75rem; padding: var(--space-2) var(--space-4); text-decoration: none; }
button:hover, a.button:hover { background: var(--surface-2); }
button.primary, a.button.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
button.primary:hover, a.button.primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
button[disabled] { cursor: progress; opacity: .6; }
a { color: var(--accent); }
:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
details > summary { color: var(--accent); cursor: pointer; font-weight: 600; }
pre { background: var(--surface-2); border-radius: var(--radius-sm); font: var(--text-xs)/1.5 var(--mono); margin: var(--space-2) 0 0; max-height: 26rem; overflow: auto; padding: var(--space-3); white-space: pre-wrap; word-break: break-word; }
ul.checks { list-style: none; margin: var(--space-3) 0 0; padding: 0; }
ul.checks li { border-top: 1px solid var(--border); padding: var(--space-2) 0; }
ul.checks li.ok::first-letter { color: var(--ok); }
ul.checks li.failed { color: var(--bad); font-weight: 600; }
.command { align-items: center; background: var(--surface-2); border-radius: var(--radius-sm); display: flex; flex-wrap: wrap; gap: var(--space-2); margin: var(--space-2) 0; padding: var(--space-2) var(--space-3); }
.command span { font-size: var(--text-sm); font-weight: 600; }
.command code { flex: 1 1 16rem; font: var(--text-sm) var(--mono); word-break: break-all; }
.command button { min-height: 2.25rem; padding: var(--space-1) var(--space-3); }
@media (prefers-reduced-motion: no-preference) { button, a.button, .choices label { transition: background-color .15s, border-color .15s; } }
@media (max-width: 51.99rem) {
  .rail ol { display: flex; gap: var(--space-2); overflow-x: auto; padding-bottom: var(--space-1); }
  .rail li.phase { flex: 0 0 auto; margin: 0; min-width: 9.5rem; }
  .rail .phase-time, .rail ul.steps, .rail details { display: none; }
}
.top p { overflow-wrap: anywhere; }
@media (max-width: 30rem) { .top { padding: var(--space-3); } .layout { padding: var(--space-3); } .card { padding: var(--space-4); } .buttons > * { flex: 1 1 100%; justify-content: center; } }
`;

export const WIZARD_CSS = `:root {
  color-scheme: light dark;
${block(BASE_TOKENS, "  ")}
${block(COLOR_TOKENS.light, "  ")}
}
@media (prefers-color-scheme: dark) {
  :root {
${block(COLOR_TOKENS.dark, "    ")}
  }
}
${COMPONENTS}`;
