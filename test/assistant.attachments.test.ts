import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

// A fake bucket: putS3Object writes into it, getS3Object reads back, and
// deleteS3Objects removes — so the retention sweep and the replay path can be
// checked end to end without touching AWS.
const bucketContents = new Map<
  string,
  { body: Uint8Array; contentType: string }
>();
let putShouldFail = false;
let configuredBucket: string | null = "test-bucket";

vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return {
    ...actual,
    getS3Config: vi.fn(() => {
      if (!configuredBucket)
        throw new Error("Learning materials require AWS_S3_BUCKET");
      return { bucket: configuredBucket, region: "us-east-1" };
    }),
    putS3Object: vi.fn(
      async (
        _bucket: string,
        key: string,
        body: Uint8Array,
        contentType: string,
      ) => {
        if (putShouldFail) throw new Error("S3 is down");
        bucketContents.set(key, { body, contentType });
      },
    ),
    getS3Object: vi.fn(async (_bucket: string, key: string) => {
      const object = bucketContents.get(key);
      if (!object) throw new Error(`S3 object ${key} has no body`);
      return object;
    }),
    deleteS3Objects: vi.fn(async (_bucket: string, keys: string[]) => {
      for (const key of keys) bucketContents.delete(key);
    }),
    signObjectReadUrl: vi.fn(
      async (_bucket: string, key: string) => `https://cdn.test/${key}`,
    ),
  };
});

import { GET as GET_ATTACHMENT } from "@/app/api/assistant/attachments/[id]/route";
import { POST as POST_CHAT } from "@/app/api/assistant/chat/route";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  findUserAttachment,
  loadStoredAttachments,
  persistAttachments,
  purgeExpiredAssistantAttachments,
} from "@/lib/assistant/attachment-store";
import { putS3Object } from "@/lib/storage";
import type { DecodedAttachment } from "@/lib/assistant/attachments";
import { saveAssistantSettings } from "@/lib/assistant/config";
import type { AssistantStreamEvent } from "@/lib/assistant/types";
import { readNdjson } from "@/lib/assistant/ndjson";
import { resetDb, createStudent } from "./db";

const mockAuth = vi.mocked(auth);
const mockPut = vi.mocked(putS3Object);

const asStudent = (userId: string) =>
  mockAuth.mockResolvedValue({
    user: { id: userId, role: "STUDENT" },
  } as never);

/** "hello" as base64 — small enough to assert on byte-for-byte. */
const HELLO = Buffer.from("hello").toString("base64");

const image = (name = "shot.png", dataBase64 = HELLO): DecodedAttachment => ({
  name,
  mimeType: "image/png",
  dataBase64,
  kind: "image",
  bytes: Buffer.from(dataBase64, "base64").byteLength,
});

const request = (id: string) =>
  GET_ATTACHMENT(
    new Request(`http://localhost/api/assistant/attachments/${id}`),
    {
      params: Promise.resolve({ id }),
    },
  );

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
  mockPut.mockClear();
  bucketContents.clear();
  putShouldFail = false;
  configuredBucket = "test-bucket";
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("persistAttachments", () => {
  it("stores the bytes and indexes them with the configured expiry", async () => {
    const { user } = await createStudent();
    const before = Date.now();

    const stored = await persistAttachments(
      { userId: user.id, audience: "student" },
      [image()],
      30,
    );

    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ name: "shot.png", kind: "image" });

    const days =
      (new Date(stored[0].expiresAt).getTime() - before) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);

    const row = await prisma.assistantAttachment.findUniqueOrThrow({
      where: { id: stored[0].id },
    });
    expect(row).toMatchObject({
      userId: user.id,
      audience: "student",
      bytes: 5,
    });
    expect(bucketContents.get(row.storageKey)?.body).toEqual(
      Buffer.from("hello"),
    );
  });

  it("keys the object by user and attachment id, so same-named uploads can't collide", async () => {
    const { user } = await createStudent();
    const stored = await persistAttachments(
      { userId: user.id, audience: "student" },
      [
        image("a.png", HELLO),
        image("a.png", Buffer.from("second").toString("base64")),
      ],
      30,
    );
    expect(stored).toHaveLength(2);
    const rows = await prisma.assistantAttachment.findMany({
      select: { storageKey: true },
    });
    expect(new Set(rows.map((row) => row.storageKey)).size).toBe(2);
    for (const row of rows) expect(row.storageKey).toContain(user.id);
  });

  it("does nothing, and does not throw, when there is no object storage", async () => {
    const { user } = await createStudent();
    configuredBucket = null;
    expect(
      await persistAttachments(
        { userId: user.id, audience: "student" },
        [image()],
        30,
      ),
    ).toEqual([]);
    expect(await prisma.assistantAttachment.count()).toBe(0);
  });

  it("leaves no index row behind when the upload fails", async () => {
    const { user } = await createStudent();
    putShouldFail = true;
    // The turn must still be answerable, so this degrades rather than throwing —
    // and the rollback is what keeps the retention sweep the only deleter needed.
    expect(
      await persistAttachments(
        { userId: user.id, audience: "student" },
        [image()],
        30,
      ),
    ).toEqual([]);
    expect(await prisma.assistantAttachment.count()).toBe(0);
  });

  it("keeps the attachments that succeed when one of them fails", async () => {
    const { user } = await createStudent();
    mockPut.mockImplementationOnce(async () => {
      throw new Error("transient");
    });
    const stored = await persistAttachments(
      { userId: user.id, audience: "student" },
      [image("bad.png"), image("good.png")],
      30,
    );
    expect(stored.map((item) => item.name)).toEqual(["good.png"]);
  });
});

