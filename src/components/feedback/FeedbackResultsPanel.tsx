"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  MessageSquareQuote,
  RefreshCw,
  Search,
  Star,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAlert } from "@/components/ui/confirm-dialog";
import { StatTile } from "@/components/viz/StatTile";
import { DistributionChart } from "@/components/viz/DistributionChart";
import { sequentialColor } from "@/components/viz/palette";
import { formatDateTime } from "@/lib/format-date";
import { cn } from "@/lib/utils";
import {
  FEEDBACK_AUDIENCES,
  FEEDBACK_AUDIENCE_LABELS,
  FEEDBACK_RATING_LABELS,
  FEEDBACK_RATING_MAX,
  FEEDBACK_RATING_SCALE,
  FEEDBACK_SUBJECT_TYPES,
  FEEDBACK_SUBJECT_TYPE_LABELS,
  formatAverageRating,
  type FeedbackSummary,
} from "@/lib/content-feedback";

const ALL = "ALL";

type FeedbackRow = {
  id: string;
  createdAt: string;
  updatedAt: string;
  audience: string;
  subjectType: string;
  subjectId: string | null;
  subjectLabel: string;
  subjectDetail: string | null;
  rating: number;
  comment: string;
  authorName: string | null;
  authorRole: string;
  className: string | null;
  quizName: string | null;
  attemptId: string | null;
};

type SubjectRow = FeedbackSummary & {
  subjectType: string;
  subjectLabel: string;
  subjectId: string | null;
};

type SummaryResponse = {
  viewerRole: "TEACHER" | "ADMIN";
  page: number;
  pageSize: number;
  total: number;
  feedback: FeedbackRow[];
  overall: FeedbackSummary;
  bySubject: SubjectRow[];
  byAudience: Record<"STUDENT" | "TEACHER", FeedbackSummary>;
  aggregateTruncated: boolean;
  classes: { id: string; name: string }[];
};

const typeLabel = (value: string) =>
  FEEDBACK_SUBJECT_TYPE_LABELS[
    value as keyof typeof FEEDBACK_SUBJECT_TYPE_LABELS
  ] ?? value;

const audienceLabel = (value: string) =>
  FEEDBACK_AUDIENCE_LABELS[value as keyof typeof FEEDBACK_AUDIENCE_LABELS] ??
  value;

/**
 * The consolidated feedback results panel, shared by the teacher and admin
 * dashboards.
 *
 * The same component serves both because the difference is scope, not shape,
 * and scope is decided by the API from the session (a teacher gets the
 * verdicts routed to them — their classes' students plus their own — and an
 * admin gets everything). Keeping one component means the two roles can never
 * drift into reading the same numbers differently.
 *
 * Order of the page follows the question being asked: how much feedback is
 * there and how good is it (tiles), what shape is it (histogram), WHICH
 * recommendations are missing (per-subject, worst first), and finally the
 * individual explanations — because the written sentence is the only part
 * anyone can actually act on.
 */
/**
 * Everything stateful behind the panel: the filters, the paged read, and the
 * CSV download. Split out from the view so the component below is layout only
 * — and, more importantly, so `filterParams` is built in exactly ONE place.
 * The table and the export share it, which is what guarantees the file a
 * teacher downloads matches the rows they were looking at.
 */
