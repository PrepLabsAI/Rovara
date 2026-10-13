import { types } from "node:util";
import { canonicalJson } from "./canonical-json.js";

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayBuffer = Reflect.get(Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer") ?? {}, "get");
const typedArrayByteOffset = Reflect.get(Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset") ?? {}, "get");
const typedArrayByteLength = Reflect.get(Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength") ?? {}, "get");
const typedArrayLength = Reflect.get(Object.getOwnPropertyDescriptor(typedArrayPrototype, "length") ?? {}, "get");
const arrayBufferByteLength = Reflect.get(Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength") ?? {}, "get");
const typedArraySet = Reflect.get(Uint8Array.prototype, "set");
if (!typedArrayBuffer || !typedArrayByteOffset || !typedArrayByteLength || !typedArrayLength || !arrayBufferByteLength) throw new Error("intrinsic typed-array accessors are unavailable");

export type E2EJsonBounds = Readonly<{ maxBytes: number; maxDepth: number; maxNodes?: number }>;

/** Copy untrusted metadata using own data descriptors only; never invoke accessors or toJSON. */
export function copyBoundedE2EJsonData(value: unknown, bounds: E2EJsonBounds): unknown {
  const seen = new Set<object>();
  let nodes = 0;
  const maxNodes = bounds.maxNodes ?? 16_384;
  const copy = (item: unknown, depth: number): unknown => {
    if (++nodes > maxNodes || depth > bounds.maxDepth) throw new TypeError("bounded JSON data exceeds structural limits");
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item !== "object" || types.isProxy(item)) throw new TypeError("value is not ordinary JSON data");
    if (seen.has(item)) throw new TypeError("cyclic JSON data");
    seen.add(item);
    try {
      const prototype: unknown = Object.getPrototypeOf(item);
      const descriptors = Object.getOwnPropertyDescriptors(item);
      const keys = Reflect.ownKeys(descriptors);
      if (Array.isArray(item)) {
        const length = descriptors.length;
        if (prototype !== Array.prototype || !length || !("value" in length) || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > 16_384) throw new TypeError("array is not bounded JSON data");
        if (keys.some((key) => typeof key !== "string" || key !== "length" && (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= length.value))) throw new TypeError("array has extra properties");
        const output: unknown[] = [];
        for (let index = 0; index < length.value; index += 1) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) throw new TypeError("array must be dense data");
          output.push(copy(descriptor.value, depth + 1));
        }
        return output;
      }
      if (prototype !== Object.prototype && prototype !== null) throw new TypeError("object prototype is not JSON data");
      const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const key of keys) {
        if (typeof key !== "string") throw new TypeError("symbol keys are not JSON data");
        const descriptor = descriptors[key];
        if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) throw new TypeError("object fields must be enumerable data");
        output[key] = copy(descriptor.value, depth + 1);
      }
      return output;
    } finally { seen.delete(item); }
  };
  const result = copy(value, 0);
  if (Buffer.byteLength(canonicalJson(result), "utf8") > bounds.maxBytes) throw new TypeError("canonical JSON exceeds the bounded input size");
  return result;
}

/** Copy source bytes without reading caller properties or invoking iterators/species/constructors. */
export function copyBoundedE2ESourceBytes(value: unknown, maxBytes: number): Uint8Array {
  if (typeof value !== "object" || value === null || types.isProxy(value) || !types.isUint8Array(value)) throw new TypeError("source bytes are not a bounded Uint8Array value");
  const prototype: unknown = Object.getPrototypeOf(value);
  const isBuffer = Buffer.isBuffer(value);
  if (prototype !== Uint8Array.prototype && !(isBuffer && prototype === Buffer.prototype)) throw new TypeError("source byte view uses an unsupported prototype");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  const length = Reflect.apply(typedArrayLength!, value, []) as number;
  if (keys.some((key) => typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)) throw new TypeError("source byte view has unsupported own properties");
  for (const key of keys) {
    const descriptor = descriptors[key as string];
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) throw new TypeError("source byte view contains non-data properties");
  }
  const byteLength = Reflect.apply(typedArrayByteLength!, value, []) as number;
  if (byteLength > maxBytes) throw new TypeError("source byte view exceeds its size limit");
  const buffer = Reflect.apply(typedArrayBuffer!, value, []) as ArrayBufferLike;
  const offset = Reflect.apply(typedArrayByteOffset!, value, []) as number;
  if (Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype) throw new TypeError("source byte view must use an ordinary ArrayBuffer");
  Reflect.apply(arrayBufferByteLength!, buffer, []);
  const source = new Uint8Array(buffer as ArrayBuffer, offset, byteLength);
  const copy = new Uint8Array(byteLength);
  Reflect.apply(typedArraySet, copy, [source]);
  return copy;
}

/** Copies the separately bounded immutable tree-membership list without generic JSON envelope limits. */
export function copyBoundedE2ETreePaths(value: unknown): string[] {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError("tree path inventory must be an ordinary array");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = Object.getOwnPropertyDescriptor(value, "length");
  if (!length || !("value" in length) || typeof length.value !== "number" || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > 100_000) throw new TypeError("tree path inventory exceeds its independent membership bound");
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || key !== "length" && (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= length.value))) throw new TypeError("tree path inventory has extra properties");
  const paths: string[] = [];
  for (let index = 0; index < length.value; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true || typeof descriptor.value !== "string" || descriptor.value.length === 0 || descriptor.value.length > 1024 || descriptor.value.startsWith("/") || descriptor.value.includes("\\") || descriptor.value.includes("\0")) throw new TypeError("tree path inventory contains an invalid path or accessor");
    paths.push(descriptor.value);
  }
  return paths;
}
