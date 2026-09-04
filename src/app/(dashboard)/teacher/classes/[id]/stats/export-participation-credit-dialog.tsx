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
import {
  buildParticipationCreditCsv,
  participationCount,
  type ParticipationCreditRow,
  type ParticipationMetric,
} from "@/lib/participation-credit-csv";

function safeFilename(value: string): string {
  return (
    value
      .replace(/[^\w\- ]+/g, "")
      .trim()
      .replace(/\s+/g, "_") || "class"
  );
}

export function ExportParticipationCreditDialog({
  className,
  rows,
}: {
  className: string;
  rows: ParticipationCreditRow[];
}) {
  const [open, setOpen] = useState(false);
  const [gradeColumnName, setGradeColumnName] = useState("Quiz Participation");
  const [pointsAwarded, setPointsAwarded] = useState("5");
  const [metric, setMetric] =
    useState<ParticipationMetric>("quizzes-completed");
  const [threshold, setThreshold] = useState("1");

  const points = Number(pointsAwarded);
  const minimum = Number(threshold);
  const pointsValid =
    Number.isFinite(points) && points > 0 && points <= 1_000_000;
  const thresholdValid =
    Number.isInteger(minimum) && minimum >= 1 && minimum <= 1_000_000;
  const studentsReceivingCredit = thresholdValid
    ? rows.filter((row) => participationCount(row, metric) >= minimum).length
    : 0;
  const canDownload =
    rows.length > 0 &&
    gradeColumnName.trim().length > 0 &&
    pointsValid &&
    thresholdValid;

  function download() {
    if (!canDownload) return;

    const csv = buildParticipationCreditCsv({
      gradeColumnName: gradeColumnName.trim(),
      pointsAwarded: points,
      metric,
      threshold: minimum,
      rows,
    });
    const url = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${safeFilename(className)}_participation_credit.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Download className="size-4" /> Quiz participation credit (instant CSV)
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Download quiz participation credit</DialogTitle>
            <DialogDescription>
              Create an eLC-ready grade column from completed quiz activity.
              This download is generated in your browser and does not require
              administrator approval.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="participation-grade-column">
                Grade column name
              </Label>
              <Input
                id="participation-grade-column"
                maxLength={200}
                value={gradeColumnName}
                onChange={(event) => setGradeColumnName(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="participation-points">Points awarded</Label>
              <Input
                id="participation-points"
                type="number"
                min="0.01"
                max="1000000"
                step="any"
                value={pointsAwarded}
                onChange={(event) => setPointsAwarded(event.target.value)}
                aria-invalid={!pointsValid}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="participation-measure">
                Participation measure
              </Label>
              <Select
                value={metric}
                onValueChange={(value) =>
                  setMetric(value as ParticipationMetric)
                }
              >
                <SelectTrigger id="participation-measure">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="quizzes-completed">
                    Different quizzes completed
                  </SelectItem>
                  <SelectItem value="completed-attempts">
                    Total completed quiz attempts
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="participation-threshold">Minimum required</Label>
              <Input
                id="participation-threshold"
                type="number"
                min="1"
                max="1000000"
                step="1"
                value={threshold}
                onChange={(event) => setThreshold(event.target.value)}
                aria-invalid={!thresholdValid}
              />
            </div>

            <p className="rounded-md bg-muted/50 p-3 text-sm">
              {rows.length === 0
                ? "There are no students in this class roster to export."
                : `${studentsReceivingCredit} of ${rows.length} roster students will receive ${pointsValid ? points : "—"} points. Everyone else will receive 0.`}
            </p>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={download} disabled={!canDownload}>
              <Download className="size-4" /> Download CSV
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
