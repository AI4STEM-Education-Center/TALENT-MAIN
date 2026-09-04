// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SimulationEditor } from "./SimulationEditor";
vi.mock("./SimulationViewer", () => ({
  SimulationViewer: ({ selectedVersion }: { selectedVersion: number }) => (
    <div data-preview={selectedVersion}>Preview</div>
  ),
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
  fetchMock
    .mockReset()
    .mockImplementation(async (_url, options) => ({
      ok: true,
      json: async () => (options ? { aborted: true } : { versions, chats }),
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
