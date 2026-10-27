"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAlert, useConfirm } from "@/components/ui/confirm-dialog";
import { useAdminCanEdit } from "@/components/admin/use-admin-can-edit";

/**
 * Whether a class's students and teacher are prompted for the IRB consent
 * form and the pre/post research surveys. A person is skipped only when
 * every class they belong to is excluded (see src/lib/research-exclusion.ts).
 * Research scientists see the state read-only.
 */
export function ClassResearchToggle(props: ToggleProps) {
  // Remount when the server value changes (router.refresh after another
  // admin's edit) so the local state never shows a stale value.
  return <ToggleInner key={String(props.excluded)} {...props} />;
}

type ToggleProps = { classId: string; className: string; excluded: boolean };

function ToggleInner({
  classId,
  className,
  excluded: initialExcluded,
}: ToggleProps) {
  const router = useRouter();
  const confirm = useConfirm();
  const alert = useAlert();
  const canEdit = useAdminCanEdit();
  const [excluded, setExcluded] = useState(initialExcluded);
  const [saving, setSaving] = useState(false);

  const badge = excluded ? (
    <Badge variant="warning">Excluded</Badge>
  ) : (
    <Badge variant="success">Prompted</Badge>
  );
  if (!canEdit) return badge;

  async function toggle() {
    const next = !excluded;
    const ok = await confirm({
      title: next
        ? `Exclude “${className}” from research prompts?`
        : `Include “${className}” in research prompts again?`,
      description: next
        ? "Its students and teacher stop seeing the IRB consent form and the pre/post survey prompts, unless they also belong to a class that is still included. Consent records and survey answers already on file are kept."
        : "Its students and teacher are asked for the IRB consent form and any due pre/post surveys the next time they open the dashboard.",
      confirmText: next ? "Exclude class" : "Include class",
    });
    if (!ok) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/classes/${classId}/research`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ excluded: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        await alert({
          title: "Could not update the class",
          description:
            typeof data.error === "string" ? data.error : "Try again.",
        });
        return;
      }
      setExcluded(data.researchExcluded === true);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      {badge}
      <Button
        variant="outline"
        size="sm"
        onClick={toggle}
        disabled={saving}
        aria-label={
          excluded
            ? `Include ${className} in research prompts`
            : `Exclude ${className} from research prompts`
        }
      >
        {saving && <Loader2 className="size-3 animate-spin" />}
        {excluded ? "Include" : "Exclude"}
      </Button>
    </div>
  );
}
