"use client";

import { useState, type ReactNode } from "react";
import { Atom } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  SimulationViewer,
  type SimulationTelemetryContext,
} from "@/components/simulation/SimulationViewer";

export type SimulationDialogTarget = {
  simulationId: string;
  title: string;
  /** Bumps the content URL so a revised artifact is not served from cache. */
  version?: number | null;
};

/**
 * The pop-up every student simulation opens in (results pages and the
 * library). Near full-viewport on desktop, full-screen on phones, so the
 * simulation has room without the page reflowing around it.
 *
 * Render it only while a simulation is open: the viewer — and with it the
 * telemetry session — mounts per open and per switch (keyed by simulation and
 * version), and unmounting on close is what sends the session's final batch.
 *
 * Outside clicks deliberately do NOT dismiss it: a stray click on the dimmed
 * page would throw away the student's set-up mid-experiment. Closing takes the
 * explicit close button or Escape — including Escape pressed while focus is
 * inside the sandboxed simulation, which the served document forwards up.
 */
export function SimulationDialog({
  simulation,
  onClose,
  description,
  context,
  headerExtra,
  footer,
  telemetry,
}: {
  simulation: SimulationDialogTarget;
  onClose: () => void;
  /** What the simulation teaches (its learning goal). */
  description?: string | null;
  /** One short line of where it came from, e.g. the quiz and class. */
  context?: ReactNode;
  /** Rendered under the title, e.g. chips to switch between simulations. */
  headerExtra?: ReactNode;
  /** Rendered under the simulation, e.g. the rating form. */
  footer?: ReactNode;
  /** Student launches only — staff viewing a simulation is never recorded. */
  telemetry?: SimulationTelemetryContext;
}) {
  // The launchers are plain buttons (not a Radix DialogTrigger) because the
  // dialog only exists while open, so Radix has no trigger to return focus to.
  // Capture whatever was focused when the dialog mounted — the launcher that
  // was just activated — and hand focus back to it on close.
  const [opener] = useState<HTMLElement | null>(() =>
    typeof document !== "undefined" &&
    document.activeElement instanceof HTMLElement &&
    document.activeElement !== document.body
      ? document.activeElement
      : null,
  );
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        onInteractOutside={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => {
          if (!opener?.isConnected) return;
          event.preventDefault();
          opener.focus();
        }}
        className="flex h-dvh w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none border-0 p-0 sm:h-[92dvh] sm:w-[96vw] sm:max-w-[1600px] sm:rounded-lg sm:border"
      >
        <DialogHeader className="space-y-2 border-b px-4 py-3 pr-12 text-left sm:text-left">
          <div className="min-w-0 space-y-1">
            <DialogTitle className="flex items-center gap-1.5 text-base">
              <Atom aria-hidden className="size-4 shrink-0 text-primary" />
              <span className="truncate">{simulation.title}</span>
            </DialogTitle>
            {description ? (
              <DialogDescription className="text-xs">
                {description}
              </DialogDescription>
            ) : (
              <DialogDescription className="sr-only">
                Interactive simulation
              </DialogDescription>
            )}
            {context && (
              <p className="text-xs text-muted-foreground/80">{context}</p>
            )}
          </div>
          {headerExtra}
        </DialogHeader>
        <div className="min-h-0 flex-1 p-2">
          <SimulationViewer
            key={`${simulation.simulationId}:${simulation.version ?? 0}`}
            simulationId={simulation.simulationId}
            title={simulation.title}
            version={simulation.version ?? undefined}
            telemetry={telemetry}
            onEscape={onClose}
          />
        </div>
        {footer && (
          <div className="max-h-[40dvh] shrink-0 overflow-y-auto border-t px-4 py-3">
            {footer}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
