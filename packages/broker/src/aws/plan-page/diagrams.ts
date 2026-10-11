// Diagrams for the task page, drawn on the server from the plan's structured evidence: state machines and schemas
// through Graphviz, call flows by AgentX's own drawing. Every drawing is cleaned and then checked against a short
// allowlist before it goes into the page; anything else leaves only the text alternative.
import { Graphviz } from "@hpcc-js/wasm-graphviz";
import { planDiagramText, redactText, type PlanEvidenceInput } from "@agentx/contracts";
import { escapeHtml } from "../web-session.js";

export type DiagramEvidence = Extract<PlanEvidenceInput, { kind: "flow" | "schema" | "stateMachine" }>;

/** What Graphviz has to offer: its layout call, which returns the drawing as SVG text. */
export interface GraphvizLike { dot(source: string): string }
export interface DiagramOptions { loadGraphviz?: () => Promise<GraphvizLike> }

let sharedGraphviz: Promise<GraphvizLike> | undefined;
/** Graphviz is loaded once per Lambda. A failed load is forgotten, so the next drawing tries again. */
function loadSharedGraphviz(): Promise<GraphvizLike> {
  sharedGraphviz ??= Graphviz.load().catch((error: unknown) => {
    sharedGraphviz = undefined;
    throw error;
  });
  return sharedGraphviz;
}

/** Model text on one line, with secrets removed. */
const oneLine = (value: string): string => redactText(value).replace(/\s+/g, " ").trim();
/** Text for inside a quoted DOT string. */
const dotText = (value: string): string => oneLine(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"");

function stateMachineDot(evidence: Extract<DiagramEvidence, { kind: "stateMachine" }>): string {
  const ids = new Map(evidence.states.map((state, index) => [state, `n${index}`]));
  const lines = ['digraph G {', '  rankdir=LR;', '  graph [fontname="sans-serif"];', '  node [fontname="sans-serif"; shape=ellipse];', '  edge [fontname="sans-serif"];'];
  for (const state of evidence.states) lines.push(`  ${ids.get(state)} [label="${dotText(state)}"];`);
  const initial = evidence.initial === undefined ? undefined : ids.get(evidence.initial);
  if (initial !== undefined) {
    lines.push(`  n${evidence.states.length} [label=""; shape=point];`, `  n${evidence.states.length} -> ${initial};`);
  }
  for (const transition of evidence.transitions) {
    const from = ids.get(transition.from);
    const to = ids.get(transition.to);
    if (from !== undefined && to !== undefined) lines.push(`  ${from} -> ${to} [label="${dotText(transition.label)}"];`);
  }
  lines.push("}");
  return lines.join("\n");
}

function schemaDot(evidence: Extract<DiagramEvidence, { kind: "schema" }>): string {
  const ids = new Map(evidence.entities.map((entity, index) => [entity.name, `n${index}`]));
  const lines = ['digraph G {', '  rankdir=LR;', '  graph [fontname="sans-serif"];', '  node [fontname="sans-serif"; shape=box];', '  edge [fontname="sans-serif"];'];
  for (const entity of evidence.entities) {
    const fields = entity.fields.map((field) => `${oneLine(field.name)}: ${oneLine(field.type)}`);
    const width = Math.min(40, Math.max(oneLine(entity.name).length, ...fields.map((field) => field.length)));
    const label = fields.length === 0
      ? dotText(entity.name)
      : `${dotText(entity.name)}\\n${"-".repeat(width)}\\n${fields.map((field) => `${dotText(field)}\\l`).join("")}`;
    lines.push(`  ${ids.get(entity.name)} [shape=box; label="${label}"];`);
  }
  for (const relation of evidence.relations) {
    const from = ids.get(relation.from);
    const to = ids.get(relation.to);
    if (from !== undefined && to !== undefined) lines.push(`  ${from} -> ${to} [label="${dotText(relation.label)}"];`);
  }
  lines.push("}");
  return lines.join("\n");
}

const COLUMN_WIDTH = 160;
const FIRST_STEP_Y = 64;
const STEP_HEIGHT = 40;
const FLOW_FONT_SIZE = 12;

