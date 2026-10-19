// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let pathname = "/student";
let userId = "u1";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));
vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: { user: { id: userId, role: "STUDENT", email: "stu@uga.edu" } },
    status: "authenticated",
    update: vi.fn(),
  }),
}));

import { ResearchGates } from "./ResearchGates";

const activeForm = {
  id: "v1",
  title: "Student consent",
  version: "v1",
  bodyHtml: "<p>Consent text</p>",
};

// What the server says right now; the test flips it mid-session.
let campaignStarted = false;
/** Accounts the re-prompt applies to (all of them unless a test narrows it). */
let repromptUsers: Set<string> | null = null;
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
      reprompt:
        campaignStarted && (!repromptUsers || repromptUsers.has(userId))
          ? { campaignKey: "p1", period: 1 }
          : null,
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
    // Through the same keyed wrapper the dashboard layout renders.
    root.render(<ResearchGates />),
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
  repromptUsers = null;
  pathname = "/student";
  userId = "u1";
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

it("hides a closed re-prompt only for the student who closed it", async () => {
  campaignStarted = true;
  await render();
  const close = [...document.querySelectorAll("button")].find(
    (b) => b.textContent === "Close",
  )!;
  await act(async () => close.click());
  expect(document.body.textContent).not.toContain(
    "A new study period is starting",
  );

  // Student B signs in on the same tab — no remount, the session changes.
  userId = "u2";
  await render();
  expect(document.body.textContent).toContain("A new study period is starting");

  // Student A again on the same tab: still hidden for them this session.
  userId = "u1";
  await render();
  expect(document.body.textContent).not.toContain(
    "A new study period is starting",
  );
});

it("drops the previous account's open prompt when the account changes", async () => {
  campaignStarted = true;
  repromptUsers = new Set(["u1"]);
  await render();
  expect(document.body.textContent).toContain("A new study period is starting");

  userId = "u2";
  await render();
  expect(document.body.textContent).not.toContain(
    "A new study period is starting",
  );
  // The new account got its own consent check.
  expect(calls("/api/consent")).toBe(2);
});
