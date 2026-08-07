"use client";

import { useEffect, useMemo, useState } from "react";
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
import { previewConsentHtml } from "@/lib/consent-html-preview";
import { AlertTriangle, Eye, FileText, Loader2 } from "lucide-react";

interface ConsentVersionRow {
  id: string;
  role: string;
  version: string;
  title: string;
  isActive: boolean;
  createdAt: string;
}

interface OfficialForm {
  role: "STUDENT" | "TEACHER";
  version: string;
  title: string;
  bodyHtml: string;
}

export default function AdminConsentFormsPage() {
  const alert = useAlert();
  const [versions, setVersions] = useState<ConsentVersionRow[]>([]);
  const [official, setOfficial] = useState<Record<string, OfficialForm> | null>(null);
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState<"STUDENT" | "TEACHER">("STUDENT");
  const [version, setVersion] = useState("");
  const [title, setTitle] = useState("");
  const [bodyHtml, setBodyHtml] = useState("");
  const [preview, setPreview] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const previewHtml = useMemo(
    () => (preview && bodyHtml.trim() ? previewConsentHtml(bodyHtml) : ""),
    [preview, bodyHtml]
  );

  async function load(signal?: AbortSignal) {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/consent/forms", { cache: "no-store", signal });
      if (!res.ok) throw new Error("Could not load consent form versions.");
      const data = await res.json();
      setVersions(data.versions ?? []);
      setOfficial(data.official ?? null);
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError")) {
        await alert({
          title: "Couldn't load forms",
          description: cause instanceof Error ? cause.message : "Unknown error.",
        });
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [alert]);

  async function publish() {
    setPublishing(true);
    try {
      const res = await fetch("/api/admin/consent/forms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role, version, title, bodyHtml }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        await alert({ title: "Couldn't publish", description: data?.error || "Unknown error." });
        return;
      }
      setVersion("");
      setTitle("");
      setBodyHtml("");
      setPreview(false);
      await load();
      await alert(`Published ${role} form ${version} as the active version.`);
    } finally {
      setPublishing(false);
    }
  }

  /** Prefill the editor with the IRB text this build ships, transcribed from
   *  the PDFs in data/ — the same text `npm run seed:consent` installs. */
  function loadOfficialText() {
    const source = official?.[role];
    if (!source) return;
    setVersion(source.version);
    setTitle(source.title);
    setBodyHtml(source.bodyHtml);
    setPreview(true);
  }

  const activeRoles = new Set<string>();
  for (const v of versions) if (v.isActive) activeRoles.add(v.role);
  const missingRoles = (["STUDENT", "TEACHER"] as const).filter((r) => !activeRoles.has(r));
  const officialAlreadyPublished = versions.some(
    (v) => v.role === role && v.version === official?.[role]?.version
  );

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div>
        <h1 className="text-3xl font-bold">Consent Form Versions</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Versions are append-only — publishing a new one deactivates the previous version for that role and asks
          everyone to respond again, without ever altering what a past signature legally agreed to.
        </p>
      </div>

      {!loading && missingRoles.length > 0 && (
        <div className="flex gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-600" />
          <div className="space-y-1">
            <p className="font-medium">
              No active consent form for {missingRoles.map((r) => r.toLowerCase()).join(" or ")}.
            </p>
            <p className="text-muted-foreground">
              Until a version is published for a role, nobody with that role is ever shown a consent form —
              the form screen is simply empty, and no decisions can be recorded. Use{" "}
              <strong>Load the official UGA text</strong> below to publish the IRB-approved form.
            </p>
          </div>
        </div>
      )}

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
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label>Form text (HTML)</Label>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" size="sm" onClick={loadOfficialText} disabled={!official}>
                  <FileText className="size-4" /> Load the official UGA text
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setPreview((v) => !v)}
                  disabled={!bodyHtml.trim()}
                >
                  <Eye className="size-4" /> {preview ? "Edit HTML" : "Preview"}
                </Button>
              </div>
            </div>
            {preview && bodyHtml.trim() ? (
              <div
                className="max-h-96 overflow-y-auto rounded-md border border-input bg-background p-4 text-sm leading-relaxed [&_h2]:text-base [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:text-sm [&_h3]:font-semibold [&_h4]:mt-3 [&_h4]:text-sm [&_h4]:font-semibold [&_li]:mt-1 [&_p]:mt-2 [&_ul]:mt-2 [&_ul]:list-disc [&_ul]:pl-5"
                // Held to the publish-time allowlist first, so this shows what
                // signers will actually get — and a draft paste can't script
                // this page while the admin reviews it.
                dangerouslySetInnerHTML={{ __html: previewHtml }}
              />
            ) : (
              <Textarea
                value={bodyHtml}
                onChange={(e) => setBodyHtml(e.target.value)}
                rows={10}
                placeholder="<h2>...</h2><p>...</p>"
              />
            )}
            <p className="text-xs text-muted-foreground">
              The official text is transcribed from the IRB PDFs in <code>data/</code> and matches what{" "}
              <code>npm run seed:consent</code> installs. Only headings, paragraphs, lists, links, and inline
              emphasis survive publishing — everything else is stripped.
            </p>
          </div>
          {officialAlreadyPublished && (
            <p className="text-xs text-muted-foreground">
              Version &quot;{official?.[role]?.version}&quot; already exists for {role.toLowerCase()}s — give this
              one a new version label to publish an amended text.
            </p>
          )}
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
              {versions.length === 0 && (
                <tr className="border-t">
                  <td className="p-4 text-center text-muted-foreground" colSpan={5}>
                    No consent form versions have been published yet.
                  </td>
                </tr>
              )}
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
