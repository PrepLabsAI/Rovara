// TE-F2 part B: the model helper's command line. Built from numbers, addresses, enum words and paths only; read back strictly; refuses anything else.
import { describe, expect, it } from "vitest";
import { ModelHelperArgsRefused, modelHelperArgs, modelHelperSummarizeArgs, parseModelHelperArgs, parseModelHelperSummarizeArgs, type ModelHelperServeArgs } from "../../packages/worker/src/model-helper-args.js";

const GOOD: ModelHelperServeArgs = {
  listen: "10.20.0.9", port: 8080, metaPort: 8081, caller: "10.20.0.3", mode: "scripted", rows: "/rovara/models/rows.json", replies: "/rovara/models/replies.json", digest: "a".repeat(64),
  ledger: "/rovara/ledger/model-ledger.jsonl", blockState: "by_name", projectId: undefined, recordEscapes: true,
};

describe("model helper arguments", () => {
  it("round-trips: the builder's line is the parser's input", () => {
    const argv = modelHelperArgs(GOOD);
    expect(argv).toContain("--record-escapes");
    expect(parseModelHelperArgs(argv)).toEqual(GOOD);
    expect(parseModelHelperArgs(modelHelperArgs({ ...GOOD, projectId: "rovara-test-project", metaPort: undefined, recordEscapes: false }))).toMatchObject({ projectId: "rovara-test-project", metaPort: undefined, recordEscapes: false });
  });
  it("refuses a wildcard or a name for listen and caller, a bad port, a bad mode, a path with .., a short digest, a project id with a slash", () => {
    const bad: Array<Partial<ModelHelperServeArgs>> = [
      { listen: "0.0.0.0" }, { listen: "localhost" }, { listen: "::" }, { caller: "rovara-models" }, { port: 0 }, { port: 70_000 }, { port: 1.5 }, { metaPort: 8080 }, { mode: "sneaky" as never },
      { rows: "../etc/passwd" }, { rows: "relative.json" }, { ledger: "/a/../b" }, { digest: "abc" }, { blockState: "sealed" as never }, { projectId: "a/b" },
    ];
    for (const over of bad) expect(() => modelHelperArgs({ ...GOOD, ...over }), JSON.stringify(over)).toThrow(ModelHelperArgsRefused);
  });
  it("allows an ephemeral port only on a loopback address", () => {
    expect(() => modelHelperArgs({ ...GOOD, listen: "127.0.0.1", caller: "127.0.0.1", port: 0, metaPort: 0 })).not.toThrow();
    expect(() => modelHelperArgs({ ...GOOD, port: 0 })).toThrow(ModelHelperArgsRefused);
  });
  it("the parser refuses an unknown flag, a repeated one, a missing value and a stray value", () => {
    const argv = modelHelperArgs(GOOD);
    expect(() => parseModelHelperArgs([...argv, "--control-token", "x"])).toThrow(ModelHelperArgsRefused);
    expect(() => parseModelHelperArgs([...argv, "--caller", "10.0.0.4"])).toThrow(ModelHelperArgsRefused);
    expect(() => parseModelHelperArgs(argv.filter((token) => token !== "--ledger" && token !== GOOD.ledger))).toThrow(ModelHelperArgsRefused);
    expect(() => parseModelHelperArgs([...argv, "stray"])).toThrow(ModelHelperArgsRefused);
    expect(() => parseModelHelperArgs(["--listen", "--port", "1"])).toThrow(ModelHelperArgsRefused);
  });
  it("the summary line: --summarize --ledger <file>, nothing else", () => {
    expect(parseModelHelperSummarizeArgs(modelHelperSummarizeArgs("/rovara/ledger/model-ledger.jsonl"))).toEqual({ ledger: "/rovara/ledger/model-ledger.jsonl" });
    expect(() => parseModelHelperSummarizeArgs(["--summarize", "--ledger", "/a/b", "--digest", "x"])).toThrow(ModelHelperArgsRefused);
    expect(() => parseModelHelperSummarizeArgs(["--summarize", "--ledger", "/a/b", "extra"])).toThrow(ModelHelperArgsRefused);
    expect(() => parseModelHelperSummarizeArgs(["--ledger", "/a/b"])).toThrow(ModelHelperArgsRefused);
  });
});
