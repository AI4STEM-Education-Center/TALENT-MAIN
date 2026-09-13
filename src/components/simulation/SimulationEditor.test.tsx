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
function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype,
    "value",
  )!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
/** The chat box, which sends on Enter. */
function messageBox() {
  const box = host.querySelector<HTMLTextAreaElement>(
    "#simulation-edit-message",
  );
  if (!box) throw new Error("Missing message box");
  return box;
}
/** Returns the event so a caller can check whether the editor claimed it. */
function pressEnter(box: HTMLTextAreaElement, shiftKey = false) {
  const event = new KeyboardEvent("keydown", {
    key: "Enter",
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  box.dispatchEvent(event);
  return event;
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
/** Serve a plan that needs no further input, i.e. one ready to build. */
function servePlanReadyToBuild() {
  const ready = {
    ...plan,
    questions: [],
    revisionPrompt: "Stop the motion until Start is clicked.",
  };
  fetchMock.mockImplementation(async (_url: string, options?: RequestInit) => ({
    ok: true,
    json: async () =>
      options
        ? { aborted: true }
        : {
            versions,
            chats: [{ ...chats[0], plan: JSON.stringify(ready) }],
            formulas,
            assistant: { enabled: true, model: "test-model" },
          },
  }));
  return ready;
}
it("says no decisions are needed and names the version a build would create", async () => {
  const ready = servePlanReadyToBuild();
  await render();
  expect(host.textContent).toContain("No decisions needed");
  // What the run will do has to be readable without opening the disclosure.
  expect(host.textContent).toContain(
    `Builds a new version, \u201C${ready.name}\u201D`,
  );
  expect(host.textContent).toContain(ready.revisionPrompt);
  expect(() => button("Send answers")).toThrow();
});
it("applies a ready plan against the selected version", async () => {
  const ready = servePlanReadyToBuild();
  await render();
  await act(async () => button(`Create \u201C${ready.name}\u201D`).click());
  const call = fetchMock.mock.calls.find(
    ([, options]) => options?.method === "POST",
  );
  expect(JSON.parse(call?.[1].body)).toMatchObject({
    action: "apply",
    version: 1,
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
  // The prompt to keep going now lives in the status line, not the transcript.
  expect(host.textContent).toContain("Pick a version above to inspect it");
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

// Teachers write these as quick one-liners, so Enter sends. Shift+Enter has to
// stay with the textarea, or a multi-line instruction can never be typed.
it("sends on Enter and leaves Shift+Enter to the textarea", async () => {
  await render();
  const box = messageBox();

  // An empty box has nothing to send; Enter must not post an invalid request.
  expect(pressEnter(box).defaultPrevented).toBe(true);
  type(box, "Stop the motion until I press start");

  const newline = pressEnter(box, true);
  expect(newline.defaultPrevented).toBe(false);
  expect(
    fetchMock.mock.calls.some(([, options]) => options?.method === "POST"),
  ).toBe(false);

  await act(async () => void pressEnter(box));
  const call = fetchMock.mock.calls.find(
    ([, options]) => options?.method === "POST",
  );
  expect(JSON.parse(call?.[1].body)).toMatchObject({
    action: "chat",
    message: "Stop the motion until I press start",
  });
});

/** An NDJSON body the test drives one event at a time, as the server does. */
function openStream() {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start: (c) => {
      controller = c;
    },
  });
  return {
    body,
    push: (event: unknown) =>
      controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)),
    close: () => controller.close(),
  };
}

// The reply is written a token at a time over minutes, so it has to appear as
// it is written rather than all at once when the turn finally lands.
it("paints the reply while it streams, then hands over to the transcript", async () => {
  await render();
  const stream = openStream();
  fetchMock.mockImplementation(async (_url, options) =>
    options
      ? { ok: true, status: 200, body: stream.body }
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

  type(messageBox(), "Remove the timer");
  await act(async () => void pressEnter(messageBox()));

  await act(async () => stream.push({ type: "delta", text: "Removing " }));
  await act(async () => stream.push({ type: "delta", text: "the timer." }));
  expect(host.querySelector('[role="log"]')?.textContent).toContain(
    "Removing the timer.",
  );
  // Tool activity is what fills the gap while the model works with no prose.
  await act(async () =>
    stream.push({
      type: "tool",
      label: "Reviewing revision plan",
      status: "running",
    }),
  );
  expect(host.querySelector('[role="status"]')?.textContent).toContain(
    "Reviewing revision plan",
  );

  await act(async () => {
    stream.push({
      type: "plan",
      chatId: "chat1",
      plan: { ...plan, message: "Removing the timer." },
    });
    stream.close();
  });
  // The saved transcript has taken over, so the live copy is not left behind
  // to be rendered twice.
  expect(host.querySelector('[role="log"]')?.textContent).not.toContain(
    "Removing the timer.",
  );
  expect(messageBox().value).toBe("");
});

it("reports an error the stream carried instead of leaving the box spinning", async () => {
  await render();
  const stream = openStream();
  fetchMock.mockImplementation(async (_url, options) =>
    options
      ? { ok: true, status: 200, body: stream.body }
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

  type(messageBox(), "Remove the timer");
  await act(async () => void pressEnter(messageBox()));
  await act(async () => {
    stream.push({
      type: "error",
      message: "The assistant took too long to answer.",
      guardrailEventId: null,
    });
    stream.close();
  });

  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "took too long",
  );
  expect(button("Send message").disabled).toBe(false);
});
