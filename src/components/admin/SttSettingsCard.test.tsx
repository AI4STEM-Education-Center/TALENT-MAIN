// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SttSettingsCard } from "./SttSettingsCard";
import { DEFAULT_STT_SETTINGS } from "@/lib/stt/types";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => vi.unstubAllGlobals());

describe("SttSettingsCard failure isolation", () => {
  it("renders missing usage arrays as empty lists", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          settings: DEFAULT_STT_SETTINGS,
          effectiveRegion: "us-east-1",
          hasCredentials: true,
          usage: { totalDurationMs: 0, totalSessions: 0, uniqueUsers: 0 },
        }),
      }),
    );
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<SttSettingsCard />));
      expect(container.textContent).toContain("By User (0)");
      expect(container.textContent).toContain("Session Log (0)");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("keeps other AI configuration content visible after an STT render fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ settings: null }),
      }),
    );
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <>
            <p>Other AI settings</p>
            <SttSettingsCard />
          </>,
        ),
      );
      expect(container.textContent).toContain("Other AI settings");
      expect(container.textContent).toContain(
        "Speech-to-Text settings could not be displayed.",
      );
    } finally {
      await act(async () => root.unmount());
      consoleError.mockRestore();
    }
  });
});
