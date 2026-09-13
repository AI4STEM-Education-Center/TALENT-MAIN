// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SimulationEditor } from "./SimulationEditor";
import type {
  SimulationPreviewChange,
  SimulationPreviewEdit,
} from "@/lib/simulation-preview-edit";
let preview: {
  editable?: boolean;
  editMode?: boolean;
  onPreviewEdit?: (edit: SimulationPreviewEdit) => void;
} = {};
const painted: (string | null)[] = [];
/** Feed the editor an edit the way the sandboxed preview would. */
function commit(change: SimulationPreviewChange) {
  preview.onPreviewEdit?.({
    ...change,
    paint: (html) => painted.push(html),
  });
}
vi.mock("./SimulationViewer", () => ({
  SimulationViewer: (props: {
    selectedVersion: number;
    editable?: boolean;
    editMode?: boolean;
    onPreviewEdit?: (edit: SimulationPreviewEdit) => void;
  }) => {
    preview = props;
    return <div data-preview={props.selectedVersion}>Preview</div>;
  },
}));
vi.mock("@/components/guardrails/GuardrailFeedbackButton", () => ({
  GuardrailFeedbackButton: () => null,
}));
let root: Root;
let host: HTMLDivElement;
const plan = {
  message: "Choose a learning direction",
  name: "Explore speed",
  revisionPrompt: "",
  questions: [
    {
      question: "Which direction?",
      options: ["Explore speed", "Compare periods"],
    },
  ],
};
const versions = [
  { number: 1, name: "Original", parentNumber: null },
  { number: 2, name: "Explore speed", parentNumber: 1 },
];
const formulas = [
  { index: 0, latex: "v = f\\lambda", display: "block" },
  { index: 1, latex: "T = 1/f", display: "block" },
];
const chats = [
  {
    id: "chat1",
    baseVersion: 1,
    state: "DISCUSSING",
    transcript: JSON.stringify([
      { role: "assistant", content: JSON.stringify(plan) },
    ]),
    plan: JSON.stringify(plan),
  },
];
const fetchMock = vi.fn();
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset().mockImplementation(async (_url, options) => ({
    ok: true,
    json: async () =>
      options
        ? { aborted: true }
        : {
            versions,
            chats,
            formulas,
            assistant: { enabled: true, model: "test-model" },
          },
  }));
  painted.length = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function render(version = 1) {
  await act(async () =>
    root.render(
      <SimulationEditor
        id="sim"
        version={version}
        revising={false}
        onRefresh={async () => {}}
      />,
    ),
  );
}
/** React tracks the last value it wrote, so set through the native setter. */
function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
function button(text: string) {
  const result = [...host.querySelectorAll("button")].find(
    (b) => b.textContent === text,
  );
  if (!result) throw new Error(`Missing button ${text}`);
  return result;
}
it("offers None of the above and sends selected answers through chat", async () => {
  await render();
  expect(button("Send answers").disabled).toBe(true);
  await act(async () => button("None of the above").click());
  expect(button("Send answers").disabled).toBe(false);
  await act(async () => button("Send answers").click());
  const call = fetchMock.mock.calls.find(
    ([, options]) => options?.method === "POST",
  );
  expect(JSON.parse(call?.[1].body)).toMatchObject({
    action: "chat",
    version: 1,
    chatId: "chat1",
    message: "Which direction?: None of the above",
  });
});
it("aborts the current proposal and follows the new live version after generation", async () => {
  await render();
  await act(async () => button("Abort this edit").click());
  const call = fetchMock.mock.calls.find(
    ([, options]) => options?.method === "POST",
  );
  expect(JSON.parse(call?.[1].body)).toMatchObject({
    action: "abort",
    chatId: "chat1",
  });
  await render(2);
  expect(
    host.querySelector("[data-preview]")?.getAttribute("data-preview"),
  ).toBe("2");
  expect((host.querySelector("select") as HTMLSelectElement).value).toBe("2");
  expect(host.textContent).toContain("What else would you like to change?");
});

/** Enter edit mode, which is what arms the preview. */
async function startEditing() {
  await act(async () => button("Edit").click());
}

it("leaves the preview unarmed until Edit is clicked", async () => {
  await render();
  expect(preview.editable).toBe(true);
  expect(preview.editMode).toBe(false);
  await startEditing();
  expect(preview.editMode).toBe(true);
  expect(button("Save edits").disabled).toBe(true);
});

// The workflow the redesign is for: correct several things, then save once.
it("stages several edits of different kinds and saves them as one batch", async () => {
  await render();
  await startEditing();
  await act(async () =>
    commit({
      kind: "text",
      token: "text:1",
      before: "Wave speed",
      after: "Wave lab",
    }),
  );
  await act(async () =>
    commit({
      kind: "formula-edit",
      token: "formula:1",
      index: 1,
      latex: "T = 2/f",
      display: "block",
    }),
  );
  await act(async () =>
    commit({ kind: "formula-delete", token: "formula:0", index: 0 }),
  );
  await act(async () =>
    commit({
      kind: "formula-add",
      token: "new:1",
      anchor: 1,
      latex: "E = K + U",
      display: "block",
    }),
  );

  expect(
    host.querySelectorAll('[aria-label="Pending direct edits"] li'),
  ).toHaveLength(4);

  fetchMock.mockClear();
  await act(async () => button("Save 4 edits").click());
  const call = fetchMock.mock.calls.find(
    ([, options]) => options?.method === "POST",
  );
  expect(JSON.parse(call?.[1].body)).toMatchObject({
    action: "patch",
    version: 1,
    patches: [
      { kind: "text", before: "Wave speed", after: "Wave lab" },
      { kind: "formula-edit", index: 1, latex: "T = 2/f" },
      { kind: "formula-delete", index: 0 },
      { kind: "formula-add", latex: "E = K + U", display: "block", after: 1 },
    ],
  });
  // Saving closes edit mode and clears the batch.
  expect(preview.editMode).toBe(false);
  expect(host.querySelector('[aria-label="Pending direct edits"]')).toBeNull();
});

