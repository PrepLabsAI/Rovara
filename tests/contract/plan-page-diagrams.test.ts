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

describe("plan page diagrams", () => {

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

});
