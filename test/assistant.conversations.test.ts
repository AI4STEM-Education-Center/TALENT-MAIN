import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { GET as GET_LIST } from "@/app/api/assistant/conversations/route";
import { GET as GET_ONE } from "@/app/api/assistant/conversations/[id]/route";
import { GET as GET_ADMIN_LIST } from "@/app/api/admin/assistants/conversations/route";
import { GET as GET_ADMIN_ONE } from "@/app/api/admin/assistants/conversations/[id]/route";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { saveAssistantSettings } from "@/lib/assistant/config";
import {
  appendTurn,
  deriveTitle,
  historyCutoff,
  listUserConversations,
  loadConversationHistory,
  parseTranscript,
  purgeEmptyConversations,
  readUserConversation,
  resolveConversation,
} from "@/lib/assistant/conversation-store";
import { resetDb, createStudent, createTeacher, createAdmin } from "./db";

const mockAuth = vi.mocked(auth);

const asStudent = (userId: string) =>
  mockAuth.mockResolvedValue({
    user: { id: userId, role: "STUDENT" },
  } as never);
const asTeacher = (userId: string) =>
  mockAuth.mockResolvedValue({
    user: { id: userId, role: "TEACHER" },
  } as never);
const asAdmin = (userId: string) =>
  mockAuth.mockResolvedValue({ user: { id: userId, role: "ADMIN" } } as never);

const DAY_MS = 24 * 60 * 60 * 1000;

const params = (id: string) => ({ params: Promise.resolve({ id }) });

/** Write a conversation with `turns` exchanges, dated `agedDays` in the past. */
async function seedConversation(opts: {
  userId: string;
  audience?: "student" | "teacher";
  title?: string;
  agedDays?: number;
  turns?: [string, string][];
}) {
  const audience = opts.audience ?? "student";
  const turns = opts.turns ?? [["hello", "hi there"]];
  const at = new Date(Date.now() - (opts.agedDays ?? 0) * DAY_MS);

  const conversation = await prisma.assistantConversation.create({
    data: {
      userId: opts.userId,
      audience,
      title: opts.title ?? deriveTitle(turns[0][0]),
      lastMessageAt: at,
      createdAt: at,
      messageCount: turns.length * 2,
    },
  });

  let seq = 0;
  for (const [question, answer] of turns) {
    await prisma.assistantMessage.createMany({
      data: [
        {
          conversationId: conversation.id,
          seq: seq,
          role: "user",
          content: question,
          createdAt: at,
        },
        {
          conversationId: conversation.id,
          seq: seq + 1,
          role: "assistant",
          content: answer,
          createdAt: at,
        },
      ],
    });
    seq += 2;
  }
  return conversation;
}

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
  await saveAssistantSettings("student", {
    enabled: true,
    historyRetentionDays: 30,
  });
  await saveAssistantSettings("teacher", {
    enabled: true,
    historyRetentionDays: 30,
  });
});

// ─── Pure helpers ────────────────────────────────────────────────────────────

describe("deriveTitle", () => {
  it("takes the first line so a pasted block doesn't become the title", () => {
    expect(deriveTitle("What is momentum?\nAlso, what is force?")).toBe(
      "What is momentum?",
    );
  });

  it("truncates a long single line with an ellipsis", () => {
    const title = deriveTitle("x".repeat(500));
    expect(title).toHaveLength(120);
    expect(title.endsWith("…")).toBe(true);
  });

  it("falls back to a label rather than an empty string", () => {
    expect(deriveTitle("   \n  ")).toBe("New conversation");
  });
});

describe("historyCutoff", () => {
  it("is the retention window before the given instant", () => {
    const now = new Date("2026-03-31T00:00:00Z");
    expect(historyCutoff(30, now).toISOString()).toBe(
      "2026-03-01T00:00:00.000Z",
    );
  });
});

