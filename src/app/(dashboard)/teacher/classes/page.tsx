"use client";
import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Plus, Users, BookOpen, Trash2, Loader2 } from "lucide-react";

interface ClassItem {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  _count: {
    enrollments: number;
    classQuizzes: number;
  };
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function ClassesPage() {
  const router = useRouter();
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<ClassItem | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  useEffect(() => {
    fetchClasses();
  }, []);

  async function fetchClasses() {
    setLoading(true);
    try {
      const res = await fetch("/api/classes");
      if (res.ok) {
        const data = await res.json();
        setClasses(data);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    try {
      const res = await fetch(`/api/classes/${deleteTarget.id}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setClasses((prev) => prev.filter((c) => c.id !== deleteTarget.id));
        setDeleteTarget(null);
      }
    } catch {
      // ignore
    } finally {
      setDeleteLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="p-4 md:p-6 flex items-center justify-center min-h-[300px]">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold">My Classes</h1>
          <p className="text-muted-foreground mt-1">
            {classes.length} class{classes.length !== 1 ? "es" : ""}
          </p>
        </div>
        <Button asChild className="shrink-0">
          <Link href="/teacher/classes/new">
            <Plus className="size-4" /> New Class
          </Link>
        </Button>
      </div>

      {classes.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Users className="size-12 text-muted-foreground mb-4" />
            <p className="text-lg font-medium mb-2">No classes yet</p>
            <p className="text-muted-foreground text-sm mb-4">
              Create your first class and invite students.
            </p>
            <Button asChild>
              <Link href="/teacher/classes/new">
                <Plus className="size-4" /> Create Class
              </Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {classes.map((cls) => (
            <Card key={cls.id} className="hover:shadow-md transition-shadow">
              <CardContent className="flex items-start justify-between gap-3 flex-wrap p-5">
                <div className="space-y-1 min-w-0 flex-1">
                  <h2 className="text-lg font-semibold">{cls.name}</h2>
                  {cls.description && (
                    <p className="text-sm text-muted-foreground">
                      {cls.description}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-3 text-xs text-muted-foreground pt-1">
                    <span className="flex items-center gap-1">
                      <Users className="size-3" />
                      {cls._count.enrollments} students
                    </span>
                    <span className="flex items-center gap-1">
                      <BookOpen className="size-3" />
                      {cls._count.classQuizzes} quizzes
                    </span>
                    <span>Created {formatDate(cls.createdAt)}</span>
                  </div>
                </div>
                <div className="flex gap-2 shrink-0">
                  <Button variant="outline" size="sm" asChild>
                    <Link href={`/teacher/classes/${cls.id}/invite`}>
                      Invite
                    </Link>
                  </Button>
                  <Button size="sm" asChild>
                    <Link href={`/teacher/classes/${cls.id}`}>Manage</Link>
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => {
                      e.preventDefault();
                      setDeleteTarget(cls);
                    }}
                    className="text-muted-foreground hover:text-destructive size-8 p-0"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Delete confirmation dialog */}
      <Dialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Class</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete{" "}
              <strong>{deleteTarget?.name}</strong>? This will remove all
              student enrollments, roster entries, quiz assignments, and invite
              links associated with this class. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={deleteLoading}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleteLoading}
            >
              {deleteLoading ? "Deleting..." : "Delete Class"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
