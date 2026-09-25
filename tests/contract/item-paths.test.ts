import { describe, expect, it } from "vitest";
import { ITEM_PATH_MAX_STEPS, ItemPathSchema, itemPathHolders, itemPathProblems, itemPathValues, schemaHasItemPath } from "../../packages/contracts/src/index.js";

describe("item argument paths (spec 014)", () => {
  it("accepts a name, a.b and a[].b, with at most four steps", () => {
    expect(ITEM_PATH_MAX_STEPS).toBe(4);
    for (const path of ["id", "issueIdOrKey", "issue_number", "fields.key", "tasks[].task", "a[].b.c[].d"]) expect(ItemPathSchema.safeParse(path).success).toBe(true);
    for (const path of ["", "tasks[]", "tasks[].", ".id", "id.", "a..b", "a[0].b", "a[]b", "a.*.b", "has space", "a.b.c.d.e", "a[].b[].c[].d[].e", "x".repeat(65)]) {
      expect(ItemPathSchema.safeParse(path).success).toBe(false);
    }
  });

  it("finds no item when the path is missing, empty, of another shape or malformed", () => {
    expect(itemPathValues({ title: "x" }, "id")).toEqual([]);
    expect(itemPathValues({ id: "" }, "id")).toEqual([]);
    expect(itemPathValues({ id: null }, "id")).toEqual([]);
    expect(itemPathValues({ tasks: [] }, "tasks[].task")).toEqual([]);
    expect(itemPathValues({ tasks: [{ name: "new" }] }, "tasks[].task")).toEqual([]);
    expect(itemPathValues({ tasks: { task: "11" } }, "tasks[].task")).toEqual([]);
    expect(itemPathValues({ tasks: ["11", "12"] }, "tasks[].task")).toEqual([]);
    expect(itemPathValues({ fields: [{ key: "PAY-7" }] }, "fields.key")).toEqual([]);
    expect(itemPathValues({ tasks: [{ task: "11" }] }, "tasks[]")).toEqual([]);
  });

  it("finds each present item: top level, nested, or in every object of an array", () => {
    expect(itemPathValues({ id: "T-5" }, "id")).toEqual(["T-5"]);
    expect(itemPathValues({ issue_number: 42 }, "issue_number")).toEqual([42]);
    expect(itemPathValues({ fields: { key: "PAY-7" } }, "fields.key")).toEqual(["PAY-7"]);
    expect(itemPathValues({ tasks: [{ task: "11" }, { name: "new" }, { task: "12" }] }, "tasks[].task")).toEqual(["11", "12"]);
    expect(itemPathHolders({ tasks: [{ task: "11", completed: true }, 3, null] }, "tasks[].task")).toEqual([{ task: "11", completed: true }]);
    expect(itemPathHolders({ id: "T-5" }, "id")).toEqual([{ id: "T-5" }]);
  });

  it("never reads deeper than the path's own steps", () => {
    const deep = { a: [{ b: { c: [{ d: "x", e: { f: "y" } }] } }] };
    expect(itemPathValues(deep, "a[].b.c[].d")).toEqual(["x"]);
    expect(itemPathValues(deep, "a[].b.c[].e.f")).toEqual([]);
    expect(itemPathHolders(deep, "a[].b.c[].e.f")).toEqual([]);
  });

  it("reports a malformed, duplicated or empty declaration", () => {
    expect(itemPathProblems(undefined)).toEqual([]);
    expect(itemPathProblems(["id"])).toEqual([]);
    expect(itemPathProblems(["task_id", "tasks[].task"])).toEqual([]);
    expect(itemPathProblems(["id", "tasks[]"])).toEqual(["malformed item argument path \"tasks[]\""]);
    expect(itemPathProblems(["id", "id"])).toEqual(["duplicate item argument path id"]);
    expect(itemPathProblems([])).toEqual(["declare 1 to 16 item argument paths"]);
  });

  it("tells whether a tool's input schema offers a path", () => {
    const schema = { type: "object", properties: {
      id: { type: "string" },
      fields: { type: "object", properties: { key: { type: "string" } } },
      tasks: { type: "array", items: { type: "object", properties: { task: { type: "string" } } } },
    } };
    expect(schemaHasItemPath(schema, "id")).toBe(true);
    expect(schemaHasItemPath(schema, "fields.key")).toBe(true);
    expect(schemaHasItemPath(schema, "tasks[].task")).toBe(true);
    expect(schemaHasItemPath(schema, "tasks.task")).toBe(false);
    expect(schemaHasItemPath(schema, "fields[].key")).toBe(false);
    expect(schemaHasItemPath(schema, "tasks[].name")).toBe(false);
    expect(schemaHasItemPath(schema, "task_id")).toBe(false);
    expect(schemaHasItemPath(schema, "tasks[]")).toBe(false);
  });
});
