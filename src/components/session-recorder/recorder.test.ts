// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { describeElement } from "./recorder";

function el(html: string, selector: string): Element {
  document.body.innerHTML = html;
  return document.querySelector(selector)!;
}

describe("describeElement", () => {
  it("prefers an explicit label, then visible text", () => {
    expect(
      describeElement(
        el('<button aria-label="Close dialog">x</button>', "button"),
      ),
    ).toBe("Close dialog");
    expect(
      describeElement(el("<button>  Submit   quiz </button>", "button")),
    ).toBe("Submit quiz");
  });

  it("names an input by its label or placeholder", () => {
    expect(
      describeElement(
        el('<label>Email <input id="a" type="email"></label>', "input"),
      ),
    ).toBe("Email");
    expect(
      describeElement(el('<input placeholder="Search students…">', "input")),
    ).toBe("Search students…");
  });

  it("never leaks text from blocked or masked regions", () => {
    expect(
      describeElement(
        el(
          '<div class="rr-block"><button>Secret UGA ID</button></div>',
          "button",
        ),
      ),
    ).toBe("button");
    expect(describeElement(el('<p class="rr-mask">Private</p>', "p"))).toBe(
      "p",
    );
  });

  it("does not label a layout container with everything inside it", () => {
    expect(
      describeElement(
        el(`<main>${"Lots of page text. ".repeat(10)}</main>`, "main"),
      ),
    ).toBe("main");
    expect(describeElement(el("<h2>My Classes</h2>", "h2"))).toBe("My Classes");
  });

  it("truncates long text", () => {
    const label = describeElement(
      el(`<button>${"x".repeat(200)}</button>`, "button"),
    );
    expect(label.length).toBe(80);
    expect(label.endsWith("…")).toBe(true);
  });
});
