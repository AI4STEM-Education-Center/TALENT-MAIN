import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rate-limit";
import { parseBody, conceptsImportSchema } from "@/lib/validation";
import { logApiError } from "@/lib/system-log";

// POST /api/admin/concepts/import
// Admin-only. Body: { concepts: ParsedConcept[] } (already parsed client-side
// by src/lib/concept-csv.ts). Full-sync semantics: every row is upserted by
// its natural key (conceptId), then records absent from the payload are soft
// deprecated. This preserves mapping history and prevents a partial import
// from cascading into destructive data loss.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limited = rateLimit(req, "admin-concepts-import", 10, 60_000);
  if (limited) return limited;

  try {
    const body = await req.json();
    const parsed = parseBody(conceptsImportSchema, body);
    if (!parsed.ok) return parsed.response;
    const { concepts } = parsed.data;

    // De-dupe by natural key so a payload with repeated conceptIds (should not
    // happen from our own parser, which already collapses duplicates, but the
    // API itself does not assume a trusted client) doesn't attempt two upserts
    // for the same row inside one transaction.
    const byConceptId = new Map<string, (typeof concepts)[number]>();
    for (const c of concepts) byConceptId.set(c.conceptId, c);
    const deduped = [...byConceptId.values()];
    const payloadIds = deduped.map((c) => c.conceptId);

    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.concept.findMany({ select: { conceptId: true } });
      const existingIds = new Set(existing.map((e) => e.conceptId));

      let created = 0;
      let updated = 0;

      for (const c of deduped) {
        if (existingIds.has(c.conceptId)) updated++;
        else created++;

        await tx.concept.upsert({
          where: { conceptId: c.conceptId },
          create: {
            conceptId: c.conceptId,
            kind: c.kind,
            parentApLo: c.parentApLo,
            unit: c.unit,
            topic: c.topic,
            displayName: c.displayName,
            description: c.description,
            sourceLoCode: c.sourceLoCode,
            comments: c.comments,
            notes: c.notes,
            url: c.url,
            deprecated: c.deprecated,
            deprecationNote: c.deprecationNote,
          },
          update: {
            kind: c.kind,
            parentApLo: c.parentApLo,
            unit: c.unit,
            topic: c.topic,
            displayName: c.displayName,
            description: c.description,
            sourceLoCode: c.sourceLoCode,
            comments: c.comments,
            notes: c.notes,
            url: c.url,
            deprecated: c.deprecated,
            deprecationNote: c.deprecationNote,
          },
        });
      }

      const { count: deprecated } = await tx.concept.updateMany({
        where: { conceptId: { notIn: payloadIds }, deprecated: false },
        data: { deprecated: true },
      });

      return { created, updated, deprecated };
    });

    return NextResponse.json(result);
  } catch (error) {
    logApiError("ADMIN_CONCEPTS_IMPORT", error);
    return NextResponse.json({ error: "Internal Error" }, { status: 500 });
  }
}
