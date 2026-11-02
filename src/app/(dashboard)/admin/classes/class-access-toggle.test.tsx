// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const confirm = vi.fn(async () => true);
const refresh = vi.fn();
let role = "ADMIN";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { role } } }),
}));
vi.mock("@/components/ui/confirm-dialog", () => ({
  useConfirm: () => confirm,
  useAlert: () => vi.fn(async () => undefined),
}));

import { ClassAccessToggle } from "./class-access-toggle";
import { DEFAULT_PAUSE_MESSAGE } from "@/lib/platform-paused";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  role = "ADMIN";
  confirm.mockClear();
  refresh.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function render(disabled: boolean) {
  await act(async () =>
    root.render(
      <ClassAccessToggle classId="c1" className="Bio" disabled={disabled} />,
    ),
  );
}
const button = (label: string) =>
  [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label,
  ) as HTMLButtonElement | undefined;

it("shows the state and follows a refreshed server value", async () => {
  await render(false);
  expect(host.textContent).toContain("Active");
  await render(true);
  expect(host.textContent).toContain("Disabled");
  expect(button("Enable")).toBeDefined();
});

it("asks for a message with the default pre-filled, then PATCHes disabled", async () => {
  const fetchMock = vi.fn(async () =>
    Response.json({ id: "c1", disabledAt: "2026-01-01T00:00:00.000Z" }),
  );
  vi.stubGlobal("fetch", fetchMock);
  await render(false);
  await act(async () => button("Disable")!.click());
  const textarea = document.querySelector("textarea")!;
  expect(textarea.value).toBe(DEFAULT_PAUSE_MESSAGE);
  expect(document.body.textContent).toContain(
    "lose access to the whole platform",
  );
  await act(async () => button("Disable class")!.click());
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/admin/classes/c1/access",
    expect.objectContaining({
      method: "PATCH",
      // The untouched default wording is not stored as a custom message.
      body: JSON.stringify({ disabled: true }),
    }),
  );
  expect(host.textContent).toContain("Disabled");
  expect(refresh).toHaveBeenCalled();
});

it("re-enables after confirmation", async () => {
  const fetchMock = vi.fn(async () =>
    Response.json({ id: "c1", disabledAt: null, disabledMessage: null }),
  );
  vi.stubGlobal("fetch", fetchMock);
  await render(true);
  await act(async () => button("Enable")!.click());
  expect(confirm).toHaveBeenCalledOnce();
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/admin/classes/c1/access",
    expect.objectContaining({ body: JSON.stringify({ disabled: false }) }),
  );
  expect(host.textContent).toContain("Active");
});

it("is read-only for research scientists", async () => {
  role = "RESEARCHER";
  await render(true);
  expect(host.textContent).toContain("Disabled");
  expect(host.querySelector("button")).toBeNull();
});
