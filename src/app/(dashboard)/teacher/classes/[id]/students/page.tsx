"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  ArrowLeft,
  Users,
  Search,
  Plus,
  Trash2,
  Loader2,
  CheckCircle,
  Clock,
  UserCheck,
  UserX,
  Mail,
  MessageSquare,
  AlertTriangle,
  Upload,
  Pencil,
} from "lucide-react";
import { parseRosterCsv } from "@/lib/csv-roster";

interface StudentEntry {
  id: string;
  orgDefinedId: string;
  firstName: string;
  lastName: string;
  email: string;
  isRegistered: boolean;
  isEnrolled: boolean;
  enrolledAt: string | null;
  createdAt: string;
}

export default function StudentsPage() {
  const { id } = useParams<{ id: string }>();
  const [students, setStudents] = useState<StudentEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [className, setClassName] = useState("");
  const [filter, setFilter] = useState<
    "all" | "enrolled" | "not_enrolled" | "not_registered"
  >("all");

  // Add dialog state
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState({
    orgDefinedId: "",
    firstName: "",
    lastName: "",
    email: "",
  });
  const [addError, setAddError] = useState("");
  const [addLoading, setAddLoading] = useState(false);

  // Delete confirmation
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // CSV upload state
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState("");
  const [uploadError, setUploadError] = useState("");

  // Edit dialog state
  const [editTarget, setEditTarget] = useState<StudentEntry | null>(null);
  const [editForm, setEditForm] = useState({
    orgDefinedId: "",
    firstName: "",
    lastName: "",
    email: "",
  });
  const [editError, setEditError] = useState("");
  const [editLoading, setEditLoading] = useState(false);

  const fetchClassName = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const res = await fetch(`/api/classes/${id}`, { signal });
        if (res.ok) {
          const data = await res.json();
          if (!signal?.aborted) setClassName(data.name || "");
        }
      } catch {
        // ignore (including AbortError)
      }
    },
    [id],
  );

  const fetchStudents = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      try {
        const res = await fetch(`/api/classes/${id}/students`, { signal });
        if (res.ok) {
          const data = await res.json();
          if (!signal?.aborted) setStudents(data);
        }
      } catch {
        // ignore (including AbortError)
      } finally {
        // An aborted request must not clear the spinner owned by its successor.
        // react-doctor-disable-next-line react-doctor/no-loading-flag-reset-outside-finally -- the reset is already inside this finally; detector misfire
        if (!signal?.aborted) setLoading(false);
      }
    },
    [id],
  );

  // react-doctor-disable-next-line react-doctor/no-set-state-after-await-in-effect -- every post-await write is guarded by `signal.aborted`, and the effect aborts on cleanup
  useEffect(() => {
    // Navigating between classes leaves the previous class's requests in flight;
    // without this they can land afterwards and paint the wrong roster.
    const controller = new AbortController();
    void fetchStudents(controller.signal);
    void fetchClassName(controller.signal);
    return () => controller.abort();
  }, [fetchStudents, fetchClassName]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setAddError("");
    setAddLoading(true);
    try {
      const res = await fetch(`/api/classes/${id}/students`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(addForm),
      });
      // Status before body; the error payload is read only in the failure branch.
      if (!res.ok) {
        const errorBody = await res.json().catch(() => null);
        setAddError(errorBody?.error || "Failed to add student.");
        return;
      }
      const data = await res.json();
      setStudents((prev) =>
        [...prev, { ...data, isEnrolled: false, enrolledAt: null }].sort(
          (a, b) =>
            a.lastName.localeCompare(b.lastName) ||
            a.firstName.localeCompare(b.firstName),
        ),
      );
      setAddForm({ orgDefinedId: "", firstName: "", lastName: "", email: "" });
      setAddOpen(false);
    } catch {
      setAddError("An unexpected error occurred.");
    } finally {
      setAddLoading(false);
    }
  }

  async function handleDelete(studentListId: string) {
    setDeleteLoading(true);
    try {
      const res = await fetch(`/api/classes/${id}/students/${studentListId}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setStudents((prev) => prev.filter((s) => s.id !== studentListId));
      }
    } catch {
      // ignore
    } finally {
      setDeleteLoading(false);
      setDeleteId(null);
    }
  }

  function handleCsvChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadMsg("");
    setUploadError("");

    const reader = new FileReader();
    reader.onload = async (ev) => {
      const text = ev.target?.result as string;
      const {
        students: parsed,
        skipped,
        normalizedEmails,
      } = parseRosterCsv(text);
      if (parsed.length === 0) {
        setUploadError(
          "Could not parse any students with a valid email. Each row needs an 81 number, first name, last name, and email.",
        );
        if (fileRef.current) fileRef.current.value = "";
        return;
      }

      setUploading(true);
      try {
        const res = await fetch(`/api/classes/${id}/students/bulk`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ students: parsed }),
        });
        const data = await res.json();
        if (!res.ok) {
          setUploadError(data.error || "Failed to upload roster.");
        } else {
          await fetchStudents();
          const parts = [
            `Added ${data.added} student${data.added === 1 ? "" : "s"}.`,
          ];
          if (data.skipped > 0)
            parts.push(`${data.skipped} already on the roster (skipped).`);
          if (skipped > 0)
            parts.push(`${skipped} row(s) skipped for missing/invalid email.`);
          if (normalizedEmails > 0) {
            parts.push(
              `${normalizedEmails} @uga.view.usg.edu address(es) rewritten to @uga.edu.`,
            );
          }
          setUploadMsg(parts.join(" "));
        }
      } catch {
        setUploadError("An unexpected error occurred during upload.");
      } finally {
        setUploading(false);
        if (fileRef.current) fileRef.current.value = "";
      }
    };
    reader.onerror = () => {
      setUploadError("Failed to read the file.");
      if (fileRef.current) fileRef.current.value = "";
    };
    reader.readAsText(file);
  }

  function openEdit(s: StudentEntry) {
    setEditError("");
    setEditTarget(s);
    setEditForm({
      orgDefinedId: s.orgDefinedId,
      firstName: s.firstName,
      lastName: s.lastName,
      email: s.email,
    });
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editTarget) return;
    setEditError("");
    setEditLoading(true);
    try {
      const res = await fetch(`/api/classes/${id}/students/${editTarget.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editForm),
      });
      // Status before body; the error payload is read only in the failure branch.
      if (!res.ok) {
        const errorBody = await res.json().catch(() => null);
        setEditError(errorBody?.error || "Failed to update student.");
        return;
      }
      {
        const data = await res.json();
        setStudents((prev) =>
          prev
            .map((s) => (s.id === editTarget.id ? { ...s, ...data } : s))
            .sort(
              (a, b) =>
                a.lastName.localeCompare(b.lastName) ||
                a.firstName.localeCompare(b.firstName),
            ),
        );
        setEditTarget(null);
      }
    } catch {
      setEditError("An unexpected error occurred.");
    } finally {
      setEditLoading(false);
    }
  }

  const searchLower = search.toLowerCase();
  let filtered = search
    ? students.filter(
        (s) =>
          s.firstName.toLowerCase().includes(searchLower) ||
          s.lastName.toLowerCase().includes(searchLower) ||
          s.email.toLowerCase().includes(searchLower) ||
          s.orgDefinedId.includes(search.replace(/^#/, "")),
      )
    : students;

  // Apply status filter
  if (filter === "enrolled") {
    filtered = filtered.filter((s) => s.isEnrolled);
  } else if (filter === "not_enrolled") {
    filtered = filtered.filter((s) => !s.isEnrolled && s.isRegistered);
  } else if (filter === "not_registered") {
    filtered = filtered.filter((s) => !s.isRegistered);
  }

  const rosterCount = students.length;
  const registeredCount = students.filter((s) => s.isRegistered).length;
  const enrolledCount = students.filter((s) => s.isEnrolled).length;

  if (loading) {
    return (
      <div className="p-4 md:p-6 flex items-center justify-center min-h-[300px]">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-6">
      <Button variant="ghost" size="sm" asChild>
        <Link href={`/teacher/classes/${id}`}>
          <ArrowLeft className="size-4" /> Back to {className || "class"}
        </Link>
      </Button>

      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Users className="size-6" /> Class Roster
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Manage the full student roster for {className || "this class"}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" asChild>
            <Link href={`/teacher/classes/${id}/messages`}>
              <MessageSquare className="size-4 mr-1" /> Message Students
            </Link>
          </Button>

          <input
            ref={fileRef}
            type="file"
            accept=".csv"
            aria-label="Upload roster CSV"
            onChange={handleCsvChange}
            className="hidden"
          />
          <Button
            size="sm"
            variant="outline"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
          >
            {uploading ? (
              <Loader2 className="size-4 mr-1 animate-spin" />
            ) : (
              <Upload className="size-4 mr-1" />
            )}
            {uploading ? "Uploading..." : "Upload CSV"}
          </Button>

          <Dialog open={addOpen} onOpenChange={setAddOpen}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="size-4 mr-1" /> Add Student
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add Student to Roster</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleAdd} className="space-y-4">
                {addError && (
                  <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">
                    {addError}
                  </div>
                )}
                <div className="space-y-2">
                  <Label htmlFor="add-orgId">81 Number</Label>
                  <Input
                    id="add-orgId"
                    value={addForm.orgDefinedId}
                    onChange={(e) =>
                      setAddForm((p) => ({
                        ...p,
                        orgDefinedId: e.target.value,
                      }))
                    }
                    required
                    placeholder="e.g. 811947904"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label htmlFor="add-first">First Name</Label>
                    <Input
                      id="add-first"
                      value={addForm.firstName}
                      onChange={(e) =>
                        setAddForm((p) => ({ ...p, firstName: e.target.value }))
                      }
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="add-last">Last Name</Label>
                    <Input
                      id="add-last"
                      value={addForm.lastName}
                      onChange={(e) =>
                        setAddForm((p) => ({ ...p, lastName: e.target.value }))
                      }
                      required
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="add-email">Email</Label>
                  <Input
                    id="add-email"
                    type="email"
                    value={addForm.email}
                    onChange={(e) =>
                      setAddForm((p) => ({ ...p, email: e.target.value }))
                    }
                    required
                    placeholder="student@example.com"
                  />
                </div>
                <Button type="submit" className="w-full" disabled={addLoading}>
                  {addLoading ? "Adding..." : "Add Student"}
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {uploadError && (
        <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm flex items-start gap-2">
          <AlertTriangle className="size-4 shrink-0 mt-0.5" />
          <span>{uploadError}</span>
        </div>
      )}
      {uploadMsg && (
        <div className="p-3 rounded-md bg-green-500/10 text-green-700 dark:text-green-400 text-sm flex items-start gap-2">
          <CheckCircle className="size-4 shrink-0 mt-0.5" />
          <span>{uploadMsg}</span>
        </div>
      )}

      {/* Stats cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Card
          className="cursor-pointer hover:shadow-md transition-shadow"
          onClick={() => setFilter("all")}
        >
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Total Roster</p>
                <p className="text-2xl font-bold">{rosterCount}</p>
              </div>
              <Users
                className={`size-8 ${filter === "all" ? "text-primary" : "text-muted-foreground/40"}`}
              />
            </div>
          </CardContent>
        </Card>
        <Card
          className="cursor-pointer hover:shadow-md transition-shadow"
          onClick={() => setFilter("enrolled")}
        >
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Enrolled</p>
                <p className="text-2xl font-bold">{enrolledCount}</p>
              </div>
              <UserCheck
                className={`size-8 ${filter === "enrolled" ? "text-green-500" : "text-muted-foreground/40"}`}
              />
            </div>
          </CardContent>
        </Card>
        <Card
          className="cursor-pointer hover:shadow-md transition-shadow"
          onClick={() => setFilter("not_registered")}
        >
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Not Registered</p>
                <p className="text-2xl font-bold">
                  {rosterCount - registeredCount}
                </p>
              </div>
              <UserX
                className={`size-8 ${filter === "not_registered" ? "text-amber-500" : "text-muted-foreground/40"}`}
              />
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <Input
                placeholder="Search by name, email, or 81 number..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
              />
            </div>
            {/* Filter pills */}
            <div className="flex gap-1.5 flex-wrap">
              {(
                ["all", "enrolled", "not_enrolled", "not_registered"] as const
              ).map((f) => (
                <Button
                  key={f}
                  variant={filter === f ? "default" : "outline"}
                  size="sm"
                  onClick={() => setFilter(f)}
                  className="text-xs h-8"
                >
                  {f === "all"
                    ? "All"
                    : f === "enrolled"
                      ? "Enrolled"
                      : f === "not_enrolled"
                        ? "Registered Only"
                        : "Not Registered"}
                </Button>
              ))}
            </div>
          </div>
          {(search || filter !== "all") && (
            <p className="text-xs text-muted-foreground mt-2">
              Showing {filtered.length} of {students.length} students
            </p>
          )}
        </CardHeader>
        <CardContent>
          {filtered.length === 0 ? (
            <div className="text-center py-10 text-muted-foreground">
              <p>
                {search || filter !== "all"
                  ? "No students match your search/filter."
                  : "No students in the roster yet."}
              </p>
            </div>
          ) : (
            <div className="divide-y">
              {filtered.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center gap-3 py-3 flex-wrap"
                >
                  <div className="size-9 rounded-full bg-primary/10 flex items-center justify-center font-bold text-primary text-sm shrink-0">
                    {s.firstName[0]}
                    {s.lastName[0]}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium">
                      {s.firstName} {s.lastName}
                    </p>
                    <p className="text-xs text-muted-foreground font-mono">
                      {s.orgDefinedId}
                    </p>
                    {s.email ? (
                      <p className="text-xs text-muted-foreground truncate flex items-center gap-1">
                        <Mail className="size-3 shrink-0" /> {s.email}
                      </p>
                    ) : (
                      <p className="text-xs text-amber-600 flex items-center gap-1">
                        <AlertTriangle className="size-3 shrink-0" /> No email
                        on file
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0 flex-wrap">
                    {/* Registration status */}
                    {s.isRegistered ? (
                      <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-600 border border-blue-500/20">
                        <CheckCircle className="size-3" /> Registered
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-600 border border-amber-500/20">
                        <Clock className="size-3" /> Not registered
                      </span>
                    )}

                    {/* Enrollment status */}
                    {s.isEnrolled ? (
                      <Badge variant="success" className="text-xs">
                        <UserCheck className="size-3 mr-1" /> Enrolled
                      </Badge>
                    ) : s.isRegistered ? (
                      <Badge variant="secondary" className="text-xs">
                        <UserX className="size-3 mr-1" /> Not Enrolled
                      </Badge>
                    ) : null}

                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => openEdit(s)}
                      aria-label={`Edit ${s.firstName} ${s.lastName}`}
                      className="text-muted-foreground hover:text-foreground size-7 p-0"
                    >
                      <Pencil className="size-4" />
                    </Button>

                    {deleteId === s.id ? (
                      <div className="flex items-center gap-1">
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => handleDelete(s.id)}
                          disabled={deleteLoading}
                          className="text-xs h-7 px-2"
                        >
                          {deleteLoading ? "..." : "Confirm"}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setDeleteId(null)}
                          className="text-xs h-7 px-2"
                        >
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setDeleteId(s.id)}
                        className="text-muted-foreground hover:text-destructive size-7 p-0"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Edit dialog */}
      <Dialog
        open={!!editTarget}
        onOpenChange={(open) => !open && setEditTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Student</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleEdit} className="space-y-4">
            {editError && (
              <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">
                {editError}
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="edit-orgId">81 Number</Label>
              <Input
                id="edit-orgId"
                value={editForm.orgDefinedId}
                onChange={(e) =>
                  setEditForm((p) => ({ ...p, orgDefinedId: e.target.value }))
                }
                required
                placeholder="e.g. 811947904"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="edit-first">First Name</Label>
                <Input
                  id="edit-first"
                  value={editForm.firstName}
                  onChange={(e) =>
                    setEditForm((p) => ({ ...p, firstName: e.target.value }))
                  }
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-last">Last Name</Label>
                <Input
                  id="edit-last"
                  value={editForm.lastName}
                  onChange={(e) =>
                    setEditForm((p) => ({ ...p, lastName: e.target.value }))
                  }
                  required
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-email">Email</Label>
              <Input
                id="edit-email"
                type="email"
                value={editForm.email}
                onChange={(e) =>
                  setEditForm((p) => ({ ...p, email: e.target.value }))
                }
                required
                placeholder="student@example.com"
              />
            </div>
            <Button type="submit" className="w-full" disabled={editLoading}>
              {editLoading ? "Saving..." : "Save Changes"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