describe("parseTranscript", () => {
  it("skips the header line and reads the turns", () => {
    const body = [
      JSON.stringify({ v: 1, conversationId: "c1", title: "t" }),
      JSON.stringify({
        role: "user",
        content: "q",
        attachmentNames: ["a.png"],
      }),
      JSON.stringify({ role: "assistant", content: "a" }),
      "",
    ].join("\n");
    expect(parseTranscript(body)).toEqual([
      {
        role: "user",
        content: "q",
        attachmentIds: [],
        attachmentNames: ["a.png"],
      },
      {
        role: "assistant",
        content: "a",
        attachmentIds: [],
        attachmentNames: [],
      },
    ]);
  });

  it("keeps the turns before a truncated final line", () => {
    const body = `${JSON.stringify({ role: "user", content: "q" })}\n{"role":"assist`;
    expect(parseTranscript(body)).toHaveLength(1);
  });
});

// ─── Writing turns ───────────────────────────────────────────────────────────

describe("resolveConversation", () => {
  it("opens a new conversation titled from the first message", async () => {
    const { user } = await createStudent();
    const id = await resolveConversation(
      { userId: user.id, audience: "student" },
      null,
      "Why is the sky blue?",
      30,
    );
    const row = await prisma.assistantConversation.findUniqueOrThrow({
      where: { id: id! },
    });
    expect(row.title).toBe("Why is the sky blue?");
    expect(row.messageCount).toBe(0);
  });

  it("resumes a conversation the caller owns", async () => {
    const { user } = await createStudent();
    const existing = await seedConversation({ userId: user.id });
    const id = await resolveConversation(
      { userId: user.id, audience: "student" },
      existing.id,
      "next question",
      30,
    );
    expect(id).toBe(existing.id);
  });

  it("starts a new conversation rather than resuming somebody else's id", async () => {
    const { user: owner } = await createStudent();
    const { user: other } = await createStudent();
    const theirs = await seedConversation({ userId: owner.id });

    const id = await resolveConversation(
      { userId: other.id, audience: "student" },
      theirs.id,
      "sneaky",
      30,
    );
    expect(id).not.toBe(theirs.id);
    const row = await prisma.assistantConversation.findUniqueOrThrow({
      where: { id: id! },
    });
    expect(row.userId).toBe(other.id);
  });

  it("will not resume a conversation that has aged out of the window", async () => {
    const { user } = await createStudent();
    const old = await seedConversation({ userId: user.id, agedDays: 31 });
    const id = await resolveConversation(
      { userId: user.id, audience: "student" },
      old.id,
      "still there?",
      30,
    );
    expect(id).not.toBe(old.id);
  });

  it("will not resume across audiences", async () => {
    const { user } = await createTeacher();
    const asStudentConversation = await seedConversation({
      userId: user.id,
      audience: "student",
    });
    const id = await resolveConversation(
      { userId: user.id, audience: "teacher" },
      asStudentConversation.id,
      "hi",
      30,
    );
    expect(id).not.toBe(asStudentConversation.id);
  });
});

describe("appendTurn", () => {
  it("writes both halves and advances the counters together", async () => {
    const { user } = await createStudent();
    const id = (await resolveConversation(
      { userId: user.id, audience: "student" },
      null,
      "first",
      30,
    ))!;

    await appendTurn(
      id,
      {
        content: "first",
        attachmentIds: ["att1"],
        attachmentNames: ["graph.png"],
      },
      "the answer",
    );

    const row = await prisma.assistantConversation.findUniqueOrThrow({
      where: { id },
    });
    expect(row.messageCount).toBe(2);

    const turns = await loadConversationHistory(id, 20);
    expect(turns).toEqual([
      {
        role: "user",
        content: "first",
        attachmentIds: ["att1"],
        attachmentNames: ["graph.png"],
      },
      {
        role: "assistant",
        content: "the answer",
        attachmentIds: [],
        attachmentNames: [],
      },
    ]);
  });

  it("orders turns by sequence, not by clock, when two land in the same millisecond", async () => {
    const { user } = await createStudent();
    const id = (await resolveConversation(
      { userId: user.id, audience: "student" },
      null,
      "q",
      30,
    ))!;
    // The SAME instant for both exchanges: timestamps alone cannot order these,
    // which is exactly why AssistantMessage carries an explicit `seq`.
    const now = new Date();
    await appendTurn(
      id,
      { content: "q", attachmentIds: [], attachmentNames: [] },
      "a",
      now,
    );
    await appendTurn(
      id,
      { content: "q2", attachmentIds: [], attachmentNames: [] },
      "a2",
      now,
    );

    expect(
      (await loadConversationHistory(id, 20)).map((turn) => turn.content),
    ).toEqual(["q", "a", "q2", "a2"]);
  });
});

