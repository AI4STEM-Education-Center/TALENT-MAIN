import { describe, it, expect } from "vitest";
import {
  computeStudentPause,
  DEFAULT_PAUSE_MESSAGE,
  type PauseClass,
} from "@/lib/class-access-pause";
const active: PauseClass = {
  id: "a",
  name: "Active",
  disabledAt: null,
  disabledMessage: null,
};
const disabled: PauseClass = {
  id: "b",
  name: "Disabled",
  disabledAt: new Date("2026-01-01"),
  disabledMessage: null,
};
describe("student pause policy", () => {
  it("does not pause a student without classes", () =>
    expect(computeStudentPause([])).toEqual({
      paused: false,
      message: null,
      classes: [],
    }));
  it("pauses one disabled enrollment", () =>
    expect(computeStudentPause([disabled])).toMatchObject({
      paused: true,
      message: DEFAULT_PAUSE_MESSAGE,
    }));
  it("keeps access through any active enrollment", () =>
    expect(computeStudentPause([active, disabled])).toMatchObject({
      paused: false,
      message: null,
    }));
  it("pauses when all enrolled classes are disabled", () =>
    expect(
      computeStudentPause([disabled, { ...disabled, id: "c" }]).paused,
    ).toBe(true));
  it("prefers the newest custom message, even if a newer class uses the default", () => {
    const classes = [
      { ...disabled, disabledMessage: "Older" },
      {
        ...disabled,
        id: "c",
        disabledAt: new Date("2026-02-01"),
        disabledMessage: "Newer",
      },
      { ...disabled, id: "d", disabledAt: new Date("2026-03-01") },
    ];
    expect(computeStudentPause(classes).message).toBe("Newer");
    expect(classes.map((c) => c.id)).toEqual(["b", "c", "d"]);
  });
  it("ignores active-class and whitespace-only messages", () =>
    expect(
      computeStudentPause([{ ...disabled, disabledMessage: "   " }]).message,
    ).toBe(DEFAULT_PAUSE_MESSAGE));
});
