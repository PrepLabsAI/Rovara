import { describe, expect, it } from "vitest";
import { planDocumentMarkdown, type PlanDocument, type PlanEvidenceInput } from "@agentx/contracts";
import { renderDiagram } from "../../packages/broker/src/aws/plan-page/diagrams.js";
import { planDocument } from "../support/plan-documents.js";

type Diagram = Extract<PlanEvidenceInput, { kind: "flow" | "schema" | "stateMachine" }>;

const stateMachine: Diagram = {
  kind: "stateMachine",
  states: ["Queued", "Running", "Done"],
  initial: "Queued",
  transitions: [
    { from: "Queued", to: "Running", label: "worker picks it up" },
    { from: "Running", to: "Done", label: "all checks pass" },
  ],
};
const schema: Diagram = {
  kind: "schema",
  entities: [
    { name: "Payment", fields: [{ name: "id", type: "uuid" }, { name: "amount", type: "int", note: "in cents" }] },
    { name: "Retry", fields: [{ name: "paymentId", type: "uuid" }, { name: "attempt", type: "int" }] },
  ],
  relations: [{ from: "Retry", to: "Payment", label: "retries" }],
};
const flow: Diagram = {
  kind: "flow",
  participants: ["Customer", "Gateway", "Bank"],
  steps: [
    { from: "Customer", to: "Gateway", label: "pays" },
    { from: "Gateway", to: "Bank", label: "charges the card" },
    { from: "Bank", to: "Bank", label: "checks the balance" },
    { from: "Bank", to: "Gateway", label: "says yes" },
  ],
};

const markdownEvidenceLine = (evidence: Diagram): string => {
  const plan: PlanDocument = planDocument({ claims: [{ id: "1", text: "A claim.", evidence: [evidence] }], decisions: [] });
  const markdown = planDocumentMarkdown(plan, { kind: "plan", version: 1, sha256: "0".repeat(64), answers: "recommended" });
  const found = markdown.split("\n").find((entry) => entry.trimStart().startsWith("- Evidence: "));
  return found!.trimStart().slice("- Evidence: ".length);
};

const forbidden = [/<script/i, /\son[a-z]+\s*=/i, /href/i, /<style/i, /\sid=/i, /\sclass=/i, /<title/i, /<!--/, /<\?xml/, /<!DOCTYPE/i];