/** Display text cut to fit its room; the full wording stays in the text alternative. */
function fitted(value: string, room: number): string {
  const characters = Array.from(oneLine(value));
  const most = Math.max(8, Math.floor(room / 6.5));
  return characters.length <= most ? characters.join("") : `${characters.slice(0, most - 1).join("")}…`;
}

/** The call flow as AgentX's own drawing: a column per participant and a numbered arrow per step. */
function flowSvg(evidence: Extract<DiagramEvidence, { kind: "flow" }>): string {
  const columns = new Map(evidence.participants.map((name, index) => [name, COLUMN_WIDTH / 2 + index * COLUMN_WIDTH]));
  const width = evidence.participants.length * COLUMN_WIDTH;
  const height = FIRST_STEP_Y + evidence.steps.length * STEP_HEIGHT;
  const parts: string[] = [`<svg viewBox="0 0 ${width} ${height}">`];
  for (const name of evidence.participants) {
    const x = columns.get(name)!;
    parts.push(
      `<text x="${x}" y="20" text-anchor="middle" font-size="${FLOW_FONT_SIZE}" fill="currentColor">${escapeHtml(fitted(name, COLUMN_WIDTH - 12))}</text>`,
      `<path d="M${x} 32L${x} ${height - 8}" fill="none" stroke="currentColor" stroke-width="1" stroke-dasharray="4 4"/>`,
    );
  }
  evidence.steps.forEach((step, index) => {
    const y = FIRST_STEP_Y + index * STEP_HEIGHT;
    const from = columns.get(step.from);
    const to = columns.get(step.to);
    if (from === undefined || to === undefined) return;
    const label = `${index + 1}. ${step.label}`;
    if (from === to) {
      // The loop goes toward the side with more room, and its label takes that room.
      const side = width - from >= from ? 1 : -1;
      const room = (side === 1 ? width - from : from) - 52;
      parts.push(
        `<path d="M${from} ${y - 12}L${from + side * 40} ${y - 12}L${from + side * 40} ${y}L${from + side * 6} ${y}" fill="none" stroke="currentColor" stroke-width="1.5"/>`,
        `<polygon points="${from + side * 6},${y} ${from + side * 13},${y - 4} ${from + side * 13},${y + 4}" fill="currentColor" stroke="currentColor"/>`,
        `<text x="${from + side * 46}" y="${y - 4}" text-anchor="${side === 1 ? "start" : "end"}" font-size="${FLOW_FONT_SIZE}" fill="currentColor">${escapeHtml(fitted(label, room))}</text>`,
      );
      return;
    }
    const direction = to > from ? 1 : -1;
    parts.push(
      `<path d="M${from} ${y}L${to - direction * 7} ${y}" fill="none" stroke="currentColor" stroke-width="1.5"/>`,
      `<polygon points="${to},${y} ${to - direction * 8},${y - 4} ${to - direction * 8},${y + 4}" fill="currentColor" stroke="currentColor"/>`,
      `<text x="${(from + to) / 2}" y="${y - 6}" text-anchor="middle" font-size="${FLOW_FONT_SIZE}" fill="currentColor">${escapeHtml(fitted(label, Math.abs(to - from) - 12))}</text>`,
    );
  });
  parts.push("</svg>");
  return parts.join("");
}

const ALLOWED_ELEMENTS = new Set(["svg", "g", "path", "polygon", "polyline", "ellipse", "text"]);
const ALLOWED_ATTRIBUTES = new Set([
  "viewBox", "width", "height", "role", "aria-label", "transform", "fill", "stroke", "stroke-width", "stroke-dasharray",
  "d", "points", "cx", "cy", "rx", "ry", "x", "y", "text-anchor", "font-size", "xml:space",
]);
/** Attributes Graphviz adds that the page has no use for; they are removed rather than refused. */
const DROPPED_ATTRIBUTES = new Set(["id", "class", "font-family", "xmlns", "xmlns:xlink"]);
const PAINT = /^(none|currentColor|#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20})$/;
const ENTITY = /&(?!(?:amp|lt|gt|quot|apos|#[0-9]{1,7}|#x[0-9a-fA-F]{1,6});)/;
const TOKEN = /<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+="[^"<>]*")*)\s*(\/?)>|([^<>]+)/y;
const ATTRIBUTE = /([\w:-]+)="([^"<>]*)"/g;

