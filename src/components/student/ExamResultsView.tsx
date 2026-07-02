"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowLeft, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ScoreBanner } from "@/components/student/QuizReviewResult";
import { HolisticRecommendations } from "@/components/student/HolisticRecommendations";
import { MisconceptionsToReview } from "@/components/student/MisconceptionsToReview";
import {
  RESULT_STATUS,
  type ResultStatus,
  type PresignedRecommendation,
  type StoredMisconception,
} from "@/lib/exam-results";

const POLL_MS = 2500;
const MARKDOWN_CLASS =
  "text-sm [&_p]:mb-2 [&_p:last-child]:mb-0 [&_h3]:mb-1 [&_h3]:mt-3 [&_h3]:font-semibold [&_ul]:mb-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:mb-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:mb-1 [&_strong]:font-semibold";

type AiState = {
  summary: string | null;
  summaryStatus: ResultStatus;
  recommendations: PresignedRecommendation[];
  recommendationsStatus: ResultStatus;
  truncated: boolean;
  misconceptions: StoredMisconception[];
};

const isPending = (status: ResultStatus) =>
  status === RESULT_STATUS.PENDING || status === RESULT_STATUS.GENERATING;

/** The AI summary body — rendered inside the unified results card (no border). */
function SummaryBody({ ai }: { ai: AiState }) {
  return (
    <div className="space-y-2">
      <h2 className="flex items-center gap-1.5 text-base font-semibold">
        <Sparkles className="size-5 text-primary" /> Summary &amp; next steps
      </h2>
      {ai.summaryStatus === RESULT_STATUS.READY && ai.summary ? (
        <div className={MARKDOWN_CLASS}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{ai.summary}</ReactMarkdown>
        </div>
      ) : ai.summaryStatus === RESULT_STATUS.FAILED ? (
        <p className="text-sm text-muted-foreground">
          We couldn&apos;t generate a summary for this attempt.
        </p>
      ) : (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin text-primary" /> Generating your summary…
        </div>
      )}
    </div>
  );
}

export function ExamResultsView({
  attemptId,
  score,
  initial,
  backHref,
  backLabel = "Back",
  actions,
}: {
  attemptId: string;
  score: number;
  initial: AiState;
  backHref?: string;
  backLabel?: string;
  actions?: ReactNode;
}) {
  const [ai, setAi] = useState<AiState>(initial);
  const needPoll = isPending(ai.summaryStatus) || isPending(ai.recommendationsStatus);
  // Strict-Mode double-mount guard so we don't run two polling loops.
  const pollingRef = useRef(false);

  useEffect(() => {
    if (!needPoll || pollingRef.current) return;
    pollingRef.current = true;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const res = await fetch(`/api/student/attempts/${attemptId}/results`);
        if (!active) return;
        if (res.ok) {
          const data = await res.json();
          setAi({
            summary: data.summary ?? null,
            summaryStatus: data.summaryStatus,
            recommendations: Array.isArray(data.recommendations) ? data.recommendations : [],
            recommendationsStatus: data.recommendationsStatus,
            truncated: data.truncated === true,
            misconceptions: Array.isArray(data.misconceptions) ? data.misconceptions : [],
          });
          if (!isPending(data.summaryStatus) && !isPending(data.recommendationsStatus)) {
            return; // both terminal — stop polling
          }
        }
      } catch {
        // transient — retry below
      }
      if (active) timer = setTimeout(poll, POLL_MS);
    };

    timer = setTimeout(poll, POLL_MS);
    return () => {
      active = false;
      pollingRef.current = false;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attemptId, needPoll]);

  return (
    <div className="p-4 md:p-6 max-w-6xl space-y-6">
      {backHref && (
        <Button variant="ghost" size="sm" asChild>
          <Link href={backHref}>
            <ArrowLeft className="size-4" /> {backLabel}
          </Link>
        </Button>
      )}

      {/* Unified header: the score banner (percentage only — no per-question
          count) and the AI summary live in one full-width card. */}
      <Card>
        <CardContent className="space-y-4 py-5">
          <ScoreBanner score={score} />
          <div className="border-t" />
          <SummaryBody ai={ai} />
        </CardContent>
      </Card>

      {/* Holistic study recommendations — up to 3 cards chosen across the whole
          attempt, with NO per-question correctness or correct answers shown. */}
      <HolisticRecommendations
        recommendations={ai.recommendations}
        status={ai.recommendationsStatus}
      />

      {/* Statements only — no per-question linkage, so it never breaks the
          blind-results contract. Renders nothing when there are no labels. */}
      <MisconceptionsToReview misconceptions={ai.misconceptions} />

      {actions && <div className="flex flex-wrap gap-3">{actions}</div>}
    </div>
  );
}
