import { describe, it, expect } from "vitest";
import { shuffleAnswerChoices, shuffleWithSeed } from "@/lib/quiz-shuffle";

const options = (...texts: string[]) =>
  texts.map((text, i) => ({ id: `o${i}`, text }));
const texts = (items: Array<{ text: string }>) =>
  items.map((item) => item.text);

describe("shuffleWithSeed", () => {
  it("is deterministic for a given seed", () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(shuffleWithSeed(items, "attempt-1:q1")).toEqual(
      shuffleWithSeed(items, "attempt-1:q1"),
    );
  });

  it("gives different seeds different orders", () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(shuffleWithSeed(items, "attempt-1:q1")).not.toEqual(
      shuffleWithSeed(items, "attempt-2:q1"),
    );
  });

  it("keeps every element and does not mutate the input", () => {
    const items = [1, 2, 3, 4, 5];
    const shuffled = shuffleWithSeed(items, "seed");
    expect([...shuffled].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(items).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("shuffleAnswerChoices", () => {
  // Resuming an attempt must reproduce the layout the student left behind, so
  // the seed is the attempt id — not a per-request random.
  it("renders the same order for the same attempt and question", () => {
    const choices = options("a", "b", "c", "d", "e");
    expect(texts(shuffleAnswerChoices(choices, "att1:q1"))).toEqual(
      texts(shuffleAnswerChoices(choices, "att1:q1")),
    );
  });

  it("reorders between attempts so positions cannot be walked across retries", () => {
    const choices = options("a", "b", "c", "d", "e", "f");
    const first = texts(shuffleAnswerChoices(choices, "att1:q1"));
    const second = texts(shuffleAnswerChoices(choices, "att2:q1"));
    expect(first).not.toEqual(second);
    expect([...first].sort()).toEqual([...second].sort());
  });

  it("keeps 'of the above' choices last", () => {
    for (const seed of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
      const shuffled = texts(
        shuffleAnswerChoices(options("6", "7", "8", "None of the above"), seed),
      );
      expect(shuffled[3]).toBe("None of the above");
    }
  });

  it("keeps multiple anchored choices in their original relative order", () => {
    const shuffled = texts(
      shuffleAnswerChoices(
        options("6", "7", "All of the above", "None of the above"),
        "seed",
      ),
    );
    expect(shuffled.slice(2)).toEqual([
      "All of the above",
      "None of the above",
    ]);
  });

  it("leaves a single choice alone", () => {
    expect(texts(shuffleAnswerChoices(options("only"), "seed"))).toEqual([
      "only",
    ]);
  });

  it("handles a question with no choices (NUMERIC)", () => {
    expect(shuffleAnswerChoices([], "seed")).toEqual([]);
  });
});
