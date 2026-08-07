"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAlert } from "@/components/ui/confirm-dialog";
import { Loader2 } from "lucide-react";

interface ConsentVersionRow {
  id: string;
  role: string;
  version: string;
  title: string;
  isActive: boolean;
  createdAt: string;
}

export default function AdminConsentFormsPage() {
  const alert = useAlert();
  const [versions, setVersions] = useState<ConsentVersionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState<"STUDENT" | "TEACHER">("STUDENT");
  const [version, setVersion] = useState("");
  const [title, setTitle] = useState("");
  const [bodyHtml, setBodyHtml] = useState("");
  const [publishing, setPublishing] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/consent/forms", { cache: "no-store" });
      const data = await res.json();
      setVersions(data.versions ?? []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function publish() {
    setPublishing(true);
    try {
      const res = await fetch("/api/admin/consent/forms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role, version, title, bodyHtml }),
      });
      const data = await res.json();
      if (!res.ok) {
        await alert({ title: "Couldn't publish", description: data?.error || "Unknown error." });
        return;
      }
      setVersion("");
      setTitle("");
      setBodyHtml("");
      await load();
      await alert(`Published ${role} form ${version} as the active version.`);
    } finally {
      setPublishing(false);
    }
  }

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div>
        <h1 className="text-3xl font-bold">Consent Form Versions</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Versions are append-only — publishing a new one deactivates the previous version for that role and asks
          everyone to respond again, without ever altering what a past signature legally agreed to.
        </p>
      </div>

      <Card>
        <CardContent className="space-y-4 pt-6">
          <h2 className="font-semibold">Publish a new version</h2>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1">
              <Label>Role</Label>
              <Select value={role} onValueChange={(v) => setRole(v as "STUDENT" | "TEACHER")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="STUDENT">Student</SelectItem>
                  <SelectItem value="TEACHER">Teacher</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Version label</Label>
              <Input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="e.g. 2026-09-01" />
            </div>
            <div className="space-y-1">
              <Label>Title</Label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Form title" />
            </div>
          </div>
          <div className="space-y-1">
            <Label>Form text (HTML)</Label>
            <Textarea
              value={bodyHtml}
              onChange={(e) => setBodyHtml(e.target.value)}
              rows={10}
              placeholder="<h2>...</h2><p>...</p>"
            />
          </div>
          <Button onClick={publish} disabled={publishing || !role || !version.trim() || !title.trim() || !bodyHtml.trim()}>
            {publishing ? "Publishing…" : "Publish as active version"}
          </Button>
        </CardContent>
      </Card>

      {loading ? (
        <div className="flex justify-center py-12 text-muted-foreground">
          <Loader2 className="mr-2 size-5 animate-spin" /> Loading…
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="p-2">Role</th>
                <th className="p-2">Version</th>
                <th className="p-2">Title</th>
                <th className="p-2">Published</th>
                <th className="p-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.id} className="border-t">
                  <td className="p-2">{v.role}</td>
                  <td className="p-2">{v.version}</td>
                  <td className="p-2">{v.title}</td>
                  <td className="p-2 text-xs">{new Date(v.createdAt).toLocaleString()}</td>
                  <td className="p-2">
                    <Badge variant={v.isActive ? "default" : "secondary"}>{v.isActive ? "Active" : "Retired"}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
