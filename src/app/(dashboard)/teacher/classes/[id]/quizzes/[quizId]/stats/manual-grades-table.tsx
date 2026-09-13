"use client";

import { useState } from "react";
import Link from "next/link";
import { Pencil } from "lucide-react";
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
import type { QuizStudentRow } from "@/lib/quiz-stats-server";

export function ManualGradesTable({
  classId,
  quizId,
  initialStudents,
}: {
  classId: string;
  quizId: string;
  initialStudents: QuizStudentRow[];
}) {
  const alert = useAlert();
  const [students, setStudents] = useState(initialStudents);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [grade, setGrade] = useState("");
  const [saving, setSaving] = useState(false);
  const selected =
    students.find((student) => student.studentId === selectedId) ?? null;
  const numericGrade = Number(grade);
  const gradeIsValid =
    grade.trim() !== "" &&
    Number.isFinite(numericGrade) &&
    numericGrade >= 0 &&
    numericGrade <= 100;

  function openEditor(student: QuizStudentRow) {
    setSelectedId(student.studentId);
    setGrade(student.manualGrade === null ? "" : String(student.manualGrade));
  }

  function closeEditor() {
    if (!saving) setSelectedId(null);
  }

  async function saveGrade() {
    if (!selected || !gradeIsValid) return;
    setSaving(true);
    try {
      const res = await fetch(
        `/api/classes/${classId}/quizzes/${quizId}/manual-grades/${selected.studentId}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ grade: numericGrade }),
        },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || "Failed to save the manual grade.");
      }
      setStudents((current) =>
        current.map((student) =>
          student.studentId === selected.studentId
            ? { ...student, manualGrade: numericGrade }
            : student,
        ),
      );
      setSelectedId(null);
    } catch (error) {
      await alert({
        title: "Couldn't save grade",
        description:
          error instanceof Error ? error.message : "Something went wrong.",
      });
    } finally {
      setSaving(false);
    }
  }

  async function clearGrade() {
    if (!selected) return;
    setSaving(true);
    try {
      const res = await fetch(
        `/api/classes/${classId}/quizzes/${quizId}/manual-grades/${selected.studentId}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || "Failed to clear the manual grade.");
      }
      setStudents((current) =>
        current.map((student) =>
          student.studentId === selected.studentId
            ? { ...student, manualGrade: null }
            : student,
        ),
      );
      setSelectedId(null);
    } catch (error) {
      await alert({
        title: "Couldn't clear grade",
        description:
          error instanceof Error ? error.message : "Something went wrong.",
      });
    } finally {
      setSaving(false);
    }
  }

  if (students.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No students are enrolled in this class.
      </p>
    );
  }

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="py-2 pr-3 font-medium">Student</th>
              <th className="px-3 py-2 text-right font-medium">Best attempt</th>
              <th className="px-3 py-2 text-right font-medium">Manual grade</th>
              <th className="px-3 py-2 text-right font-medium">Attempts</th>
              <th className="py-2 pl-3">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {students.map((student) => (
              <tr
                key={student.studentId}
                className="border-b last:border-0 hover:bg-muted/30"
              >
                <td className="py-2 pr-3">
                  <Link
                    href={`/teacher/classes/${classId}/students/${student.studentId}/stats`}
                    className="text-primary hover:underline"
                  >
                    {student.name}
                  </Link>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {student.bestScore === null
                    ? "—"
                    : `${Math.round(student.bestScore * 100) / 100}%`}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {student.manualGrade === null
                    ? "—"
                    : `${Math.round(student.manualGrade * 100) / 100}%`}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {student.attempts}
                </td>
                <td className="py-2 pl-3 text-right">
                  {student.canEditManualGrade && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => openEditor(student)}
                    >
                      <Pencil className="size-3.5" />
                      {student.manualGrade === null ? "Set grade" : "Edit"}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Dialog
        open={selected !== null}
        onOpenChange={(open) => !open && closeEditor()}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Manual grade for {selected?.name}</DialogTitle>
            <DialogDescription>
              Enter a percentage from 0 to 100. It will override the calculated
              grade for this test when grades are exported.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="manual-grade">Manual grade (%)</Label>
            <Input
              id="manual-grade"
              type="number"
              min="0"
              max="100"
              step="any"
              value={grade}
              onChange={(event) => setGrade(event.target.value)}
              aria-invalid={grade.trim() !== "" && !gradeIsValid}
              autoFocus
            />
          </div>
          <DialogFooter className="gap-2 sm:justify-between">
            <div>
              {selected?.manualGrade !== null && (
                <Button
                  variant="outline"
                  onClick={clearGrade}
                  disabled={saving}
                >
                  Clear manual grade
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={closeEditor} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={saveGrade} disabled={saving || !gradeIsValid}>
                {saving ? "Saving…" : "Save grade"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
