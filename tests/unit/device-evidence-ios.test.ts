// Device testing slice 4 (DEC 244): the iOS readers in contracts. Maestro's hierarchy output as the flat view tree (points scaled to the screenshot's pixels, widened outward, one node per text, fail
// closed on anything that is not exactly the tree), and the customer's XCTest results as a CTRF report the worker's existing adapters read.
import { describe, expect, it } from "vitest";
import { DEVICE_UNREADABLE_TREE } from "../../packages/contracts/src/device-evidence-android.js";
import { IOS_HIERARCHY_MAX_BYTES, XCRESULT_TESTS_MAX, iosHierarchyToTree, xcresultTestsToCtrf } from "../../packages/contracts/src/device-evidence-ios.js";
import { DEVICE_EVIDENCE_TREE_NODES_MAX, DEVICE_EVIDENCE_TREE_TEXT_MAX, planDeviceMask } from "../../packages/contracts/src/device-evidence.js";
import { parseReportParts } from "../../packages/worker/src/verification/report-adapters.js";

type Attrs = Record<string, string>;
const node = (attributes: Attrs, children: unknown[] = []) => ({ attributes, children });
/** A screen of 390 x 844 points; the screenshot is 3x. */
const FRAME = { width: 1170, height: 2532 };
const screen = (...children: unknown[]) => JSON.stringify(node({ bounds: "[0,0][390,844]" }, children));
const tree = (output: unknown, frame = FRAME) => iosHierarchyToTree(output, frame);

