// Device testing slice 4 (DEC 244): the pure half of the iOS simulator driver. Two readers of what Apple's tools and Maestro print, both fail closed:
//   * `iosHierarchyToTree`: Maestro's `hierarchy` output (the accessibility tree of the screen, JSON, in POINTS) as the flat view tree every device driver hands to the mask plan (device-evidence.ts), in the
//     PIXELS of the screenshot (the plan paints pixels). The scale is read from the screen's own root element and the screenshot's size and must be one even factor; anything else is unreadable.
//   * `xcresultTestsToCtrf`: `xcrun xcresulttool get test-results tests` (the customer's own XCTest or XCUITest results, run as written) as a CTRF report, a format the worker's report adapters already read.
// UNVERIFIED on a real simulator (the lane's Mac had no Xcode): both formats are read from the tools' documented shapes and every part that is not exactly that shape is "unreadable" or "no report",
// never "a smaller tree" or "fewer tests". The macOS CI job (tests/macos) is the first real run. Pure and browser-safe: nothing here imports a Node module. Linear in the input.
import { DEVICE_EVIDENCE_TREE_NODES_MAX, parseDeviceViewTree, type DeviceViewTree } from "./device-evidence.js";
import { DEVICE_UNREADABLE_TREE } from "./device-evidence-android.js";

/** The most hierarchy text read. */
export const IOS_HIERARCHY_MAX_BYTES = 4 * 1_048_576;
/** Deeper than this is not a screen (a real tree is a few dozen levels). */
const MAX_DEPTH = 100;
/** Nodes visited, including the ones that say nothing; more is unreadable. */
const MAX_VISITED = DEVICE_EVIDENCE_TREE_NODES_MAX * 4;
const BOUNDS = /^\[(-?\d{1,7}(?:\.\d{1,4})?),(-?\d{1,7}(?:\.\d{1,4})?)\]\[(-?\d{1,7}(?:\.\d{1,4})?),(-?\d{1,7}(?:\.\d{1,4})?)\]$/u;
const WEB_VIEW = /web[-_ ]?view/iu;
const SECURE = /secure/iu;
/** Element types that draw their own pixels: a tree says nothing of what they show. */
const SURFACE = /(?:XCUIElementTypeMap|MKMapView|SKView|SCNView|MTKView|GLKView|FlutterView|UnityView|AVPlayerView|CameraView)\b/u;
/** Attributes whose text is on the screen (a label, a title, a value), the accessibility description, and a placeholder. The first of each group that is present is the node's own; the others get nodes of their own. */
const TEXT_KEYS = ["text", "title", "value", "label"] as const;
const DESCRIPTION_KEYS = ["accessibilityText"] as const;
const HINT_KEYS = ["hintText", "hint", "placeholder"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
type Box = { left: number; top: number; right: number; bottom: number };
function boundsOf(value: unknown): Box | undefined {
  if (typeof value !== "string") return undefined;
  const match = BOUNDS.exec(value);
  if (match === null) return undefined;
  const [left, top, right, bottom] = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])] as const;
  return right >= left && bottom >= top ? { left, top, right, bottom } : undefined;
}
/** The JSON object inside the program's output: the first `{` to the last `}` (a banner line before or after is not part of the tree; what is inside is checked whole). */
function jsonIn(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try { return JSON.parse(text.slice(start, end + 1)) as unknown; } catch { return undefined; }
}

/**
 * The view tree of one iOS screen from Maestro's hierarchy output, for a screenshot of `frame` pixels, or `DEVICE_UNREADABLE_TREE`. The root element's rectangle is the screen in points (it must start at
 * 0,0); the factor from points to the screenshot's pixels must be the same across and down (to a hundredth) and between 1 and 4. Rectangles are widened outward to whole pixels, so a rounding never leaves
 * an edge of a secret unpainted. A node with several different texts (a label, a title, a value) gives one node per text, so each is scanned and painted. Nodes with nothing to say are left out. A text over
 * the cap, a tree too deep or too big, and an output that is not the tree make the whole screen unreadable, never a shorter tree. Never throws.
 */