function useFeedbackResults() {
  const alert = useAlert();
  const [data, setData] = useState<SummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<"detail" | "summary" | null>(null);

  const [audience, setAudience] = useState<string>(ALL);
  const [subjectType, setSubjectType] = useState<string>(ALL);
  const [rating, setRating] = useState<string>(ALL);
  const [classId, setClassId] = useState<string>(ALL);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);

  // Debounced: typing must not fire a query (and a page reset) per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const filterParams = useMemo(() => {
    const params = new URLSearchParams();
    if (audience !== ALL) params.set("audience", audience);
    if (subjectType !== ALL) params.set("subjectType", subjectType);
    if (rating !== ALL) params.set("rating", rating);
    if (classId !== ALL) params.set("classId", classId);
    if (query) params.set("q", query);
    return params;
  }, [audience, subjectType, rating, classId, query]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams(filterParams);
      params.set("page", String(page));
      const res = await fetch(`/api/feedback/summary?${params}`);
      if (!res.ok) throw new Error("Failed to load feedback");
      setData(await res.json());
    } catch {
      setError("Could not load feedback results.");
    } finally {
      setLoading(false);
    }
  }, [filterParams, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const exportCsv = useCallback(
    async (view: "detail" | "summary") => {
      setExporting(view);
      try {
        const params = new URLSearchParams(filterParams);
        params.set("view", view);
        const res = await fetch(`/api/feedback/export?${params}`);
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          await alert({
            title: "Couldn't export feedback",
            description: body?.error || "Failed to generate the CSV.",
          });
          return;
        }
        // Trust the server's filename (it carries the date and the view) and
        // fall back only if the header is missing.
        const filename =
          res.headers
            .get("Content-Disposition")
            ?.match(/filename="([^"]+)"/)?.[1] ?? "feedback.csv";
        const url = URL.createObjectURL(await res.blob());
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = filename;
        anchor.click();
        URL.revokeObjectURL(url);
      } catch {
        await alert({
          title: "Couldn't export feedback",
          description: "Something went wrong while downloading the CSV.",
        });
      } finally {
        setExporting(null);
      }
    },
    [alert, filterParams],
  );

  return {
    data,
    loading,
    error,
    exporting,
    page,
    setPage,
    load,
    exportCsv,
    /** True when no filter is active, so "nothing here" can say which it is. */
    unfiltered: filterParams.size === 0,
    filters: {
      search,
      onSearchChange: setSearch,
      audience,
      onAudienceChange: setAudience,
      subjectType,
      onSubjectTypeChange: setSubjectType,
      rating,
      onRatingChange: setRating,
      classId,
      onClassIdChange: setClassId,
      classes: data?.classes ?? [],
      onAnyChange: () => setPage(1),
    },
  };
}

export function FeedbackResultsPanel() {
  const {
    data,
    loading,
    error,
    exporting,
    page,
    setPage,
    load,
    exportCsv,
    unfiltered,
    filters,
  } = useFeedbackResults();

  const total = data?.total ?? 0;
  const pageSize = data?.pageSize ?? 25;
  const overall = data?.overall;

  return (
    <div className="space-y-6">
      <PanelHeader
        loading={loading}
        exporting={exporting}
        canExport={total > 0}
        onRefresh={load}
        onExport={exportCsv}
      />

      <SummaryTiles data={data} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <div className="surface-card p-[var(--pad-card)]">
          {overall && overall.count > 0 ? (
            <DistributionChart
              buckets={ratingHistogram(overall)}
              title="Ratings by point on the scale"
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              No ratings yet, so there is no distribution to show.
            </p>
          )}
        </div>

        <SubjectBreakdown rows={data?.bySubject ?? []} />
      </div>

      <FilterBar {...filters} />

      {error && <p className="text-sm text-destructive">{error}</p>}

      <FeedbackList
        rows={data?.feedback ?? []}
        loading={loading && !data}
        unfiltered={unfiltered}
      />

      <Pagination
        page={page}
        pageSize={pageSize}
        total={total}
        loading={loading}
        onPageChange={setPage}
      />
    </div>
  );
}

/** The 1-5 histogram as DistributionChart buckets (one bucket per point). */
function ratingHistogram(overall: FeedbackSummary) {
  return FEEDBACK_RATING_SCALE.map((point) => ({
    label: `${point}`,
    min: point,
    max: point,
    count: overall.distribution[point] ?? 0,
  }));
}

function FeedbackList({
  rows,
  loading,
  unfiltered,
}: {
  rows: FeedbackRow[];
  loading: boolean;
  unfiltered: boolean;
}) {
  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading feedback…</p>;
  }
  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">
        {unfiltered
          ? "No feedback yet. Ratings appear here as students rate their post-quiz recommendations and teachers rate those recommendations and their generated simulations."
          : "No feedback matches the current filters."}
      </div>
    );
  }
  return (
    <ul className="space-y-3">
      {rows.map((row) => (
        <FeedbackListItem key={row.id} row={row} />
      ))}
    </ul>
  );
}

function Pagination({
  page,
  pageSize,
  total,
  loading,
  onPageChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  loading: boolean;
  onPageChange: (next: (current: number) => number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="flex items-center justify-between text-sm text-muted-foreground">
      <span>
        {total > 0
          ? `Showing ${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total}`
          : "0 entries"}
      </span>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPageChange((p) => Math.max(1, p - 1))}
          disabled={page <= 1 || loading}
        >
          <ChevronLeft className="size-4" /> Previous
        </Button>
        <span>
          Page {page} of {totalPages}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPageChange((p) => Math.min(totalPages, p + 1))}
          disabled={page >= totalPages || loading}
        >
          Next <ChevronRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}