describe("loadStoredAttachments", () => {
  it("reads the bytes back for the owner, in the order asked for", async () => {
    const { user } = await createStudent();
    const stored = await persistAttachments(
      { userId: user.id, audience: "student" },
      [
        image("one.png", HELLO),
        image("two.png", Buffer.from("world").toString("base64")),
      ],
      30,
    );

    const loaded = await loadStoredAttachments(
      user.id,
      [stored[1].id, stored[0].id],
      4,
    );
    expect(loaded.map((item) => item.name)).toEqual(["two.png", "one.png"]);
    expect(Buffer.from(loaded[0].dataBase64, "base64").toString()).toBe(
      "world",
    );
    expect(loaded[0]).toMatchObject({ kind: "image", mimeType: "image/png" });
  });

  it("returns nothing for another user's attachment id", async () => {
    const mine = await createStudent();
    const theirs = await createStudent();
    const stored = await persistAttachments(
      { userId: theirs.user.id, audience: "student" },
      [image()],
      30,
    );
    expect(
      await loadStoredAttachments(mine.user.id, [stored[0].id], 4),
    ).toEqual([]);
  });

  it("returns nothing for an expired attachment even before the sweep runs", async () => {
    const { user } = await createStudent();
    const stored = await persistAttachments(
      { userId: user.id, audience: "student" },
      [image()],
      30,
    );
    await prisma.assistantAttachment.update({
      where: { id: stored[0].id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await loadStoredAttachments(user.id, [stored[0].id], 4)).toEqual([]);
  });

  it("honours the limit", async () => {
    const { user } = await createStudent();
    const stored = await persistAttachments(
      { userId: user.id, audience: "student" },
      [image("a.png"), image("b.png"), image("c.png")],
      30,
    );
    const loaded = await loadStoredAttachments(
      user.id,
      stored.map((item) => item.id),
      2,
    );
    expect(loaded).toHaveLength(2);
  });

  it("skips an id whose object has vanished rather than failing the turn", async () => {
    const { user } = await createStudent();
    const stored = await persistAttachments(
      { userId: user.id, audience: "student" },
      [image("gone.png"), image("here.png")],
      30,
    );
    const row = await prisma.assistantAttachment.findFirstOrThrow({
      where: { name: "gone.png" },
    });
    bucketContents.delete(row.storageKey);

    const loaded = await loadStoredAttachments(
      user.id,
      stored.map((item) => item.id),
      4,
    );
    expect(loaded.map((item) => item.name)).toEqual(["here.png"]);
  });

  it("returns nothing when the caller asks for no ids or has no budget", async () => {
    const { user } = await createStudent();
    expect(await loadStoredAttachments(user.id, [], 4)).toEqual([]);
    expect(await loadStoredAttachments(user.id, ["x"], 0)).toEqual([]);
  });
});

describe("purgeExpiredAssistantAttachments", () => {
  it("deletes the object and the row together once retention lapses", async () => {
    const { user } = await createStudent();
    const stored = await persistAttachments(
      { userId: user.id, audience: "student" },
      [image()],
      30,
    );
    const row = await prisma.assistantAttachment.findUniqueOrThrow({
      where: { id: stored[0].id },
    });
    await prisma.assistantAttachment.update({
      where: { id: row.id },
      data: { expiresAt: new Date("2020-01-01T00:00:00Z") },
    });

    expect(await purgeExpiredAssistantAttachments()).toBe(1);
    expect(await prisma.assistantAttachment.count()).toBe(0);
    expect(bucketContents.has(row.storageKey)).toBe(false);
  });

  it("leaves attachments inside their retention window alone", async () => {
    const { user } = await createStudent();
    await persistAttachments(
      { userId: user.id, audience: "student" },
      [image()],
      30,
    );
    expect(await purgeExpiredAssistantAttachments()).toBe(0);
    expect(await prisma.assistantAttachment.count()).toBe(1);
  });

  it("is idempotent — a second run finds nothing left to do", async () => {
    const { user } = await createStudent();
    await persistAttachments(
      { userId: user.id, audience: "student" },
      [image()],
      30,
    );
    await prisma.assistantAttachment.updateMany({
      data: { expiresAt: new Date("2020-01-01T00:00:00Z") },
    });
    expect(await purgeExpiredAssistantAttachments()).toBe(1);
    expect(await purgeExpiredAssistantAttachments()).toBe(0);
  });
});

describe("GET /api/assistant/attachments/:id", () => {
  it("401s a signed-out caller", async () => {
    mockAuth.mockResolvedValue(null as never);
    expect((await request("anything")).status).toBe(401);
  });

  it("redirects the owner to a signed read URL", async () => {
    const { user } = await createStudent();
    const stored = await persistAttachments(
      { userId: user.id, audience: "student" },
      [image()],
      30,
    );
    asStudent(user.id);

    const res = await request(stored[0].id);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("https://cdn.test/");
    // The signed URL expires, so it must never be cached as this id's location.
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("404s another user's attachment id", async () => {
    const mine = await createStudent();
    const theirs = await createStudent();
    const stored = await persistAttachments(
      { userId: theirs.user.id, audience: "student" },
      [image()],
      30,
    );
    asStudent(mine.user.id);
    expect((await request(stored[0].id)).status).toBe(404);
  });

  it("404s an expired attachment", async () => {
    const { user } = await createStudent();
    const stored = await persistAttachments(
      { userId: user.id, audience: "student" },
      [image()],
      30,
    );
    await prisma.assistantAttachment.update({
      where: { id: stored[0].id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    asStudent(user.id);
    expect((await request(stored[0].id)).status).toBe(404);
  });

  it("404s a fabricated id", async () => {
    const { user } = await createStudent();
    asStudent(user.id);
    expect((await request("made-up")).status).toBe(404);
  });
});

describe("findUserAttachment", () => {
  it("does not return a row whose upload never completed", async () => {
    const { user } = await createStudent();
    // storageKey "" is the pre-upload state; nothing can be fetched from it.
    const row = await prisma.assistantAttachment.create({
      data: {
        userId: user.id,
        audience: "student",
        name: "half.png",
        mimeType: "image/png",
        kind: "image",
        bytes: 1,
        storageKey: "",
        bucket: "test-bucket",
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    expect(await findUserAttachment(user.id, row.id)).toBeNull();
  });
});

describe("POST /api/assistant/chat — persisting a turn's attachments", () => {
  /** Drain the NDJSON stream a chat turn produces. */
  async function chat(body: unknown): Promise<AssistantStreamEvent[]> {
    const res = await POST_CHAT(
      new Request("http://localhost/api/assistant/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    expect(res.status).toBe(200);
    const events: AssistantStreamEvent[] = [];
    for await (const event of readNdjson<AssistantStreamEvent>(res.body!))
      events.push(event);
    return events;
  }

  it("stores the attachment and streams its id before answering", async () => {
    const { user } = await createStudent();
    await saveAssistantSettings("student", { enabled: true });
    asStudent(user.id);

    // No provider is assigned, so the turn ends in an error event — but the
    // attachment must already have been kept and announced by then.
    const events = await chat({
      message: "what is this?",
      attachments: [
        { name: "shot.png", mimeType: "image/png", dataBase64: HELLO },
      ],
    });

    const announced = events.find((event) => event.type === "attachments");
    expect(announced).toBeDefined();
    const stored = (
      announced as { stored: Array<{ id: string; name: string }> }
    ).stored;
    expect(stored).toHaveLength(1);
    expect(stored[0].name).toBe("shot.png");

    const row = await prisma.assistantAttachment.findUniqueOrThrow({
      where: { id: stored[0].id },
    });
    expect(row.userId).toBe(user.id);
    expect(bucketContents.has(row.storageKey)).toBe(true);
  });

  it("announces nothing when the turn carries no attachments", async () => {
    const { user } = await createStudent();
    await saveAssistantSettings("student", { enabled: true });
    asStudent(user.id);

    const events = await chat({ message: "hello" });
    expect(events.some((event) => event.type === "attachments")).toBe(false);
    expect(await prisma.assistantAttachment.count()).toBe(0);
  });

  it("does not store an attachment the admin's limits rejected", async () => {
    const { user } = await createStudent();
    // CSV is not in the default allowed kinds, so it never reaches storage.
    await saveAssistantSettings("student", {
      enabled: true,
      attachmentKinds: ["image"],
    });
    asStudent(user.id);

    const events = await chat({
      message: "read this",
      attachments: [
        { name: "roster.csv", mimeType: "text/csv", dataBase64: HELLO },
      ],
    });
    expect(events.some((event) => event.type === "attachments")).toBe(false);
    expect(await prisma.assistantAttachment.count()).toBe(0);
  });
});
