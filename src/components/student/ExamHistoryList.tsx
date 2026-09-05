import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ChevronRight, Trophy } from "lucide-react";

const PASS_THRESHOLD = 60;

export type ExamHistoryItem = {
  attemptId: string;
  className: string;
  topicName: string;
  quizName: string;
  score: number;
  /** ISO string — formatted on the client to avoid SSR/runtime mismatch. */
  completedAt: string;
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Responsive list of past exam attempts. Each row links back to the same
 * results page. When `showClass` is set (global history), the class name is
 * shown so the student knows which class an exam belongs to.
 */
export function ExamHistoryList({
  items,
  showClass = true,
}: {
  items: ExamHistoryItem[];
  showClass?: boolean;
}) {
  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center py-12 text-center">
          <Trophy className="size-12 text-muted-foreground mb-3" />
          <p className="text-lg font-medium">No exams yet</p>
          <p className="text-muted-foreground text-sm mt-1">
            Your completed quizzes will show up here.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-2">
      {items.map((item) => {
        const pct = Math.round(item.score);
        const passed = pct >= PASS_THRESHOLD;
        return (
          <Link
            key={item.attemptId}
            href={`/student/results/${item.attemptId}`}
            className="block"
          >
            <Card className="transition-colors hover:bg-muted/30">
              <CardContent className="flex items-center justify-between gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-sm truncate">
                    {item.quizName}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">
                    {showClass && (
                      <>
                        <span className="font-medium text-foreground/70">
                          {item.className}
                        </span>
                        {" · "}
                      </>
                    )}
                    {/* topicName can be empty — quizzes may be ungrouped */}
                    {item.topicName && <>{item.topicName} · </>}
                    {item.completedAt && formatDate(item.completedAt)}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Badge variant={passed ? "success" : "destructive"}>
                    {pct}%
                  </Badge>
                  <ChevronRight className="size-4 text-muted-foreground" />
                </div>
              </CardContent>
            </Card>
          </Link>
        );
      })}
    </div>
  );
}
