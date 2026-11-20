// Device testing slice 2: the tree-reading contract for Android. Android's UI dump (XML) becomes the flat view tree of the mask plan: nodes in reading order, secure fields, web views and surfaces
// reported, and anything that cannot be read as a dump is UNREADABLE (withheld even under the admin's fixture-data choice), never a tree with less in it.
import { describe, expect, it } from "vitest";
import { DEVICE_EVIDENCE_TREE_NODES_MAX, DEVICE_EVIDENCE_TREE_TEXT_MAX, planDeviceMask } from "../../packages/contracts/src/device-evidence.js";
import { ANDROID_HIERARCHY_MAX_BYTES, DEVICE_UNREADABLE_TREE, androidHierarchyToTree } from "../../packages/contracts/src/device-evidence-android.js";

const SIZE = { width: 720, height: 1280 };
const attrs = (row: Record<string, string>) => Object.entries(row).map(([key, value]) => ` ${key}="${value}"`).join("");
const node = (row: Record<string, string>, children = "") => (children === "" ? `<node${attrs(row)} />` : `<node${attrs(row)}>${children}</node>`);
const OPEN = `<displays><display id="0"><window id="1" title="app"><hierarchy rotation="0">`;
const CLOSE = "</hierarchy></window></display></displays>";
const XML = "<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>";
/** The dump of every window (`uiautomator dump --windows`): the displays, each window and its hierarchy. */
const dump = (inner: string) => `${XML}${OPEN}${inner}${CLOSE}`;
const box = (l: number, t: number, r: number, b: number) => `[${String(l)},${String(t)}][${String(r)},${String(b)}]`;
const FRAME = { frame: SIZE };

