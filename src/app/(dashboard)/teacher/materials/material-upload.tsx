"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Upload } from "lucide-react";

type MaterialUploadFormProps = {
  maxUploadBytes: number;
};

function formatSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

async function describeUploadFailure(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");

  if (body.includes("<Code>AccessDenied</Code>")) {
    return "S3 denied the upload. Check IAM permissions for s3:PutObject on this bucket.";
  }

  if (body.includes("<Code>SignatureDoesNotMatch</Code>")) {
    return "S3 rejected the upload signature. Verify AWS region, bucket name, and any S3 endpoint override.";
  }

  if (body.includes("<Code>ExpiredToken</Code>") || body.includes("<Code>InvalidToken</Code>")) {
    return "AWS credentials for S3 are invalid or expired.";
  }

  return `Upload to S3 failed (${res.status} ${res.statusText}).`;
}

export function MaterialUploadForm({ maxUploadBytes }: MaterialUploadFormProps) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function cleanupPendingMaterial(id: string) {
    await fetch(`/api/learning-materials/${id}`, { method: "DELETE" }).catch(() => undefined);
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const nextFile = e.target.files?.[0] ?? null;
    setError("");

    if (nextFile && nextFile.size > maxUploadBytes) {
      setFile(null);
      e.target.value = "";
      setError(`File exceeds the ${formatSize(maxUploadBytes)} limit.`);
      return;
    }

    setFile(nextFile);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!file) {
      setError("Choose a file.");
      return;
    }

    setBusy(true);
    try {
      const initRes = await fetch("/api/learning-materials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim() || undefined,
          originalName: file.name,
          mimeType: file.type || "application/octet-stream",
          sizeBytes: file.size,
        }),
      });
      const data = await initRes.json();
      if (!initRes.ok) {
        setError(data.error ?? "Could not start upload.");
        return;
      }

      if (!data.presignedUrl || !data.id) {
        setError("Unexpected server response.");
        return;
      }

      const putRes = await fetch(data.presignedUrl, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": data.mimeType },
      });
      if (!putRes.ok) {
        await cleanupPendingMaterial(data.id);
        setError(await describeUploadFailure(putRes));
        return;
      }

      const doneRes = await fetch(`/api/learning-materials/${data.id}/complete`, {
        method: "POST",
      });
      const doneJson = await doneRes.json();
      if (!doneRes.ok) {
        setError(doneJson.error ?? "Could not finalize upload.");
        return;
      }

      setTitle("");
      setFile(null);
      router.refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Failed to upload.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Upload className="w-5 h-5" />
          Upload materials
        </CardTitle>
        <CardDescription>
          Files are stored in Amazon S3. The app issues a presigned <code className="text-xs bg-muted px-1 rounded">PUT</code> URL
          so the browser uploads directly to S3; configure <code className="text-xs bg-muted px-1 rounded">AWS_REGION</code>,{" "}
          <code className="text-xs bg-muted px-1 rounded">AWS_S3_BUCKET</code>, and credentials (or an IAM role on the server).
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4 max-w-md">
          <div className="space-y-2">
            <Label htmlFor="title">Title (optional)</Label>
            <Input
              id="title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Week 3 reading"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="file">File</Label>
            <Input id="file" type="file" onChange={onFileChange} />
            <p className="text-xs text-muted-foreground">Max file size: {formatSize(maxUploadBytes)}.</p>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={busy}>
            {busy ? "Uploading…" : "Upload"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
