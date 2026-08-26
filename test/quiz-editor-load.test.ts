import { describe, expect, it, vi } from "vitest";
import { loadQuizEditorData } from "@/components/quiz/quiz-editor-load";

type Quiz = { id: string; name: string };
type Topic = { id: string; name: string };

const QUIZ = { id: "q1", name: "Kinematics" };
const TOPICS = [{ id: "t1", name: "Unit 1" }];

/** Build a fetch stub that answers /api/quizzes/* and /api/topics separately. */
function stubFetch(
  quiz: { status: number; body: unknown },
  topics: { status: number; body: unknown }
) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const pick = url.includes("/api/topics") ? topics : quiz;
    return {
      ok: pick.status >= 200 && pick.status < 300,
      status: pick.status,
      json: async () => pick.body,
    } as Response;
  }) as unknown as typeof fetch;
}

const load = (f: typeof fetch, signal = new AbortController().signal) =>
  loadQuizEditorData<Quiz, Topic>("q1", signal, f);

describe("loadQuizEditorData", () => {
  it("returns the quiz and topics when both calls succeed", async () => {
    const result = await load(stubFetch({ status: 200, body: QUIZ }, { status: 200, body: TOPICS }));
    expect(result).toEqual({ kind: "ok", quiz: QUIZ, topics: TOPICS });
  });

  // The original defect: /api/topics answers 401 with an error object, which was
  // written straight into `topics` state and threw on `topics.map(...)`.
  it("reports an error instead of passing a 401 error body through as topics", async () => {
    const result = await load(
      stubFetch({ status: 200, body: QUIZ }, { status: 401, body: { error: "Unauthorized" } })
    );
    expect(result.kind).toBe("error");
    expect(result).toMatchObject({ message: expect.stringContaining("401") });
  });

  // A 200 is not a promise about the body: a proxy or error page can return one
  // with a shape the render cannot consume.
  it("rejects a 200 whose topics body is not an array", async () => {
    const result = await load(
      stubFetch({ status: 200, body: QUIZ }, { status: 200, body: { error: "nope" } })
    );
    expect(result.kind).toBe("error");
    expect(result).toMatchObject({ message: expect.stringContaining("unexpected format") });
  });

  it("rejects a 200 whose quiz body is not an object", async () => {
    for (const body of [["not", "a", "quiz"], "a string", null]) {
      const result = await load(stubFetch({ status: 200, body }, { status: 200, body: TOPICS }));
      expect(result.kind, `body: ${JSON.stringify(body)}`).toBe("error");
    }
  });

  it("distinguishes a missing quiz from a failed load", async () => {
    const missing = await load(
      stubFetch({ status: 404, body: { error: "Not found" } }, { status: 200, body: TOPICS })
    );
    expect(missing).toEqual({ kind: "notFound" });

    const failed = await load(
      stubFetch({ status: 500, body: { error: "boom" } }, { status: 200, body: TOPICS })
    );
    expect(failed.kind).toBe("error");
    expect(failed).toMatchObject({ message: expect.stringContaining("500") });
  });

  it("reports 'aborted' so a superseded request writes no state", async () => {
    const controller = new AbortController();
    const failing = vi.fn(async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    }) as unknown as typeof fetch;
    controller.abort();

    const result = await load(failing, controller.signal);
    expect(result).toEqual({ kind: "aborted" });
  });

  it("reports a rejected fetch as an error when it was not aborted", async () => {
    const failing = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    const result = await load(failing);
    expect(result).toMatchObject({ kind: "error", message: "Failed to fetch" });
  });
});