describe("iosHierarchyToTree", () => {
  it("reads the screen in points, scales every rectangle to the screenshot's pixels, and keeps reading order", () => {
    const got = tree(screen(
      node({ text: "Total: 12", bounds: "[10,100][200,140]", "resource-id": "total" }),
      node({ accessibilityText: "Email field", hintText: "you@example.com", bounds: "[10,150][380,190]" }, [node({ title: "Child", bounds: "[20,160][100,180]" })]),
    ));
    expect(got).toEqual({ width: 1170, height: 2532, nodes: [
      { id: "total", text: "Total: 12", bounds: { x: 30, y: 300, width: 570, height: 120 } },
      { description: "Email field", hint: "you@example.com", bounds: { x: 30, y: 450, width: 1110, height: 120 } },
      { text: "Child", bounds: { x: 60, y: 480, width: 240, height: 60 } },
    ] });
  });
  it("widens a rectangle outward to whole pixels, so a rounding never leaves an edge of a secret unpainted", () => {
    const got = tree(screen(node({ text: "x", bounds: "[10.2,100.2][20.4,140.4]" }))) as { nodes: Array<{ bounds: { x: number; y: number; width: number; height: number } }> };
    expect(got.nodes[0]!.bounds).toEqual({ x: 30, y: 300, width: 32, height: 122 });
  });
  it("gives each different text of one element a node of its own, with the same rectangle, so each is scanned and painted", () => {
    const got = tree(screen(node({ text: "Label", title: "Title", value: "a@b.co", label: "Label", bounds: "[0,0][10,10]" }))) as { nodes: Array<Record<string, unknown>> };
    expect(got.nodes.map((row) => row["text"])).toEqual(["Label", "Title", "a@b.co"]);
    expect(new Set(got.nodes.map((row) => JSON.stringify(row["bounds"]))).size).toBe(1);
  });
  it("flags a secure field (by its password or secure attribute or its type), a web view and a drawn surface, and the mask plan paints them whatever they say", () => {
    const got = tree(screen(
      node({ password: "true", text: "••••", bounds: "[0,0][100,40]" }), node({ secure: "true", bounds: "[0,50][100,90]" }), node({ type: "XCUIElementTypeSecureTextField", bounds: "[0,100][100,140]" }),
      node({ class: "WKWebView", bounds: "[0,150][100,190]" }), node({ type: "MKMapView", bounds: "[0,200][100,240]" }), node({ text: "Hello", bounds: "[0,250][100,290]" }),
    )) as { nodes: Array<Record<string, unknown>> };
    expect(got.nodes.map((row) => [row["secure"], row["webView"], row["surface"]])).toEqual([[true, undefined, undefined], [true, undefined, undefined], [true, undefined, undefined], [undefined, true, undefined], [undefined, undefined, true], [undefined, undefined, undefined]]);
    const plan = planDeviceMask(got, { frame: FRAME });
    expect(plan.status).toBe("paint");
    expect(plan.status === "paint" ? plan.rects.length : 0).toBe(5);
  });
  it("leaves out an element with nothing to say and nothing to paint, and an empty text is no text", () => {
    const got = tree(screen(node({ text: "", bounds: "[0,0][10,10]" }), node({ enabled: "true" }), node({ text: "Hi", bounds: "[0,0][10,10]" }))) as { nodes: unknown[] };
    expect(got.nodes).toHaveLength(1);
  });
  it("keeps an element whose rectangle is not a rectangle without it (the mask plan then withholds the screen if it needs painting)", () => {
    const got = tree(screen(node({ text: "Hi", bounds: "oops" }), node({ text: "a@b.co", bounds: "[5,5][1,1]" }))) as { nodes: Array<Record<string, unknown>> };
    expect(got.nodes).toEqual([{ text: "Hi" }, { text: "a@b.co" }]);
    expect(planDeviceMask(got, { frame: FRAME })).toEqual({ status: "withheld", reason: "masked_content" });
  });
  it("accepts a banner line before or after the JSON (what is inside is checked whole)", () => {
    expect(tree(`Running on iPhone\n${screen(node({ text: "Hi", bounds: "[0,0][10,10]" }))}\ndone\n`)).toMatchObject({ nodes: [{ text: "Hi" }] });
  });
  it("is unreadable, never a smaller tree, for every output that is not exactly the tree", () => {
    const ok = node({ text: "Hi", bounds: "[0,0][10,10]" });
    const bad: unknown[] = [undefined, null, 5, "", "   ", "no json here", "{", "{}", "[]", JSON.stringify({ attributes: {} }), JSON.stringify({ attributes: { bounds: "oops" }, children: [] }),
      JSON.stringify(node({ bounds: "[5,0][390,844]" }, [ok])), JSON.stringify(node({ bounds: "[0,5][390,844]" }, [ok])), JSON.stringify(node({ bounds: "[0,0][0,844]" }, [ok])),
      // the screen's own factor is not even: 1170/400 against 2532/844 is not one scale
      JSON.stringify(node({ bounds: "[0,0][400,844]" }, [ok])), JSON.stringify(node({ bounds: "[0,0][2000,4000]" }, [ok])), JSON.stringify(node({ bounds: "[0,0][100,200]" }, [ok])),
      JSON.stringify({ attributes: { bounds: "[0,0][390,844]" }, children: "x" }), JSON.stringify({ attributes: { bounds: "[0,0][390,844]" }, children: [5] }), JSON.stringify({ attributes: { bounds: "[0,0][390,844]" }, children: [{ attributes: 5 }] }),
      screen(node({ text: "x".repeat(DEVICE_EVIDENCE_TREE_TEXT_MAX + 1), bounds: "[0,0][10,10]" })), "x".repeat(IOS_HIERARCHY_MAX_BYTES + 1)];
    for (const output of bad) expect(tree(output), String(output).slice(0, 80)).toBe(DEVICE_UNREADABLE_TREE);
    for (const frame of [{ width: 0, height: 10 }, { width: 1.5, height: 10 }, null as unknown as { width: number; height: number }]) expect(tree(screen(ok), frame)).toBe(DEVICE_UNREADABLE_TREE);
  });
  it("is unreadable for a tree that is too deep or has too many nodes, in bounded time", () => {
    let deep: unknown = node({ text: "leaf", bounds: "[0,0][10,10]" });
    for (let at = 0; at < 150; at += 1) deep = node({ bounds: "[0,0][10,10]" }, [deep]);
    expect(tree(JSON.stringify(node({ bounds: "[0,0][390,844]" }, [deep])))).toBe(DEVICE_UNREADABLE_TREE);
    const many = Array.from({ length: DEVICE_EVIDENCE_TREE_NODES_MAX * 4 + 10 }, () => node({ enabled: "true" }));
    const started = Date.now();
    expect(tree(screen(...many))).toBe(DEVICE_UNREADABLE_TREE);
    expect(tree(screen(...Array.from({ length: DEVICE_EVIDENCE_TREE_NODES_MAX + 5 }, (_unused, at) => node({ text: `t${String(at)}`, bounds: "[0,0][1,1]" }))))).toBe(DEVICE_UNREADABLE_TREE);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
  it("takes only strings as attributes (a number or a flag is not text) and ignores an id with hidden characters", () => {
    const got = tree(screen(node({ text: 5 as unknown as string, bounds: "[0,0][10,10]", "resource-id": "a‮b" }), node({ text: "ok", "resource-id": "fine.id", bounds: "[0,0][10,10]" }))) as { nodes: Array<Record<string, unknown>> };
    expect(got.nodes).toEqual([{ text: "ok", id: "fine.id", bounds: { x: 0, y: 0, width: 30, height: 30 } }]);
  });
});

const testNode = (name: string, result: unknown, extra: Record<string, unknown> = {}) => ({ nodeType: "Test Case", name, result, ...extra });
const bundle = (...children: unknown[]) => ({ testNodes: [{ nodeType: "Test Plan", name: "Plan", children: [{ nodeType: "Unit test bundle", name: "AppTests", children: [{ nodeType: "Test Suite", name: "CheckoutTests", children }] }] }] });

describe("xcresultTestsToCtrf", () => {
  it("turns each test case into a CTRF test (suite and case name, status, duration) that the worker's report adapters read", () => {
    const text = xcresultTestsToCtrf(bundle(testNode("testPays()", "Passed", { durationInSeconds: 0.25 }), testNode("testRefunds()", "Failed", { duration: "1.5s" }), testNode("testLater()", "Skipped"), testNode("testKnown()", "Expected Failure")))!;
    const parts = parseReportParts(text);
    expect(parts?.format).toBe("ctrf");
    expect(parts?.tests?.tests.map((row) => [row.name, row.status, row.durationMs])).toEqual([["CheckoutTests/testPays()", "passed", 250], ["CheckoutTests/testRefunds()", "failed", 1500], ["CheckoutTests/testLater()", "skipped", undefined], ["CheckoutTests/testKnown()", "passed", undefined]]);
  });
  it("reads a result that is not one of the known words, or none, as errored, never as passed", () => {
    const parts = parseReportParts(xcresultTestsToCtrf(bundle(testNode("a()", "Mystery"), testNode("b()", undefined), testNode("c()", 5), testNode("d()", "passed")))!);
    expect(parts?.tests?.tests.map((row) => row.status)).toEqual(["errored", "errored", "errored", "errored"]);
  });
  it("does not count what is under a test case (runs, failure messages) as tests of their own, and names a case outside any suite by itself", () => {
    const text = xcresultTestsToCtrf({ testNodes: [testNode("loose()", "Passed", { children: [testNode("run 1", "Failed"), { nodeType: "Failure Message", name: "boom" }] })] })!;
    expect(parseReportParts(text)?.tests?.tests.map((row) => row.name)).toEqual(["loose()"]);
  });
  it("is no report for anything that is not that output, or has no test case, or is over a bound, or has a name that is not plain", () => {
    const bad: unknown[] = [undefined, null, 5, "x", [], {}, { testNodes: "x" }, { testNodes: [] }, { testNodes: [{ nodeType: "Test Plan", children: "x" }] }, { testNodes: [5] }, bundle(testNode("", "Passed")), bundle(testNode(5 as unknown as string, "Passed")),
      bundle(testNode("a‮b", "Passed")), bundle(testNode("x".repeat(401), "Passed")), { testNodes: [{ nodeType: "Test Plan", children: [{ nodeType: "Test Suite", name: "S", children: [{ nodeType: "Bundle" }] }] }] }];
    for (const value of bad) expect(xcresultTestsToCtrf(value), JSON.stringify(value)?.slice(0, 80)).toBeUndefined();
    const tooMany = bundle(...Array.from({ length: XCRESULT_TESTS_MAX + 1 }, (_unused, at) => testNode(`t${String(at)}()`, "Passed")));
    expect(xcresultTestsToCtrf(tooMany)).toBeUndefined();
    let deep: unknown = testNode("leaf()", "Passed");
    for (let at = 0; at < 30; at += 1) deep = { nodeType: "Test Suite", name: "S", children: [deep] };
    expect(xcresultTestsToCtrf({ testNodes: [deep] })).toBeUndefined();
  });
  it("ignores a duration that is not sane", () => {
    const parts = parseReportParts(xcresultTestsToCtrf(bundle(testNode("a()", "Passed", { durationInSeconds: -1 }), testNode("b()", "Passed", { duration: "soon" }), testNode("c()", "Passed", { durationInSeconds: 1e9 })))!);
    expect(parts?.tests?.tests.map((row) => row.durationMs)).toEqual([undefined, undefined, undefined]);
  });
});
