// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildSimulationEditorLayer } from "./simulation-editor-script";

/**
 * The layer is a string injected into an AI-generated document, so the only way
 * to know it works is to run it against a document shaped like one. The cases
 * that matter are the ones the first implementation silently ignored: text
 * sitting beside inline markup, and a rendered formula.
 */
const messages: MessageEvent["data"][] = [];

function record(event: MessageEvent) {
  messages.push(event.data);
}

/** jsdom has no hit testing; point the caret at the node a click would hit. */
function aimCaretAt(node: Node) {
  (
    document as Document & { caretPositionFromPoint: unknown }
  ).caretPositionFromPoint = () => ({
    offsetNode: node,
    offset: 0,
    getClientRect: () => null,
  });
}

function dblclick(target: Element) {
  target.dispatchEvent(
    new MouseEvent("dblclick", { bubbles: true, clientX: 5, clientY: 5 }),
  );
}

function editing() {
  return document.querySelector(".sim-edit-active") as HTMLElement | null;
}

type Registration = [string, EventListenerOrEventListenerObject, unknown];
let listeners: Registration[] = [];

beforeEach(() => {
  document.body.innerHTML = `
<h1>Spring lab</h1>
<p id="legend">Here <b>x</b> is the displacement in metres.</p>
<span class="sim-formula" data-sim-index="1" data-sim-display="block"
      data-sim-latex="U_s = 1"><math><mi>U</mi></math></span>
<button id="pause">Pause</button>`;
  const layer = buildSimulationEditorLayer();
  const script = layer.slice(
    layer.indexOf("<script>") + 8,
    -"</script>".length,
  );
  document.head.insertAdjacentHTML(
    "afterbegin",
    layer.slice(0, layer.indexOf("<script>")),
  );
  messages.length = 0;
  window.addEventListener("message", record);
  // The layer registers on `document`, which outlives one test's body — track
  // the registrations so each test starts with exactly one set of handlers.
  listeners = [];
  const add = document.addEventListener.bind(document);
  vi.spyOn(document, "addEventListener").mockImplementation(((
    ...args: Registration
  ) => {
    listeners.push(args);
    add(args[0], args[1], args[2] as never);
  }) as typeof document.addEventListener);
  delete (window as unknown as Record<string, unknown>).__simEditorLayer;
  new Function(script)();
  vi.mocked(document.addEventListener).mockRestore();
});

afterEach(() => {
  for (const [type, listener, options] of listeners)
    document.removeEventListener(type, listener, options as never);
  window.removeEventListener("message", record);
  vi.restoreAllMocks();
});

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

it("edits a run of text that sits beside inline markup", async () => {
  const legend = document.getElementById("legend")!;
  const target = legend.lastChild!; // " is the displacement in metres."
  aimCaretAt(target);
  dblclick(legend);

  const host = editing();
  expect(host?.textContent).toBe("is the displacement in metres.");
  host!.textContent = "is the displacement from equilibrium.";
  host!.dispatchEvent(new Event("blur"));
  await settle();

  expect(messages).toEqual([
    {
      type: "simulation-text-edit",
      before: "is the displacement in metres.",
      after: "is the displacement from equilibrium.",
    },
  ]);
  // The surrounding markup and the node's own spacing survive the round trip.
  expect(legend.innerHTML).toBe(
    "Here <b>x</b> is the displacement from equilibrium.",
  );
  expect(editing()).toBeNull();
});

it("hands a double-clicked formula to the parent by index", async () => {
  dblclick(document.querySelector(".sim-formula")!);
  await settle();
  expect(messages).toEqual([{ type: "simulation-formula-pick", index: 1 }]);
  expect(editing()).toBeNull();
});

it("leaves script-driven controls alone", async () => {
  const pause = document.getElementById("pause")!;
  aimCaretAt(pause.firstChild!);
  dblclick(pause);
  await settle();
  expect(editing()).toBeNull();
  expect(messages).toEqual([]);
});

it("reports nothing when the text comes back unchanged, and on Escape", async () => {
  const title = document.querySelector("h1")!;
  aimCaretAt(title.firstChild!);
  dblclick(title);
  editing()!.dispatchEvent(new Event("blur"));
  await settle();
  expect(messages).toEqual([]);

  aimCaretAt(document.querySelector("h1")!.firstChild!);
  dblclick(document.querySelector("h1")!);
  const host = editing()!;
  host.textContent = "Spring bench";
  host.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  host.dispatchEvent(new Event("blur"));
  await settle();
  expect(messages).toEqual([]);
  expect(document.querySelector("h1")!.textContent).toBe("Spring lab");
});

it("outlines what a double-click would reach", () => {
  const legend = document.getElementById("legend")!;
  aimCaretAt(legend.lastChild!);
  legend.dispatchEvent(
    new MouseEvent("mousemove", { bubbles: true, clientX: 5, clientY: 5 }),
  );
  expect(legend.classList.contains("sim-edit-target")).toBe(true);

  const formula = document.querySelector(".sim-formula")!;
  formula.dispatchEvent(
    new MouseEvent("mousemove", { bubbles: true, clientX: 5, clientY: 5 }),
  );
  expect(formula.classList.contains("sim-edit-target")).toBe(true);
  expect(legend.classList.contains("sim-edit-target")).toBe(false);
});