describe("loadConversationHistory", () => {
  it("returns the newest turns, oldest first, within the limit", async () => {
    const { user } = await createStudent();
    const conversation = await seedConversation({
      userId: user.id,
      turns: [
        ["q1", "a1"],
        ["q2", "a2"],
        ["q3", "a3"],
      ],
    });
    const turns = await loadConversationHistory(conversation.id, 2);
    expect(turns.map((turn) => turn.content)).toEqual(["q3", "a3"]);
  });
});

// ─── User-facing reads ───────────────────────────────────────────────────────

describe("listUserConversations", () => {
  it("lists only the caller's own conversations, newest first", async () => {
    const { user } = await createStudent();
    const { user: other } = await createStudent();
    await seedConversation({ userId: user.id, title: "older", agedDays: 3 });
    await seedConversation({ userId: user.id, title: "newer", agedDays: 1 });
    await seedConversation({ userId: other.id, title: "theirs" });

    const rows = await listUserConversations(
      { userId: user.id, audience: "student" },
      30,
    );
    expect(rows.map((row) => row.title)).toEqual(["newer", "older"]);
  });

  it("hides conversations past the retention window", async () => {
    const { user } = await createStudent();
    await seedConversation({ userId: user.id, title: "inside", agedDays: 29 });
    await seedConversation({ userId: user.id, title: "outside", agedDays: 31 });

    const rows = await listUserConversations(
      { userId: user.id, audience: "student" },
      30,
    );
    expect(rows.map((row) => row.title)).toEqual(["inside"]);
  });

  it("honours a shortened window without waiting for the archiver", async () => {
    const { user } = await createStudent();
    await seedConversation({
      userId: user.id,
      title: "eight days ago",
      agedDays: 8,
    });

    expect(
      await listUserConversations({ userId: user.id, audience: "student" }, 30),
    ).toHaveLength(1);
    // Same un-archived rows, smaller window: visibility is decided by the date.
    expect(
      await listUserConversations({ userId: user.id, audience: "student" }, 7),
    ).toHaveLength(0);
  });

  it("omits conversations that never recorded a turn", async () => {
    const { user } = await createStudent();
    await resolveConversation(
      { userId: user.id, audience: "student" },
      null,
      "unanswered",
      30,
    );
    expect(
      await listUserConversations({ userId: user.id, audience: "student" }, 30),
    ).toEqual([]);
  });

  it("omits archived conversations even if the window would allow them", async () => {
    const { user } = await createStudent();
    const conversation = await seedConversation({
      userId: user.id,
      agedDays: 1,
    });
    await prisma.assistantConversation.update({
      where: { id: conversation.id },
      data: { archivedAt: new Date(), storageKey: "k", bucket: "b" },
    });
    expect(
      await listUserConversations({ userId: user.id, audience: "student" }, 30),
    ).toEqual([]);
  });
});

describe("readUserConversation", () => {
  it("returns the whole transcript for the owner", async () => {
    const { user } = await createStudent();
    const conversation = await seedConversation({
      userId: user.id,
      turns: [
        ["q1", "a1"],
        ["q2", "a2"],
      ],
    });
    const result = await readUserConversation(
      { userId: user.id, audience: "student" },
      conversation.id,
      30,
    );
    expect(result?.turns.map((turn) => turn.content)).toEqual([
      "q1",
      "a1",
      "q2",
      "a2",
    ]);
  });

  it("is null for another user's conversation", async () => {
    const { user: owner } = await createStudent();
    const { user: other } = await createStudent();
    const conversation = await seedConversation({ userId: owner.id });
    expect(
      await readUserConversation(
        { userId: other.id, audience: "student" },
        conversation.id,
        30,
      ),
    ).toBeNull();
  });

  it("is null once the conversation is past the window", async () => {
    const { user } = await createStudent();
    const conversation = await seedConversation({
      userId: user.id,
      agedDays: 31,
    });
    expect(
      await readUserConversation(
        { userId: user.id, audience: "student" },
        conversation.id,
        30,
      ),
    ).toBeNull();
  });
});

// ─── Archival housekeeping ───────────────────────────────────────────────────

