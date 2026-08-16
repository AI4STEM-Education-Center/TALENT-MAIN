"use client";

import { useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { SignatureCanvas, type SignatureCanvasHandle } from "./SignatureCanvas";

export interface ConsentFormActiveVersion {
  id: string;
  title: string;
  version: string;
  bodyHtml: string;
}

/**
 * Renders one consent form (student or instructor) and posts the decision to
 * /api/consent. Shared by the blocking dashboard modal (ConsentGate) and the
 * standalone /teacher/consent-required page, since both need the exact same
 * capture flow — only the surrounding chrome differs.
 *
 * bodyHtml is rendered via dangerouslySetInnerHTML: it is admin-authored
 * content (published only through /admin/consent/forms), the same trust
 * level as other admin-authored text fields in this app (e.g. EmailSender
 * body overrides) — never user-supplied.
 */
export function ConsentForm({
  role,
  activeForm,
  onSubmitted,
}: {
  role: "STUDENT" | "TEACHER";
  activeForm: ConsentFormActiveVersion;
  onSubmitted: (decision: "AGREE" | "DECLINE") => void;
}) {
  const { update } = useSession();
  const [decision, setDecision] = useState<"AGREE" | "DECLINE" | null>(null);
  const [wantsRecordingConsent, setWantsRecordingConsent] = useState(false);
  const [wantsDrawnSignature, setWantsDrawnSignature] = useState(false);
  const [signatureTypedName, setSignatureTypedName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initialsRef = useRef<SignatureCanvasHandle>(null);
  const signatureRef = useRef<SignatureCanvasHandle>(null);

  async function handleSubmit() {
    if (!decision) {
      setError("Choose Yes or No before submitting.");
      return;
    }
    if (!signatureTypedName.trim()) {
      setError("Type your full name to sign this form.");
      return;
    }
    if (decision === "AGREE" && wantsRecordingConsent && (initialsRef.current?.isEmpty() ?? true)) {
      setError("Draw your initials to consent to the interview being recorded.");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision,
          interviewRecordingConsent: decision === "AGREE" ? wantsRecordingConsent : undefined,
          initialsStrokeData:
            decision === "AGREE" && wantsRecordingConsent ? initialsRef.current?.toData() : undefined,
          signatureTypedName: signatureTypedName.trim(),
          signatureStrokeData: wantsDrawnSignature ? signatureRef.current?.toData() : undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || "Could not submit your response.");
      }
      // Refresh the JWT's consent claim so proxy.ts's teacher gate and any
      // session-derived UI reflect this decision without a re-login.
      //
      // The `{}` argument is load-bearing: next-auth's update() only POSTs
      // (firing the jwt callback's "update" trigger, which re-stamps the claim
      // from the database) when it is passed data — with no arguments it
      // quietly degrades to a GET that refreshes nothing. Without it a teacher
      // who agreed still carried an undecided claim, so proxy.ts bounced them
      // back to /teacher/consent-required, which sent them on to /teacher, and
      // round again: ERR_TOO_MANY_REDIRECTS. The value is unused — src/lib/auth.ts
      // re-reads from the database rather than trusting a client-supplied patch.
      await update({});
      onSubmitted(decision);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not submit your response.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold leading-tight">{activeForm.title}</h2>
        <p className="text-xs text-muted-foreground">Form version {activeForm.version}</p>
      </div>

      <div
        className="max-h-72 overflow-y-auto rounded-md border border-input p-4 text-sm leading-relaxed [&_h2]:text-base [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:text-sm [&_h3]:font-semibold [&_h4]:mt-3 [&_h4]:text-sm [&_h4]:font-semibold [&_li]:mt-1 [&_p]:mt-2 [&_ul]:mt-2 [&_ul]:list-disc [&_ul]:pl-5"
        dangerouslySetInnerHTML={{ __html: activeForm.bodyHtml }}
      />

      <div className="space-y-2">
        <Label>Do you agree to participate in this study?</Label>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant={decision === "AGREE" ? "default" : "outline"}
            onClick={() => setDecision("AGREE")}
          >
            Yes, I agree to participate
          </Button>
          <Button
            type="button"
            variant={decision === "DECLINE" ? "default" : "outline"}
            onClick={() => setDecision("DECLINE")}
          >
            No, I do not agree
          </Button>
        </div>
        {role === "STUDENT" && (
          <p className="text-xs text-muted-foreground">
            Either answer is complete — declining has no effect on your grades or coursework.
          </p>
        )}
      </div>

      {decision === "AGREE" && (
        <div className="space-y-2 rounded-md bg-muted/40 p-3">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1 size-4"
              checked={wantsRecordingConsent}
              onChange={(e) => setWantsRecordingConsent(e.target.checked)}
            />
            <span>I give my consent to have the interview recorded.</span>
          </label>
          {wantsRecordingConsent && (
            <div className="space-y-1 pl-6">
              <Label className="text-xs">Draw your initials</Label>
              <SignatureCanvas ref={initialsRef} height={70} />
              <Button type="button" variant="ghost" size="sm" onClick={() => initialsRef.current?.clear()}>
                Clear
              </Button>
            </div>
          )}
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="consent-typed-name">Typed signature (your full legal name)</Label>
        <Input
          id="consent-typed-name"
          value={signatureTypedName}
          onChange={(e) => setSignatureTypedName(e.target.value)}
          placeholder="Type your full name"
        />
        <p className="text-xs text-muted-foreground">
          For the purposes of this form, typing your name is equivalent to your legal signature.
        </p>
      </div>

      <div className="space-y-1">
        <button
          type="button"
          className="text-xs text-primary underline underline-offset-2"
          onClick={() => setWantsDrawnSignature((v) => !v)}
        >
          {wantsDrawnSignature ? "Remove hand-drawn signature" : "Add a hand-drawn signature (optional)"}
        </button>
        {wantsDrawnSignature && (
          <div className="space-y-1 pt-1">
            <SignatureCanvas ref={signatureRef} height={90} />
            <Button type="button" variant="ghost" size="sm" onClick={() => signatureRef.current?.clear()}>
              Clear
            </Button>
          </div>
        )}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Button className="w-full" onClick={handleSubmit} disabled={submitting}>
        {submitting ? "Submitting…" : "Submit my response"}
      </Button>
    </div>
  );
}
