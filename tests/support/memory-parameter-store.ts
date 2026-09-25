// In-memory ParameterStore for environment-settings and environment-lock tests. Behaves like SSM
// Parameter Store closely enough for those tests: createOnly refuses an existing name, deleting an
// absent name is not an error, and list(path) returns names under that path recursively.

import { ParameterExistsError, type ParameterStore } from "../../packages/cli/src/environments/parameter-store.js";

export class MemoryParameterStore implements ParameterStore {
  readonly calls: Array<{ op: string; name: string }> = [];
  readonly values = new Map<string, string>();
  private readonly versions = new Map<string, number>();

  async get(name: string): Promise<{ value: string; version: number } | undefined> {
    this.calls.push({ op: "get", name });
    await Promise.resolve();
    const value = this.values.get(name);
    if (value === undefined) return undefined;
    return { value, version: this.versions.get(name) ?? 1 };
  }

  async put(name: string, value: string, options: { createOnly?: boolean } = {}): Promise<void> {
    this.calls.push({ op: "put", name });
    await Promise.resolve();
    if (options.createOnly && this.values.has(name)) throw new ParameterExistsError(name);
    this.values.set(name, value);
    this.versions.set(name, (this.versions.get(name) ?? 0) + 1);
  }

  async delete(name: string): Promise<void> {
    this.calls.push({ op: "delete", name });
    await Promise.resolve();
    this.values.delete(name);
    this.versions.delete(name);
  }

  async list(path: string): Promise<string[]> {
    this.calls.push({ op: "list", name: path });
    await Promise.resolve();
    return [...this.values.keys()].filter((name) => name.startsWith(path));
  }
}