describe("purgeEmptyConversations", () => {
  it("drops aged conversations that never recorded a turn, keeping the rest", async () => {
    const { user } = await createStudent();
    await resolveConversation(
      { userId: user.id, audience: "student" },
      null,
      "unanswered",
      30,
      new Date(Date.now() - 40 * DAY_MS),
    );
    const withTurns = await seedConversation({ userId: user.id, agedDays: 40 });

    const cutoffs = [
      { audience: "student" as const, cutoff: historyCutoff(30) },
    ];
    expect(await purgeEmptyConversations(cutoffs)).toBe(1);
    expect(await prisma.assistantConversation.findMany()).toHaveLength(1);
    expect((await prisma.assistantConversation.findFirst())?.id).toBe(
      withTurns.id,
    );
  });

  it("leaves an empty conversation alone while it is still inside the window", async () => {
    const { user } = await createStudent();
    await resolveConversation(
      { userId: user.id, audience: "student" },
      null,
      "fresh",
      30,
    );
    const cutoffs = [
      { audience: "student" as const, cutoff: historyCutoff(30) },
    ];
    expect(await purgeEmptyConversations(cutoffs)).toBe(0);
  });
});

// ─── User-facing routes ──────────────────────────────────────────────────────

describe("GET /api/assistant/conversations", () => {
  it("returns the caller's history and the window it was cut at", async () => {
    const { user } = await createStudent();
    asStudent(user.id);
    await seedConversation({ userId: user.id, title: "kept", agedDays: 2 });
    await seedConversation({
      userId: user.id,
      title: "aged out",
      agedDays: 45,
    });

    const res = await GET_LIST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.retentionDays).toBe(30);
    expect(
      body.conversations.map((row: { title: string }) => row.title),
    ).toEqual(["kept"]);
  });

  it("is 401 when signed out", async () => {
    mockAuth.mockResolvedValue(null as never);
    expect((await GET_LIST()).status).toBe(401);
  });

  it("is 401 for an admin, who has no assistant of their own", async () => {
    const admin = await createAdmin();
    asAdmin(admin.id);
    expect((await GET_LIST()).status).toBe(401);
  });
});

describe("GET /api/assistant/conversations/:id", () => {
  it("returns the owner's transcript", async () => {
    const { user } = await createStudent();
    asStudent(user.id);
    const conversation = await seedConversation({
      userId: user.id,
      turns: [["what is force?", "mass times acceleration"]],
    });

    const res = await GET_ONE(
      new Request("http://localhost"),
      params(conversation.id),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.turns.map((turn: { content: string }) => turn.content)).toEqual(
      ["what is force?", "mass times acceleration"],
    );
  });

  it("is 404 — not 403 — for another user's conversation", async () => {
    const { user: owner } = await createStudent();
    const { user: other } = await createStudent();
    const conversation = await seedConversation({ userId: owner.id });
    asStudent(other.id);

    const res = await GET_ONE(
      new Request("http://localhost"),
      params(conversation.id),
    );
    expect(res.status).toBe(404);
  });

  it("is 404 once the conversation is older than the configured window", async () => {
    const { user } = await createStudent();
    asStudent(user.id);
    const conversation = await seedConversation({
      userId: user.id,
      agedDays: 31,
    });

    const res = await GET_ONE(
      new Request("http://localhost"),
      params(conversation.id),
    );
    expect(res.status).toBe(404);
  });

  it("follows a shortened window immediately", async () => {
    const { user } = await createStudent();
    asStudent(user.id);
    const conversation = await seedConversation({
      userId: user.id,
      agedDays: 10,
    });

    expect(
      (await GET_ONE(new Request("http://localhost"), params(conversation.id)))
        .status,
    ).toBe(200);

    await saveAssistantSettings("student", { historyRetentionDays: 7 });
    expect(
      (await GET_ONE(new Request("http://localhost"), params(conversation.id)))
        .status,
    ).toBe(404);
  });
});

// ─── Admin routes ────────────────────────────────────────────────────────────

const adminListRequest = (query = "") =>
  new Request(`http://localhost/api/admin/assistants/conversations?${query}`);

