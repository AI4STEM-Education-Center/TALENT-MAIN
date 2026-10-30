// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SimulationRail } from "./SimulationRail";
import type { SimulationRecommendationView } from "@/lib/exam-results";

vi.mock("@/components/simulation/SimulationDialog", () => ({
  SimulationDialog: ({
    simulation,
    onClose,
  }: {
    simulation: { title: string };
    onClose: () => void;
  }) => (
    <div role="dialog">
      {simulation.title}
      <button onClick={onClose}>Close</button>
    </div>
  ),
}));

let host: HTMLDivElement;
let root: Root;
const sims: SimulationRecommendationView[] = [
  {
    simulationId: "gone",
    title: "Deleted",
    topic: null,
    learningGoal: null,
    unavailable: true,
  },
  { simulationId: "first", title: "Pendulum", topic: null, learningGoal: null },
  { simulationId: "second", title: "Gravity", topic: null, learningGoal: null },
];
const dialog = () => host.querySelector('[role="dialog"]');
const render = async (simulations = sims, autoOpen = true) => {
  await act(async () =>
    root.render(
      <StrictMode>
        <SimulationRail simulations={simulations} autoOpen={autoOpen} />
      </StrictMode>,
    ),
  );
};
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it("automatically opens the first available simulation", async () => {
  await render();
  expect(dialog()?.textContent).toContain("Pendulum");
});

it("opens when recommendations arrive later and stays closed after dismissal", async () => {
  await render([]);
  expect(dialog()).toBeNull();
  await render([sims[0]]);
  expect(dialog()).toBeNull();
  await render();
  expect(dialog()).not.toBeNull();
  await act(async () =>
    (dialog()!.querySelector("button") as HTMLElement).click(),
  );
  await render([...sims]);
  expect(dialog()).toBeNull();
  await act(async () =>
    (
      host.querySelectorAll('[aria-haspopup="dialog"]')[1] as HTMLElement
    ).click(),
  );
  expect(dialog()?.textContent).toContain("Gravity");
});

it("keeps other results views collapsed until clicked", async () => {
  await render(sims, false);
  expect(dialog()).toBeNull();
  await act(async () =>
    (host.querySelector('[aria-haspopup="dialog"]') as HTMLElement).click(),
  );
  expect(dialog()?.textContent).toContain("Pendulum");
});

it("does not open on top of another pop-up the student already opened", async () => {
  await render([]);
  const other = document.createElement("div");
  other.setAttribute("role", "dialog");
  document.body.appendChild(other);
  await render();
  other.remove();
  expect(dialog()).toBeNull();
  await render([...sims]);
  expect(dialog()).toBeNull();
});
