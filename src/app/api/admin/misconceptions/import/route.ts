import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rate-limit";
import { parseBody, misconceptionsImportSchema } from "@/lib/validation";
import { logApiError } from "@/lib/system-log";

// POST /api/admin/misconceptions/import
// Admin-only. Body: { misconceptions: ParsedMisconception[] } (already parsed
// client-side by src/lib/concept-csv.ts). Full-sync semantics, mirroring
// /api/admin/concepts/import: upsert every row by its natural key
// (misconceptionId), then soft-deprecate entries absent from the payload.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limited = rateLimit(req, "admin-misconceptions-import", 10, 60_000);
  if (limited) return limited;

  try {
    const body = await req.json();
    const parsed = parseBody(misconceptionsImportSchema, body);
    if (!parsed.ok) return parsed.response;
    const { misconceptions } = parsed.data;

    // De-dupe by natural key (defense in depth — our own parser already
    // collapses duplicates, but the API doesn't assume a trusted client).
    const byId = new Map<string, (typeof misconceptions)[number]>();
    for (const m of misconceptions) byId.set(m.misconceptionId, m);
    const deduped = [...byId.values()];
    const payloadIds = deduped.map((m) => m.misconceptionId);

    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.misconception.findMany({
        select: { misconceptionId: true },
      });
      const existingIds = new Set(existing.map((e) => e.misconceptionId));

      let created = 0;
      let updated = 0;

      for (const m of deduped) {
        if (existingIds.has(m.misconceptionId)) updated++;
        else created++;

        await tx.misconception.upsert({
          where: { misconceptionId: m.misconceptionId },
          create: {
            misconceptionId: m.misconceptionId,
            statement: m.statement,
            sourceCitation: m.sourceCitation,
            link: m.link,
            sourceType: m.sourceType,
            notes: m.notes,
            deprecated: m.deprecated,
            deprecationNote: m.deprecationNote,
          },
          update: {
            statement: m.statement,
            sourceCitation: m.sourceCitation,
            link: m.link,
            sourceType: m.sourceType,
            notes: m.notes,
            deprecated: m.deprecated,
            deprecationNote: m.deprecationNote,
          },
        });
      }

      const { count: deprecated } = await tx.misconception.updateMany({
        where: { misconceptionId: { notIn: payloadIds }, deprecated: false },
        data: { deprecated: true },
      });

      return { created, updated, deprecated };
    });

    return NextResponse.json(result);
  } catch (error) {
    logApiError("ADMIN_MISCONCEPTIONS_IMPORT", error);
    return NextResponse.json({ error: "Internal Error" }, { status: 500 });
  }
}
