"use client";
import { useEffect, useState } from "react";
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
import { Textarea } from "@/components/ui/textarea";
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
  Send,
  AlertTriangle,
} from "lucide-react";

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
  const [filter, setFilter] = useState<"all" | "enrolled" | "not_enrolled" | "not_registered">("all");

  // Add dialog state
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState({ orgDefinedId: "", firstName: "", lastName: "", email: "" });
  const [addError, setAddError] = useState("");
  const [addLoading, setAddLoading] = useState(false);

  // Delete confirmation
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Email-students dialog state
  const [emailOpen, setEmailOpen] = useState(false);
  const [emailForm, setEmailForm] = useState({ subject: "", body: "" });
  const [emailError, setEmailError] = useState("");
  const [emailResult, setEmailResult] = useState("");
  const [emailLoading, setEmailLoading] = useState(false);

  useEffect(() => {
    fetchStudents();
    fetchClassName();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function fetchClassName() {
    try {
      const res = await fetch(`/api/classes/${id}`);
      if (res.ok) {
        const data = await res.json();
        setClassName(data.name || "");
      }
    } catch {
      // ignore
    }
  }

  async function fetchStudents() {
    setLoading(true);
    try {
      const res = await fetch(`/api/classes/${id}/students`);
      if (res.ok) {
        const data = await res.json();
        setStudents(data);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }

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
      const data = await res.json();
      if (!res.ok) {
        setAddError(data.error || "Failed to add student.");
      } else {
        setStudents((prev) => [...prev, { ...data, isEnrolled: false, enrolledAt: null }].sort((a, b) =>
          a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName)
        ));
        setAddForm({ orgDefinedId: "", firstName: "", lastName: "", email: "" });
        setAddOpen(false);
      }
    } catch {
      setAddError("An unexpected error occurred.");
    } finally {
      setAddLoading(false);
    }
  }

  async function handleSendEmail(e: React.FormEvent) {
    e.preventDefault();
    setEmailError("");
    setEmailResult("");
    setEmailLoading(true);
    try {
      const res = await fetch(`/api/classes/${id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(emailForm),
      });
      const data = await res.json();
      if (!res.ok) {
        setEmailError(data.error || "Failed to send email.");
      } else {
        setEmailResult(
          data.failed > 0
            ? `Sent to ${data.sent} student(s); ${data.failed} failed.`
            : `Email sent to ${data.sent} student(s).`
        );
        setEmailForm({ subject: "", body: "" });
      }
    } catch {
      setEmailError("An unexpected error occurred.");
    } finally {
      setEmailLoading(false);
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

  const searchLower = search.toLowerCase();
  let filtered = search
    ? students.filter(
        (s) =>
          s.firstName.toLowerCase().includes(searchLower) ||
          s.lastName.toLowerCase().includes(searchLower) ||
          s.orgDefinedId.includes(search.replace(/^#/, ""))
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
  const emailableCount = students.filter((s) => !!s.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.email)).length;

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
        <Dialog
          open={emailOpen}
          onOpenChange={(o) => {
            setEmailOpen(o);
            if (!o) {
              setEmailError("");
              setEmailResult("");
            }
          }}
        >
          <DialogTrigger asChild>
            <Button size="sm" variant="outline" disabled={emailableCount === 0}>
              <Mail className="size-4 mr-1" /> Email Students
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Email students</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSendEmail} className="space-y-4">
              {emailError && (
                <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm flex items-start gap-2">
                  <AlertTriangle className="size-4 shrink-0 mt-0.5" />
                  {emailError}
                </div>
              )}
              {emailResult && (
                <div className="p-3 rounded-md bg-green-500/10 text-green-700 dark:text-green-400 text-sm flex items-start gap-2">
                  <CheckCircle className="size-4 shrink-0 mt-0.5" />
                  {emailResult}
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                This message will be emailed to {emailableCount} student
                {emailableCount === 1 ? "" : "s"} on the roster with a valid email address.
                Replies go to your account email.
              </p>
              <div className="space-y-2">
                <Label htmlFor="email-subject">Subject</Label>
                <Input
                  id="email-subject"
                  value={emailForm.subject}
                  onChange={(e) => setEmailForm((p) => ({ ...p, subject: e.target.value }))}
                  required
                  placeholder="e.g. Reminder: Quiz 3 due Friday"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email-body">Message</Label>
                <Textarea
                  id="email-body"
                  value={emailForm.body}
                  onChange={(e) => setEmailForm((p) => ({ ...p, body: e.target.value }))}
                  required
                  rows={6}
                  placeholder="Write your message to the class..."
                />
              </div>
              <Button type="submit" className="w-full" disabled={emailLoading || emailableCount === 0}>
                {emailLoading ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Send className="size-4" />
                )}
                {emailLoading ? "Sending..." : "Send email"}
              </Button>
            </form>
          </DialogContent>
        </Dialog>

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
                    setAddForm((p) => ({ ...p, orgDefinedId: e.target.value }))
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

      {/* Stats cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Card className="cursor-pointer hover:shadow-md transition-shadow" onClick={() => setFilter("all")}>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Total Roster</p>
                <p className="text-2xl font-bold">{rosterCount}</p>
              </div>
              <Users className={`size-8 ${filter === "all" ? "text-primary" : "text-muted-foreground/40"}`} />
            </div>
          </CardContent>
        </Card>
        <Card className="cursor-pointer hover:shadow-md transition-shadow" onClick={() => setFilter("enrolled")}>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Enrolled</p>
                <p className="text-2xl font-bold">{enrolledCount}</p>
              </div>
              <UserCheck className={`size-8 ${filter === "enrolled" ? "text-green-500" : "text-muted-foreground/40"}`} />
            </div>
          </CardContent>
        </Card>
        <Card className="cursor-pointer hover:shadow-md transition-shadow" onClick={() => setFilter("not_registered")}>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Not Registered</p>
                <p className="text-2xl font-bold">{rosterCount - registeredCount}</p>
              </div>
              <UserX className={`size-8 ${filter === "not_registered" ? "text-amber-500" : "text-muted-foreground/40"}`} />
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
                placeholder="Search by name or 81 number..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
              />
            </div>
            {/* Filter pills */}
            <div className="flex gap-1.5 flex-wrap">
              {(["all", "enrolled", "not_enrolled", "not_registered"] as const).map((f) => (
                <Button
                  key={f}
                  variant={filter === f ? "default" : "outline"}
                  size="sm"
                  onClick={() => setFilter(f)}
                  className="text-xs h-8"
                >
                  {f === "all" ? "All" : f === "enrolled" ? "Enrolled" : f === "not_enrolled" ? "Registered Only" : "Not Registered"}
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
              <p>{search || filter !== "all" ? "No students match your search/filter." : "No students in the roster yet."}</p>
            </div>
          ) : (
            <div className="divide-y">
              {filtered.map((s) => (
                <div key={s.id} className="flex items-center gap-3 py-3 flex-wrap">
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
                        <AlertTriangle className="size-3 shrink-0" /> No email on file
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
    </div>
  );
}
