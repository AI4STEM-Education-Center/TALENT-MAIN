"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const DEFAULT_KIND = "results";

/**
 * Filter form for the usage records page. The fields are controlled so Clear
 * can reset them: a plain link back to /admin/usage re-renders the server
 * page but leaves the uncontrolled inputs showing whatever was typed. The
 * page keys this component on the applied filters, so a navigation that
 * changes them (Apply, Clear, a student link) remounts it with fresh values.
 */
export function UsageFilters({
  kinds,
  kind,
  q,
  classId,
  studentId,
}: {
  kinds: Record<string, string>;
  kind: string;
  q: string;
  classId: string;
  studentId: string;
}) {
  const router = useRouter();
  const [kindValue, setKindValue] = useState(kind);
  const [query, setQuery] = useState(q);

  const clear = () => {
    setKindValue(DEFAULT_KIND);
    setQuery("");
    router.push("/admin/usage");
  };

  return (
    <form className="flex flex-wrap items-end gap-3" action="/admin/usage">
      <label className="grid gap-1 text-sm">
        Activity
        <select
          name="kind"
          value={kindValue}
          onChange={(event) => setKindValue(event.target.value)}
          className="h-9 rounded-md border bg-background px-3"
        >
          {Object.entries(kinds).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-sm">
        Student name or email
        <Input
          name="q"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search students…"
        />
      </label>
      <input type="hidden" name="classId" value={classId} />
      <input type="hidden" name="studentId" value={studentId} />
      <Button type="submit">Apply filters</Button>
      <Button type="button" variant="ghost" onClick={clear}>
        Clear
      </Button>
    </form>
  );
}
