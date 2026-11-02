"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useAlert, useConfirm } from "@/components/ui/confirm-dialog";
import { useAdminCanEdit } from "@/components/admin/use-admin-can-edit";
import { DEFAULT_PAUSE_MESSAGE } from "@/lib/platform-paused";

export const PAUSE_MESSAGE_MAX = 500;

/**
 * Admin control for pausing a class: its students lose access to the whole
 * platform until it is re-enabled (src/lib/class-access-pause.ts). Disabling
 * asks for confirmation and an optional message shown to the students.
 * Research scientists see the state read-only.
 */
export function ClassAccessToggle(props: ToggleProps) {
  // Remount when the server value changes (router.refresh after another
  // admin's edit) so the local state never shows a stale value.
  return <ToggleInner key={String(props.disabled)} {...props} />;
}

type ToggleProps = { classId: string; className: string; disabled: boolean };

function ToggleInner({
  classId,
  className,
  disabled: initialDisabled,
}: ToggleProps) {
  const router = useRouter();
  const confirm = useConfirm();
  const alert = useAlert();
  const canEdit = useAdminCanEdit();
  const messageId = useId();
  const [disabled, setDisabled] = useState(initialDisabled);
  const [saving, setSaving] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [message, setMessage] = useState(DEFAULT_PAUSE_MESSAGE);

  const badge = disabled ? (
    <Badge variant="destructive">Disabled</Badge>
  ) : (
    <Badge variant="success">Active</Badge>
  );
  if (!canEdit) return badge;

  async function save(next: boolean, text?: string) {
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/classes/${classId}/access`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          next ? { disabled: true, message: text } : { disabled: false },
        ),
      });
      if (!res.ok) {
        const failure = await res.json().catch(() => ({}));
        await alert({
          title: "Could not update the class",
          description:
            typeof failure.error === "string" ? failure.error : "Try again.",
        });
        return false;
      }
      const data = await res.json();
      setDisabled(data.disabledAt != null);
      router.refresh();
      return true;
    } finally {
      setSaving(false);
    }
  }

  async function enable() {
    const ok = await confirm({
      title: `Re-enable “${className}”?`,
      description:
        "Its students regain access to the platform within a few seconds.",
      confirmText: "Enable access",
    });
    if (ok) await save(false);
  }

  async function disable() {
    // The default wording is the fallback anyway, so send it only when edited.
    const text = message.trim();
    const custom = text && text !== DEFAULT_PAUSE_MESSAGE ? text : undefined;
    if (await save(true, custom)) setAskOpen(false);
  }

  return (
    <div className="flex items-center gap-2">
      {badge}
      <Button
        variant={disabled ? "outline" : "destructive"}
        size="sm"
        onClick={() => (disabled ? enable() : setAskOpen(true))}
        disabled={saving}
        aria-label={
          disabled ? `Enable access for ${className}` : `Disable ${className}`
        }
      >
        {saving && <Loader2 className="size-3 animate-spin" />}
        {disabled ? "Enable" : "Disable"}
      </Button>
      <Dialog
        open={askOpen}
        onOpenChange={(open) => !saving && setAskOpen(open)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Disable “{className}”?</DialogTitle>
            <DialogDescription>
              Students in this class lose access to the whole platform until you
              re-enable it, including quizzes, materials and the assistant. A
              student who is also in another active class keeps the platform but
              loses this class. Nothing is deleted. Teachers keep full access.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor={messageId}>Message shown to students</Label>
            <Textarea
              id={messageId}
              value={message}
              maxLength={PAUSE_MESSAGE_MAX}
              onChange={(e) => setMessage(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Optional. {message.length}/{PAUSE_MESSAGE_MAX}
            </p>
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              onClick={() => setAskOpen(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button variant="destructive" onClick={disable} disabled={saving}>
              {saving && <Loader2 className="size-3 animate-spin" />}
              Disable class
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
