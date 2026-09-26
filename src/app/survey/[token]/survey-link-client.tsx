"use client";

import { useEffect, useState } from "react";
import { Loader2, CheckCircle2 } from "lucide-react";
import {
  SurveyFormView,
  type SurveyFormData,
} from "@/components/survey/SurveyFormView";

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "done" }
  | { status: "ready"; name: string; form: SurveyFormData };

export function SurveyLinkClient({ token }: { token: string }) {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/surveys/invite/${encodeURIComponent(token)}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (controller.signal.aborted) return;
        if (!res.ok) {
          setState({
            status: "error",
            message: data?.error ?? "This survey link could not be opened.",
          });
        } else if (data.submitted || !data.form) {
          setState({ status: "done" });
        } else {
          setState({ status: "ready", name: data.name, form: data.form });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setState({
            status: "error",
            message:
              "Could not reach the server. Check your connection and reload.",
          });
      });
    return () => controller.abort();
  }, [token]);

  if (state.status === "loading")
    return (
      <div className="flex justify-center py-12 text-muted-foreground">
        <Loader2 className="mr-2 size-5 animate-spin" /> Loading survey…
      </div>
    );
  if (state.status === "error")
    return <p className="py-8 text-center text-sm">{state.message}</p>;
  if (state.status === "done")
    return (
      <div className="flex flex-col items-center gap-3 py-10 text-center">
        <CheckCircle2 className="size-10 text-primary" />
        <h1 className="text-xl font-semibold">Thank you!</h1>
        <p className="text-sm text-muted-foreground">
          Your response has been recorded. You can close this page.
        </p>
      </div>
    );

  return (
    <div className="space-y-4">
      {state.name && (
        <p className="text-sm text-muted-foreground">Hi {state.name},</p>
      )}
      <SurveyFormView
        form={state.form}
        onSubmit={async (answers) => {
          const res = await fetch(
            `/api/surveys/invite/${encodeURIComponent(token)}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ answers }),
            },
          );
          const data = await res.json().catch(() => null);
          if (!res.ok)
            return {
              ok: false,
              error: data?.error ?? "Could not submit the survey.",
              questionId: data?.questionId,
            };
          setState({ status: "done" });
          return { ok: true };
        }}
      />
    </div>
  );
}
