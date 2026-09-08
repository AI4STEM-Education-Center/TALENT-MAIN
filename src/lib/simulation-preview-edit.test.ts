import { expect, it } from "vitest";
import { readPreviewEdit } from "./simulation-preview-edit";

/**
 * The sandbox holds an AI-generated document and whatever a teacher typed into
 * it, so this boundary is the one place that decides what is allowed to become
 * a staged patch.
 */
it("reads each edit the preview can commit", () => {
  expect(
    readPreviewEdit({
      type: "simulation-text-edit",
      token: "text:1",
      before: "Wave speed",
      after: "Wave lab",
    }),
  ).toEqual({
    kind: "text",
    token: "text:1",
    before: "Wave speed",
    after: "Wave lab",
  });
  expect(
    readPreviewEdit({
      type: "simulation-formula-add",
      token: "new:1",
      after: 2,
      latex: "E = K",
      display: "inline",
    }),
  ).toEqual({
    kind: "formula-add",
    token: "new:1",
    anchor: 2,
    latex: "E = K",
    display: "inline",
  });
  expect(
    readPreviewEdit({
      type: "simulation-formula-delete",
      token: "formula:0",
      index: 0,
    }),
  ).toEqual({ kind: "formula-delete", token: "formula:0", index: 0 });
});

it("refuses anything malformed rather than staging it", () => {
  const cases = [
    null,
    "not an object",
    { type: "simulation-text-edit", before: "a", after: "b" }, // no token
    { type: "simulation-text-edit", token: "t", before: "a" }, // no after
    { type: "simulation-formula-edit", token: "t", latex: "x" }, // no index
    { type: "simulation-formula-edit", token: "t", index: -1, latex: "x" },
    { type: "simulation-formula-edit", token: "t", index: 1.5, latex: "x" },
    { type: "simulation-text-edit", token: "t", before: "a", after: "" },
    { type: "sim-formula-painted", token: "t" }, // inbound, never inbound-parsed
  ];
  for (const value of cases) expect(readPreviewEdit(value)).toBeNull();
});

it("caps the strings it will carry", () => {
  expect(
    readPreviewEdit({
      type: "simulation-text-edit",
      token: "t",
      before: "a",
      after: "x".repeat(2001),
    }),
  ).toBeNull();
  expect(
    readPreviewEdit({
      type: "simulation-formula-edit",
      token: "t",
      index: 0,
      latex: "x".repeat(501),
    }),
  ).toBeNull();
});

it("defaults an unrecognised display to block", () => {
  expect(
    readPreviewEdit({
      type: "simulation-formula-add",
      token: "new:1",
      after: 0,
      latex: "E = K",
      display: "sideways",
    }),
  ).toMatchObject({ display: "block" });
});