/**
 * Cleans a drawing for the page and checks it. Returns the SVG, or undefined when it holds anything the page does not
 * allow: another element, another attribute, a stray `<` or `&`, an unbalanced tag, or a paint that is not a plain colour.
 */
function cleanSvg(raw: string, label: string): string | undefined {
  const source = raw
    .replace(/<\?xml[\s\S]*?\?>/g, "")
    .replace(/<!DOCTYPE[^>]*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<title>[^<]*<\/title>/g, "")
    .trim();
  const output: string[] = [];
  const open: string[] = [];
  let at = 0;
  let sawRoot = false;
  while (at < source.length) {
    TOKEN.lastIndex = at;
    const token = TOKEN.exec(source);
    if (token === null) return undefined;
    at = TOKEN.lastIndex;
    const [, closing, name, attributes, selfClosing, textNode] = token;
    if (textNode !== undefined) {
      if (ENTITY.test(textNode)) return undefined;
      if (open[open.length - 1] === "text") output.push(textNode);
      else if (textNode.trim() !== "") return undefined;
      continue;
    }
    if (name === undefined || !ALLOWED_ELEMENTS.has(name)) return undefined;
    if (closing === "/") {
      if (open.pop() !== name) return undefined;
      output.push(`</${name}>`);
      continue;
    }
    if (name === "svg" ? sawRoot || open.length > 0 : open.length === 0) return undefined;
    sawRoot ||= name === "svg";
    const kept: string[] = [];
    let seen = 0;
    for (const attribute of (attributes ?? "").matchAll(ATTRIBUTE)) {
      const [, key, value] = attribute;
      if (key === undefined || value === undefined) return undefined;
      seen += 1;
      if (DROPPED_ATTRIBUTES.has(key) || (name === "svg" && ["width", "height", "fill", "role", "aria-label"].includes(key))) continue;
      if (!ALLOWED_ATTRIBUTES.has(key) || /&/.test(value)) return undefined;
      let next = value;
      if (key === "fill" || key === "stroke") {
        if (!PAINT.test(value)) return undefined;
        next = value === "white" && key === "fill" ? "none" : value === "black" ? "currentColor" : value;
      }
      kept.push(` ${key}="${next}"`);
    }
    if (seen !== (attributes ?? "").match(/\s[\w:-]+="/g)?.length) return undefined;
    // Text Graphviz leaves unpainted takes the page's text colour, so it reads in both themes.
    if (name === "svg") kept.unshift(' width="100%"', ' fill="currentColor"', ' role="img"', ` aria-label="${escapeHtml(label)}"`);
    output.push(`<${name}${kept.join("")}${selfClosing === "/" ? "/" : ""}>`);
    if (selfClosing !== "/") open.push(name);
  }
  return sawRoot && open.length === 0 ? output.join("") : undefined;
}

/**
 * The diagram for one piece of evidence. `text` is always there: the plain-text alternative, worded as the Markdown
 * copy's evidence line. `svg` is there only when the drawing succeeded and passed the allowlist.
 */
export async function renderDiagram(evidence: DiagramEvidence, options: DiagramOptions = {}): Promise<{ svg?: string; text: string }> {
  const text = planDiagramText(evidence);
  try {
    if (evidence.kind === "flow") {
      const svg = cleanSvg(flowSvg(evidence), text);
      return svg === undefined ? { text } : { svg, text };
    }
    const graphviz = await (options.loadGraphviz ?? loadSharedGraphviz)();
    const svg = cleanSvg(graphviz.dot(evidence.kind === "schema" ? schemaDot(evidence) : stateMachineDot(evidence)), text);
    return svg === undefined ? { text } : { svg, text };
  } catch {
    return { text };
  }
}