export function iosHierarchyToTree(output: unknown, frame: { width: number; height: number }): DeviceViewTree | typeof DEVICE_UNREADABLE_TREE {
  if (typeof output !== "string" || output.length === 0 || output.length > IOS_HIERARCHY_MAX_BYTES || typeof frame !== "object" || frame === null
    || !Number.isInteger(frame.width) || !Number.isInteger(frame.height) || frame.width < 1 || frame.height < 1) return DEVICE_UNREADABLE_TREE;
  const root = jsonIn(output);
  if (!isRecord(root) || !isRecord(root["attributes"])) return DEVICE_UNREADABLE_TREE;
  const screen = boundsOf(root["attributes"]["bounds"]);
  if (screen === undefined || screen.left !== 0 || screen.top !== 0 || screen.right <= 0 || screen.bottom <= 0) return DEVICE_UNREADABLE_TREE;
  const scaleX = frame.width / screen.right;
  const scaleY = frame.height / screen.bottom;
  if (Math.abs(scaleX - scaleY) > 0.01 || scaleX < 1 || scaleX > 4) return DEVICE_UNREADABLE_TREE;

  const nodes: DeviceViewTree["nodes"] = [];
  // Reading order is document order: parent before its children, siblings top to bottom. An explicit stack, so a deep tree cannot overflow the call stack.
  const stack: Array<{ node: unknown; depth: number }> = [{ node: root, depth: 0 }];
  let visited = 0;
  let typed = false;
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    visited += 1;
    if (visited > MAX_VISITED || depth > MAX_DEPTH || !isRecord(node)) return DEVICE_UNREADABLE_TREE;
    const attributes = node["attributes"];
    if (attributes !== undefined && !isRecord(attributes)) return DEVICE_UNREADABLE_TREE;
    const children = node["children"];
    if (children !== undefined && !Array.isArray(children)) return DEVICE_UNREADABLE_TREE;
    for (let at = (children?.length ?? 0) - 1; at >= 0; at -= 1) stack.push({ node: (children as unknown[])[at], depth: depth + 1 });
    if (attributes === undefined) continue;

    const string = (key: string): string | undefined => { const value = attributes[key]; return typeof value === "string" && value !== "" ? value : undefined; };
    const first = (keys: readonly string[]): string | undefined => keys.map(string).find((value) => value !== undefined);
    const texts = [...new Set(TEXT_KEYS.map(string).filter((value): value is string => value !== undefined))];
    const description = first(DESCRIPTION_KEYS);
    const hint = first(HINT_KEYS);
    const type = [string("class"), string("type"), string("elementType")].filter((value): value is string => value !== undefined).join(" ");
    const rawId = string("resource-id");
    const id = rawId !== undefined && rawId.length <= 200 && !/[\p{Cc}\p{Cf}]/u.test(rawId) ? rawId : undefined;
    if (type !== "") typed = true;
    const webView = WEB_VIEW.test(type);
    const surface = !webView && SURFACE.test(type);
    const secure = attributes["password"] === "true" || attributes["secure"] === "true" || SECURE.test(type);
    const box = boundsOf(attributes["bounds"]);
    const bounds = box === undefined ? undefined : (() => {
      // Each axis has its own factor (they agree to a hundredth), so no edge is placed by the other axis's rounding.
      const x = Math.floor(box.left * scaleX);
      const y = Math.floor(box.top * scaleY);
      return { x, y, width: Math.ceil(box.right * scaleX) - x, height: Math.ceil(box.bottom * scaleY) - y };
    })();
    if (bounds !== undefined && (Math.abs(bounds.x) > 1_000_000 || Math.abs(bounds.y) > 1_000_000 || bounds.width > 1_000_000 || bounds.height > 1_000_000)) return DEVICE_UNREADABLE_TREE;
    const common = { ...(secure ? { secure: true as const } : {}), ...(webView ? { webView: true as const } : {}), ...(surface ? { surface: true as const } : {}), ...(bounds === undefined ? {} : { bounds }) };
    // Nothing to say and nothing to paint: the node adds nothing (its children are their own nodes).
    if (id === undefined && texts.length === 0 && description === undefined && hint === undefined && !secure && !webView && !surface) continue;
    nodes.push({ ...(id === undefined ? {} : { id }), ...(texts[0] === undefined ? {} : { text: texts[0] }), ...(description === undefined ? {} : { description }), ...(hint === undefined ? {} : { hint }), ...common });
    for (const extra of texts.slice(1)) nodes.push({ ...(id === undefined ? {} : { id }), text: extra, ...common });
  }
  // Without an element type on any node, a web view, a map or other drawn surface cannot be told from text: the screen is unreadable, never "a tree with no surfaces" (fails closed until the real shape is seen).
  if (!typed) return DEVICE_UNREADABLE_TREE;
  return parseDeviceViewTree({ width: frame.width, height: frame.height, nodes }) ?? DEVICE_UNREADABLE_TREE;
}

