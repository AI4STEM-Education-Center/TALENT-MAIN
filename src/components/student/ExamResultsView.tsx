"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowLeft, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ScoreSummaryCard, QuizReviewList } from "@/components/student/QuizReviewResult";
import {
  RESULT_STATUS,
  type ResultStatus,
  type SnapshotQuestion,
  type PresignedRecommendation,
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
};

const isPending = (status: ResultStatus) =>
  status === RESULT_STATUS.PENDING || status === RESULT_STATUS.GENERATING;

function LoadingCard({ label }: { label: string }) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 py-6 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin text-primary" />
        {label}
      </CardContent>
    </Card>
  );
}

function SummarySection({ ai }: { ai: AiState }) {
  if (ai.summaryStatus === RESULT_STATUS.READY && ai.summary) {
    return (
      <div className="space-y-2">
        <h2 className="flex items-center gap-1.5 text-lg font-semibold">
          <Sparkles className="size-5 text-primary" /> Summary &amp; next steps
        </h2>
        <Card>
          <CardContent className={`py-4 ${MARKDOWN_CLASS}`}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{ai.summary}</ReactMarkdown>
          </CardContent>
        </Card>
      </div>
    );
  }
  if (ai.summaryStatus === RESULT_STATUS.FAILED) {
    return (
      <Card>
        <CardContent className="py-4 text-sm text-muted-foreground">
          We couldn&apos;t generate a summary for this attempt.
        </CardContent>
      </Card>
    );
  }
  return <LoadingCard label="Generating your summary…" />;
}

export function ExamResultsView({
  attemptId,
  score,
  correct,
  total,
  questions,
  initial,
  backHref,
  backLabel = "Back",
  actions,
}: {
  attemptId: string;
  score: number;
  correct: number;
  total: number;
  questions: SnapshotQuestion[];
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
    <div className="p-4 md:p-6 max-w-5xl space-y-6">
      {backHref && (
        <Button variant="ghost" size="sm" asChild>
          <Link href={backHref}>
            <ArrowLeft className="size-4" /> {backLabel}
          </Link>
        </Button>
      )}

      {/* Score and AI summary sit side by side on wide screens, stacking on
          smaller ones (score first). */}
      <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
        <ScoreSummaryCard score={score} correct={correct} total={total} />
        <SummarySection ai={ai} />
      </div>

      {/* Review: each incorrect question is paired with its recommended
          materials card; the page images inside scroll. */}
      <QuizReviewList
        questions={questions}
        recommendations={ai.recommendations}
        recommendationsStatus={ai.recommendationsStatus}
        truncated={ai.truncated}
      />

      {actions && <div className="flex flex-wrap gap-3">{actions}</div>}
    </div>
  );
}
