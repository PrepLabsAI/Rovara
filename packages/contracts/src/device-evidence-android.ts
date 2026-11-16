// Device testing slice 2 (DEC 244): the tree-reading contract for Android. The emulator driver reads the screen with Android's own UI dump (`uiautomator dump`, XML) and this file turns that text into
// the flat view tree every device driver hands to the mask plan (device-evidence.ts: `DeviceViewTree`): the nodes in reading order (the dump's own order: the document, top to bottom, parent
// before its children), each with its text, accessibility description, hint, resource id and rectangle, and three flags the mask plan always paints whatever they say: `secure` (a password field),
// `webView` (an embedded web page) and `surface` (a canvas, game, map, video or other drawn surface, which has no text of its own to read).
// Fail closed: a dump that is too big, not the expected XML, with an entity it does not know, more nodes than the cap or a text over the cap is not "a tree with less in it", it is UNREADABLE
// (`DEVICE_UNREADABLE_TREE`), which the mask plan withholds even under an admin's fixture-data choice (only a screen with no tree at all can be waived, never a dump that failed).
// Pure and browser-safe: nothing here imports a Node module. Linear in the input (one pass, no nested quantifiers).
import { DEVICE_EVIDENCE_TREE_NODES_MAX, parseDeviceViewTree, type DeviceViewTree } from "./device-evidence.js";

/** The most dump text read (a dump of 5,000 nodes with long text stays well under it). */
export const ANDROID_HIERARCHY_MAX_BYTES = 4 * 1_048_576;
/** What a driver hands the mask plan when it could not read the screen: a value that is not a tree and not "no tree", so the screen is withheld. */
export const DEVICE_UNREADABLE_TREE: Readonly<{ unreadable: true }> = Object.freeze({ unreadable: true as const });

