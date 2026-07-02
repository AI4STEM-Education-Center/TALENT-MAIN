// Plain serializable row shapes passed from the server component
// (page.tsx) down to the client tables. Kept separate from the Prisma
// models so the client bundle never needs `@prisma/client` types.

export interface ConceptRow {
  id: string;
  conceptId: string;
  kind: string;
  parentApLo: string | null;
  unit: string | null;
  topic: string | null;
  displayName: string;
  description: string | null;
  sourceLoCode: string | null;
  comments: string | null;
  notes: string | null;
  url: string | null;
  deprecated: boolean;
  deprecationNote: string | null;
}

export interface MisconceptionRow {
  id: string;
  misconceptionId: string;
  statement: string;
  sourceCitation: string | null;
  link: string | null;
  sourceType: string | null;
  notes: string | null;
  deprecated: boolean;
  deprecationNote: string | null;
}

export interface MappingRow {
  id: string;
  misconceptionId: string;
  conceptId: string;
  confidence: string | null;
  notes: string | null;
  misconceptionStatement: string;
  conceptDisplayName: string;
}

export interface ExternalRefRow {
  id: string;
  conceptId: string;
  refCode: string;
  refType: string;
  sourceUrl: string | null;
}
