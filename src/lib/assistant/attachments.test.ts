import { describe, it, expect } from "vitest";
import {
  allAttachmentKindInfo,
  buildUserContent,
  kindForMimeType,
  validateAttachments,
  MAX_TEXT_ATTACHMENT_CHARS,
  type AttachmentLimits,
  type ContentPart,
} from "./attachments";
import type { IncomingAttachment } from "./types";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

/** Base64 whose decoded length is exactly `bytes`. */
const payloadOfBytes = (bytes: number) =>
  Buffer.alloc(bytes, 0x41).toString("base64");

const limits = (
  overrides: Partial<AttachmentLimits> = {},
): AttachmentLimits => ({
  allowedKinds: ["image", "csv"],
  maxAttachments: 2,
  maxAttachmentBytes: 1024,
  ...overrides,
});

const image = (name = "shot.png"): IncomingAttachment => ({
  name,
  mimeType: "image/png",
  dataBase64: payloadOfBytes(64),
});

describe("kindForMimeType", () => {
  it("maps registered types to their kind, ignoring case and parameters", () => {
    expect(kindForMimeType("image/PNG")).toBe("image");
    expect(kindForMimeType("text/csv; charset=utf-8")).toBe("csv");
    expect(kindForMimeType("text/plain")).toBe("text");
  });

  it("returns null for anything not registered", () => {
    expect(kindForMimeType("application/pdf")).toBeNull();
    expect(kindForMimeType("application/x-sh")).toBeNull();
  });
});

describe("validateAttachments", () => {
  it("accepts an allowed, in-size attachment and reports its decoded byte count", () => {
    const { accepted, rejected } = validateAttachments([image()], limits());
    expect(rejected).toEqual([]);
    expect(accepted).toHaveLength(1);
    expect(accepted[0].kind).toBe("image");
    expect(accepted[0].bytes).toBe(64);
  });

  it("rejects a kind the admin has not enabled", () => {
    const { accepted, rejected } = validateAttachments(
      [{ name: "notes.txt", mimeType: "text/plain", dataBase64: b64("hello") }],
      limits({ allowedKinds: ["image"] }),
    );
    expect(accepted).toEqual([]);
    expect(rejected[0].reason).toContain("not enabled");
  });

  it("rejects an unregistered MIME type", () => {
    const { rejected } = validateAttachments(
      [
        {
          name: "report.pdf",
          mimeType: "application/pdf",
          dataBase64: b64("x"),
        },
      ],
      limits(),
    );
    expect(rejected[0].reason).toContain("unsupported file type");
  });

  it("rejects an attachment over the admin's per-file ceiling", () => {
    const { accepted, rejected } = validateAttachments(
      [
        {
          name: "big.png",
          mimeType: "image/png",
          dataBase64: payloadOfBytes(4096),
        },
      ],
      limits({ maxAttachmentBytes: 1024 }),
    );
    expect(accepted).toEqual([]);
    expect(rejected[0].reason).toContain("too large");
  });

  it("applies the kind's own ceiling even when the admin limit is higher", () => {
    // csv caps at 2 MiB regardless of maxAttachmentBytes.
    const { rejected } = validateAttachments(
      [
        {
          name: "huge.csv",
          mimeType: "text/csv",
          dataBase64: payloadOfBytes(3 * 1024 * 1024),
        },
      ],
      limits({ maxAttachmentBytes: 10 * 1024 * 1024 }),
    );
    expect(rejected[0].reason).toContain("too large");
  });

  it("keeps the first N attachments and rejects the overflow", () => {
    const { accepted, rejected } = validateAttachments(
      [image("a.png"), image("b.png"), image("c.png")],
      limits({ maxAttachments: 2 }),
    );
    expect(accepted.map((a) => a.name)).toEqual(["a.png", "b.png"]);
    expect(rejected).toEqual([
      { name: "c.png", reason: "over the 2-attachment limit" },
    ]);
  });

  it("counts only accepted files against the limit, so a rejection does not consume a slot", () => {
    const { accepted } = validateAttachments(
      [
        { name: "bad.pdf", mimeType: "application/pdf", dataBase64: b64("x") },
        image("a.png"),
        image("b.png"),
      ],
      limits({ maxAttachments: 2 }),
    );
    expect(accepted.map((a) => a.name)).toEqual(["a.png", "b.png"]);
  });
});

describe("buildUserContent", () => {
  it("returns a plain string when nothing is attached", () => {
    expect(buildUserContent("hello", [])).toBe("hello");
  });

  it("emits an image_url data URL after the text", () => {
    const { accepted } = validateAttachments([image()], limits());
    const parts = buildUserContent("look", accepted) as ContentPart[];
    expect(parts[0]).toEqual({ type: "text", text: "look" });
    expect(parts[1]).toEqual({
      type: "text",
      text: 'Attached image "shot.png":',
    });
    expect(parts[2]).toMatchObject({
      type: "image_url",
      image_url: { url: expect.stringContaining("data:image/png;base64,") },
    });
  });

  it("omits the empty text part when only files were sent", () => {
    const { accepted } = validateAttachments([image()], limits());
    const parts = buildUserContent("   ", accepted) as ContentPart[];
    expect(parts[0]).toEqual({
      type: "text",
      text: 'Attached image "shot.png":',
    });
  });

  it("renders a CSV as a fenced text block", () => {
    const { accepted } = validateAttachments(
      [
        {
          name: "grades.csv",
          mimeType: "text/csv",
          dataBase64: b64("a,b\n1,2"),
        },
      ],
      limits(),
    );
    const parts = buildUserContent("check", accepted) as ContentPart[];
    expect(parts[1]).toEqual({
      type: "text",
      text: 'Attached file "grades.csv":\n```csv\na,b\n1,2\n```',
    });
  });

  it("truncates an over-long text attachment and says so", () => {
    const long = "x".repeat(MAX_TEXT_ATTACHMENT_CHARS + 500);
    const { accepted } = validateAttachments(
      [{ name: "long.csv", mimeType: "text/csv", dataBase64: b64(long) }],
      limits({ maxAttachmentBytes: 1024 * 1024 }),
    );
    const parts = buildUserContent("", accepted) as ContentPart[];
    const rendered = (parts[0] as { text: string }).text;
    expect(rendered).toContain("truncated at");
    expect(rendered.length).toBeLessThan(long.length);
  });
});

describe("allAttachmentKindInfo", () => {
  it("exposes every registered kind with a file-picker accept string", () => {
    const info = allAttachmentKindInfo();
    expect(info.map((k) => k.kind)).toEqual(["image", "text", "csv"]);
    for (const kind of info) {
      expect(kind.accept.length).toBeGreaterThan(0);
      expect(kind.maxBytes).toBeGreaterThan(0);
    }
  });
});
