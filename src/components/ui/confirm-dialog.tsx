"use client";

import * as React from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export interface ConfirmOptions {
  title?: string;
  description?: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  /** Visual style of the confirm button. Use "destructive" for delete/remove actions. */
  variant?: "default" | "destructive";
}

export interface AlertOptions {
  title?: string;
  description?: React.ReactNode;
  confirmText?: string;
}

interface ConfirmState extends ConfirmOptions {
  kind: "confirm";
}

interface AlertState extends AlertOptions {
  kind: "alert";
}

type DialogState = ConfirmState | AlertState;

interface DialogContextValue {
  confirm: (options?: ConfirmOptions) => Promise<boolean>;
  alert: (options?: AlertOptions | string) => Promise<void>;
}

const DialogContext = React.createContext<DialogContextValue | null>(null);

/**
 * Mounts a single themed dialog and exposes imperative `confirm()` / `alert()`
 * replacements for the native `window.confirm` / `window.alert`, so every
 * confirmation popup matches the site's design system.
 */
export function ConfirmDialogProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [state, setState] = React.useState<DialogState | null>(null);
  const [open, setOpen] = React.useState(false);
  const resolverRef = React.useRef<((value: boolean) => void) | null>(null);

  const settle = React.useCallback((value: boolean) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setOpen(false);
    resolve?.(value);
  }, []);

  const confirm = React.useCallback(
    (options: ConfirmOptions = {}) =>
      new Promise<boolean>((resolve) => {
        resolverRef.current = resolve;
        setState({ kind: "confirm", ...options });
        setOpen(true);
      }),
    [],
  );

  const alert = React.useCallback((options: AlertOptions | string = {}) => {
    const opts =
      typeof options === "string" ? { description: options } : options;
    return new Promise<void>((resolve) => {
      resolverRef.current = () => resolve();
      setState({ kind: "alert", ...opts });
      setOpen(true);
    });
  }, []);

  const value = React.useMemo(() => ({ confirm, alert }), [confirm, alert]);

  const isAlert = state?.kind === "alert";
  const variant =
    state?.kind === "confirm" ? (state.variant ?? "default") : "default";

  return (
    <DialogContext.Provider value={value}>
      {children}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          // Closing via the X button, Escape, or the overlay counts as a cancel.
          if (!next) settle(false);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {state?.title ?? (isAlert ? "Notice" : "Are you sure?")}
            </DialogTitle>
            {state?.description != null && state.description !== "" && (
              <DialogDescription>{state.description}</DialogDescription>
            )}
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            {!isAlert && (
              <Button variant="outline" onClick={() => settle(false)}>
                {(state?.kind === "confirm" && state.cancelText) || "Cancel"}
              </Button>
            )}
            <Button
              variant={variant}
              onClick={() => settle(true)}
              autoFocus={isAlert}
            >
              {state?.confirmText ?? (isAlert ? "OK" : "Confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DialogContext.Provider>
  );
}

function useDialogContext() {
  const ctx = React.use(DialogContext);
  if (!ctx) {
    throw new Error(
      "useConfirm/useAlert must be used within a ConfirmDialogProvider",
    );
  }
  return ctx;
}

/** Returns an async `confirm(options)` that resolves to true when confirmed. */
export function useConfirm() {
  return useDialogContext().confirm;
}

/** Returns an async `alert(options | string)` that resolves once dismissed. */
export function useAlert() {
  return useDialogContext().alert;
}
