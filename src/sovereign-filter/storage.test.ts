import { describe, expect, it } from "vitest";
import { normalizeRowKey, TABLE_URGENCY, TABLE_ARCHIVE } from "./storage.js";

describe("normalizeRowKey", () => {
  it("encodes slashes", () => {
    expect(normalizeRowKey("a/b/c")).not.toContain("/");
  });

  it("encodes backslashes", () => {
    expect(normalizeRowKey("a\\b")).not.toContain("\\");
  });

  it("encodes hash signs", () => {
    expect(normalizeRowKey("a#b")).not.toContain("#");
  });

  it("encodes question marks", () => {
    expect(normalizeRowKey("a?b")).not.toContain("?");
  });

  it("leaves simple alphanumeric ids unchanged", () => {
    expect(normalizeRowKey("user123")).toBe("user123");
  });

  it("uses $ instead of % for URL encoding", () => {
    const encoded = normalizeRowKey("a/b");
    expect(encoded).toContain("$");
    expect(encoded).not.toContain("%");
  });
});

describe("table name constants", () => {
  it("has correct urgency table name", () => {
    expect(TABLE_URGENCY).toBe("sovereignurgency");
  });

  it("has correct archive table name", () => {
    expect(TABLE_ARCHIVE).toBe("sovereignarchive");
  });
});
