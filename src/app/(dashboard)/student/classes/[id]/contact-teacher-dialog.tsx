"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Mail, Send, Loader2, CheckCircle, AlertTriangle } from "lucide-react";

export function ContactTeacherDialog({
  classId,
  teacherName,
}: {
  classId: string;
  teacherName: string;
}) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ subject: "", body: "" });
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setResult("");
    setLoading(true);
    try {
      const res = await fetch(`/api/classes/${classId}/contact-teacher`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to send your message.");
      } else {
        setResult("Your message was sent to your teacher.");
        setForm({ subject: "", body: "" });
      }
    } catch {
      setError("An unexpected error occurred.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setError("");
          setResult("");
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="shrink-0">
          <Mail className="size-4" /> Message teacher
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Message {teacherName || "your teacher"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm flex items-start gap-2">
              <AlertTriangle className="size-4 shrink-0 mt-0.5" />
              {error}
            </div>
          )}
          {result && (
            <div className="p-3 rounded-md bg-green-500/10 text-green-700 dark:text-green-400 text-sm flex items-start gap-2">
              <CheckCircle className="size-4 shrink-0 mt-0.5" />
              {result}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Your teacher will receive this by email and can reply directly to
            your account email.
          </p>
          <div className="space-y-2">
            <Label htmlFor="contact-subject">Subject</Label>
            <Input
              id="contact-subject"
              value={form.subject}
              onChange={(e) =>
                setForm((p) => ({ ...p, subject: e.target.value }))
              }
              required
              placeholder="e.g. Question about Quiz 3"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="contact-body">Message</Label>
            <Textarea
              id="contact-body"
              value={form.body}
              onChange={(e) => setForm((p) => ({ ...p, body: e.target.value }))}
              required
              rows={6}
              placeholder="Write your message..."
            />
          </div>
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Send className="size-4" />
            )}
            {loading ? "Sending..." : "Send message"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
