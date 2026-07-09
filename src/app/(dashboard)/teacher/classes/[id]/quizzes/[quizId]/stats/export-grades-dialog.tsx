"use client";
import { useState } from "react";
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
import { useAlert } from "@/components/ui/confirm-dialog";
import { Download } from "lucide-react";

/**
 * "Export grades" button + dialog on the per-quiz stats page. Downloads the
 * class roster in the eLC gradebook CSV format with each student's best score
 * in a teacher-named grade column, so the file can be imported back into eLC.
 */
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
  const [header, setHeader] = useState(`${quizName} Points Grade <Numeric MaxPoints:100>`);
  const [downloading, setDownloading] = useState(false);

  async function handleDownload() {
    setDownloading(true);
    try {
      const res = await fetch(
        `/api/classes/${classId}/quizzes/${quizId}/grades-export?header=${encodeURIComponent(header.trim())}`
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
        res.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1] ??
        "grades.csv";
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
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
              The file matches the roster CSV from eLC&apos;s gradebook export
              (OrgDefinedId, Last Name, First Name, End-of-Line Indicator), with
              your grade column inserted right before the End-of-Line Indicator.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="grade-column-header">Grade column header</Label>
            <Input
              id="grade-column-header"
              value={header}
              onChange={(e) => setHeader(e.target.value)}
              placeholder="e.g. Quiz 3 Points Grade <Numeric MaxPoints:100>"
            />
            <p className="text-xs text-muted-foreground">
              To import the file back into eLC, use the Export function in UGA
              eLC&apos;s Grades tool first and copy the exact header of the grade
              item column you want to fill, then paste it here.
            </p>
            <p className="text-xs text-muted-foreground">
              Each grade is the student&apos;s best score (0–100) across completed
              attempts. Roster students are matched to accounts by name; students
              without a matching account or completed attempt are left blank.
            </p>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={downloading}>
              Cancel
            </Button>
            <Button onClick={handleDownload} disabled={downloading || !header.trim()}>
              {downloading ? "Preparing…" : "Download CSV"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
