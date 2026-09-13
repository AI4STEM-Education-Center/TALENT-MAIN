import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { ConceptsClient } from "./concepts-client";
import type {
  ConceptRow,
  MisconceptionRow,
  MappingRow,
  ExternalRefRow,
} from "./types";

export default async function AdminConceptsPage() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") redirect("/login");

  const [concepts, misconceptions, mappings, externalRefs] = await Promise.all([
    prisma.concept.findMany({
      orderBy: [{ unit: "asc" }, { topic: "asc" }, { conceptId: "asc" }],
    }),
    prisma.misconception.findMany({ orderBy: { misconceptionId: "asc" } }),
    prisma.conceptMisconception.findMany({
      orderBy: { misconceptionId: "asc" },
      select: {
        id: true,
        misconceptionId: true,
        conceptId: true,
        confidence: true,
        notes: true,
        misconception: { select: { statement: true } },
        concept: { select: { displayName: true } },
      },
    }),
    prisma.conceptExternalRef.findMany({
      orderBy: [{ conceptId: "asc" }, { refCode: "asc" }],
    }),
  ]);

  const conceptRows: ConceptRow[] = concepts.map((c) => ({
    id: c.id,
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
  }));

  const misconceptionRows: MisconceptionRow[] = misconceptions.map((m) => ({
    id: m.id,
    misconceptionId: m.misconceptionId,
    statement: m.statement,
    sourceCitation: m.sourceCitation,
    link: m.link,
    sourceType: m.sourceType,
    notes: m.notes,
    deprecated: m.deprecated,
    deprecationNote: m.deprecationNote,
  }));

  const mappingRows: MappingRow[] = mappings.map((m) => ({
    id: m.id,
    misconceptionId: m.misconceptionId,
    conceptId: m.conceptId,
    confidence: m.confidence,
    notes: m.notes,
    misconceptionStatement: m.misconception.statement,
    conceptDisplayName: m.concept.displayName,
  }));

  const externalRefRows: ExternalRefRow[] = externalRefs.map((r) => ({
    id: r.id,
    conceptId: r.conceptId,
    refCode: r.refCode,
    refType: r.refType,
    sourceUrl: r.sourceUrl,
  }));

  return (
    <ConceptsClient
      concepts={conceptRows}
      misconceptions={misconceptionRows}
      mappings={mappingRows}
      externalRefs={externalRefRows}
    />
  );
}
