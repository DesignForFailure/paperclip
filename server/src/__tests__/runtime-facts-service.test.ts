import { describe, expect, it } from "vitest";
import { normalizeRuntimeFactLimit, sameJson } from "../services/runtime-facts.ts";

describe("runtime fact helpers", () => {
  it("compares JSON without regard to key order, and with regard to array order", () => {
    expect(sameJson({ a: 1, b: { c: [1, 2], d: null } }, { b: { d: null, c: [1, 2] }, a: 1 })).toBe(true);
    expect(sameJson({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(sameJson({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(sameJson({ a: null }, { a: {} })).toBe(false);
    expect(sameJson([], {})).toBe(false);
    expect(sameJson("x", "x")).toBe(true);
  });

  it("bounds the list limit", () => {
    expect(normalizeRuntimeFactLimit(undefined)).toBe(200);
    expect(normalizeRuntimeFactLimit("0")).toBe(200);
    expect(normalizeRuntimeFactLimit("17")).toBe(17);
    expect(normalizeRuntimeFactLimit("999999")).toBe(1000);
    expect(normalizeRuntimeFactLimit("abc")).toBe(200);
  });
});
