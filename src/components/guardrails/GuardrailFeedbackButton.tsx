"use client";

import { useState } from "react";
import { Flag, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { MAX_FEEDBACK_CHARS } from "@/lib/guardrail-feedback";

/**
 * "Report a problem" on a guardrail result.
 *
 * Shown wherever a safety check refused something or attached a warning a user
 * reads. The notice itself never says WHICH check fired — that would hand
 * anyone probing it a free hint — so this is the only route by which a person
 * who was wrongly stopped can say so. Renders nothing without an event id,
 * which is what a caller gets when the check passed or the record could not be
 * written, so it is safe to drop into any error path unconditionally.
 */
interface GuardrailFeedbackButtonProps {
  eventId?: string | null;
  className?: string;
}

export function GuardrailFeedbackButton({
  eventId,
  className,
}: GuardrailFeedbackButtonProps) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!eventId) return null;

  async function send() {
    if (!message.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/guardrails/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId, message: message.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Could not send that report.");
        return;
      }
      setSent(true);
      setOpen(false);
    } catch {
      setError("Could not send that report.");
    } finally {
      setSending(false);
    }
  }

  if (sent) {
    return (
      <span className={cn("text-xs text-muted-foreground", className)}>
        Thanks — an admin will see this.
      </span>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "inline-flex items-center gap-1 text-xs underline underline-offset-2 hover:no-underline",
          className,
        )}
      >
        <Flag className="h-3 w-3" aria-hidden="true" />
        Report a problem
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Report a safety check</DialogTitle>
            <DialogDescription>
              Tell us what you were trying to do. This goes to a site admin, who
              can adjust the checks. Your message is stored with the flagged
              submission.
            </DialogDescription>
          </DialogHeader>

          <Textarea
            rows={5}
            autoFocus
            maxLength={MAX_FEEDBACK_CHARS}
            placeholder="What were you trying to submit, and why do you think it was wrongly stopped?"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            aria-label="What went wrong"
          />
          {error && <p className="text-sm text-destructive">{error}</p>}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={sending}
            >
              Cancel
            </Button>
            <Button onClick={send} disabled={sending || !message.trim()}>
              {sending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Send report
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
