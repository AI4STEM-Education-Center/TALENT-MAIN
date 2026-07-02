import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rate-limit";
import { parseBody, conceptMappingsImportSchema } from "@/lib/validation";

// POST /api/admin/concept-mappings/import
// Admin-only. Body: { mappings: ParsedMapping[], externalRefs: ParsedExternalRef[] }
// (already parsed client-side by src/lib/concept-csv.ts).
//
// Full-sync semantics for BOTH tables, but unlike the concepts/misconceptions
// routes this is a delete-then-recreate (not an upsert): ConceptMisconception
// rows have no independent identity outside the (misconceptionId, conceptId)
// pair, and concept/misconception full-sync imports already cascade-delete
// stale mappings on their own delete pass — so there is nothing to preserve
// across a mapping re-upload. Deleting first, inside the same transaction as
// the recreate, keeps the table from ever being briefly out of sync with a
// half-applied upload.
//
// Unknown references abort the entire transaction before the existing mapping
// tables are touched. Admins get a validation error instead of a partial sync.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limited = rateLimit(req, "admin-concept-mappings-import", 10, 60_000);
  if (limited) return limited;

  try {
    const body = await req.json();
    const parsed = parseBody(conceptMappingsImportSchema, body);
    if (!parsed.ok) return parsed.response;
    const { mappings, externalRefs } = parsed.data;

    const result = await prisma.$transaction(async (tx) => {
      const [concepts, misconceptions] = await Promise.all([
        tx.concept.findMany({ select: { conceptId: true } }),
        tx.misconception.findMany({ select: { misconceptionId: true } }),
      ]);
      const conceptIds = new Set(concepts.map((c) => c.conceptId));
      const misconceptionIds = new Set(misconceptions.map((m) => m.misconceptionId));

      const skipped: { misconceptionId: string; conceptId: string; reason: string }[] = [];
      const validMappings = new Map<string, (typeof mappings)[number]>();

      for (const m of mappings) {
        const missingConcept = !conceptIds.has(m.conceptId);
        const missingMisconception = !misconceptionIds.has(m.misconceptionId);
        if (missingConcept || missingMisconception) {
          const reason = missingConcept && missingMisconception
            ? "Unknown conceptId and misconceptionId"
            : missingConcept
              ? "Unknown conceptId"
              : "Unknown misconceptionId";
          skipped.push({ misconceptionId: m.misconceptionId, conceptId: m.conceptId, reason });
          continue;
        }
        // De-dupe by natural key (last wins) — defense in depth, mirroring the
        // concepts/misconceptions routes.
        validMappings.set(`${m.misconceptionId}|${m.conceptId}`, m);
      }

      if (skipped.length > 0) {
        return { ok: false as const, skipped };
      }

      const dedupedExternalRefs = new Map<string, (typeof externalRefs)[number]>();
      for (const r of externalRefs) {
        dedupedExternalRefs.set(`${r.conceptId}|${r.refCode}|${r.refType}`, r);
      }

      // Delete-then-recreate, both inside this transaction (see file-level
      // comment above for why this table can't be upserted the way
      // concepts/misconceptions are).
      await tx.conceptMisconception.deleteMany({});
      await tx.conceptExternalRef.deleteMany({});

      if (validMappings.size > 0) {
        await tx.conceptMisconception.createMany({
          data: [...validMappings.values()].map((m) => ({
            misconceptionId: m.misconceptionId,
            conceptId: m.conceptId,
            confidence: m.confidence,
            notes: m.notes,
          })),
        });
      }

      if (dedupedExternalRefs.size > 0) {
        await tx.conceptExternalRef.createMany({
          data: [...dedupedExternalRefs.values()].map((r) => ({
            conceptId: r.conceptId,
            refCode: r.refCode,
            refType: r.refType,
            sourceUrl: r.sourceUrl,
          })),
        });
      }

      return {
        ok: true as const,
        mappings: validMappings.size,
        externalRefs: dedupedExternalRefs.size,
        skipped,
      };
    });

    if (!result.ok) {
      return NextResponse.json(
        {
          error: `Import cancelled: ${result.skipped.length} mapping row(s) reference unknown concepts or misconceptions. No data was changed.`,
          skipped: result.skipped,
        },
        { status: 400 }
      );
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("[ADMIN_CONCEPT_MAPPINGS_IMPORT]", error);
    return NextResponse.json({ error: "Internal Error" }, { status: 500 });
  }
}
