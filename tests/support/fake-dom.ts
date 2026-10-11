// A small DOM for running the task page's scripts in a vm sandbox: it parses the page the server renders and offers the
// parts of the DOM those scripts use (elements, text, attributes, simple selectors, events, focus, dialogs). It has no
// innerHTML or outerHTML, so a script that builds markup from strings fails here.

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const RAW = new Set(["script", "style"]);

export interface FakeEvent {
  type: string;
  target: FakeElement | FakeDocument;
  currentTarget: FakeElement | FakeDocument | null;
  key?: string;
  defaultPrevented: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

type Listener = (event: FakeEvent) => void;

class Listeners {
  private readonly map = new Map<string, Listener[]>();
  add(type: string, fn: Listener) { this.map.set(type, [...(this.map.get(type) ?? []), fn]); }
  remove(type: string, fn: Listener) { this.map.set(type, (this.map.get(type) ?? []).filter((entry) => entry !== fn)); }
  call(type: string, event: FakeEvent) { for (const fn of [...(this.map.get(type) ?? [])]) fn(event); }
}

export class FakeText {
  readonly nodeType = 3;
  parentNode: FakeElement | null = null;
  constructor(public data: string) {}
  get textContent(): string { return this.data; }
  set textContent(value: string) { this.data = String(value); }
  get nodeValue(): string { return this.data; }
}

export type FakeNode = FakeElement | FakeText;

const decode = (text: string): string => text.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos|#39|nbsp);/gi, (whole, name: string) => {
  const lower = name.toLowerCase();
  if (lower.startsWith("#x")) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
  if (lower.startsWith("#")) return String.fromCodePoint(Number(lower.slice(1)));
  return ({ amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " } as Record<string, string>)[lower] ?? whole;
});

interface SimpleSelector { tag?: string; id?: string; classes: string[]; attributes: Array<{ name: string; value?: string }>; checked?: boolean }

function parseCompound(text: string): SimpleSelector {
  const selector: SimpleSelector = { classes: [], attributes: [] };
  const pattern = /([a-zA-Z][a-zA-Z0-9-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]|(:checked)/gy;
  let match: RegExpExecArray | null;
  let at = 0;
  while (at < text.length && (pattern.lastIndex = at, match = pattern.exec(text)) !== null) {
    if (match[1] !== undefined) selector.tag = match[1].toLowerCase();
    else if (match[2] !== undefined) selector.id = match[2];
    else if (match[3] !== undefined) selector.classes.push(match[3]);
    else if (match[4] !== undefined) {
      const value = match[5] ?? match[6] ?? match[7];
      selector.attributes.push(value === undefined ? { name: match[4].toLowerCase() } : { name: match[4].toLowerCase(), value });
    } else selector.checked = true;
    at = pattern.lastIndex;
  }
  if (at !== text.length) throw new Error(`fake-dom: unsupported selector ${text}`);
  return selector;
}

function matchesCompound(element: FakeElement, selector: SimpleSelector): boolean {
  if (selector.tag !== undefined && element.localName !== selector.tag) return false;
  if (selector.id !== undefined && element.getAttribute("id") !== selector.id) return false;
  for (const name of selector.classes) if (!element.classList.contains(name)) return false;
  for (const attribute of selector.attributes) {
    const value = element.getAttribute(attribute.name);
    if (value === null || (attribute.value !== undefined && value !== attribute.value)) return false;
  }
  if (selector.checked === true && !element.checked) return false;
  return true;
}

/** Selector groups separated by commas; each a chain of compounds joined by spaces (descendant). */
function matches(element: FakeElement, selector: string): boolean {
  return selector.split(",").some((group) => {
    const parts = group.trim().split(/\s+/).map(parseCompound);
    if (!matchesCompound(element, parts.at(-1)!)) return false;
    let index = parts.length - 2;
    for (let up = element.parentElement; up !== null && index >= 0; up = up.parentElement) {
      if (matchesCompound(up, parts[index]!)) index -= 1;
    }
    return index < 0;
  });
}

export class FakeElement {
  readonly nodeType = 1;
  readonly localName: string;
  parentNode: FakeElement | null = null;
  childNodes: FakeNode[] = [];
  private readonly attrs = new Map<string, string>();
  private readonly listeners = new Listeners();
  /** Each call to scrollIntoView, with its options. */
  scrolled: unknown[] = [];
  private currentValue: string | undefined;
  private currentChecked: boolean | undefined;
  disabled = false;
  returnValue = "";

  constructor(readonly ownerDocument: FakeDocument, tag: string) {
    this.localName = tag.toLowerCase();
  }

  get tagName(): string { return this.localName.toUpperCase(); }
  get parentElement(): FakeElement | null { return this.parentNode; }
  get children(): FakeElement[] { return this.childNodes.filter((node): node is FakeElement => node instanceof FakeElement); }
  get firstElementChild(): FakeElement | null { return this.children[0] ?? null; }
  get firstChild(): FakeNode | null { return this.childNodes[0] ?? null; }
  get nextSibling(): FakeNode | null {
    const siblings = this.parentNode?.childNodes ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  get nextElementSibling(): FakeElement | null {
    const siblings = this.parentNode?.children ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }

  getAttribute(name: string): string | null { return this.attrs.get(name.toLowerCase()) ?? null; }
  hasAttribute(name: string): boolean { return this.attrs.has(name.toLowerCase()); }
  setAttribute(name: string, value: unknown): void {
    const key = String(name).toLowerCase();
    if (key.startsWith("on")) throw new Error("fake-dom: event handler attributes are not allowed");
    this.attrs.set(key, String(value));
  }
  removeAttribute(name: string): void { this.attrs.delete(name.toLowerCase()); }
  get attributeNames(): string[] { return [...this.attrs.keys()]; }

  get id(): string { return this.getAttribute("id") ?? ""; }
  set id(value: string) { this.setAttribute("id", value); }
  get className(): string { return this.getAttribute("class") ?? ""; }
  set className(value: string) { this.setAttribute("class", value); }
  get classList() {
    const read = () => new Set(this.className.split(/\s+/).filter(Boolean));
    const write = (set: Set<string>) => this.setAttribute("class", [...set].join(" "));
    return {
      contains: (name: string) => read().has(name),
      add: (...names: string[]) => { const set = read(); for (const name of names) set.add(name); write(set); },
      remove: (...names: string[]) => { const set = read(); for (const name of names) set.delete(name); write(set); },
      toggle: (name: string, force?: boolean) => {
        const set = read();
        const on = force ?? !set.has(name);
        if (on) set.add(name); else set.delete(name);
        write(set);
        return on;
      },
    };
  }
  private flag(name: string): boolean { return this.hasAttribute(name); }
  private setFlag(name: string, on: boolean) { if (on) this.attrs.set(name, ""); else this.attrs.delete(name); }
  get hidden(): boolean { return this.flag("hidden"); }
  set hidden(on: boolean) { this.setFlag("hidden", Boolean(on)); }
  get open(): boolean { return this.flag("open"); }
  set open(on: boolean) { this.setFlag("open", Boolean(on)); }
  get type(): string { return this.getAttribute("type") ?? (this.localName === "button" ? "submit" : "text"); }
  set type(value: string) { this.setAttribute("type", value); }
  get name(): string { return this.getAttribute("name") ?? ""; }
  set name(value: string) { this.setAttribute("name", value); }
  get htmlFor(): string { return this.getAttribute("for") ?? ""; }
  set htmlFor(value: string) { this.setAttribute("for", value); }
  get maxLength(): number { return Number(this.getAttribute("maxlength") ?? -1); }
  set maxLength(value: number) { this.setAttribute("maxlength", value); }

  get value(): string {
    if (this.currentValue !== undefined) return this.currentValue;
    if (this.localName === "textarea") return this.textContent;
    return this.getAttribute("value") ?? (this.type === "checkbox" || this.type === "radio" ? "on" : "");
  }
  set value(value: string) { this.currentValue = String(value); }
  get checked(): boolean { return this.currentChecked ?? this.hasAttribute("checked"); }
  set checked(on: boolean) {
    this.currentChecked = Boolean(on);
    if (on && this.type === "radio" && this.name !== "") {
      for (const other of this.ownerDocument.querySelectorAll(`input[name="${this.name}"]`)) if (other !== this) other.currentChecked = false;
    }
  }

  get textContent(): string { return this.childNodes.map((node) => node.textContent).join(""); }
  set textContent(value: string) {
    for (const node of this.childNodes) node.parentNode = null;
    this.childNodes = [];
    if (value !== "") this.appendChild(new FakeText(String(value)));
  }
  /** What a reader would see: text without hidden elements, spaces collapsed. */
  get visibleText(): string {
    if (this.hidden) return "";
    return this.childNodes.map((node) => node instanceof FakeElement ? ` ${node.visibleText} ` : node.data).join("").replace(/\s+/g, " ").trim();
  }

  appendChild<T extends FakeNode>(node: T): T { return this.insertBefore(node, null); }
  append(...nodes: Array<FakeNode | string>): void { for (const node of nodes) this.appendChild(typeof node === "string" ? new FakeText(node) : node); }
  insertBefore<T extends FakeNode>(node: T, before: FakeNode | null): T {
    if (node.parentNode !== null) node.parentNode.removeChild(node);
    const index = before === null ? -1 : this.childNodes.indexOf(before);
    if (index < 0) this.childNodes.push(node); else this.childNodes.splice(index, 0, node);
    node.parentNode = this;
    return node;
  }
  removeChild<T extends FakeNode>(node: T): T {
    this.childNodes = this.childNodes.filter((entry) => entry !== node);
    node.parentNode = null;
    return node;
  }
  remove(): void { this.parentNode?.removeChild(this); }
  replaceChild<T extends FakeNode>(node: FakeNode, old: T): T {
    this.insertBefore(node, old);
    return this.removeChild(old);
  }
  replaceChildren(...nodes: FakeNode[]): void {
    for (const node of this.childNodes) node.parentNode = null;
    this.childNodes = [];
    for (const node of nodes) this.appendChild(node);
  }
  after(node: FakeNode): void {
    const parent = this.parentNode;
    if (parent === null) return;
    parent.insertBefore(node, this.nextSibling);
  }
  contains(other: FakeNode | null): boolean {
    for (let at: FakeNode | null = other; at !== null; at = at.parentNode) if (at === this) return true;
    return false;
  }

  /** Every element under this one, in document order. */
  descendants(): FakeElement[] {
    const found: FakeElement[] = [];
    const walk = (element: FakeElement) => { for (const child of element.children) { found.push(child); walk(child); } };
    walk(this);
    return found;
  }
  matches(selector: string): boolean { return matches(this, selector); }
  closest(selector: string): FakeElement | null {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- walking up from this element
    for (let at: FakeElement | null = this; at !== null; at = at.parentElement) if (matches(at, selector)) return at;
    return null;
  }
  querySelector(selector: string): FakeElement | null { return this.descendants().find((element) => matches(element, selector)) ?? null; }
  querySelectorAll(selector: string): FakeElement[] { return this.descendants().filter((element) => matches(element, selector)); }

  addEventListener(type: string, fn: Listener): void { this.listeners.add(type, fn); }
  removeEventListener(type: string, fn: Listener): void { this.listeners.remove(type, fn); }
  /** Calls this element's listeners, then each ancestor's, then the document's (bubbling). */
  dispatchEvent(event: FakeEvent): boolean {
    let stopped = false;
    event.stopPropagation = () => { stopped = true; };
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- walking up from this element
    for (let at: FakeElement | null = this; at !== null && !stopped; at = at.parentElement) {
      event.currentTarget = at;
      at.listeners.call(event.type, event);
    }
    if (!stopped && this.ownerDocument.contains(this)) {
      event.currentTarget = this.ownerDocument;
      this.ownerDocument.callListeners(event.type, event);
    }
    return !event.defaultPrevented;
  }
  /** Calls listeners for `type` on this element only (no bubbling). */
  callListeners(type: string, event: FakeEvent): void { this.listeners.call(type, event); }

  click(): void {
    if (this.disabled) return;
    if (this.localName === "input" && (this.type === "checkbox" || this.type === "radio")) {
      const before = this.checked;
      this.checked = this.type === "radio" ? true : !before;
      this.dispatchEvent(makeEvent("click", this));
      if (this.checked !== before) {
        this.dispatchEvent(makeEvent("input", this));
        this.dispatchEvent(makeEvent("change", this));
      }
      return;
    }
    this.dispatchEvent(makeEvent("click", this));
  }
  /** Types text into a field: sets its value and fires input. */
  type_(text: string): void {
    this.value = text;
    this.dispatchEvent(makeEvent("input", this));
  }
  focus(): void { this.ownerDocument.activeElement = this; }
  blur(): void { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  scrollIntoView(options?: unknown): void { this.scrolled.push(options); }

  // <dialog>
  showModal(): void {
    if (this.open) throw new Error("fake-dom: dialog is already open");
    this.open = true;
  }
  close(value?: string): void {
    if (!this.open) return;
    this.open = false;
    if (value !== undefined) this.returnValue = value;
    this.listeners.call("close", makeEvent("close", this));
  }
}

export function makeEvent(type: string, target: FakeElement | FakeDocument, extra: { key?: string } = {}): FakeEvent {
  const event: FakeEvent = {
    type, target, currentTarget: null, defaultPrevented: false,
    preventDefault() { event.defaultPrevented = true; },
    stopPropagation() {},
    ...extra,
  };
  return event;
}

export class FakeDocument {
  readonly documentElement: FakeElement;
  activeElement: FakeElement | null = null;
  visibilityState: "visible" | "hidden" = "visible";
  private readonly listeners = new Listeners();

  constructor() {
    this.documentElement = new FakeElement(this, "html");
  }

  get hidden(): boolean { return this.visibilityState === "hidden"; }
  get body(): FakeElement { return this.documentElement.querySelector("body") ?? this.documentElement; }
  createElement(tag: string): FakeElement { return new FakeElement(this, tag); }
  createTextNode(text: string): FakeText { return new FakeText(String(text)); }
  getElementById(id: string): FakeElement | null { return this.documentElement.querySelector(`#${CSS_ID(id)}`) ?? this.byIdSlow(id); }
  private byIdSlow(id: string): FakeElement | null { return this.documentElement.descendants().find((element) => element.getAttribute("id") === id) ?? null; }
  querySelector(selector: string): FakeElement | null { return this.documentElement.querySelector(selector); }
  querySelectorAll(selector: string): FakeElement[] { return this.documentElement.querySelectorAll(selector); }
  contains(node: FakeNode | null): boolean { return this.documentElement.contains(node); }
  addEventListener(type: string, fn: Listener): void { this.listeners.add(type, fn); }
  removeEventListener(type: string, fn: Listener): void { this.listeners.remove(type, fn); }
  callListeners(type: string, event: FakeEvent): void { this.listeners.call(type, event); }
  dispatchEvent(event: FakeEvent): boolean {
    event.currentTarget = this;
    this.listeners.call(event.type, event);
    return !event.defaultPrevented;
  }
  /** Shows or hides the page, firing visibilitychange. */
  setVisibility(state: "visible" | "hidden"): void {
    this.visibilityState = state;
    this.dispatchEvent(makeEvent("visibilitychange", this));
  }
}

/** IDs with characters the selector parser does not take are found by a slower walk. */
const CSS_ID = (id: string): string => (/^[\w-]+$/.test(id) ? id : "\u0000never");

/** Parses a page the server rendered (well formed: every non-void element closed) into a FakeDocument. */
export function parseHtml(html: string): FakeDocument {
  const document = new FakeDocument();
  const stack: FakeElement[] = [document.documentElement];
  let at = 0;
  const top = () => stack.at(-1)!;
  let sawHtml = false;
  while (at < html.length) {
    const lt = html.indexOf("<", at);
    if (lt < 0) { top().appendChild(new FakeText(decode(html.slice(at)))); break; }
    if (lt > at) top().appendChild(new FakeText(decode(html.slice(at, lt))));
    if (html.startsWith("<!--", lt)) { at = html.indexOf("-->", lt) + 3; continue; }
    if (html.startsWith("<!", lt)) { at = html.indexOf(">", lt) + 1; continue; }
    if (html.startsWith("</", lt)) {
      const end = html.indexOf(">", lt);
      const tag = html.slice(lt + 2, end).trim().toLowerCase();
      const index = stack.map((element) => element.localName).lastIndexOf(tag);
      if (index <= 0 && tag !== "html") throw new Error(`fake-dom: unexpected </${tag}> at ${lt}`);
      if (index > 0) stack.length = index;
      at = end + 1;
      continue;
    }
    const open = /^<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/.exec(html.slice(lt));
    if (open === null) throw new Error(`fake-dom: cannot parse tag at ${lt}: ${html.slice(lt, lt + 40)}`);
    const tag = open[1]!.toLowerCase();
    at = lt + open[0].length;
    if (tag === "html" && !sawHtml) {
      sawHtml = true;
      continue;
    }
    const element = new FakeElement(document, tag);
    for (const attribute of open[2]!.matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      element.setAttribute(attribute[1]!, decode(attribute[2] ?? attribute[3] ?? attribute[4] ?? ""));
    }
    top().appendChild(element);
    if (VOID.has(tag) || open[3] === "/") continue;
    if (RAW.has(tag) || tag === "textarea") {
      const close = html.toLowerCase().indexOf(`</${tag}`, at);
      const text = html.slice(at, close);
      if (text !== "") element.appendChild(new FakeText(tag === "textarea" ? decode(text) : text));
      at = html.indexOf(">", close) + 1;
      continue;
    }
    stack.push(element);
  }
  return document;
}

/** An in-memory Storage (localStorage / sessionStorage); `fail: true` throws on every call, as a blocked storage does. */
export function fakeStorage(options: { fail?: boolean } = {}) {
  const map = new Map<string, string>();
  const check = () => { if (options.fail === true) throw new Error("SecurityError"); };
  return {
    map,
    getItem(key: string) { check(); return map.has(key) ? map.get(key)! : null; },
    setItem(key: string, value: string) { check(); map.set(key, String(value)); },
    removeItem(key: string) { check(); map.delete(key); },
    key(index: number) { check(); return [...map.keys()][index] ?? null; },
    get length() { check(); return map.size; },
  };
}
