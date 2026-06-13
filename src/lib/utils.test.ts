import { describe, it, expect } from "vitest";
import { cn } from "./utils";

describe("cn", () => {
  it("joins plain class names with spaces", () => {
    expect(cn("a", "b")).toBe("a b");
  });

  it("drops falsy values (false, null, undefined, empty string)", () => {
    expect(cn("a", false, null, undefined, "", "b")).toBe("a b");
  });

  it("supports clsx's conditional object syntax", () => {
    expect(cn("base", { active: true, disabled: false })).toBe("base active");
  });

  it("flattens nested arrays", () => {
    expect(cn(["a", "b"], "c")).toBe("a b c");
  });

  it("merges conflicting tailwind utilities so the last one wins", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
    expect(cn("text-sm text-lg")).toBe("text-lg");
  });

  it("returns an empty string with no inputs", () => {
    expect(cn()).toBe("");
  });
});