describe("androidHierarchyToTree", () => {
  it("flattens the dump in reading order with text, description, hint, id and rectangle, and reports secure, web-view and surface nodes", () => {
    const xml = dump(node({ class: "android.widget.FrameLayout", bounds: box(0, 0, 720, 1280) }, [
      node({ class: "android.widget.TextView", text: "Welcome", "resource-id": "io.app:id/title", bounds: box(10, 20, 710, 120) }),
      node({ class: "android.widget.EditText", text: "••••", password: "true", hint: "Password", "resource-id": "io.app:id/pw", bounds: box(10, 130, 710, 230) }),
      node({ class: "android.widget.LinearLayout", bounds: box(0, 240, 720, 900) }, [
        node({ class: "android.webkit.WebView", "content-desc": "Terms", bounds: box(0, 240, 720, 600) }),
        node({ class: "android.view.SurfaceView", bounds: box(0, 600, 720, 900) }),
      ].join("")),
      node({ class: "android.widget.ImageButton", "content-desc": "Close", bounds: box(600, 1100, 700, 1200) }),
    ].join("")));
    expect(androidHierarchyToTree(xml, SIZE)).toEqual({
      width: 720, height: 1280, nodes: [
        { text: "Welcome", id: "io.app:id/title", bounds: { x: 10, y: 20, width: 700, height: 100 } },
        { id: "io.app:id/pw", text: "••••", hint: "Password", secure: true, bounds: { x: 10, y: 130, width: 700, height: 100 } },
        { description: "Terms", webView: true, bounds: { x: 0, y: 240, width: 720, height: 360 } },
        { surface: true, bounds: { x: 0, y: 600, width: 720, height: 300 } },
        { description: "Close", bounds: { x: 600, y: 1100, width: 100, height: 100 } },
      ],
    });
  });

  it("decodes the XML entities the dump writes and refuses any other", () => {
    const tree = androidHierarchyToTree(dump(node({ text: "A &amp; B &lt;c&gt; &quot;d&quot; &apos;e&apos; f&#10;g &#x263A;", bounds: box(0, 0, 10, 10) })), SIZE) as { nodes: Array<{ text: string }> };
    expect(tree.nodes[0]!.text).toBe("A & B <c> \"d\" 'e' f\ng ☺");
    for (const bad of ["x &nbsp; y", "x & y", "x &#xD800; y", "x &#1114112; y", "x &lt"]) expect(androidHierarchyToTree(dump(node({ text: bad, bounds: box(0, 0, 10, 10) })), SIZE), bad).toBe(DEVICE_UNREADABLE_TREE);
    // One pass: "&amp;amp;" is the text "&amp;", never decoded twice.
    const once = androidHierarchyToTree(dump(node({ text: "&amp;amp;", bounds: box(0, 0, 10, 10) })), SIZE) as { nodes: Array<{ text: string }> };
    expect(once.nodes[0]!.text).toBe("&amp;");
  });

  it("is UNREADABLE (not a tree with less in it) for anything that is not a well-formed dump", () => {
    const ok = node({ text: "x", bounds: box(0, 0, 10, 10) });
    const cases: Record<string, unknown> = {
      empty: "", notText: 5, nothing: undefined, plain: "hello", noHierarchy: `<node text="x" />`, unclosedHierarchy: `${XML}${OPEN}${ok}`, wrongClose: `${XML}${OPEN}${ok}</node>`,
      afterEnd: `${dump(ok)}${ok}`, stray: dump(`${ok}garbage`), unknownTag: dump(`<view text="x" />`), badAttribute: dump(`<node text=x />`),
      rawLess: dump(`<node text="a<b" />`), duplicate: dump(`<node text="a" text="b" />`), unclosedNode: `${XML}${OPEN}<node text="a">${CLOSE}`,
      skipped: dump(`${ok}<node text="a" ${ok}`), nodeBeforeRoot: `${ok}${dump("")}`, twoRoots: `${dump(ok)}${dump(ok)}`, nodeOutsideAWindow: `<displays><display>${ok}</display></displays>`,
      activeWindowOnly: `${XML}<hierarchy rotation="0">${ok}</hierarchy>`, noDisplays: `<hierarchy rotation="0">${ok}</hierarchy>`, windowsUnclosed: `${XML}<displays><display><window><hierarchy>${ok}</hierarchy></window></display>`,
      strayLess: dump(`${ok}< ${ok}`), comment: dump(`${ok}<!-- hidden -->${ok}`), cdata: dump(`${ok}<![CDATA[x]]>`), trailingLess: `${dump(ok)}<`, emptyRoot: `${XML}<displays />`,
      nestedDisplays: `${XML}<displays><displays><display><window><hierarchy>${ok}</hierarchy></window></display></displays></displays>`,
    };
    for (const [name, xml] of Object.entries(cases)) expect(androidHierarchyToTree(xml, SIZE), name).toBe(DEVICE_UNREADABLE_TREE);
  });

  it("is UNREADABLE over the byte cap, over the node cap, over the text cap and over the total text cap, never a cut tree", () => {
    const line = node({ text: "t", bounds: box(0, 0, 10, 10) });
    expect(androidHierarchyToTree(dump(line.repeat(DEVICE_EVIDENCE_TREE_NODES_MAX)), SIZE)).not.toBe(DEVICE_UNREADABLE_TREE);
    expect(androidHierarchyToTree(dump(line.repeat(DEVICE_EVIDENCE_TREE_NODES_MAX + 1)), SIZE)).toBe(DEVICE_UNREADABLE_TREE);
    expect(androidHierarchyToTree(dump(node({ text: "x".repeat(DEVICE_EVIDENCE_TREE_TEXT_MAX), bounds: box(0, 0, 10, 10) })), SIZE)).not.toBe(DEVICE_UNREADABLE_TREE);
    expect(androidHierarchyToTree(dump(node({ text: "x".repeat(DEVICE_EVIDENCE_TREE_TEXT_MAX + 1), bounds: box(0, 0, 10, 10) })), SIZE)).toBe(DEVICE_UNREADABLE_TREE);
    const long = node({ text: "x".repeat(DEVICE_EVIDENCE_TREE_TEXT_MAX), bounds: box(0, 0, 10, 10) });
    expect(androidHierarchyToTree(dump(long.repeat(51)), SIZE)).toBe(DEVICE_UNREADABLE_TREE);
    expect(androidHierarchyToTree(`${OPEN}${" ".repeat(ANDROID_HIERARCHY_MAX_BYTES)}${CLOSE}`, SIZE)).toBe(DEVICE_UNREADABLE_TREE);
    // Structural nodes count against the raw cap too, so a dump of nothing but containers is not read at all.
    expect(androidHierarchyToTree(dump(node({ class: "a.B", bounds: box(0, 0, 1, 1) }).repeat(DEVICE_EVIDENCE_TREE_NODES_MAX * 4 + 1)), SIZE)).toBe(DEVICE_UNREADABLE_TREE);
  });

  it("keeps a node whose rectangle is not usable, without it (the mask plan then withholds a screen that needs it painted)", () => {
    const rows = ["", "[0,0]", "[10,10][5,20]", "[0,0][10,-5]", "[a,b][c,d]", "[0,0][99999999,5]"].map((bounds) => node({ text: "contact: sam@example.org", ...(bounds === "" ? {} : { bounds }) })).join("");
    const tree = androidHierarchyToTree(dump(rows), SIZE) as { nodes: Array<{ bounds?: unknown }> };
    expect(tree.nodes).toHaveLength(6);
    expect(tree.nodes.every((row) => row.bounds === undefined)).toBe(true);
    expect(planDeviceMask(tree, FRAME)).toEqual({ status: "withheld", reason: "masked_content" });
  });

  it("feeds the mask plan: a secret in text is painted at its rectangle, a secure field and a web view always are", () => {
    const xml = dump([
      node({ text: "Total", bounds: box(0, 0, 720, 100) }),
      node({ text: "sam@example.org", bounds: box(0, 100, 720, 200) }),
      node({ class: "android.widget.EditText", text: "abc", password: "true", bounds: box(0, 200, 720, 300) }),
      node({ class: "android.webkit.WebView", bounds: box(0, 300, 720, 900) }),
    ].join(""));
    expect(planDeviceMask(androidHierarchyToTree(xml, SIZE), FRAME)).toEqual({
      status: "paint", rects: [{ x: 0, y: 100, width: 720, height: 100 }, { x: 0, y: 200, width: 720, height: 100 }, { x: 0, y: 300, width: 720, height: 600 }],
    });
  });
});
