"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { LogOut, PauseCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DEFAULT_PAUSE_MESSAGE } from "@/lib/platform-paused";

export const POLL_INTERVAL_MS = 30_000;

/**
 * Full-page "access paused" notice. Polls /api/student/access (reachable while
 * paused) every 30 s and when the tab regains focus, and returns the student
 * to the dashboard as soon as an admin re-enables their class.
 */
export function PausedView({ message }: { message: string }) {
  const router = useRouter();
  const [text, setText] = useState(message || DEFAULT_PAUSE_MESSAGE);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const res = await fetch("/api/student/access", { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const data: { paused?: boolean; message?: string | null } =
          await res.json();
        if (cancelled) return;
        if (data.paused === false) router.replace("/student");
        else if (data.message) setText(data.message);
      } catch {
        // Offline or a blip: keep showing the notice and try again later.
      }
    }
    const timer = setInterval(check, POLL_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [router]);

  async function handleSignOut() {
    setSigningOut(true);
    await signOut({ redirect: false });
    window.location.href = `${window.location.origin}/login`;
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-lg">
        <CardContent className="flex flex-col items-center gap-4 p-8 text-center">
          <div className="flex size-14 items-center justify-center rounded-full bg-primary/10">
            <PauseCircle className="size-7 text-primary" aria-hidden="true" />
          </div>
          <h1 className="text-2xl font-bold">Access is paused</h1>
          <p role="status" className="text-muted-foreground">
            {text}
          </p>
          <p className="text-xs text-muted-foreground">
            Your work and results are safe. This page checks automatically and
            will take you back as soon as access returns.
          </p>
          <Button
            variant="outline"
            onClick={handleSignOut}
            disabled={signingOut}
          >
            <LogOut className="size-4" /> Sign out
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
