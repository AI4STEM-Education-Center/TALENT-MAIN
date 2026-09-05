// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SimulationEditor } from "./SimulationEditor";
let preview: {
  editable?: boolean;
  onTextEdit?: (before: string, after: string) => void;
  onFormulaPick?: (index: number) => void;
} = {};
vi.mock("./SimulationViewer", () => ({
  SimulationViewer: (props: {
    selectedVersion: number;
    editable?: boolean;
    onTextEdit?: (before: string, after: string) => void;
    onFormulaPick?: (index: number) => void;
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

it("stages a preview text edit and an equation change, then applies them without the model", async () => {
  await render();
  expect(preview.editable).toBe(true);

  await act(async () => preview.onTextEdit?.("Wave speed", "Wave lab"));
  await act(async () => preview.onFormulaPick?.(1));
  const latex = host.querySelector(
    'input[aria-label="LaTeX for equation 2"]',
  ) as HTMLInputElement;
  expect(latex.value).toBe("T = 1/f");
  await act(async () => type(latex, "T = 1/f + 1"));
  await act(async () => button("Stage").click());
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('[aria-label="Remove equation 1"]')!
      .click(),
  );

  const staged = [
    ...host.querySelectorAll('[aria-label="Pending direct edits"] li'),
  ].map((li) => li.textContent);
  expect(staged).toHaveLength(3);
  expect(staged[0]).toContain('Replace text "Wave speed" with "Wave lab".');

  fetchMock.mockClear();
  await act(async () => button("Apply as new version").click());
  const call = fetchMock.mock.calls.find(
    ([, options]) => options?.method === "POST",
  );
  expect(JSON.parse(call?.[1].body)).toMatchObject({
    action: "patch",
    version: 1,
    patches: [
      { kind: "text", before: "Wave speed", after: "Wave lab" },
      { kind: "formula-edit", index: 1, latex: "T = 1/f + 1" },
      { kind: "formula-delete", index: 0 },
    ],
  });
});

it("hands staged edits to the chat draft when asked instead", async () => {
  await render();
  await act(async () => preview.onTextEdit?.("Wave speed", "Wave lab"));
  await act(async () => button("Discuss in chat instead").click());
  expect(host.querySelector('[aria-label="Pending direct edits"]')).toBeNull();
  expect(
    (host.querySelector("#simulation-edit-message") as HTMLTextAreaElement)
      .value,
  ).toBe('Replace text "Wave speed" with "Wave lab".');
});

it("names the missing half of the chat setup and keeps direct editing usable", async () => {
  fetchMock.mockImplementation(async (_url, options) => ({
    ok: true,
    json: async () =>
      options
        ? { aborted: true }
        : {
            versions,
            chats: [],
            formulas,
            assistant: { enabled: false, model: null },
          },
  }));
  await render();
  expect(host.textContent).toContain("Simulation Editing Chat");
  expect(host.textContent).toContain("Simulation editing assistant");
  expect(
    (host.querySelector("#simulation-edit-message") as HTMLTextAreaElement)
      .disabled,
  ).toBe(true);
  // The whole point of the notice: the direct controls still work.
  expect(preview.editable).toBe(true);
  expect(host.querySelector('[aria-label="Equations"]')).not.toBeNull();
});