const TAG = /<(\/?)([A-Za-z][A-Za-z0-9_.-]*)((?:\s+[A-Za-z_:][-A-Za-z0-9_:.]*="[^"<]*")*)\s*(\/?)>|<\?xml[^>]{0,200}\?>|([^<]+)/gu;
const ATTRIBUTE = /([A-Za-z_:][-A-Za-z0-9_:.]*)="([^"<]*)"/gu;
const BOUNDS = /^\[(-?\d{1,7}),(-?\d{1,7})\]\[(-?\d{1,7}),(-?\d{1,7})\]$/u;
const WEB_VIEW = /web[-_ ]?view/iu;
/** Classes that draw their own pixels: a view tree says nothing of what they show. */
const SURFACE = /(?:SurfaceView|TextureView|GLSurfaceView|VideoView|MapView|FlutterView|FlutterImageView|FlutterSurfaceView|FlutterTextureView|UnityPlayer|CanvasView|ARView|CameraView|PreviewView)\b/u;
const ENTITY = /&(?:#(\d{1,7})|#x([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos));/gu;
/** An ampersand that does not start one of those entities. */
const STRAY_AMPERSAND = /&(?!(?:#\d{1,7}|#x[0-9a-fA-F]{1,6}|amp|lt|gt|quot|apos);)/u;
const NAMED: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** The attribute's text with XML entities decoded; undefined when it holds a `&` that is not one of the XML entities (not what the dump wrote), or a code point that is not a character. */
function decode(value: string): string | undefined {
  if (!value.includes("&")) return value;
  if (STRAY_AMPERSAND.test(value)) return undefined;
  let bad = false;
  const text = value.replace(ENTITY, (_all, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (name !== undefined) return NAMED[name]!;
    const code = decimal !== undefined ? Number(decimal) : Number.parseInt(hex!, 16);
    if (!Number.isInteger(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) { bad = true; return ""; }
    return String.fromCodePoint(code);
  });
  return bad ? undefined : text;
}

type RawNode = Record<string, string>;
/** The dump's nodes in document order, or undefined when it is not the dump (not well-formed, too many nodes, an attribute that does not decode). */
function readNodes(xml: string): RawNode[] | undefined {
  const nodes: RawNode[] = [];
  const open: string[] = [];
  let sawHierarchy = false;
  let closedHierarchy = false;
  let end = 0;
  for (const match of xml.matchAll(TAG)) {
    // Everything is read: a stretch the pattern skipped (a tag that is not well-formed) is not the dump.
    if (match.index !== end) return undefined;
    end = match.index + match[0].length;
    const [, closing, name, attributes, selfClosing, between] = match;
    if (between !== undefined) { if (between.trim() !== "") return undefined; continue; }
    if (name === undefined) continue; // the XML declaration
    if (closedHierarchy) return undefined;
    if (closing === "/") {
      if (open.pop() !== name) return undefined;
      if (name === "hierarchy") closedHierarchy = true;
      continue;
    }
    if (name !== "hierarchy" && name !== "node") return undefined;
    if (name === "hierarchy") { if (sawHierarchy || open.length > 0) return undefined; sawHierarchy = true; }
    else {
      if (!sawHierarchy) return undefined;
      const row: RawNode = {};
      for (const attribute of (attributes ?? "").matchAll(ATTRIBUTE)) {
        const value = decode(attribute[2]!);
        if (value === undefined || Object.hasOwn(row, attribute[1]!)) return undefined;
        row[attribute[1]!] = value;
      }
      nodes.push(row);
      if (nodes.length > DEVICE_EVIDENCE_TREE_NODES_MAX * 4) return undefined;
    }
    if (selfClosing !== "/") open.push(name);
  }
  return end === xml.length && sawHierarchy && closedHierarchy && open.length === 0 ? nodes : undefined;
}

/**
 * The view tree of one Android screen from its UI dump, for a frame of `size` pixels, or `DEVICE_UNREADABLE_TREE`. Nodes with nothing to say (no text, description, hint, id or flag) are left out;
 * a node whose rectangle is not a rectangle keeps everything but it (the mask plan then withholds the screen if that node needs painting). A text over the cap makes the whole screen unreadable,
 * never a shortened one. Never throws.
 */
export function androidHierarchyToTree(xml: unknown, size: { width: number; height: number }): DeviceViewTree | typeof DEVICE_UNREADABLE_TREE {
  if (typeof xml !== "string" || xml.length === 0 || xml.length > ANDROID_HIERARCHY_MAX_BYTES || typeof size !== "object" || size === null) return DEVICE_UNREADABLE_TREE;
  const raw = readNodes(xml);
  if (raw === undefined) return DEVICE_UNREADABLE_TREE;
  const nodes: DeviceViewTree["nodes"] = [];
  for (const row of raw) {
    const className = row["class"] ?? "";
    const id = row["resource-id"];
    const bounds = BOUNDS.exec(row["bounds"] ?? "");
    const left = bounds === null ? 0 : Number(bounds[1]);
    const top = bounds === null ? 0 : Number(bounds[2]);
    const width = bounds === null ? -1 : Number(bounds[3]) - left;
    const height = bounds === null ? -1 : Number(bounds[4]) - top;
    const webView = WEB_VIEW.test(className);
    const surface = !webView && SURFACE.test(className);
    const secure = row["password"] === "true";
    const text = row["text"];
    const description = row["content-desc"];
    const hint = row["hint"];
    const node: DeviceViewTree["nodes"][number] = {
      ...(id !== undefined && id !== "" && id.length <= 200 && !/[\p{Cc}\p{Cf}]/u.test(id) ? { id } : {}),
      ...(text !== undefined && text !== "" ? { text } : {}),
      ...(description !== undefined && description !== "" ? { description } : {}),
      ...(hint !== undefined && hint !== "" ? { hint } : {}),
      ...(secure ? { secure: true } : {}), ...(webView ? { webView: true } : {}), ...(surface ? { surface: true } : {}),
      ...(width >= 0 && height >= 0 && width <= 1_000_000 && height <= 1_000_000 && Math.abs(left) <= 1_000_000 && Math.abs(top) <= 1_000_000 ? { bounds: { x: left, y: top, width, height } } : {}),
    };
    // A node that says nothing and needs nothing painted adds nothing to the screen's mask (its children are their own nodes).
    if (node.id === undefined && node.text === undefined && node.description === undefined && node.hint === undefined && !secure && !webView && !surface) continue;
    nodes.push(node);
  }
  const tree = parseDeviceViewTree({ width: size.width, height: size.height, nodes });
  return tree ?? DEVICE_UNREADABLE_TREE;
}