/** Title, refresh, and the two CSV downloads. */
function PanelHeader({
  loading,
  exporting,
  canExport,
  onRefresh,
  onExport,
}: {
  loading: boolean;
  exporting: "detail" | "summary" | null;
  canExport: boolean;
  onRefresh: () => void;
  onExport: (view: "detail" | "summary") => void;
}) {
  return (
    <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Feedback</h1>
        <p className="mt-1 text-muted-foreground">
          How useful students found the materials and simulations recommended
          after their quizzes, and what teachers made of the same
          recommendations and of the simulations generated for them.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={onRefresh} disabled={loading}>
          <RefreshCw className={cn("size-4", loading && "animate-spin")} />
          Refresh
        </Button>
        <Button
          variant="outline"
          onClick={() => onExport("summary")}
          disabled={exporting !== null || !canExport}
        >
          {exporting === "summary" ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Download className="size-4" />
          )}
          Export summary
        </Button>
        <Button
          onClick={() => onExport("detail")}
          disabled={exporting !== null || !canExport}
        >
          {exporting === "detail" ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Download className="size-4" />
          )}
          Export CSV
        </Button>
      </div>
    </div>
  );
}

/**
 * The KPI row. The two audience tiles sit beside the overall mean because the
 * consolidated average is the least useful of the three on its own: students
 * rating recommendations and teachers rating generated simulations are
 * answering different questions, and a drop in one must not hide behind the
 * other.
 */
function SummaryTiles({ data }: { data: SummaryResponse | null }) {
  const overall = data?.overall;
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatTile
        label="Average rating"
        value={formatAverageRating(overall?.average ?? null)}
        sub={`out of ${FEEDBACK_RATING_MAX}`}
      />
      <StatTile
        label="Ratings received"
        value={String(overall?.count ?? 0)}
        sub={
          data?.aggregateTruncated
            ? "Newest 5,000 rows summarized"
            : "All matching feedback"
        }
      />
      <StatTile
        label="From students"
        value={formatAverageRating(data?.byAudience.STUDENT.average ?? null)}
        sub={`${data?.byAudience.STUDENT.count ?? 0} on recommendations`}
      />
      <StatTile
        label="From teachers"
        value={formatAverageRating(data?.byAudience.TEACHER.average ?? null)}
        sub={`${data?.byAudience.TEACHER.count ?? 0} on recommendations & simulations`}
      />
    </div>
  );
}

/** Search + the four scoping dropdowns. The class filter appears only once
 *  some feedback actually carries a class, so it never offers an empty list. */
function FilterBar({
  search,
  onSearchChange,
  audience,
  onAudienceChange,
  subjectType,
  onSubjectTypeChange,
  rating,
  onRatingChange,
  classId,
  onClassIdChange,
  classes,
  onAnyChange,
}: {
  search: string;
  onSearchChange: (value: string) => void;
  audience: string;
  onAudienceChange: (value: string) => void;
  subjectType: string;
  onSubjectTypeChange: (value: string) => void;
  rating: string;
  onRatingChange: (value: string) => void;
  classId: string;
  onClassIdChange: (value: string) => void;
  classes: { id: string; name: string }[];
  onAnyChange: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 lg:flex-row">
      <div className="relative flex-1">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search explanations, subjects, people, quizzes…"
          className="pl-9"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
        />
      </div>
      <FilterSelect
        label="Filter by source"
        value={audience}
        onChange={onAudienceChange}
        allLabel="All sources"
        options={FEEDBACK_AUDIENCES.map((value) => ({
          value,
          label: `${FEEDBACK_AUDIENCE_LABELS[value]} feedback`,
        }))}
        onAnyChange={onAnyChange}
      />
      <FilterSelect
        label="Filter by content"
        value={subjectType}
        onChange={onSubjectTypeChange}
        allLabel="All content"
        options={FEEDBACK_SUBJECT_TYPES.map((value) => ({
          value,
          label: FEEDBACK_SUBJECT_TYPE_LABELS[value],
        }))}
        onAnyChange={onAnyChange}
      />
      <FilterSelect
        label="Filter by rating"
        value={rating}
        onChange={onRatingChange}
        allLabel="All ratings"
        options={FEEDBACK_RATING_SCALE.map((point) => ({
          value: String(point),
          label: `${point} — ${FEEDBACK_RATING_LABELS[point]}`,
        }))}
        onAnyChange={onAnyChange}
      />
      {classes.length > 0 && (
        <FilterSelect
          label="Filter by class"
          value={classId}
          onChange={onClassIdChange}
          allLabel="All classes"
          options={classes.map((cls) => ({ value: cls.id, label: cls.name }))}
          onAnyChange={onAnyChange}
        />
      )}
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  allLabel,
  options,
  onAnyChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  allLabel: string;
  options: { value: string; label: string }[];
  onAnyChange: () => void;
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        onChange(next);
        onAnyChange();
      }}
    >
      <SelectTrigger className="w-full lg:w-48" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{allLabel}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Per-subject means, worst first — the table that answers "which
 * recommendations are not landing".
 *
 * The mean gets a 5-segment share strip beside it because a mean alone hides
 * the shape that matters most here: a subject split between 1s and 5s (it
 * works for some students and not others) and one where everybody said 3 both
 * average 3, and they call for completely different responses.
 */
