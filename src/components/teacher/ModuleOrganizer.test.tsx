// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ModuleOrganizer } from "./ModuleOrganizer";
import type { ModuleLayout } from "@/lib/class-modules";
vi.mock("@/components/ui/confirm-dialog", () => ({
  useConfirm: () => async () => true,
}));
const fetchMock = vi.fn();
const onSaved = vi.fn(async () => {});
let host: HTMLDivElement;
let root: Root;
const quizzes = [
  {
    id: "q1",
    name: "Newton",
    topic: { id: "physics", name: "Physics" },
    _count: { questions: 5 },
  },
  { id: "q2", name: "Energy", topic: null, _count: { questions: 3 } },
  { id: "q3", name: "Momentum", topic: null, _count: { questions: 4 } },
];
const initialLayout: ModuleLayout = {
  revision: 2,
  modules: [
    {
      id: "midterm",
      name: "Midterm Prep",
      description: "First half",
      quizIds: ["q1", "q2"],
    },
    { id: "final", name: "Final Prep", description: "", quizIds: [] },
  ],
};
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.stubGlobal("fetch", fetchMock);
  onSaved.mockClear();
  fetchMock.mockReset().mockImplementation(async (_url, init) => {
    const body = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => ({ ...body, revision: body.revision + 1 }),
    };
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () =>
    root.render(
      <ModuleOrganizer
        classId="class1"
        initialLayout={initialLayout}
        quizzes={quizzes}
        assignedQuizIds={["q1", "q2"]}
        renderQuiz={(id) => (
          <span>{quizzes.find((q) => q.id === id)?.name}</span>
        )}
        onSaved={onSaved}
      />,
    ),
  );
}
function button(text: string) {
  const match = [...document.querySelectorAll("button")].find(
    (b) =>
      b.textContent?.trim() === text || b.getAttribute("aria-label") === text,
  );
  if (!match) throw new Error(`Missing button: ${text}`);
  return match;
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
}
async function selectQuiz() {
  await click(
    host.querySelector<HTMLInputElement>(
      '[aria-label="Select Newton in Midterm Prep"]',
    )!,
  );
}
async function destination() {
  await act(async () => {
    const select = host.querySelector<HTMLSelectElement>(
      '[aria-label="Destination module"]',
    )!;
    select.value = "final";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
function submitted(index = 0) {
  return JSON.parse(fetchMock.mock.calls[index][1].body) as ModuleLayout;
}

it("selects and moves a quiz, then undoes with the current revision", async () => {
  await render();
  await selectQuiz();
  await destination();
  await click(button("Move to module"));
  expect(submitted()).toMatchObject({
    revision: 2,
    modules: [{ quizIds: ["q2"] }, { quizIds: ["q1"] }],
  });
  expect(onSaved).toHaveBeenCalledOnce();
  await click(button("Undo"));
  expect(submitted(1)).toEqual({ ...initialLayout, revision: 3 });
});
it("reuses a quiz without removing its original membership", async () => {
  await render();
  await selectQuiz();
  await destination();
  await click(button("Add to another module"));
  expect(submitted().modules.map((m) => m.quizIds)).toEqual([
    ["q1", "q2"],
    ["q1"],
  ]);
});
it("rolls back failed moves, preserves selection and allows retry", async () => {
  fetchMock.mockRejectedValueOnce(new Error("Offline"));
  await render();
  await selectQuiz();
  await destination();
  await click(button("Move to module"));
  expect(host.textContent).toContain("Offline");
  expect(
    host.querySelector<HTMLInputElement>(
      '[aria-label="Select Newton in Midterm Prep"]',
    )?.checked,
  ).toBe(true);
  expect(button("Move to module").disabled).toBe(false);
  await click(button("Move to module"));
  expect(submitted(1).revision).toBe(2);
});
it("blocks stale writes until modules are reloaded", async () => {
  fetchMock.mockResolvedValueOnce({
    ok: false,
    status: 409,
    json: async () => ({ error: "Modules changed in another tab." }),
  });
  await render();
  await selectQuiz();
  await destination();
  await click(button("Move to module"));
  expect(button("Move to module").disabled).toBe(true);
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ ...initialLayout, revision: 5 }),
  });
  await click(button("Reload modules"));
  await selectQuiz();
  await destination();
  await click(button("Move to module"));
  expect(submitted(2).revision).toBe(5);
});
it("offers keyboard-operable ordering and preserves module metadata", async () => {
  await render();
  await click(button("Move Energy up in Midterm Prep"));
  expect(submitted().modules[0]).toEqual({
    ...initialLayout.modules[0],
    quizIds: ["q2", "q1"],
  });
  await click(button("Move Final Prep up"));
  expect(submitted(1).modules.map((m) => m.id)).toEqual(["final", "midterm"]);
});
it("adds a library quiz through the picker and keeps the existing module members", async () => {
  await render();
  await click(button("Add quizzes"));
  const label = [...document.querySelectorAll("label")].find((label) =>
    label.textContent?.includes("Momentum"),
  )!;
  expect(label.textContent).toContain("Will be added as draft");
  await click(label.querySelector("input")!);
  await click(button("Add selected quizzes (1)"));
  expect(submitted().modules[0].quizIds).toEqual(["q1", "q2", "q3"]);
});
it("dragging a selected group moves the group to the destination", async () => {
  await render();
  await selectQuiz();
  await click(
    host.querySelector<HTMLInputElement>(
      '[aria-label="Select Energy in Midterm Prep"]',
    )!,
  );
  const dataTransfer = { effectAllowed: "", dropEffect: "", setData: vi.fn() };
  await act(async () => {
    const event = new Event("dragstart", { bubbles: true });
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
    button(
      "Drag Newton; use selection and move buttons as an alternative",
    ).dispatchEvent(event);
  });
  await act(async () => {
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
    host.querySelector('[aria-label="Final Prep"]')!.dispatchEvent(event);
  });
  expect(submitted().modules.map((m) => m.quizIds)).toEqual([[], ["q1", "q2"]]);
});
it("deletes only a module and makes its quizzes available under Other quizzes", async () => {
  await render();
  await click(button("Delete Midterm Prep"));
  expect(submitted().modules.map((m) => m.id)).toEqual(["final"]);
  expect(
    host.querySelector('[aria-label="Select Newton in Other quizzes"]'),
  ).not.toBeNull();
  expect(
    host.querySelector('[aria-label="Select Energy in Other quizzes"]'),
  ).not.toBeNull();
});
