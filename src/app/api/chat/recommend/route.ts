import { NextResponse } from "next/server";
import type OpenAI from "openai";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveProvider, createOpenAIClient } from "@/lib/ai-provider";
import { presignGetUrl, getS3Config } from "@/lib/storage";
import {
  FILE_SELECTION_SCHEMA,
  PAGE_SELECTION_SCHEMA,
  buildFileSelectionPrompt,
  buildPageSelectionPrompt,
  resolveSelectedMaterial,
  clampPageRange,
  type MisconceptionInput,
  type CatalogMaterial,
  type CatalogPage,
  type FileSelection,
  type PageSelection,
} from "@/lib/recommendation";

export const runtime = "nodejs";

// Bound LLM fan-out and rendered images: at most one recommendation per wrong
// question, capped, and at most this many pages shown per recommendation.
const MAX_RECOMMENDATIONS = 6;
const MAX_PAGES_PER_REC = 5;
const PROCESSED_STATUS = "SUCCESS";

type MaterialPageRow = {
  pageNumber: number;
  storageKey: string;
  needed: boolean | null;
  keyConcept: string | null;
  description: string | null;
};

type MaterialRow = {
  id: string;
  title: string | null;
  originalName: string;
  processingStatus: string;
  batchDescription: string | null;
  batchKeyConcepts: string;
  pages: MaterialPageRow[];
};

type Recommendation = {
  questionText: string;
  materialTitle: string;
  pageRange: { start: number; end: number };
  fileReason: string;
  pageReason: string;
  pages: { pageNumber: number; imageUrl: string }[];
};

function parseKeyConcepts(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === "string") : [];
  } catch {
    return [];
  }
}

/** Extract the first balanced-looking JSON object from a free-text response. */
function parseFirstJsonObject<T>(content: string): T {
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON object found in model response");
  return JSON.parse(match[0]) as T;
}

/**
 * Run one structured step against the LLM. Prefers OpenAI strict json_schema
 * output; if the provider rejects response_format (e.g. some local models),
 * retries once as a plain completion and parses JSON out of the text.
 */
async function runStructuredStep<T>(
  client: OpenAI,
  model: string,
  prompt: string,
  schemaName: string,
  schema: object
): Promise<T> {
  const messages = [{ role: "user" as const, content: prompt }];
  try {
    const res = await client.chat.completions.create({
      model,
      messages,
      response_format: {
        type: "json_schema",
        json_schema: { name: schemaName, schema: schema as Record<string, unknown>, strict: true },
      },
    });
    const content = res.choices?.[0]?.message?.content ?? "";
    return JSON.parse(content) as T;
  } catch {
    const res = await client.chat.completions.create({ model, messages });
    const content = res.choices?.[0]?.message?.content ?? "";
    return parseFirstJsonObject<T>(content);
  }
}

function correctAnswerText(options: Array<{ text: string; isCorrect: boolean }>): string | null {
  const correct = options.flatMap((o) => (o.isCorrect ? [o.text] : []));
  return correct.length > 0 ? correct.join(" | ") : null;
}

/** Append a unit suffix; LaTeX in the unit passes through raw (display-only). */
function withUnit(value: string, unit: string | null | undefined): string {
  return unit ? `${value} ${unit}` : value;
}

/**
 * Build the misconception input for one wrong answer. NUMERIC questions carry no
 * options, so surface the student's submitted number (or "No answer") and the
 * correct number (+unit); choice questions keep their option-text behavior.
 */
function misconceptionFor(answer: {
  numericValue: number | null;
  selectedOption: { text: string } | null;
  question: {
    text: string;
    options: Array<{ text: string; isCorrect: boolean }>;
    answerMode?: string;
    answerNumeric?: number | null;
    answerUnit?: string | null;
  };
}): MisconceptionInput {
  const { question } = answer;
  if (question.answerMode === "NUMERIC") {
    return {
      questionText: question.text,
      wrongAnswer:
        answer.numericValue != null
          ? withUnit(String(answer.numericValue), question.answerUnit)
          : "No answer",
      correctAnswer:
        question.answerNumeric != null
          ? withUnit(String(question.answerNumeric), question.answerUnit)
          : null,
    };
  }
  return {
    questionText: question.text,
    wrongAnswer: answer.selectedOption?.text ?? "No answer selected",
    correctAnswer: correctAnswerText(question.options),
  };
}