describe("GET /api/admin/assistants/conversations", () => {
  it("is 403 for a non-admin", async () => {
    const { user } = await createStudent();
    asStudent(user.id);
    expect((await GET_ADMIN_LIST(adminListRequest())).status).toBe(403);
  });

  it("shows conversations past the user's own retention window", async () => {
    const { user } = await createStudent();
    const admin = await createAdmin();
    await seedConversation({
      userId: user.id,
      title: "ancient",
      agedDays: 400,
    });
    asAdmin(admin.id);

    const res = await GET_ADMIN_LIST(adminListRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.rows[0].title).toBe("ancient");
    expect(body.rows[0].userEmail).toBe(user.email);
  });

  it("filters by audience", async () => {
    const { user: student } = await createStudent();
    const { user: teacher } = await createTeacher();
    const admin = await createAdmin();
    await seedConversation({
      userId: student.id,
      audience: "student",
      title: "s",
    });
    await seedConversation({
      userId: teacher.id,
      audience: "teacher",
      title: "t",
    });
    asAdmin(admin.id);

    const body = await (
      await GET_ADMIN_LIST(adminListRequest("audience=teacher"))
    ).json();
    expect(body.rows.map((row: { title: string }) => row.title)).toEqual(["t"]);
  });

  it("searches the message bodies of live conversations", async () => {
    const { user } = await createStudent();
    const admin = await createAdmin();
    await seedConversation({
      userId: user.id,
      title: "unrelated title",
      turns: [["tell me about photosynthesis", "plants convert light"]],
    });
    await seedConversation({
      userId: user.id,
      title: "other",
      turns: [["algebra", "maths"]],
    });
    asAdmin(admin.id);

    const body = await (
      await GET_ADMIN_LIST(adminListRequest("q=photosynthesis"))
    ).json();
    expect(body.rows.map((row: { title: string }) => row.title)).toEqual([
      "unrelated title",
    ]);
  });

  it("filters by user email", async () => {
    const { user: a } = await createStudent();
    const { user: b } = await createStudent();
    const admin = await createAdmin();
    await seedConversation({ userId: a.id, title: "a's chat" });
    await seedConversation({ userId: b.id, title: "b's chat" });
    asAdmin(admin.id);

    const body = await (
      await GET_ADMIN_LIST(
        adminListRequest(`user=${encodeURIComponent(a.email)}`),
      )
    ).json();
    expect(body.rows.map((row: { title: string }) => row.title)).toEqual([
      "a's chat",
    ]);
  });
});

describe("GET /api/admin/assistants/conversations/:id", () => {
  it("is 403 for a teacher", async () => {
    const { user } = await createTeacher();
    const target = await seedConversation({ userId: user.id });
    asTeacher(user.id);
    const res = await GET_ADMIN_ONE(
      new Request("http://localhost"),
      params(target.id),
    );
    expect(res.status).toBe(403);
  });

  it("reads a live transcript and reports its tier", async () => {
    const { user } = await createStudent();
    const admin = await createAdmin();
    const conversation = await seedConversation({
      userId: user.id,
      agedDays: 400,
      turns: [["old question", "old answer"]],
    });
    asAdmin(admin.id);

    const res = await GET_ADMIN_ONE(
      new Request("http://localhost"),
      params(conversation.id),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.archived).toBe(false);
    expect(body.transcriptUnavailable).toBe(false);
    expect(body.turns.map((turn: { content: string }) => turn.content)).toEqual(
      ["old question", "old answer"],
    );
  });

  it("flags an archived transcript whose object cannot be read", async () => {
    const { user } = await createStudent();
    const admin = await createAdmin();
    const conversation = await seedConversation({ userId: user.id });
    await prisma.assistantConversation.update({
      where: { id: conversation.id },
      data: {
        archivedAt: new Date(),
        bucket: "missing-bucket",
        storageKey: "missing-key",
      },
    });
    asAdmin(admin.id);

    const body = await (
      await GET_ADMIN_ONE(
        new Request("http://localhost"),
        params(conversation.id),
      )
    ).json();
    expect(body.archived).toBe(true);
    // The record exists; only its bytes are unreachable. That must not read as
    // an empty conversation.
    expect(body.transcriptUnavailable).toBe(true);
    expect(body.turns).toEqual([]);
  });

  it("is 404 for an unknown id", async () => {
    const admin = await createAdmin();
    asAdmin(admin.id);
    const res = await GET_ADMIN_ONE(
      new Request("http://localhost"),
      params("nope"),
    );
    expect(res.status).toBe(404);
  });
});
