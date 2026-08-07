"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { signOut, SessionProvider } from "next-auth/react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ConsentForm, type ConsentFormActiveVersion } from "@/components/consent/ConsentForm";

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
                router.push("/teacher");
              } else {
                setReviewing(false);
              }
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
