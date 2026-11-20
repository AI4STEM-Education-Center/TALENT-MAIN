// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStreamedResults, type AiState } from "./use-streamed-results";

const pending: AiState = {
  summary: null,
  summaryStatus: "GENERATING",
  summaryMetrics: null,
  recommendations: [],
  simulations: [],
  recommendationsStatus: "PENDING",
  recommendationMetrics: null,
  truncated: false,
};

let root: Root;
let host: HTMLElement;
let latest: AiState;

function Harness({ initial }: { initial: AiState }) {
  latest = useStreamedResults("att-1", initial);
  return null;
}

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  host = document.createElement("div");
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useStreamedResults", () => {
  it.each([401, 403, 404])(
    "stops on a permanent %i and marks pending sections failed",
    async (status) => {
      const fetchMock = vi.fn(async () => new Response(null, { status }));
      vi.stubGlobal("fetch", fetchMock);
      await act(async () =>
        root.render(
          <Harness initial={{ ...pending, recommendationsStatus: "READY" }} />,
        ),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(latest.summaryStatus).toBe("FAILED");
      // Already terminal sections are left alone.
      expect(latest.recommendationsStatus).toBe("READY");
    },
  );

  it("keeps retrying a transient failure", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => root.render(<Harness initial={pending} />));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3500);
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(2);
    expect(latest.summaryStatus).toBe("GENERATING");
  });
});
