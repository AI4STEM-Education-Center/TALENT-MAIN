"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { getVersionInfo } from "@/lib/version";
import { BookText, X } from "lucide-react";

export function VersionModal() {
  const versionInfo = getVersionInfo();

  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <button
          className="w-full flex items-center justify-between rounded-lg border border-sidebar-border/80 bg-sidebar-accent/30 px-3 py-2 text-xs text-sidebar-foreground/80 hover:bg-sidebar-accent/60 transition-colors"
          type="button"
        >
          <span>Version</span>
          <Badge variant="outline" className="border-sidebar-border text-sidebar-foreground/90">
            v{versionInfo.version}
          </Badge>
        </button>
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/45" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[95vw] max-w-2xl -translate-x-1/2 -translate-y-1/2 focus:outline-none">
          <Card className="max-h-[85vh] overflow-hidden border-sidebar-border bg-card/95 backdrop-blur">
            <div className="border-b border-sidebar-border px-5 py-4 flex items-start justify-between gap-4">
              <div className="space-y-2">
                <Dialog.Title className="flex items-center gap-2 text-lg font-semibold text-foreground">
                  <BookText className="h-5 w-5" />
                  Release Notes
                </Dialog.Title>
                <Dialog.Description className="text-sm text-muted-foreground">
                  Current version v{versionInfo.version}
                  {versionInfo.date ? ` (${versionInfo.date})` : ""}
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <Button variant="ghost" size="icon" aria-label="Close changelog modal">
                  <X className="h-4 w-4" />
                </Button>
              </Dialog.Close>
            </div>

            <div className="max-h-[65vh] overflow-y-auto p-5 space-y-4">
              {versionInfo.changelogEntries.length === 0 && (
                <p className="text-sm text-muted-foreground">No changelog entries found.</p>
              )}

              {versionInfo.changelogEntries.map((entry) => (
                <section key={`${entry.version}-${entry.date}`} className="rounded-md border border-border/80 p-4">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold text-foreground">v{entry.version}</h3>
                    {entry.date && (
                      <span className="text-xs text-muted-foreground">{entry.date}</span>
                    )}
                  </div>
                  {entry.notes.length > 0 ? (
                    <ul className="space-y-1 text-sm text-foreground/90">
                      {entry.notes.map((note) => (
                        <li key={note} className="leading-relaxed">
                          - {note}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted-foreground">No notes recorded for this release.</p>
                  )}
                </section>
              ))}
            </div>
          </Card>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