async function recommendForAnswer(
  client: OpenAI,
  model: string,
  bucket: string,
  input: MisconceptionInput,
  catalog: CatalogMaterial[],
  materials: MaterialRow[]
): Promise<Recommendation | null> {
  // Step 1: choose the most relevant material.
  const fileSelection = await runStructuredStep<FileSelection>(
    client,
    model,
    buildFileSelectionPrompt(input, catalog),
    "file_selection",
    FILE_SELECTION_SCHEMA
  );

  const chosen = resolveSelectedMaterial(fileSelection.material_index, catalog);
  if (!chosen) return null;
  const material = materials[chosen.index - 1];
  if (!material) return null;

  // Pages worth recommending: drop pages the VLM marked as non-teaching
  // (needed === false). If that leaves nothing, fall back to all pages.
  const teachingPages = material.pages.filter((p) => p.needed !== false);
  const usablePages = teachingPages.length > 0 ? teachingPages : material.pages;
  if (usablePages.length === 0) return null;

  const catalogPages: CatalogPage[] = usablePages.map((p) => ({
    pageNumber: p.pageNumber,
    keyConcept: p.keyConcept ?? "",
    description: p.description ?? "",
  }));

  // Step 2: choose a focused page range within the selected material.
  const pageSelection = await runStructuredStep<PageSelection>(
    client,
    model,
    buildPageSelectionPrompt(input, chosen.title, catalogPages),
    "page_selection",
    PAGE_SELECTION_SCHEMA
  );

  const range = clampPageRange(
    pageSelection.start_page,
    pageSelection.end_page,
    usablePages.map((p) => p.pageNumber)
  );
  if (!range) return null;

  const selectedPages = usablePages
    .filter((p) => p.pageNumber >= range.start && p.pageNumber <= range.end)
    .slice(0, MAX_PAGES_PER_REC);
  if (selectedPages.length === 0) return null;

  const pages = await Promise.all(
    selectedPages.map(async (p) => ({
      pageNumber: p.pageNumber,
      imageUrl: await presignGetUrl(bucket, p.storageKey),
    }))
  );

  return {
    questionText: input.questionText,
    materialTitle: chosen.title,
    pageRange: range,
    fileReason: fileSelection.reasoning,
    pageReason: pageSelection.reasoning,
    pages,
  };
}

const EMPTY = NextResponse.json({ recommendations: [] });

export async function POST() {
  try {
    const session = await auth();
    if (!session?.user || session.user.role !== "STUDENT") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const student = await prisma.student.findUnique({
      where: { userId: session.user.id },
      select: { id: true },
    });
    if (!student) return EMPTY;

    const attempt = await prisma.quizAttempt.findFirst({
      where: { studentId: student.id, completedAt: { not: null } },
      orderBy: { completedAt: "desc" },
      include: {
        answers: {
          select: {
            isCorrect: true,
            numericValue: true, // NUMERIC questions: the student's submitted number
            selectedOption: { select: { text: true } },
            question: {
              select: {
                text: true,
                options: { select: { text: true, isCorrect: true } },
                // NUMERIC grading data so the misconception input reflects the
                // numeric answer rather than (absent) option text.
                answerMode: true,
                answerNumeric: true,
                answerUnit: true,
              },
            },
          },
        },
      },
    });

    if (!attempt) return EMPTY;

    const incorrect = attempt.answers.filter((a) => !a.isCorrect);
    if (incorrect.length === 0) return EMPTY;

    // Catalog: materials shown in this class (MaterialClass is the source of
    // truth), restricted to fully processed files that have analysis metadata
    // and at least one page.
    const links = await prisma.materialClass.findMany({
      where: { classId: attempt.classId },
      select: {
        material: {
          select: {
            id: true,
            title: true,
            originalName: true,
            processingStatus: true,
            batchDescription: true,
            batchKeyConcepts: true,
            pages: {
              select: {
                pageNumber: true,
                storageKey: true,
                needed: true,
                keyConcept: true,
                description: true,
              },
              orderBy: { pageNumber: "asc" },
            },
          },
        },
      },
    });

    const materials: MaterialRow[] = links.flatMap((l) => {
      const m = l.material;
      return m.processingStatus === PROCESSED_STATUS &&
        !!m.batchDescription?.trim() &&
        m.pages.length > 0
        ? [m]
        : [];
    });

    if (materials.length === 0) return EMPTY;

    const provider = await resolveProvider("student_chat");
    if (!provider) return EMPTY;
    if (provider.providerType !== "local" && !provider.apiKey) return EMPTY;

    let bucket: string;
    try {
      bucket = getS3Config().bucket;
    } catch {
      return EMPTY;
    }

    const client = await createOpenAIClient(provider);

    const catalog: CatalogMaterial[] = materials.map((m, i) => ({
      index: i + 1,
      title: m.title?.trim() || m.originalName,
      description: m.batchDescription ?? "",
      keyConcepts: parseKeyConcepts(m.batchKeyConcepts),
    }));

    const truncated = incorrect.length > MAX_RECOMMENDATIONS;
    const toProcess = incorrect.slice(0, MAX_RECOMMENDATIONS);

    const results = await Promise.all(
      toProcess.map(async (answer) => {
        const input = misconceptionFor(answer);
        try {
          return await recommendForAnswer(client, provider.model, bucket, input, catalog, materials);
        } catch (err) {
          console.error("[Recommend] Failed to build recommendation for a question:", err);
          return null;
        }
      })
    );

    const recommendations = results.filter((r): r is Recommendation => r !== null);

    return NextResponse.json({
      recommendations,
      ...(truncated ? { truncated: true } : {}),
    });
  } catch (error) {
    console.error("Error handling recommendation request:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
