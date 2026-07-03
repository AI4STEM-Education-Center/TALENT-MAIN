"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { BookOpen, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { UploadCard } from "./upload-card";
import { ConceptsTable } from "./concepts-table";
import { MisconceptionsTable } from "./misconceptions-table";
import { MappingsTable } from "./mappings-table";
import { ExternalRefsTable } from "./external-refs-table";
import { uploadConceptsCsv, uploadMisconceptionsCsv, uploadMappingsCsv } from "./import-actions";
import type { ConceptRow, MisconceptionRow, MappingRow, ExternalRefRow } from "./types";

interface ConceptsClientProps {
  concepts: ConceptRow[];
  misconceptions: MisconceptionRow[];
  mappings: MappingRow[];
  externalRefs: ExternalRefRow[];
}

export function ConceptsClient({ concepts, misconceptions, mappings, externalRefs }: ConceptsClientProps) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [showDeprecated, setShowDeprecated] = useState(false);

  function handleImported() {
    router.refresh();
  }

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <BookOpen className="size-6" /> Concept &amp; Misconception Catalog
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Upload and review the concept catalog, misconception catalog, and the mappings between them.
        </p>
      </div>

      <div>
        <p className="text-sm text-muted-foreground mb-3">
          Recommended upload order: <strong className="text-foreground">Concepts</strong> →{" "}
          <strong className="text-foreground">Misconceptions</strong> →{" "}
          <strong className="text-foreground">Mappings</strong>. Mapping rows that reference an unknown
          concept or misconception ID are skipped and reported after upload.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <UploadCard
            title="1. Concepts"
            description="Upload the Concepts CSV export."
            ariaLabel="Upload Concepts CSV"
            onFile={uploadConceptsCsv}
            onSuccess={handleImported}
          />
          <UploadCard
            title="2. Misconceptions"
            description="Upload the Misconceptions CSV export."
            ariaLabel="Upload Misconceptions CSV"
            onFile={uploadMisconceptionsCsv}
            onSuccess={handleImported}
          />
          <UploadCard
            title="3. Concept ↔ Misconception Mappings"
            description="Upload the mapping CSV (also contains external references)."
            ariaLabel="Upload Concept Misconception Mappings CSV"
            onFile={uploadMappingsCsv}
            onSuccess={handleImported}
          />
        </div>
      </div>

      <div className="flex items-center gap-4 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            placeholder="Filter by ID, name, or statement..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
            aria-label="Filter catalog tables"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
          <input
            type="checkbox"
            className="size-4"
            checked={showDeprecated}
            onChange={(e) => setShowDeprecated(e.target.checked)}
            aria-label="Show deprecated"
          />
          Show deprecated
        </label>
      </div>

      <ConceptsTable concepts={concepts} search={search} showDeprecated={showDeprecated} />
      <MisconceptionsTable misconceptions={misconceptions} search={search} showDeprecated={showDeprecated} />
      <MappingsTable mappings={mappings} search={search} />
      <ExternalRefsTable externalRefs={externalRefs} search={search} />
    </div>
  );
}