// ---- XCTest results

/** The most tests read from one result (the worker's report limit). */
export const XCRESULT_TESTS_MAX = 50_000;
const XC_MAX_DEPTH = 20;
const XC_MAX_VISITED = 200_000;
const STATUS: Readonly<Record<string, "passed" | "failed" | "skipped">> = { Passed: "passed", Failed: "failed", Skipped: "skipped", "Expected Failure": "passed" };
const NAME_MAX = 400;

const SECONDS = /^(\d{1,7}(?:\.\d{1,9})?)\s?s$/u;
/** A duration in milliseconds from `durationInSeconds` (a number) or `duration` (a text such as `1.5s`); undefined when there is none or it is not sane. */
function millis(node: Record<string, unknown>): number | undefined {
  const text = typeof node["duration"] === "string" ? SECONDS.exec(node["duration"])?.[1] : undefined;
  const seconds = typeof node["durationInSeconds"] === "number" ? node["durationInSeconds"] : text === undefined ? undefined : Number(text);
  return seconds !== undefined && Number.isFinite(seconds) && seconds >= 0 && seconds <= 86_400 ? Math.round(seconds * 1_000) : undefined;
}

/**
 * The customer's XCTest and XCUITest results (`xcrun xcresulttool get test-results tests --path <bundle>`, parsed JSON) as a CTRF report (text), or undefined when it is not that output or has no test
 * case. A test case is a node of type `Test Case`; its name is its suite's name and its own. `Passed` and `Expected Failure` are passed, `Failed` is failed, `Skipped` is skipped, and any other result
 * (or none) is errored, never passed. Bounded in depth, nodes and tests; a result over a bound is "no report", never a cut one. Never throws.
 */
export function xcresultTestsToCtrf(result: unknown): string | undefined {
  if (!isRecord(result) || !Array.isArray(result["testNodes"])) return undefined;
  const tests: Array<{ name: string; status: "passed" | "failed" | "skipped" | "other"; duration?: number }> = [];
  const stack: Array<{ node: unknown; depth: number; suite: string | undefined }> = [];
  for (let at = result["testNodes"].length - 1; at >= 0; at -= 1) stack.push({ node: result["testNodes"][at], depth: 0, suite: undefined });
  let visited = 0;
  while (stack.length > 0) {
    const { node, depth, suite } = stack.pop()!;
    visited += 1;
    if (visited > XC_MAX_VISITED || depth > XC_MAX_DEPTH || !isRecord(node)) return undefined;
    const type = node["nodeType"];
    const name = node["name"];
    const children = node["children"];
    if (children !== undefined && !Array.isArray(children)) return undefined;
    if (type === "Test Case") {
      if (typeof name !== "string" || name === "" || name.length > NAME_MAX || /[\p{Cc}\p{Cf}]/u.test(name)) return undefined;
      const result = typeof node["result"] === "string" ? STATUS[node["result"]] : undefined;
      const ms = millis(node);
      tests.push({ name: suite === undefined ? name : `${suite}/${name}`, status: result ?? "other", ...(ms === undefined ? {} : { duration: ms }) });
      if (tests.length > XCRESULT_TESTS_MAX) return undefined;
      continue; // the runs and failures under a test case are not tests of their own
    }
    const nextSuite = type === "Test Suite" && typeof name === "string" && name !== "" && name.length <= NAME_MAX && !/[\p{Cc}\p{Cf}]/u.test(name) ? name : suite;
    for (let at = (children?.length ?? 0) - 1; at >= 0; at -= 1) stack.push({ node: (children as unknown[])[at], depth: depth + 1, suite: nextSuite });
  }
  if (tests.length === 0) return undefined;
  return JSON.stringify({ reportFormat: "CTRF", results: { tool: { name: "xcresulttool" }, tests: tests.map((row) => ({ name: row.name, status: row.status, ...(row.duration === undefined ? {} : { duration: row.duration }) })) } });
}
