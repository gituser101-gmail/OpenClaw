import { describe, expect, it } from "vitest";
import { repairJson } from "./json-parse.js";

describe("repairJson", () => {
  describe("valid JSON escapes", () => {
    it("preserves \\n as newline escape", () => {
      const input = '{"content":"line1\\nline2"}';
      const parsed = JSON.parse(repairJson(input));
      expect(parsed.content).toBe("line1\nline2");
    });

    it("preserves multiple \\n in code", () => {
      const input = '{"content":"import sys\\nprint(1)"}';
      const parsed = JSON.parse(repairJson(input));
      expect(parsed.content).toBe("import sys\nprint(1)");
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
    it("preserves \\n in Python multi-line script", () => {
      const input = '{"content":"def foo():\\n    return 1\\n"}';
      const parsed = JSON.parse(repairJson(input));
      expect(parsed.content).toBe("def foo():\n    return 1\n");
    });

    it("preserves \\n after path-like prefix (mixed content)", () => {
      const input = '{"content":"go to C:\\\\dir\\nand run"}';
      const parsed = JSON.parse(repairJson(input));
      expect(parsed.content).toBe("go to C:\\dir\nand run");
    });
  });

  describe("invalid escape handling", () => {
    it("doubles backslash before invalid escape", () => {
      const input = '{"text":"bad\\z"}';
      const repaired = repairJson(input);
      const parsed = JSON.parse(repaired);
      expect(parsed.text).toBe("bad\\z");
    });

    it("doubles trailing backslash", () => {
      const input = '{"text":"trailing\\\\"}';
      const repaired = repairJson(input);
      const parsed = JSON.parse(repaired);
      expect(parsed.text).toBe("trailing\\");
    });
  });

  describe("control character escaping", () => {
    it("escapes raw newline in JSON string", () => {
      const input = '{"text":"hello\nworld"}';
      const repaired = repairJson(input);
      expect(repaired).toContain("\\n");
      const parsed = JSON.parse(repaired);
      expect(parsed.text).toBe("hello\nworld");
    });

    it("escapes raw tab in JSON string", () => {
      const input = '{"text":"col1\tcol2"}';
      const repaired = repairJson(input);
      expect(repaired).toContain("\\t");
      const parsed = JSON.parse(repaired);
      expect(parsed.text).toBe("col1\tcol2");
    });
  });

  describe("unicode escape handling", () => {
    it("preserves valid \\uXXXX", () => {
      const input = '{"text":"hello\\u0020world"}';
      const parsed = JSON.parse(repairJson(input));
      expect(parsed.text).toBe("hello world");
    });

    it("doubles invalid \\u escape", () => {
      const input = '{"text":"bad\\u12"}';
      const repaired = repairJson(input);
      expect(repaired).toContain("\\\\u12");
      const parsed = JSON.parse(repaired);
      expect(parsed.text).toBe("bad\\u12");
    });
  });
});
