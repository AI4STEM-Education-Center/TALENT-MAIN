"use client";
import { useState } from "react";
import JSZip from "jszip";
import { parseQtiQuestionBank } from "@/lib/question-import/qti";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Upload } from "lucide-react";
import type { ImportSummary } from "./quiz-editor-types";

export function QtiImportCard({
  quizId,
  onImported,
  onMessage,
}: {
  quizId: string;
  onImported: () => Promise<void>;
  onMessage: (message: string, eventId?: string | null) => void;
}) {
  const [importSourcePath, setImportSourcePath] = useState("");
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(
    null,
  );
  async function importQuestions() {
    onMessage("");
    setImportSummary(null);
    if (!importFile) {
      onMessage("Choose a QTI ZIP file to import.");
      return;
    }
    if (!importFile.name.toLowerCase().endsWith(".zip")) {
      onMessage("Only QTI .zip files are supported.");
      return;
    }

    setImportBusy(true);
    try {
      const zip = await JSZip.loadAsync(importFile);
      const qtiXml = zip.file("qti/qti.xml");
      if (!qtiXml) {
        onMessage("The QTI ZIP must contain qti/qti.xml.");
        return;
      }

      const parsed = parseQtiQuestionBank(await qtiXml.async("text"));
      if (parsed.questions.length === 0 && parsed.errors.length === 0) {
        onMessage("No questions were found in qti/qti.xml.");
        return;
      }

      const res = await fetch("/api/question-imports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quizId,
          originalName: importFile.name,
          sourcePath: importSourcePath.trim() || undefined,
          ...parsed,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        onMessage(
          data.error ?? "Import failed.",
          data.guardrailEventId ?? null,
        );
        return;
      }

      setImportSummary(data);
      onMessage(
        `Imported ${data.importedCount} question${data.importedCount === 1 ? "" : "s"}. Skipped ${data.skippedCount}.`,
      );
      setImportFile(null);
      await onImported();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "Import failed.");
    } finally {
      setImportBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Upload className="size-5" /> Import from QTI ZIP
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Upload a QTI ZIP question bank into this quiz. The ZIP is opened in
          your browser, and only parsed questions are sent to the server.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="qti-file">QTI ZIP File</Label>
            <Input
              id="qti-file"
              type="file"
              accept=".zip,application/zip"
              onChange={(e) => setImportFile(e.target.files?.[0] ?? null)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="qti-source">Source folder/path (optional)</Label>
            <Input
              id="qti-source"
              value={importSourcePath}
              onChange={(e) => setImportSourcePath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !importBusy && importFile)
                  importQuestions();
              }}
              placeholder="e.g. data/3_Forces/PHY1-F-IFBDF-091725"
            />
          </div>
        </div>
        <Button onClick={importQuestions} disabled={importBusy || !importFile}>
          {importBusy ? "Importing..." : "Import QTI ZIP"}
        </Button>
        {importSummary && (
          <div className="rounded-md border p-3 text-sm space-y-2">
            <p className="font-medium">
              {importSummary.bankTitle ?? "Question bank"} import complete
            </p>
            <p className="text-muted-foreground">
              Imported {importSummary.importedCount}, skipped{" "}
              {importSummary.skippedCount}, validation errors{" "}
              {importSummary.errorCount}.
            </p>
            {importSummary.errors && importSummary.errors.length > 0 && (
              <div className="space-y-1 text-destructive">
                {importSummary.errors.slice(0, 5).map((error) => (
                  <p
                    key={`${error.index}-${error.sourceQuestionId ?? "unknown"}`}
                  >
                    Question {error.sourceQuestionId ?? error.index + 1}:{" "}
                    {error.message}
                  </p>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
