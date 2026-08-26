import { XCircle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { MathText } from "@/components/ui/math-text";
import type { StudentMistakeView } from "@/lib/exam-results";

function NumericResponse({
  value,
  unit,
}: {
  value: number | null;
  unit: string | null;
}) {
  if (value === null) return <span>No answer</span>;
  return <MathText text={unit ? `${value} ${unit}` : String(value)} />;
}

export function StudentMistakesReview({
  mistakes,
}: {
  mistakes: StudentMistakeView[];
}) {
  if (mistakes.length === 0) return null;

  return (
    <section className="space-y-3" aria-labelledby="questions-to-review">
      <h2 id="questions-to-review" className="text-lg font-semibold">
        Questions to review
      </h2>
      <div className="grid gap-3 xl:grid-cols-2">
        {mistakes.map((mistake) => (
          <Card
            key={mistake.questionNumber}
            className="h-full border-destructive/35"
          >
            <CardContent className="space-y-3 p-4">
              {mistake.figureUrl && (
                // Short-lived presigned S3 URLs cannot use next/image without
                // remote-pattern configuration and may expire after rendering.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={mistake.figureUrl}
                  alt={mistake.figureAlt ?? "Question figure"}
                  loading="lazy"
                  className="mb-3 max-h-64 rounded-md border"
                />
              )}

              <div className="flex items-start gap-2">
                <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
                <p className="text-sm font-medium">
                  {mistake.questionNumber}. <MathText text={mistake.text} />
                </p>
              </div>

              <div className="ml-6 space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Your answer
                </p>
                {mistake.response.kind === "numeric" ? (
                  <div className="rounded bg-destructive/10 px-2 py-1 text-sm text-destructive">
                    <NumericResponse
                      value={mistake.response.value}
                      unit={mistake.response.unit}
                    />
                  </div>
                ) : mistake.response.choices.length === 0 ? (
                  <div className="rounded bg-destructive/10 px-2 py-1 text-sm text-destructive">
                    No answer
                  </div>
                ) : (
                  <div className="space-y-1">
                    {mistake.response.choices.map((choice, index) => (
                      <div
                        // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- key is content-composite and this list is read-only and never reordered
                        key={`${choice.text}-${choice.imageAlt ?? ""}-${index}`}
                        className="flex items-center gap-2 rounded bg-destructive/10 px-2 py-1 text-sm text-destructive"
                      >
                        {choice.imageUrl && (
                          // Short-lived presigned S3 URL; see the figure above.
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={choice.imageUrl}
                            alt={choice.imageAlt ?? "Submitted answer choice"}
                            loading="lazy"
                            className="max-h-28 rounded border bg-white"
                          />
                        )}
                        {choice.text && <MathText text={choice.text} />}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}
