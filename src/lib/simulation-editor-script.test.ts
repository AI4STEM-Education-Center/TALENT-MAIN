// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildSimulationEditorLayer } from "./simulation-editor-script";

/**
 * The layer is a string injected into an AI-generated document, so the only way
 * to know it works is to run it against a document shaped like one — a formula
 * in a card, a sentence with inline markup in it, and a script-driven control.
 */
const messages: MessageEvent["data"][] = [];

/**
 * Only the layer's own outbound traffic. jsdom has no real frame, so `parent`
 * is this same window and the messages the test sends *in* would otherwise be
 * recorded alongside the ones the layer sends *out*.
 */
function record(event: MessageEvent) {
  if (typeof event.data?.type === "string")
    if (event.data.type.startsWith("simulation-")) messages.push(event.data);
}

/** A message from the parent frame, which in jsdom is this window. */
function send(data: unknown) {
  window.dispatchEvent(
    new MessageEvent("message", { data, source: window as Window }),
  );
}

function editMode(on: boolean) {
  send({ type: "sim-edit-mode", on });
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

function click(target: Element) {
  target.dispatchEvent(
    new MouseEvent("click", { bubbles: true, clientX: 5, clientY: 5 }),
  );
}
function hover(target: Element) {
  target.dispatchEvent(
    new MouseEvent("mousemove", { bubbles: true, clientX: 5, clientY: 5 }),
  );
}
function press(el: Element, key: string) {
  el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}
function editing() {
  return document.querySelector(".sim-edit-active") as HTMLElement | null;
}
function barButton(label: string) {
  return [...document.querySelectorAll(".sim-edit-bar button")].find(
    (b) => b.textContent === label,
  ) as HTMLButtonElement;
}
function formulas() {
  return [...document.querySelectorAll("[data-sim-latex]")];
}

type Registration = [string, EventListenerOrEventListenerObject, unknown];
let listeners: Registration[] = [];
let windowListeners: Registration[] = [];

beforeEach(() => {
  document.body.innerHTML = `
<h1>Spring lab</h1>
<p id="legend">Here <b>x</b> is the displacement in metres.</p>
<div class="cards">
<div class="card"><span class="sim-formula" data-sim-index="0" data-sim-display="block"
      data-sim-latex="F_s = -kx"><math><mi>F</mi></math></span></div>
<div class="card"><span class="sim-formula" data-sim-index="1" data-sim-display="block"
      data-sim-latex="U_s = 1"><math><mi>U</mi></math></span></div>
</div>
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
  windowListeners = [];
  const windowAdd = window.addEventListener.bind(window);
  vi.spyOn(window, "addEventListener").mockImplementation(((
    ...args: Registration
  ) => {
    windowListeners.push(args);
    windowAdd(args[0], args[1], args[2] as never);
  }) as typeof window.addEventListener);
  delete (window as unknown as Record<string, unknown>).__simEditorLayer;
  new Function(script)();
  vi.mocked(document.addEventListener).mockRestore();
  vi.mocked(window.addEventListener).mockRestore();
});

afterEach(() => {
  editMode(false);
  for (const [type, listener, options] of windowListeners)
    window.removeEventListener(type, listener, options as never);
  for (const [type, listener, options] of listeners)
    document.removeEventListener(type, listener, options as never);
  window.removeEventListener("message", record);
  vi.restoreAllMocks();
});

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

it("stays inert until the parent turns edit mode on", async () => {
  const legend = document.getElementById("legend")!;
  aimCaretAt(legend.lastChild!);
  click(legend);
  hover(legend);
  await settle();
  expect(editing()).toBeNull();
  expect(legend.classList.contains("sim-edit-target")).toBe(false);
  expect(messages).toEqual([]);
});

it("edits a run of text that sits beside inline markup", async () => {
  editMode(true);
  const legend = document.getElementById("legend")!;
  const target = legend.lastChild!; // " is the displacement in metres."
  aimCaretAt(target);
  click(legend);

  const host = editing();
  expect(host?.textContent).toBe("is the displacement in metres.");
  host!.textContent = "is the displacement from equilibrium.";
  press(host!, "Enter");
  await settle();

  expect(messages).toEqual([
    {
      type: "simulation-text-edit",
      token: expect.stringMatching(/^text:/),
      before: "is the displacement in metres.",
      after: "is the displacement from equilibrium.",
    },
  ]);
  // The surrounding markup and the node's own spacing survive the round trip.
  expect(legend.innerHTML).toContain(
    "Here <b>x</b> is the displacement from equilibrium.",
  );
  expect(editing()).toBeNull();
});

// The staged batch is resolved against the original document, so a second edit
// of one label has to report where it started, not where the first one left it.
it("reports the original wording every time the same text is re-edited", async () => {
  editMode(true);
  const title = document.querySelector("h1")!;
  for (const text of ["Spring bench", "Spring bay"]) {
    aimCaretAt(document.querySelector("h1")!.firstChild!);
    click(document.querySelector("h1")!);
    const host = editing()!;
    host.textContent = text;
    press(host, "Enter");
  }
  await settle();

  expect(messages.map((m) => [m.before, m.after])).toEqual([
    ["Spring lab", "Spring bench"],
    ["Spring lab", "Spring bay"],
  ]);
  // Both edits are the same target, so they carry the same token and the
  // parent replaces rather than stacks them.
  expect(messages[0].token).toBe(messages[1].token);
  expect(title.textContent).toBe("Spring bay");
});

it("says so when text is put back the way it was", async () => {
  editMode(true);
  aimCaretAt(document.querySelector("h1")!.firstChild!);
  click(document.querySelector("h1")!);
  const host = editing()!;
  host.textContent = "Spring bench";
  press(host, "Escape");
  await settle();

  expect(messages).toEqual([]);
  expect(document.querySelector("h1")!.textContent).toBe("Spring lab");
});

it("turns a clicked formula into LaTeX and paints the render back", async () => {
  editMode(true);
  const formula = document.querySelector('[data-sim-index="1"]')!;
  click(formula);
  expect(formula.textContent).toBe("U_s = 1");

  formula.textContent = "U_s = 2";
  press(formula, "Enter");
  await settle();

  expect(messages).toEqual([
    {
      type: "simulation-formula-edit",
      token: "formula:1",
      ticket: expect.any(String),
      index: 1,
      after: 0,
      display: "block",
      latex: "U_s = 2",
    },
  ]);

  send({
    type: "sim-formula-painted",
    ticket: messages[0].ticket,
    html: "<math><mi>U2</mi></math>",
    latex: "U_s = 2",
  });
  expect(formula.innerHTML).toBe("<math><mi>U2</mi></math>");
  expect(formula.getAttribute("data-sim-latex")).toBe("U_s = 2");
  expect(formula.classList.contains("sim-edit-bad")).toBe(false);
});

it("flags a formula the parent could not render", async () => {
  editMode(true);
  const formula = document.querySelector('[data-sim-index="1"]')!;
  click(formula);
  formula.textContent = "U_s = \\frac{";
  press(formula, "Enter");
  await settle();

  send({ type: "sim-formula-painted", ticket: messages[0].ticket, html: null });
  expect(formula.classList.contains("sim-edit-bad")).toBe(true);
  // The source stays on screen so it can be corrected in place.
  expect(formula.textContent).toBe("U_s = \\frac{");
});

it("adds a formula after the hovered one, in a clone of its card", async () => {
  editMode(true);
  const first = document.querySelector('[data-sim-index="0"]')!;
  hover(first);
  barButton("+ formula").dispatchEvent(
    new MouseEvent("click", { bubbles: true }),
  );

  const made = editing()!;
  expect(made.getAttribute("data-sim-after")).toBe("0");
  // It landed in its own card, straight after the anchor's.
  expect(made.closest(".card")).not.toBe(first.closest(".card"));
  expect(first.closest(".card")!.nextElementSibling).toBe(
    made.closest(".card"),
  );

  made.textContent = "E = K + U_s";
  press(made, "Enter");
  await settle();

  expect(messages).toEqual([
    {
      type: "simulation-formula-add",
      token: "new:1",
      ticket: expect.any(String),
      index: null,
      after: 0,
      display: "block",
      latex: "E = K + U_s",
    },
  ]);
});

it("drops a new formula that was left empty", async () => {
  editMode(true);
  hover(document.querySelector('[data-sim-index="0"]')!);
  barButton("+ formula").dispatchEvent(
    new MouseEvent("click", { bubbles: true }),
  );
  press(editing()!, "Enter");
  await settle();

  expect(messages).toEqual([
    { type: "simulation-formula-drop", token: "new:1" },
  ]);
  expect(formulas()).toHaveLength(2);
  expect(document.querySelectorAll(".card")).toHaveLength(2);
});

it("removes a formula in place, but never the last one", async () => {
  editMode(true);
  const second = document.querySelector('[data-sim-index="1"]')!;
  hover(second);
  barButton("Remove").dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await settle();

  expect(messages).toEqual([
    { type: "simulation-formula-delete", token: "formula:1", index: 1 },
  ]);
  expect(formulas()).toHaveLength(1);
  expect(document.querySelectorAll(".card")).toHaveLength(1);

  messages.length = 0;
  const last = document.querySelector('[data-sim-index="0"]')!;
  hover(last);
  barButton("Remove").dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await settle();
  expect(messages).toEqual([]);
  expect(formulas()).toHaveLength(1);
});

it("leaves script-driven controls alone", async () => {
  editMode(true);
  const pause = document.getElementById("pause")!;
  aimCaretAt(pause.firstChild!);
  click(pause);
  await settle();
  expect(editing()).toBeNull();
  expect(messages).toEqual([]);
});

it("outlines what a click would reach, and stops when edit mode ends", () => {
  editMode(true);
  const legend = document.getElementById("legend")!;
  aimCaretAt(legend.lastChild!);
  hover(legend);
  expect(legend.classList.contains("sim-edit-target")).toBe(true);

  const formula = document.querySelector('[data-sim-index="0"]')!;
  hover(formula);
  expect(formula.classList.contains("sim-edit-target")).toBe(true);
  expect(legend.classList.contains("sim-edit-target")).toBe(false);
  expect(barButton("Remove")).toBeTruthy();

  editMode(false);
  expect(formula.classList.contains("sim-edit-target")).toBe(false);
  expect(document.querySelector(".sim-edit-bar")).toBeNull();
});

it("does not invent changes when clicking between text runs in the same legend", async () => {
  editMode(true);
  const legend = document.getElementById("legend")!;
  legend.innerHTML = "<b>F</b>: net force (N); <b>K</b>: kinetic energy (J);";
  const force = legend.childNodes[1];
  const energy = legend.childNodes[3];
  for (const node of [force, energy, force, energy]) {
    aimCaretAt(node);
    click(legend);
  }
  press(editing()!, "Enter");
  await settle();
  expect(messages).toEqual([]);
  expect(legend.textContent).toBe("F: net force (N); K: kinetic energy (J);");
});

it("keeps edits and reverts independent for neighboring text runs", async () => {
  editMode(true);
  const legend = document.getElementById("legend")!;
  legend.innerHTML = "<b>F</b>: net force (N); <b>K</b>: kinetic energy (J);";
  const force = legend.childNodes[1];
  const energy = legend.childNodes[3];
  for (const [node, text] of [
    [force, ": total force (N);"],
    [energy, ": motion energy (J);"],
    [force, ": net force (N);"],
  ] as const) {
    aimCaretAt(node);
    click(legend);
    editing()!.textContent = text;
    press(editing()!, "Enter");
  }
  await settle();
  expect(messages).toEqual([
    {
      type: "simulation-text-edit",
      token: expect.any(String),
      before: ": net force (N);",
      after: ": total force (N);",
    },
    {
      type: "simulation-text-edit",
      token: expect.any(String),
      before: ": kinetic energy (J);",
      after: ": motion energy (J);",
    },
    { type: "simulation-text-revert", token: expect.any(String) },
  ]);
  expect(messages[0].token).not.toBe(messages[1].token);
  expect(messages[2].token).toBe(messages[0].token);
});

it("keeps the toolbar reachable when leaving a formula and crossing onto Remove", async () => {
  editMode(true);
  const formula = formulas()[0];
  hover(formula);
  const remove = barButton("Remove");
  formula.dispatchEvent(
    new MouseEvent("mouseleave", { relatedTarget: document.body }),
  );
  hover(document.body); // cross the small gap before reaching the toolbar
  hover(remove);
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(remove.isConnected).toBe(true);
  click(remove);
  await settle();
  expect(formulas()).toHaveLength(1);
  expect(messages).toEqual([
    { type: "simulation-formula-delete", token: "formula:0", index: 0 },
  ]);
});

it("does not open another editor while positioning the caret in the active box", async () => {
  editMode(true);
  const title = document.querySelector("h1")!;
  aimCaretAt(title.firstChild!);
  click(title);
  const host = editing()!;
  aimCaretAt(host.firstChild!);
  click(host);
  expect(editing()).toBe(host);
  expect(document.querySelectorAll(".sim-edit-active")).toHaveLength(1);
  press(host, "Enter");
  await settle();
  expect(messages).toEqual([]);
});
