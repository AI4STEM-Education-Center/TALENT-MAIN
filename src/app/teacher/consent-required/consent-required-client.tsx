"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { signOut, SessionProvider, useSession } from "next-auth/react";
import { Loader2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ConsentForm, type ConsentFormActiveVersion } from "@/components/consent/ConsentForm";
import { isTeacherConsentBlocked } from "@/lib/consent-claim";

function ConsentRequiredInner({
  activeForm,
  priorDecision,
}: {
  activeForm: ConsentFormActiveVersion;
  priorDecision: "DECLINE" | null;
}) {
  const router = useRouter();
  const [reviewing, setReviewing] = useState(priorDecision === null);

  if (!reviewing) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <Card className="w-full max-w-lg">
          <CardHeader>
            <CardTitle>Access to AI4Talent is on hold</CardTitle>
            <CardDescription className="pt-2 text-sm leading-relaxed">
              You previously indicated you do not agree to participate in the &quot;{activeForm.title}&quot;
              research study. Because using AI4Talent in your course is part of what this study is evaluating,
              instructor access is only available to instructors who agree to participate — this has no effect on
              your employment or professional standing.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 sm:flex-row">
            <Button onClick={() => setReviewing(true)}>Review my response</Button>
            <Button
              variant="outline"
              onClick={async () => {
                await signOut({ redirect: false });
                router.push("/login");
              }}
            >
              Sign out
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-2xl">
        <CardContent className="pt-6">
          <ConsentForm
            role="TEACHER"
            activeForm={activeForm}
            onSubmitted={(decision) => {
              if (decision === "AGREE") {
                // Hard navigation: ConsentForm has just refreshed the session
                // cookie, and src/proxy.ts only sees it on a fresh request.
                window.location.replace("/teacher");
                return;
              }
              setReviewing(false);
              router.refresh();
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}

/** ConsentForm needs useSession()'s update() to refresh the JWT's consent
 *  claim, which requires a SessionProvider ancestor — this route lives
 *  outside the (dashboard) group (deliberately, so it stays self-contained
 *  while every other /api/* call is blocked), so it provides its own. */
export function ConsentRequiredClient(props: {
  activeForm: ConsentFormActiveVersion;
  priorDecision: "DECLINE" | null;
}) {
  return (
    <SessionProvider>
      <ConsentRequiredInner {...props} />
    </SessionProvider>
  );
}

function ConsentClaimSyncInner({ reason }: { reason: "no-form" | "already-agreed" }) {
  const { update, status } = useSession();
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    // update() no-ops while the session is still loading, so wait it out
    // rather than reading that no-op as a failure to refresh.
    if (status === "loading") return;
    let cancelled = false;
    // Leave only once the refreshed claim is one the proxy actually accepts.
    // Navigating optimistically is what loops: the proxy would bounce us
    // straight back here and we would try again forever. update({}) hands back
    // the very session it just wrote to the cookie, so this is a real check,
    // not a guess (and the argument matters — see ConsentForm). The navigation
    // is hard rather than router.push because the proxy only re-reads that
    // cookie on a fresh document request.
    update({})
      .then((session) => {
        if (cancelled) return;
        if (session && !isTeacherConsentBlocked(session.user?.consentDecision)) {
          window.location.replace("/teacher");
        } else {
          setStuck(true);
        }
      })
      .catch(() => {
        if (!cancelled) setStuck(true);
      });
    return () => {
      cancelled = true;
    };
  }, [update, status]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>
            {stuck ? "We couldn't refresh your session" : "Getting your dashboard ready…"}
          </CardTitle>
          <CardDescription className="pt-2 text-sm leading-relaxed">
            {stuck ? (
              <>
                Your instructor access is already cleared
                {reason === "no-form"
                  ? " (there is no research consent form published for instructors right now)"
                  : " (your agreement is on file)"}
                , but this browser session is still carrying an out-of-date copy of it. Signing out
                and back in will pick up the current one.
              </>
            ) : (
              <>One moment — we&apos;re bringing your session up to date.</>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 sm:flex-row">
          {stuck ? (
            <>
              <Button
                onClick={async () => {
                  await signOut({ redirect: false });
                  window.location.replace("/login");
                }}
              >
                Sign out and sign back in
              </Button>
              <Button variant="outline" onClick={() => window.location.replace("/teacher")}>
                Try my dashboard again
              </Button>
            </>
          ) : (
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Shown instead of a server redirect when this page has nothing to ask the
 * teacher (no published instructor form, or an AGREE already on record).
 * Re-stamps the session's consent claim once so src/proxy.ts stops bouncing
 * them here, then leaves for /teacher — and degrades to a plain "sign out and
 * back in" screen rather than looping if the claim still disagrees.
 */
export function ConsentClaimSync({ reason }: { reason: "no-form" | "already-agreed" }) {
  return (
    <SessionProvider>
      <ConsentClaimSyncInner reason={reason} />
    </SessionProvider>
  );
}
