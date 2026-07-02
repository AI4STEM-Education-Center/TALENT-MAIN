"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertTriangle, CheckCircle, Loader2, Upload } from "lucide-react";
import type { UploadResult } from "./import-actions";

interface UploadCardProps {
  title: string;
  description: string;
  ariaLabel: string;
  onFile: (text: string) => Promise<UploadResult>;
  onSuccess: () => void;
}

/** Presentational upload card: hidden file input, banner, expandable row details. */
export function UploadCard({ title, description, ariaLabel, onFile, onSuccess }: UploadCardProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<UploadResult | null>(null);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setResult(null);

    const reader = new FileReader();
    reader.onload = async (ev) => {
      const text = (ev.target?.result as string) ?? "";
      setUploading(true);
      try {
        const outcome = await onFile(text);
        setResult(outcome);
        if (outcome.ok) onSuccess();
      } finally {
        setUploading(false);
        if (fileRef.current) fileRef.current.value = "";
      }
    };
    reader.onerror = () => {
      setResult({ ok: false, message: "Failed to read the file." });
      if (fileRef.current) fileRef.current.value = "";
    };
    reader.readAsText(file);
  }

  const detailCount = result?.details?.length ?? 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{title}</CardTitle>
        <p className="text-sm text-muted-foreground">{description}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        <input
          ref={fileRef}
          type="file"
          accept=".csv"
          aria-label={ariaLabel}
          onChange={handleChange}
          className="hidden"
        />
        <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()} disabled={uploading}>
          {uploading ? (
            <Loader2 className="size-4 mr-1 animate-spin" />
          ) : (
            <Upload className="size-4 mr-1" />
          )}
          {uploading ? "Uploading..." : "Upload CSV"}
        </Button>

        {result && !result.ok && (
          <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm flex items-start gap-2">
            <AlertTriangle className="size-4 shrink-0 mt-0.5" />
            <span>{result.message}</span>
          </div>
        )}
        {result && result.ok && (
          <div className="p-3 rounded-md bg-green-500/10 text-green-700 dark:text-green-400 text-sm flex items-start gap-2">
            <CheckCircle className="size-4 shrink-0 mt-0.5" />
            <span>{result.message}</span>
          </div>
        )}
        {detailCount > 0 && (
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer select-none">
              {detailCount} row detail{detailCount === 1 ? "" : "s"}
            </summary>
            <ul className="mt-2 space-y-1 list-disc pl-4">
              {result?.details?.map((detail) => <li key={detail}>{detail}</li>)}
            </ul>
          </details>
        )}
      </CardContent>
    </Card>
  );
}
