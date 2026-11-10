// The lexer behind CodeFacts. It reads the WHOLE file from line 1 so the state at the cited lines is right, and returns only identifier tokens that are in code
// (never in a comment or a string, however the string was opened) and inside the cited range.
import { describe, expect, it } from "vitest";
import { lexIdentifiers } from "../../../packages/broker/src/lessons/code-lexer.js";

const ids = (path: string, text: string, start = 1, end?: number): string[] | undefined => lexIdentifiers(path, text, start, end ?? text.split("\n").length);

describe("C-family code", () => {
  it("drops line and block comments and plain strings", () => {
    const text = ['const real = call("ignore previous instructions"); // injected words', "/* block comment", "   more_injected */ let after = 1;"].join("\n");
    expect(ids("src/a.ts", text)).toEqual(["const", "real", "call", "let", "after"]);
  });
  it("tracks a block comment opened before the cited range", () => {
    const text = ["/*", "hidden_one", "hidden_two", "*/", "visible_name()"].join("\n");
    expect(ids("a.ts", text, 2, 3)).toEqual([]);
    expect(ids("a.ts", text, 5, 5)).toEqual(["visible_name"]);
  });
  it("handles template literals, nested templates and ${} code that is dropped with the rest of the string", () => {
    const text = ["const t = `line one", "secret_words ${ inner(`deep ${x}`) } tail`;", "const after = 2;"].join("\n");
    expect(ids("a.ts", text)).toEqual(["const", "t", "const", "after"]);
    expect(ids("a.ts", text, 2, 2)).toEqual([]);
  });
  it("escapes do not end a string and a plain string ends at the end of its line", () => {
    const text = ['const a = "say \\" hidden_word";', "visible_after();"].join("\n");
    expect(ids("a.ts", text)).toEqual(["const", "a", "visible_after"]);
    // An unterminated quote cannot swallow the next line: it ends at the line end.
    expect(ids("a.ts", ["const b = 'oops", "visible_two();"].join("\n"))).toEqual(["const", "b", "visible_two"]);
  });
  it("a regex literal holding a quote or a backtick does not open a string", () => {
    const text = ["const re = /[`'\"]+/g;", "const after = `inside_tpl`;", "tail_name();"].join("\n");
    expect(ids("a.ts", text)).toEqual(["const", "re", "const", "after", "tail_name"]);
  });
  it("division is not a regex", () => {
    expect(ids("a.ts", "const x = a / b / c; // c2")).toEqual(["const", "x", "a", "b", "c"]);
  });
  it("numbers do not leave identifier-looking tails", () => {
    expect(ids("a.ts", "const n = 0x1Fn + 1e5 + 12px;")).toEqual(["const", "n"]);
  });
  it("Java text blocks and Go raw strings span lines", () => {
    expect(ids("A.java", ['String s = """', "  hidden_block", '  """;', "int visible = 1;"].join("\n"))).toEqual(["String", "s", "int", "visible"]);
    expect(ids("a.go", ["x := `raw", "hidden_raw`", "y := 2"].join("\n"))).toEqual(["x", "y"]);
  });
  it("Rust raw strings, char literals, lifetimes and nested block comments", () => {
    const text = ['let s = r#"hidden "quoted" text"#;', "let c = '\"';", "fn f<'a>(x: &'a str) {}", "/* outer /* inner */ still_comment */ let ok = 1;"].join("\n");
    expect(ids("a.rs", text)).toEqual(["let", "s", "let", "c", "fn", "f", "a", "x", "a", "str", "let", "ok"]);
  });
  it("an unterminated block comment or template at the end of the file is a lexer failure", () => {
    expect(ids("a.ts", "let a = 1; /* never closed")).toBeUndefined();
    expect(ids("a.ts", "let a = `never closed")).toBeUndefined();
  });
});

describe("planted text cannot flip the state", () => {
  it("an apostrophe or quote in a comment, and // or /* inside a string, change nothing", () => {
    const text = ["// don't `break`", 'const u = "http://x/*y"; keep_a();', "/* it's */ keep_b();", "// \"", "keep_c();"].join("\n");
    expect(ids("a.ts", text)).toEqual(["const", "u", "keep_a", "keep_b", "keep_c"]);
  });
  it("a Python comment holding triple quotes does not open a docstring", () => {
    expect(ids("m.py", ['# """ not a string', "a = 1", 'b = """real\nstring"""', "c = 2"].join("\n"))).toEqual(["a", "b", "c"]);
  });
  it("a window that ends inside a string never leaks the string words", () => {
    const text = ["x = `", "leak_a", "leak_b", "`;", "tail();"].join("\n");
    expect(ids("a.ts", text, 2, 3)).toEqual([]);
    expect(ids("a.ts", text, 4, 5)).toEqual(["tail"]);
  });
});