describe("plan page diagrams", () => {
  it("draws a state machine with every state and nothing that could run", async () => {
    const { svg, text } = await renderDiagram(stateMachine);
    expect(svg).toBeDefined();
    for (const state of stateMachine.states) expect(svg).toContain(state);
    for (const pattern of forbidden) expect(svg).not.toMatch(pattern);
    expect(svg).toMatch(/^<svg /);
    expect(svg).toContain('width="100%"');
    expect(svg).toMatch(/^<svg [^>]*fill="currentColor"/);
    expect(svg).toContain("viewBox=");
    expect(svg).toContain('role="img"');
    expect(svg).toContain(`aria-label="${text.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`);
    expect(svg).not.toContain('fill="white"');
    expect(svg).not.toContain('"black"');
    expect(svg).not.toContain("font-family");
  });

  it("keeps hostile labels inert in a state machine", async () => {
    const hostile: Diagram = {
      kind: "stateMachine",
      states: ["\"><script>alert(1)</script>", "</text><a href=\"javascript:x\">"],
      transitions: [{ from: "\"><script>alert(1)</script>", to: "</text><a href=\"javascript:x\">", label: "\\ \" back\nslash" }],
    };
    const { svg } = await renderDiagram(hostile);
    expect(svg).toBeDefined();
    expect(svg).not.toContain("<script");
    expect(svg).not.toContain("<a ");
    expect(svg).not.toContain("</text><a");
    expect(svg).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(svg).toContain("&lt;/text&gt;&lt;a href=&quot;javascript:x&quot;&gt;");
  });

  it("draws a schema with two entities and a relation", async () => {
    const { svg } = await renderDiagram(schema);
    expect(svg).toBeDefined();
    for (const word of ["Payment", "Retry", "paymentId: uuid", "amount: int", "retries"]) expect(svg).toContain(word);
    for (const pattern of forbidden) expect(svg).not.toMatch(pattern);
  });

  it("draws a call flow with numbered steps", async () => {
    const { svg } = await renderDiagram(flow);
    expect(svg).toBeDefined();
    for (const word of ["Customer", "Gateway", "Bank", "1. pays", "2. charges the card", "3. checks the balance", "4. says yes"]) expect(svg).toContain(word);
    for (const pattern of forbidden) expect(svg).not.toMatch(pattern);
    expect(svg).toContain('role="img"');
    expect(svg).toContain('width="100%"');
  });

  it("keeps hostile text inert in a call flow", async () => {
    const hostile: Diagram = {
      kind: "flow",
      participants: ["</text><a href=\"javascript:x\">", "B"],
      steps: [{ from: "</text><a href=\"javascript:x\">", to: "B", label: "\"><script>alert(1)</script>" }],
    };
    const { svg } = await renderDiagram(hostile);
    expect(svg).toBeDefined();
    expect(svg).not.toContain("<script");
    expect(svg).not.toContain("<a ");
    expect(svg).toContain("&lt;script&gt;");
  });

  it("gives a text alternative with the Markdown copy's wording", async () => {
    for (const evidence of [stateMachine, schema, flow]) {
      const { text } = await renderDiagram(evidence);
      expect(text).toBe(markdownEvidenceLine(evidence));
    }
  });

  it("returns only the text when Graphviz cannot load", async () => {
    const { svg, text } = await renderDiagram(stateMachine, { loadGraphviz: async () => { throw new Error("no wasm"); } });
    expect(svg).toBeUndefined();
    expect(text).toBe(markdownEvidenceLine(stateMachine));
  });

  it("returns only the text when Graphviz fails on the drawing", async () => {
    const { svg, text } = await renderDiagram(schema, { loadGraphviz: async () => ({ dot: () => { throw new Error("syntax error"); } }) });
    expect(svg).toBeUndefined();
    expect(text).toBe(markdownEvidenceLine(schema));
  });

  it("returns only the text when the drawing holds anything outside the allowlist", async () => {
    const drawings = [
      '<svg viewBox="0 0 10 10"><script>alert(1)</script></svg>',
      '<svg viewBox="0 0 10 10"><g onclick="x()"></g></svg>',
      '<svg viewBox="0 0 10 10"><a href="https://example.com"><text>x</text></a></svg>',
      '<svg viewBox="0 0 10 10"><style>text{fill:red}</style></svg>',
      '<svg viewBox="0 0 10 10"><text style="fill:red">x</text></svg>',
      '<svg viewBox="0 0 10 10"><foreignObject></foreignObject></svg>',
      '<svg viewBox="0 0 10 10"><path d="M0 0" fill="url(https://example.com/x)"/></svg>',
      '<svg viewBox="0 0 10 10"><text>a & b</text></svg>',
      '<svg viewBox="0 0 10 10"><![CDATA[x]]></svg>',
    ];
    for (const drawing of drawings) {
      const { svg, text } = await renderDiagram(stateMachine, { loadGraphviz: async () => ({ dot: () => drawing }) });
      expect(svg, drawing).toBeUndefined();
      expect(text).toBe(markdownEvidenceLine(stateMachine));
    }
  });

  it("strips identifiers, comments and titles that Graphviz adds", async () => {
    const drawing = '<?xml version="1.0"?>\n<!DOCTYPE svg>\n<!-- c -->\n<svg width="62pt" height="44pt" viewBox="0.00 0.00 62.00 44.00" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">\n<g id="graph0" class="graph" transform="translate(4 40)"><title>G</title><polygon fill="white" stroke="none" points="-4,4 -4,-40 58,-40 58,4 -4,4"/><text font-family="Times" text-anchor="middle" x="27" y="-14" font-size="14.00" fill="black">A</text><path fill="none" stroke="black" d="M0 0L1 1"/></g></svg>';
    const { svg } = await renderDiagram(stateMachine, { loadGraphviz: async () => ({ dot: () => drawing }) });
    expect(svg).toBeDefined();
    for (const pattern of forbidden) expect(svg).not.toMatch(pattern);
    expect(svg).not.toContain("xmlns");
    expect(svg).toContain('fill="none" stroke="none"');
    expect(svg).toContain('stroke="currentColor"');
    expect(svg).toContain('fill="currentColor"');
    expect(svg).not.toContain("font-family");
  });
});