function SubjectBreakdown({ rows }: { rows: SubjectRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="surface-card p-[var(--pad-card)] text-sm text-muted-foreground">
        Once feedback arrives, each rated material and simulation is listed here
        with its average — lowest first.
      </div>
    );
  }

  return (
    <div className="surface-card viz-root overflow-hidden p-[var(--pad-card)]">
      <p className="mb-3 text-sm font-medium">
        Lowest-rated content{" "}
        <span className="font-normal text-muted-foreground">
          · {rows.length} rated
        </span>
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="py-1.5 font-medium">Content</th>
              <th className="py-1.5 text-right font-medium">Ratings</th>
              <th className="py-1.5 text-right font-medium">Average</th>
              <th className="py-1.5 pl-3 font-medium">Spread (1→5)</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 12).map((row) => (
              <tr
                key={`${row.subjectType}:${row.subjectId ?? row.subjectLabel}`}
                className="border-b border-border/50"
              >
                <td className="max-w-64 py-2">
                  <span className="block truncate font-medium">
                    {row.subjectLabel}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {typeLabel(row.subjectType)}
                  </span>
                </td>
                <td className="py-2 text-right tabular-nums">{row.count}</td>
                <td className="py-2 text-right font-medium tabular-nums">
                  {formatAverageRating(row.average)}
                </td>
                <td className="w-40 py-2 pl-3">
                  <SpreadStrip
                    distribution={row.distribution}
                    count={row.count}
                    label={row.subjectLabel}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Spread runs 1 (lightest) to 5 (darkest); the widest band is where most
        ratings fell.
      </p>
    </div>
  );
}

function SpreadStrip({
  distribution,
  count,
  label,
}: {
  distribution: Record<number, number>;
  count: number;
  label: string;
}) {
  if (count === 0) return null;
  return (
    <span
      className="flex h-2.5 w-full overflow-hidden"
      style={{ borderRadius: "var(--viz-bar-radius, 2px)" }}
      // The row already carries the count and the mean as text; the numbers
      // behind each band are in the CSV export, so this is a second encoding
      // rather than information only available here.
      aria-label={`Rating spread for ${label}: ${FEEDBACK_RATING_SCALE.map(
        (point) => `${distribution[point] ?? 0} rated ${point}`,
      ).join(", ")}`}
      role="img"
    >
      {FEEDBACK_RATING_SCALE.map((point) => {
        const share = (distribution[point] ?? 0) / count;
        if (share === 0) return null;
        return (
          <span
            key={point}
            style={{
              width: `${share * 100}%`,
              // Ordinal ramp: 1 is the lightest visible step, 5 the darkest.
              background: sequentialColor(
                (point - 1) / (FEEDBACK_RATING_MAX - 1),
                true,
              ),
            }}
          />
        );
      })}
    </span>
  );
}

function FeedbackListItem({ row }: { row: FeedbackRow }) {
  return (
    <li className="rounded-xl border bg-card p-4 text-sm shadow-xs">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1 font-medium text-foreground">
          <Star className="size-3.5 fill-primary text-primary" />
          {row.rating}/{FEEDBACK_RATING_MAX}
        </span>
        <span>{FEEDBACK_RATING_LABELS[row.rating]}</span>
        <span>·</span>
        <span>{audienceLabel(row.audience)} feedback</span>
        <span>·</span>
        <span>{formatDateTime(row.createdAt)}</span>
      </div>

      <p className="mt-2 font-medium">
        {row.subjectLabel}
        {row.subjectDetail && (
          <span className="ml-1 font-normal text-muted-foreground">
            · {row.subjectDetail}
          </span>
        )}
      </p>

      <p className="mt-1.5 flex items-start gap-1.5 whitespace-pre-wrap">
        <MessageSquareQuote
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        {row.comment}
      </p>

      <p className="mt-2 text-xs text-muted-foreground">
        {typeLabel(row.subjectType)}
        {" · "}
        {row.authorName || "Deleted account"} ({row.authorRole.toLowerCase()})
        {row.className && ` · ${row.className}`}
        {row.quizName && ` · ${row.quizName}`}
      </p>
    </li>
  );
}
