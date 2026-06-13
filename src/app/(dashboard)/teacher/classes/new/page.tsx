"use client";
import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, Upload, FileText, X, Users, AlertTriangle } from "lucide-react";
import { parseRosterCsv, type ParsedRosterStudent } from "@/lib/csv-roster";

type ParsedStudent = ParsedRosterStudent;

export default function NewClassPage() {
  const { push } = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [fileName, setFileName] = useState("");
  const [studentList, setStudentList] = useState<ParsedStudent[]>([]);
  const [showPreview, setShowPreview] = useState(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [loading, setLoading] = useState(false);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setError("");
    setWarning("");

    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const { students, headerInferred, skipped } = parseRosterCsv(text);
      if (students.length === 0) {
        setError(
          "Could not parse any students with a valid email from the CSV. " +
            "Each row needs an ID, first name, last name, and email."
        );
        setStudentList([]);
        setShowPreview(false);
      } else {
        setStudentList(students);
        setShowPreview(true);
        const notes: string[] = [];
        if (headerInferred) {
          notes.push(
            "No recognizable header row was found, so columns were inferred as " +
              "OrgDefinedId, Last Name, First Name, Email. Verify the preview is correct."
          );
        }
        if (skipped > 0) {
          notes.push(`${skipped} row(s) were skipped for missing or invalid email addresses.`);
        }
        setWarning(notes.join(" "));
      }
    };
    reader.onerror = () => setError("Failed to read the file.");
    reader.readAsText(file);
  }

  function clearFile() {
    setStudentList([]);
    setFileName("");
    setShowPreview(false);
    setWarning("");
    if (fileRef.current) fileRef.current.value = "";
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (studentList.length === 0) {
      setError("Please upload a class list CSV file.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/classes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description, studentList }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to create class.");
      } else {
        push(`/teacher/classes/${data.id}`);
      }
    } catch {
      setError("An unexpected error occurred.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="p-4 md:p-6 max-w-2xl">
      <div className="mb-6">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/teacher/classes"><ArrowLeft className="size-4" /> Back to classes</Link>
        </Button>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Create New Class</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">{error}</div>}
            <div className="space-y-2">
              <Label htmlFor="name">Class Name</Label>
              <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required placeholder="e.g. CSCI4300 Web Programming - Spring 2026" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="description">Description <span className="text-muted-foreground">(optional)</span></Label>
              <Textarea id="description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Brief description of this class..." />
            </div>

            {/* CSV Upload */}
            <div className="space-y-2">
              <Label>Class List (CSV) <span className="text-destructive">*</span></Label>
              <p className="text-xs text-muted-foreground">
                Upload a CSV file with columns: OrgDefinedId, Last Name, First Name, Email.
                An email address is required for every student so you can send them notifications.
                The # prefix on 81 numbers is removed automatically. If no header row is detected,
                columns are inferred in that order.
              </p>
              {warning && (
                <div className="p-3 rounded-md bg-amber-500/10 text-amber-700 dark:text-amber-400 text-xs flex items-start gap-2">
                  <AlertTriangle className="size-4 shrink-0 mt-0.5" />
                  <span>{warning}</span>
                </div>
              )}
              {!fileName ? (
                <label
                  htmlFor="csv-upload"
                  className="flex flex-col items-center justify-center gap-2 p-6 border-2 border-dashed border-muted-foreground/25 rounded-lg cursor-pointer hover:border-primary/50 hover:bg-muted/50 transition-colors"
                >
                  <Upload className="size-8 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">Click to upload CSV file</span>
                  <input
                    ref={fileRef}
                    id="csv-upload"
                    type="file"
                    accept=".csv"
                    aria-label="Upload class list CSV"
                    onChange={handleFileChange}
                    className="hidden"
                  />
                </label>
              ) : (
                <div className="flex items-center gap-3 p-3 bg-muted rounded-lg">
                  <FileText className="size-5 text-primary shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{fileName}</p>
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <Users className="size-3" /> {studentList.length} students parsed
                    </p>
                  </div>
                  <Button type="button" variant="ghost" size="sm" onClick={clearFile}>
                    <X className="size-4" />
                  </Button>
                </div>
              )}
            </div>

            {/* Preview Table */}
            {showPreview && studentList.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Preview ({studentList.length} students)</Label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowPreview(!showPreview)}
                    className="text-xs"
                  >
                    {showPreview ? "Hide" : "Show"} preview
                  </Button>
                </div>
                <div className="max-h-60 overflow-y-auto border rounded-md">
                  <table className="w-full text-sm">
                    <thead className="bg-muted sticky top-0">
                      <tr>
                        <th className="text-left p-2 font-medium">#</th>
                        <th className="text-left p-2 font-medium">81 Number</th>
                        <th className="text-left p-2 font-medium">Last Name</th>
                        <th className="text-left p-2 font-medium">First Name</th>
                        <th className="text-left p-2 font-medium">Email</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {studentList.map((s, i) => (
                        <tr key={s.orgDefinedId} className="hover:bg-muted/50">
                          <td className="p-2 text-muted-foreground">{i + 1}</td>
                          <td className="p-2 font-mono text-xs">{s.orgDefinedId}</td>
                          <td className="p-2">{s.lastName}</td>
                          <td className="p-2">{s.firstName}</td>
                          <td className="p-2 text-xs">{s.email}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="flex gap-3 pt-2">
              <Button type="submit" disabled={loading}>{loading ? "Creating..." : "Create Class"}</Button>
              <Button type="button" variant="outline" asChild><Link href="/teacher/classes">Cancel</Link></Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
