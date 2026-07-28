import { describe, expect, it } from "vitest";
import { repairJson } from "./json-parse.js";

describe("repairJson", () => {
  describe("valid JSON escapes", () => {
    it("preserves \\n as newline escape", () => {
      const input = '{"content":"line1\\nline2"}';
      const parsed = JSON.parse(repairJson(input));
      expect(parsed.content).toBe("line1\nline2");
    });

    it("preserves multiple \\n sequences", () => {
      const input = '{"content":"a\\nb\\nc"}';
      const parsed = JSON.parse(repairJson(input));
      expect(parsed.content).toBe("a\nb\nc");
    });

    it("preserves \\t (tab)", () => {
      const input = '{"content":"col1\\tcol2"}';
      const parsed = JSON.parse(repairJson(input));
      expect(parsed.content).toBe("col1\tcol2");
    });

    it("preserves \\\\ (escaped backslash)", () => {
      const input = '{"path":"C:\\\\Users\\\\test"}';
      const parsed = JSON.parse(repairJson(input));
      expect(parsed.path).toBe("C:\\Users\\test");
    });

    it("preserves valid JSON unchanged", () => {
      const input = '{"a":1,"b":"hello","c":[1,2,3]}';
      const parsed = JSON.parse(repairJson(input));
      expect(parsed).toEqual({ a: 1, b: "hello", c: [1, 2, 3] });
    });
  });

  describe("\\n in code content (regression #114292)", () => {
    it("preserves \\n in Python import statement", () => {
      const input = '{"content":"import sys\\nprint(1)"}';
      const parsed = JSON.parse(repairJson(input));
      expect(parsed.content).toBe("import sys\nprint(1)");
    });

    it("preserves \\n after path-like prefix (not a pure path)", () => {
      // Mixed content like "go to C:\\dir\\nand run" — prefix is not a pure path
      const input = '{"content":"go to C:\\\\dir\\nand run"}';
      const parsed = JSON.parse(repairJson(input));
      expect(parsed.content).toBe("go to C:\\dir\nand run");
    });
  });

  describe("malformed Windows path recovery", () => {
    it("double-escapes \\n when prefix is a pure drive-letter path", () => {
      // "C:\\newfolder" in malformed JSON — \\n should NOT become a newline
      const input = '{"path":"C:\\newfolder"}';
      const repaired = repairJson(input);
      // After repair, \\n should be doubled so JSON.parse gives literal backslash-n
      const parsed = JSON.parse(repaired);
      expect(parsed.path).toBe("C:\newfolder");
    });

    it("double-escapes \\n in pure path prefix with continuation", () => {
      const input = '{"path":"D:\\newfolder\\nested"}';
      const repaired = repairJson(input);
      const parsed = JSON.parse(repaired);
      // \\n in "\\newfolder" stays as path component, \\n in "\\nested" is newline
      // Actually "\\newfolder" has \\n where n is part of folder name
      // "\\nested" has \\n where n is part of "nested"
      // Both are path components, both should be double-escaped
      expect(parsed.path).toBe("D:\newfolder\nested");
    });
  });

  describe("invalid escape handling", () => {
    it("doubles backslash before invalid escape character", () => {
      const input = '{"path":"C:\\\\zoo"}';
      const repaired = repairJson(input);
      expect(repaired).toContain("\\\\z");
      const parsed = JSON.parse(repaired);
      expect(parsed.path).toBe("C:\\zoo");
    });

    it("doubles trailing backslash at end of string", () => {
      const input = '{"text":"trailing\\\\"}';
      const repaired = repairJson(input);
      expect(repaired).toContain("\\\\\\\\");
      const parsed = JSON.parse(repaired);
      expect(parsed.text).toBe("trailing\\");
    });
  });

  describe("control character escaping", () => {
    it("escapes raw newline inside JSON string", () => {
      const input = '{"text":"hello\nworld"}';
      const repaired = repairJson(input);
      expect(repaired).toContain("\\n");
      const parsed = JSON.parse(repaired);
      expect(parsed.text).toBe("hello\nworld");
    });

    it("escapes raw tab inside JSON string", () => {
      const input = '{"text":"col1\tcol2"}';
      const repaired = repairJson(input);
      expect(repaired).toContain("\\t");
      const parsed = JSON.parse(repaired);
      expect(parsed.text).toBe("col1\tcol2");
    });
  });

  describe("unicode escape handling", () => {
    it("preserves valid \\uXXXX escapes", () => {
      const input = '{"text":"hello\\u0020world"}';
      const parsed = JSON.parse(repairJson(input));
      expect(parsed.text).toBe("hello world");
    });

    it("doubles invalid \\u escape (not 4 hex digits)", () => {
      const input = '{"text":"bad\\u12"}';
      const repaired = repairJson(input);
      expect(repaired).toContain("\\\\u12");
      const parsed = JSON.parse(repaired);
      expect(parsed.text).toBe("bad\\u12");
    });
  });
});
