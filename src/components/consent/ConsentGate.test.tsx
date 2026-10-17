// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let pathname = "/student";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));
vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: { user: { id: "u1", role: "STUDENT", email: "stu@uga.edu" } },
    status: "authenticated",
    update: vi.fn(),
  }),
}));

import { ConsentGate } from "./ConsentGate";
import { SurveyGate } from "@/components/survey/SurveyGate";

const activeForm = {
  id: "v1",
  title: "Student consent",
  version: "v1",
  bodyHtml: "<p>Consent text</p>",
};

// What the server says right now; the test flips it mid-session.
let campaignStarted = false;
const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  if (url.startsWith("/api/consent"))
    return json({
      needsDecision: false,
      role: "STUDENT",
      activeForm,
      priorDecision: { decision: "DECLINE" },
      reprompt: campaignStarted ? { campaignKey: "p1", period: 1 } : null,
    });
  if (url.startsWith("/api/surveys/due"))
    return json(
      campaignStarted ? { state: "CONSENT_PENDING" } : { state: "NONE" },
    );
  throw new Error(`unexpected fetch ${url}`);
});

const calls = (prefix: string) =>
  fetchMock.mock.calls.filter(([u]) => String(u).startsWith(prefix)).length;

let host: HTMLDivElement;
let root: Root;

async function render() {
  await act(async () =>
    root.render(
      <>
        <ConsentGate />
        <SurveyGate />
      </>,
    ),
  );
  // Let the fetch promises settle.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear();
  sessionStorage.clear();
  campaignStarted = false;
  pathname = "/student";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("shows the re-consent prompt after a campaign starts mid-session, on the next navigation", async () => {
  await render();
  expect(document.body.textContent).not.toContain(
    "A new study period is starting",
  );
  expect(calls("/api/consent")).toBe(1);

  // Admin turns on the in-app prompt; the student then navigates.
  campaignStarted = true;
  pathname = "/student/quizzes";
  await render();

  expect(document.body.textContent).toContain("A new study period is starting");
  // One fetch per navigation per gate — no ping-pong between them.
  expect(calls("/api/consent")).toBe(2);
  expect(calls("/api/surveys/due")).toBe(2);

  // Navigating while the prompt is open neither refetches nor resets it.
  pathname = "/student/classes";
  await render();
  expect(document.body.textContent).toContain("A new study period is starting");
  expect(calls("/api/consent")).toBe(2);
});

it("keeps an open consent form open across navigations", async () => {
  campaignStarted = true;
  await render();
  const review = [...document.querySelectorAll("button")].find(
    (b) => b.textContent === "Review consent form",
  )!;
  await act(async () => review.click());
  expect(document.body.textContent).toContain("Consent text");

  pathname = "/student/quizzes";
  await render();
  expect(document.body.textContent).toContain("Consent text");
  expect(calls("/api/consent")).toBe(1);
});
