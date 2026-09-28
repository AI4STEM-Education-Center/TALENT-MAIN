// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SurveyFormView } from "./SurveyFormView";

let host: HTMLDivElement;
let root: Root;
const onSubmit = vi.fn(async () => ({ ok: true as const }));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  onSubmit.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function render(email: string | undefined = "student@uga.edu") {
  await act(async () =>
    root.render(
      <SurveyFormView
        form={{ id: "pre", title: "Survey", description: "", questions: [] }}
        interviewDefaultEmail={email}
        onSubmit={onSubmit}
      />,
    ),
  );
}
async function click(text: string) {
  const element = [...host.querySelectorAll("button, label")].find(
    (el) => el.textContent?.trim() === text,
  ) as HTMLElement;
  expect(element).toBeTruthy();
  await act(async () => element.click());
}
async function optIn() {
  await act(async () =>
    host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
  );
}
const confirmation = "Use this email for post-survey and interview messages.";

it("shows the account email and submits it after confirmation without retyping", async () => {
  await render();
  await optIn();
  expect(host.textContent).toContain("student@uga.edu");
  expect(host.querySelector('input[type="email"]')).toBeNull();
  expect(host.textContent).toContain("Your login email will stay the same.");
  await click("Submit survey");
  expect(onSubmit).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "Please confirm",
  );
  await click(confirmation);
  await click("Submit survey");
  expect(onSubmit).toHaveBeenCalledWith(
    {},
    { optIn: true, email: "student@uga.edu" },
  );
});

it("lets the student change the email and requires confirmation of the new address", async () => {
  await render();
  await optIn();
  await click(confirmation);
  await click("Change email");
  const input = host.querySelector<HTMLInputElement>('input[type="email"]')!;
  expect(input.value).toBe("student@uga.edu");
  async function changeEmail(value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  await changeEmail("invalid");
  await click(confirmation);
  await click("Submit survey");
  expect(onSubmit).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "valid email",
  );
  await changeEmail("personal@example.com");
  await click("Submit survey");
  expect(onSubmit).not.toHaveBeenCalled();
  await click(confirmation);
  await click("Submit survey");
  expect(onSubmit).toHaveBeenCalledWith(
    {},
    { optIn: true, email: "personal@example.com" },
  );
});

it("does not require email confirmation when interview contact is declined", async () => {
  await render();
  await click("Submit survey");
  expect(onSubmit).toHaveBeenCalledWith(
    {},
    { optIn: false, email: "student@uga.edu" },
  );
});

it("allows entering an email if no saved address is available", async () => {
  await render("");
  await optIn();
  expect(
    host.querySelector<HTMLInputElement>('input[type="email"]')?.value,
  ).toBe("");
});