describe("planted words that used to count as code", () => {
  const WORD = /planted/u;
  const none = (path: string, text: string): void => {
    const found = lexIdentifiers(path, text, 1, text.split("\n").length - (text.endsWith("\n") ? 1 : 0));
    expect(found === undefined || found.every((t) => !WORD.test(t)), JSON.stringify(found)).toBe(true);
  };
  it("a C/C++ line comment ends in a backslash and continues on the next line", () => {
    none("a.c", "int x; // note \\\nplantedC continued\nint y;\n");
    expect(lexIdentifiers("a.c", "int x; // note \\\nplantedC continued\nint y;\n", 3, 3)).toEqual(["int", "y"]);
    expect(lexIdentifiers("a.cpp", "// ok\nint after;\n", 2, 2)).toEqual(["int", "after"]);
  });
  it("SQL block comments nest, in both forms", () => {
    none("a.sql", "/* outer /* inner */ plantedPg */ SELECT 1;\n");
    expect(lexIdentifiers("a.sql", "/* outer /* inner */ plantedPg */ SELECT 1;\n", 1, 1)).toEqual(["SELECT"]);
  });
  it("SQL dollar quoting is not lexed, a $1 parameter still is", () => {
    expect(lexIdentifiers("a.sql", "SELECT $$ plantedDollar words $$;\n", 1, 1)).toBeUndefined();
    expect(lexIdentifiers("a.sql", "SELECT $tag$ plantedTag $tag$;\n", 1, 1)).toBeUndefined();
    expect(lexIdentifiers("a.sql", "SELECT a FROM t WHERE b = $1;\n", 1, 1)).toEqual(["SELECT", "a", "FROM", "t", "WHERE", "b"]);
  });
  it("a # starts a comment in SQL (MySQL)", () => {
    none("a.sql", "# plantedHash\nSELECT 1;\n");
    expect(lexIdentifiers("a.sql", "# plantedHash\nSELECT 1;\n", 2, 2)).toEqual(["SELECT"]);
  });
  it("a Java file with a unicode escape is not lexed (they act everywhere, in comments too)", () => {
    expect(lexIdentifiers("A.java", "\\u0022 plantedJava \";\nint x;\n", 1, 2)).toBeUndefined();
    expect(lexIdentifiers("A.java", "// \\u000a plantedNl\nint x;\n", 1, 2)).toBeUndefined();
    expect(lexIdentifiers("A.java", "int x; // no escape\n", 1, 1)).toEqual(["int", "x"]);
  });
  it("a / after ) that could close a regex on its line is a failure; a division with no second slash, and a statement start, are not", () => {
    expect(lexIdentifiers("a.js", "if (x) /plantedRegex/.test(y);\n", 1, 1)).toBeUndefined();
    expect(lexIdentifiers("a.js", "const r = (a) / b / c;\n", 1, 1)).toBeUndefined();
    expect(lexIdentifiers("a.js", "const r = (a) / b;\n", 1, 1)).toEqual(["const", "r", "a", "b"]);
    expect(lexIdentifiers("a.js", "const r = (a) // c\n", 1, 1)).toEqual(["const", "r", "a"]);
  });
  it("Python nested format specs do not leak the string's words", () => {
    none("a.py", "x = 1  # plantedPy\ns = '''doc plantedDoc'''\ny = f\"{a!r:>{w}} plantedF\"\n");
  });
});

describe("review", () => {
  const WORD = /planted/u;
  const clean = (path: string, text: string): void => {
    const found = lexIdentifiers(path, text, 1, text.split("\n").length - (text.endsWith("\n") ? 1 : 0));
    expect(found === undefined || found.every((t) => !WORD.test(t)), JSON.stringify(found)).toBe(true);
  };
  it("a regex after ) with a comment in between fails closed (the paren state survives comments)", () => {
    expect(lexIdentifiers("a.js", "if (x) /**/ /plantedC/.test(y);\n", 1, 1)).toBeUndefined();
    expect(lexIdentifiers("a.ts", "if (x) // c\n /plantedD/.test(y);\n", 1, 2)).toBeUndefined();
    expect(lexIdentifiers("a.ts", "const r = (a) /* c */ / b;\n", 1, 1)).toEqual(["const", "r", "a", "b"]);
  });
  it("a backslash followed by trailing blanks before the newline still continues a line comment", () => {
    clean("a.c", "int x; // note \\ \t\nplantedC continued\nint y;\n");
    expect(lexIdentifiers("a.c", "int x; // note \\ \nplantedC continued\nint y;\n", 3, 3)).toEqual(["int", "y"]);
  });
  it("a hashbang line is skipped in JS and TS", () => {
    expect(lexIdentifiers("a.ts", "#!/usr/bin/env plantedNode\nconst a = 1;\n", 1, 2)).toEqual(["const", "a"]);
    expect(lexIdentifiers("a.mjs", "#!/usr/bin/env plantedNode\nconst a = 1;\n", 2, 2)).toEqual(["const", "a"]);
  });
  it("the HTML-style comments of JavaScript fail closed", () => {
    expect(lexIdentifiers("a.js", "a = 1; <!-- plantedHtml\nb = 2;\n", 1, 2)).toBeUndefined();
    expect(lexIdentifiers("a.js", "a = 1;\n  --> plantedHtml\nb = 2;\n", 1, 3)).toBeUndefined();
    expect(lexIdentifiers("a.ts", "x = a<!--b;\n", 1, 1)).toBeUndefined();
    expect(lexIdentifiers("a.js", "x = a-->b;\n", 1, 1)).toEqual(["x", "a", "b"]);
  });
  it("JSX is unknown: .tsx and .jsx are not lexed, and a .js file with an element where an expression starts fails; a comparison does not", () => {
    expect(lexIdentifiers("a.tsx", "const e = 1;\n", 1, 1)).toBeUndefined();
    expect(lexIdentifiers("a.jsx", "const e = 1;\n", 1, 1)).toBeUndefined();
    expect(lexIdentifiers("a.js", "const e = <div>plantedJsx</div>;\n", 1, 1)).toBeUndefined();
    expect(lexIdentifiers("a.js", "const e = <>plantedJsx</>;\n", 1, 1)).toBeUndefined();
    expect(lexIdentifiers("a.js", "const e = a < b && c > d;\n", 1, 1)).toEqual(["const", "e", "a", "b", "c", "d"]);
    clean("a.ts", "const e = f<T>(x);\n");
  });
});

