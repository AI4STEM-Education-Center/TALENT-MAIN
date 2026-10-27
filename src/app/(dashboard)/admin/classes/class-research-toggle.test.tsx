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

import { ClassResearchToggle } from "./class-research-toggle";

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

async function render(excluded: boolean) {
  await act(async () =>
    root.render(
      <ClassResearchToggle classId="c1" className="Bio" excluded={excluded} />,
    ),
  );
}
const button = () => host.querySelector("button");

it("follows a refreshed server value on an existing instance", async () => {
  await render(false);
  expect(host.textContent).toContain("Prompted");
  expect(button()?.textContent).toBe("Exclude");
  await render(true);
  expect(host.textContent).toContain("Excluded");
  expect(button()?.textContent).toBe("Include");
});

it("PATCHes the opposite value after confirmation", async () => {
  const fetchMock = vi.fn(async () =>
    Response.json({ id: "c1", researchExcluded: true }),
  );
  vi.stubGlobal("fetch", fetchMock);
  await render(false);
  await act(async () => button()!.click());
  expect(confirm).toHaveBeenCalledOnce();
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/admin/classes/c1/research",
    expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ excluded: true }),
    }),
  );
  expect(host.textContent).toContain("Excluded");
  expect(refresh).toHaveBeenCalled();
});

it("is read-only for research scientists", async () => {
  role = "RESEARCHER";
  await render(true);
  expect(host.textContent).toContain("Excluded");
  expect(button()).toBeNull();
});
