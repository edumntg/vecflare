import { describe, expect, it } from "vitest";
// Plain browser module; it has no DOM dependency at import time.
// @ts-ignore no declaration file for the dashboard script
import { lintJson, inferValue, valueToField, checkFilterShape } from "../ui/editors.js";

describe("json lint", () => {
  it("accepts valid documents", () => {
    expect(lintJson(' {"a": [1, 2.5e3, null, true, "s\\n"]} ')).toEqual({ ok: true, value: { a: [1, 2500, null, true, "s\n"] } });
  });
  it("reports line and column of the first problem", () => {
    expect(lintJson('{\n  "a": 1\n  "b": 2\n}')).toMatchObject({ ok: false, line: 3, col: 3 });
    expect(lintJson("{a:1}")).toMatchObject({ ok: false, line: 1, col: 2, message: expect.stringContaining("quoted key") });
    expect(lintJson('{"a":1,}')).toMatchObject({ ok: false, message: "trailing comma before }" });
    expect(lintJson("{'a': 1}")).toMatchObject({ ok: false, message: "strings must use double quotes" });
    expect(lintJson("[1,2")).toMatchObject({ ok: false, message: "unterminated array" });
    expect(lintJson("")).toMatchObject({ ok: false, empty: true });
  });
});

describe("value inference", () => {
  it("round-trips through the field text", () => {
    for (const v of [42, true, null, "hello", [1, 2], { x: 1 }, "42", "", "true"]) {
      expect(inferValue(valueToField(v))).toEqual(v);
    }
  });
});

describe("filter shape", () => {
  it("mirrors the server grammar", () => {
    expect(checkFilterShape(["And", [["a", "Eq", 1], ["b", "In", [1]]]])).toBeNull();
    expect(checkFilterShape(["Not", ["a", "Eq", 1]])).toBeNull();
    expect(checkFilterShape(["a", "In", 1])).toContain("array");
    expect(checkFilterShape(["a", "Like", 1])).toContain("unknown op");
    expect(checkFilterShape(["And", []])).toContain("non-empty");
  });
});
