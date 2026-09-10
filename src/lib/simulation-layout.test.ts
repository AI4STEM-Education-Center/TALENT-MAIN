// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { buildSimulationLayoutLayer } from "./simulation-layout";

const cleanups: (() => void)[] = [];
function track(target: Window | Document) {
  const add = target.addEventListener.bind(target);
  vi.spyOn(target, "addEventListener").mockImplementation(
    (type, listener, options) => {
      add(type, listener, options);
      cleanups.push(() => target.removeEventListener(type, listener, options));
    },
  );
}

/** The DOM suite exercises lifecycle/state; real browser checks cover sizing. */
async function preview(width = 900) {
  document.body.innerHTML =
    '<aside style="overflow-y:auto;max-height:200px;background:white"><input value="3"><span>Live state</span></aside>';
  track(window);
  track(document);
  Object.defineProperty(window, "innerWidth", { value: width, writable: true });
  Object.defineProperty(window, "innerHeight", { value: 600, writable: true });
  const controls = document.querySelector("aside")!;
  // Model a panel below a 200px header, containing 600px of controls. jsdom
  // itself has no layout engine, so give it those container measurements.
  Object.defineProperties(controls, {
    clientWidth: { get: () => 300 },
    scrollWidth: { get: () => 300 },
    clientHeight: {
      get: () =>
        window.innerHeight /
          (Number(document.documentElement.style.zoom) || 1) -
        200,
    },
    scrollHeight: { get: () => Math.max(600, controls.clientHeight) },
  });
  const layer = buildSimulationLayoutLayer();
  new Function(layer.slice("<script>".length, -"</script>".length))();
  await settle();
  return { window, document, controls };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 40));
}

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("style");
  delete (window as unknown as Record<string, unknown>).__simLayout;
});

it("fits an overflowing desktop panel without replacing controls or their state", async () => {
  const { controls, document } = await preview();
  expect(controls.scrollHeight).toBeLessThanOrEqual(controls.clientHeight + 1);
  expect(Number(document.documentElement.style.zoom)).toBeGreaterThan(0.7);
  expect(controls.querySelector("input")?.value).toBe("3");
  expect(controls.textContent).toBe("Live state");
});

it("restores phone layout while preserving style and input changes made by the simulation", async () => {
  const { window, document, controls } = await preview();
  controls.style.background = "blue";
  controls.querySelector("input")!.value = "7";
  window.innerWidth = 390;
  window.dispatchEvent(new window.Event("resize"));
  await settle();
  expect(document.documentElement.style.zoom).toBe("");
  expect(controls.style.maxHeight).toBe("200px");
  expect(controls.style.minHeight).toBe("");
  expect(controls.style.background).toBe("blue");
  expect(controls.querySelector("input")?.value).toBe("7");
});

it("does not resize a box during typing, and fits after that edit closes", async () => {
  const { window, document, controls } = await preview();
  const initial = document.documentElement.style.zoom;
  controls.querySelector("span")!.className = "sim-edit-active";
  window.innerHeight = 450;
  window.dispatchEvent(new window.Event("resize"));
  await settle();
  expect(document.documentElement.style.zoom).toBe(initial);
  controls.querySelector("span")!.className = "";
  document.dispatchEvent(new window.Event("sim-layout-change"));
  await settle();
  expect(controls.scrollHeight).toBeLessThanOrEqual(controls.clientHeight + 1);
  expect(Number(document.documentElement.style.zoom)).toBeLessThan(
    Number(initial),
  );
});

it("leaves phone presentation alone and does not refit for live readout updates", async () => {
  const { document, controls } = await preview(390);
  controls.querySelector("span")!.textContent = "0.321 m";
  await settle();
  expect(document.documentElement.style.zoom).toBe("");
  expect(controls.style.maxHeight).toBe("200px");
  expect(controls.textContent).toBe("0.321 m");
});
