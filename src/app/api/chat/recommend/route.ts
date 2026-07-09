import { NextResponse } from "next/server";
import type OpenAI from "openai";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveProvider, createOpenAIClient } from "@/lib/ai-provider";
import { streamJsonCompletion } from "@/lib/ai-streaming";
import { presignGetUrl, getS3Config } from "@/lib/storage";
import {
  MATERIAL_SELECTION_SCHEMA,
  PAGE_SELECTION_SCHEMA,
  buildMaterialSelectionPrompt,
  buildPageSelectionPrompt,
  resolveSelectedMaterial,
  dedupeSelectedMaterials,
  clampPageRange,
  type HolisticAttempt,
  type CatalogMaterial,
  type CatalogPage,
  type MaterialSelection,
  type SelectedMaterial,
  type PageSelection,
} from "@/lib/recommendation";
import { logApiError } from "@/lib/system-log";

export const runtime = "nodejs";

// At most this many pages shown per recommendation.
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

// Holistic recommendation: one card per chosen material (no per-question
// framing), so it never reveals which questions the student got wrong.
type Recommendation = {
  materialTitle: string;
  pageRange: { start: number; end: number };
  reason: string;
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

/**
 * Run one streamed structured step against the LLM. `streamJsonCompletion`
 * prefers strict json_schema output and falls back to a plain streamed
 * completion (parsing the JSON out of the text) for providers that reject
 * response_format, e.g. some local models.
 */
async function runStructuredStep<T>(
  client: OpenAI,
  model: string,
  prompt: string,
  schemaName: string,
  schema: object,
  isLocal: boolean
): Promise<T> {
  const { value } = await streamJsonCompletion<T>(
    client,
    { model, messages: [{ role: "user", content: prompt }] },
    { name: schemaName, schema: schema as Record<string, unknown>, strict: true },
    { includeUsage: !isLocal, requestOptions: { maxRetries: isLocal ? 0 : 3 } }
  );
  return value;
}

/** Step 2 for one chosen material: pick a focused 0-5 page range within it. */
async function recommendForMaterial(
  client: OpenAI,
  model: string,
  bucket: string,
  attempt: HolisticAttempt,
  chosen: CatalogMaterial,
  material: MaterialRow,
  materialReason: string,
  isLocal: boolean
): Promise<Recommendation | null> {
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

  const pageSelection = await runStructuredStep<PageSelection>(
    client,
    model,
    buildPageSelectionPrompt(attempt, chosen.title, catalogPages),
    "page_selection",
    PAGE_SELECTION_SCHEMA,
    isLocal
  );

  if (!pageSelection.has_relevant_pages) return null;

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
    materialTitle: chosen.title,
    pageRange: range,
    reason: pageSelection.reasoning?.trim() || materialReason,
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
            question: { select: { text: true } },
          },
        },
      },
    });

    if (!attempt) return EMPTY;
    if (attempt.answers.length === 0) return EMPTY;

    // Holistic attempt picture (every question + correctness, aggregate counts).
    // The prompts never reveal which questions were wrong.
    const holistic: HolisticAttempt = {
      questions: attempt.answers.map((a) => ({
        questionText: a.question.text,
        isCorrect: a.isCorrect,
      })),
      correctCount: attempt.answers.filter((a) => a.isCorrect).length,
      incorrectCount: attempt.answers.filter((a) => !a.isCorrect).length,
    };
    if (holistic.incorrectCount === 0) return EMPTY;

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
    const isLocal = provider.providerType === "local";

    const catalog: CatalogMaterial[] = materials.map((m, i) => ({
      index: i + 1,
      title: m.title?.trim() || m.originalName,
      description: m.batchDescription ?? "",
      keyConcepts: parseKeyConcepts(m.batchKeyConcepts),
    }));

    // Step 1: choose at most 3 materials across the whole attempt.
    const materialSelection = await runStructuredStep<MaterialSelection>(
      client,
      provider.model,
      buildMaterialSelectionPrompt(holistic, catalog),
      "material_selection",
      MATERIAL_SELECTION_SCHEMA,
      isLocal
    );
    const { kept, truncated } = dedupeSelectedMaterials(materialSelection.materials ?? [], catalog);

    // Step 2: one page-selection call per chosen material (skipped when none).
    const results = await Promise.all(
      kept.map(async (sel: SelectedMaterial) => {
        const chosen = resolveSelectedMaterial(sel.material_index, catalog);
        const material = chosen ? materials[chosen.index - 1] : undefined;
        if (!chosen || !material) return null;
        try {
          return await recommendForMaterial(
            client,
            provider.model,
            bucket,
            holistic,
            chosen,
            material,
            sel.reasoning,
            isLocal
          );
        } catch (err) {
          logApiError("CHAT_RECOMMEND", err, "Failed to build a recommendation");
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
