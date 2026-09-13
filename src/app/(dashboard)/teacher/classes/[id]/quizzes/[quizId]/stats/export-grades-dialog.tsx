"use client";

import { useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAlert } from "@/components/ui/confirm-dialog";
import {
  formatGrade,
  parseMaxPointsFromGradeHeader,
  type GradeExportMode,
} from "@/lib/grades-csv";

/** Export an eLC-compatible grade CSV with configurable scoring and points. */
export function ExportGradesDialog({
  classId,
  quizId,
  quizName,
}: {
  classId: string;
  quizId: string;
  quizName: string;
}) {
  const alert = useAlert();
  const [open, setOpen] = useState(false);
  const [gradeHeader, setGradeHeader] = useState("");
  const [mode, setMode] = useState<GradeExportMode>("best-attempt");
  const [maxPoints, setMaxPoints] = useState("100");
  const [downloading, setDownloading] = useState(false);
  const parsedMaxPoints = Number(maxPoints);
  const maxPointsValid =
    Number.isFinite(parsedMaxPoints) &&
    parsedMaxPoints > 0 &&
    parsedMaxPoints <= 1_000_000;

  function handleGradeHeaderChange(value: string) {
    setGradeHeader(value);
    const headerMaxPoints = parseMaxPointsFromGradeHeader(value);
    if (headerMaxPoints !== null) setMaxPoints(formatGrade(headerMaxPoints));
  }

  async function handleDownload() {
    setDownloading(true);
    try {
      const query = new URLSearchParams({
        header: gradeHeader.trim(),
        mode,
        maxPoints,
      });
      const res = await fetch(
        `/api/classes/${classId}/quizzes/${quizId}/grades-export?${query}`,
      );
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        await alert({
          title: "Couldn't export grades",
          description: data?.error || "Failed to generate the CSV.",
        });
        return;
      }
      const filename =
        res.headers
          .get("Content-Disposition")
          ?.match(/filename="([^"]+)"/)?.[1] ?? "grades.csv";
      const url = URL.createObjectURL(await res.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
      setOpen(false);
    } catch {
      await alert({
        title: "Couldn't export grades",
        description: "Something went wrong while downloading the CSV.",
      });
    } finally {
      setDownloading(false);
    }
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Download className="size-4" /> Export grades
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Export grades (eLC CSV)</DialogTitle>
            <DialogDescription>
              Enter the exact eLC grade column, then choose how completed work
              is graded.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="grade-item-name">Grade item column</Label>
              <Input
                id="grade-item-name"
                value={gradeHeader}
                onChange={(event) =>
                  handleGradeHeaderChange(event.target.value)
                }
                placeholder={`${quizName} Points Grade <Numeric MaxPoints:100>`}
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="grade-calculation">Grade calculation</Label>
                <Select
                  value={mode}
                  onValueChange={(value) => setMode(value as GradeExportMode)}
                >
                  <SelectTrigger id="grade-calculation">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="best-attempt">Best attempt</SelectItem>
                    <SelectItem value="completion">Completion</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="max-points">Max points</Label>
                <Input
                  id="max-points"
                  type="number"
                  min="0.01"
                  max="1000000"
                  step="any"
                  value={maxPoints}
                  onChange={(event) => setMaxPoints(event.target.value)}
                  aria-invalid={!maxPointsValid}
                />
              </div>
            </div>

            <div className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
              {mode === "best-attempt" ? (
                <p>
                  The highest completed-attempt percentage is scaled to the
                  maximum points. For example, 80% is{" "}
                  {maxPointsValid
                    ? (parsedMaxPoints * 0.8).toFixed(2).replace(/\.00$/, "")
                    : "—"}{" "}
                  points.
                </p>
              ) : (
                <p>
                  Any completed attempt receives full points; students with no
                  completed attempt are left blank.
                </p>
              )}
              <p className="mt-2">
                A teacher-entered manual grade overrides either calculation.
                Roster students are matched to accounts by name.
              </p>
            </div>

            <p className="text-xs text-muted-foreground">
              Exported column:{" "}
              <span className="font-medium text-foreground">
                {gradeHeader.trim() ||
                  "Enter the complete grade item column above"}
              </span>
            </p>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={downloading}
            >
              Cancel
            </Button>
            <Button
              onClick={handleDownload}
              disabled={downloading || !gradeHeader.trim() || !maxPointsValid}
            >
              {downloading ? "Preparing…" : "Download CSV"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