// Every patch resolves against the original document, so a second edit of one
// target has to replace the first rather than stack a second entry.
it("replaces a re-edited target instead of stacking it", async () => {
  await render();
  await startEditing();
  for (const after of ["Wave lab", "Wave bench"])
    await act(async () =>
      commit({ kind: "text", token: "text:1", before: "Wave speed", after }),
    );
  for (const latex of ["T = 2/f", "T = 3/f"])
    await act(async () =>
      commit({
        kind: "formula-edit",
        token: "formula:1",
        index: 1,
        latex,
        display: "block",
      }),
    );

  fetchMock.mockClear();
  await act(async () => button("Save 2 edits").click());
  const call = fetchMock.mock.calls.find(
    ([, options]) => options?.method === "POST",
  );
  expect(JSON.parse(call?.[1].body).patches).toEqual([
    { kind: "text", before: "Wave speed", after: "Wave bench" },
    { kind: "formula-edit", index: 1, latex: "T = 3/f" },
  ]);
});

it("drops an edit that was undone in the preview", async () => {
  await render();
  await startEditing();
  await act(async () =>
    commit({
      kind: "text",
      token: "text:1",
      before: "Wave speed",
      after: "Wave lab",
    }),
  );
  await act(async () =>
    commit({
      kind: "formula-add",
      token: "new:1",
      anchor: 0,
      latex: "E = K",
      display: "block",
    }),
  );
  expect(
    host.querySelectorAll('[aria-label="Pending direct edits"] li'),
  ).toHaveLength(2);

  await act(async () => commit({ kind: "text-revert", token: "text:1" }));
  await act(async () => commit({ kind: "formula-drop", token: "new:1" }));
  expect(host.querySelector('[aria-label="Pending direct edits"]')).toBeNull();
  expect(button("Save edits").disabled).toBe(true);
});

it("renders a committed formula back into the preview", async () => {
  await render();
  await startEditing();
  await act(async () =>
    commit({
      kind: "formula-edit",
      token: "formula:1",
      index: 1,
      latex: "T = 2/f",
      display: "block",
    }),
  );
  expect(painted).toHaveLength(1);
  expect(painted[0]).toContain("<math");
});

it("says so when a committed formula cannot be rendered", async () => {
  await render();
  await startEditing();
  await act(async () =>
    commit({
      kind: "formula-edit",
      token: "formula:1",
      index: 1,
      latex: "T = \\frac{",
      display: "block",
    }),
  );
  expect(painted).toEqual([null]);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "KaTeX cannot render it",
  );
  // Still staged, so the teacher can fix or discard it rather than lose it.
  expect(
    host.querySelectorAll('[aria-label="Pending direct edits"] li'),
  ).toHaveLength(1);
});

it("throws the batch away and remounts the preview on Cancel", async () => {
  await render();
  await startEditing();
  await act(async () =>
    commit({
      kind: "text",
      token: "text:1",
      before: "Wave speed",
      after: "Wave lab",
    }),
  );
  const before = host.querySelector("[data-preview]");
  await act(async () => button("Cancel").click());

  expect(preview.editMode).toBe(false);
  expect(host.querySelector('[aria-label="Pending direct edits"]')).toBeNull();
  // A fresh node means the iframe was remounted, discarding on-screen edits.
  expect(host.querySelector("[data-preview]")).not.toBe(before);
  expect(button("Edit")).toBeTruthy();
});

// A gateway page or a login redirect answers with HTML, and res.json() on that
// used to surface as "Unexpected token '<'" — a dead end for a teacher.
it("explains a response that is not JSON instead of leaking a parse error", async () => {
  await render();
  fetchMock.mockImplementation(async (_url, options) =>
    options
      ? {
          ok: false,
          status: 504,
          json: async () => {
            throw new SyntaxError(`Unexpected token '<', "<!DOCTYPE "...`);
          },
        }
      : {
          ok: true,
          json: async () => ({
            versions,
            chats,
            formulas,
            assistant: { enabled: true, model: "test-model" },
          }),
        },
  );
  await act(async () => button("Abort this edit").click());

  const alert = host.querySelector('[role="alert"]')?.textContent ?? "";
  expect(alert).toContain("HTTP 504");
  expect(alert).toContain("check the version list");
  expect(alert).not.toContain("Unexpected token");
  // The outcome is unknown, so the history is reloaded rather than guessed at.
  expect(
    fetchMock.mock.calls.filter(([, options]) => !options).length,
  ).toBeGreaterThan(1);
});

it("shows the server's own message when a version load is refused", async () => {
  fetchMock.mockImplementation(async () => ({
    ok: false,
    status: 401,
    json: async () => ({ error: "Your session has expired." }),
  }));
  await render();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "Your session has expired.",
  );
});