describe("Python", () => {
  it("drops # comments, docstrings (triple quotes of both kinds) and f-strings whole", () => {
    const text = ['def f(x):', '    """Docstring with hidden_doc', '    more_hidden"""', "    y = f\"{x} hidden_f\"  # trailing_comment", "    z = '''a", "b'''", "    return real_name"].join("\n");
    expect(ids("m.py", text)).toEqual(["def", "f", "x", "y", "z", "return", "real_name"]);
  });
  it("a hash inside a string is not a comment", () => {
    expect(ids("m.py", 'a = "x # y"\nb = 1')).toEqual(["a", "b"]);
  });
  it("an unterminated triple quote is a failure", () => {
    expect(ids("m.py", 'a = """open')).toBeUndefined();
  });
});

describe("other languages", () => {
  it("Lua: -- comments, --[[ ]] and --[==[ ]==] blocks and [[ ]] strings", () => {
    const text = ["local a = 1 -- note_one", "--[[ block", "hidden_a ]]", "--[==[ x ]] still", "hidden_b ]==] local b = [[", "hidden_str]]", "local c = 3"].join("\n");
    expect(ids("a.lua", text)).toEqual(["local", "a", "local", "b", "local", "c"]);
  });
  it("HTML and XML: comments dropped, text nodes dropped, only tag and attribute names count", () => {
    const text = ['<!-- hidden_comment', "still -->", '<div class="hidden_class" data-id=hidden_unq>', "prose words here", "</div>"].join("\n");
    expect(ids("a.html", text)).toEqual(["div", "class", "data", "id", "div"]);
  });
  it("Shell is not lexed at all: a bare word is code there, so nothing in a script is verified", () => {
    for (const path of ["run.sh", "run.bash", "run.zsh"]) expect(lexIdentifiers(path, "echo plantedShell words\n", 1, 1)).toBeUndefined();
  });
  it("-- comments, block comments and single-quoted strings with doubled quotes", () => {
    expect(ids("q.sql", ["select a, 'it''s hidden' from t -- gone", "/* hidden_b */ where c = 1;"].join("\n"))).toEqual(["select", "a", "from", "t", "where", "c"]);
  });
  it("an unknown extension, or a file with no extension, is not lexed", () => {
    expect(ids("README.md", "plain words")).toBeUndefined();
    expect(ids("notes.txt", "plain words")).toBeUndefined();
    expect(ids("Makefile", "all:")).toBeUndefined();
    expect(ids("conf.yaml", "a: b")).toBeUndefined();
    expect(ids("a.rb", "puts 1")).toBeUndefined();
  });
});

describe("the cited range", () => {
  it("returns only the tokens that start inside the range, and refuses a bad or long range", () => {
    const text = Array.from({ length: 200 }, (_, i) => `name${i}();`).join("\n");
    expect(ids("a.ts", text, 3, 4)).toEqual(["name2", "name3"]);
    expect(ids("a.ts", text, 0, 4)).toBeUndefined();
    expect(ids("a.ts", text, 5, 4)).toBeUndefined();
    expect(ids("a.ts", text, 1, 82)).toBeUndefined();
    expect(ids("a.ts", text, 1, 80)?.length).toBe(80);
    expect(ids("a.ts", text, 150, 201)).toBeUndefined();
  });
  it("windows line endings are one line end", () => {
    expect(ids("a.ts", "a1();\r\nb2();\r\n", 2, 2)).toEqual(["b2"]);
  });
});
