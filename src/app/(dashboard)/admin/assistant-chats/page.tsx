"use client";

// Admin browser for stored chat transcripts. Deliberately exempt from the
// retention window the chat panel enforces on its own users: an admin reads hot
// and archived conversations alike, which is the whole reason the archive
// exists.

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  TranscriptDialog,
  TierBadge,
  type ListResponse,
} from "./transcript-dialog";

const ALL = "ALL";

const PAGE_SIZE = 25;

export default function AdminAssistantChatsPage() {
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const requestRef = useRef<AbortController | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [audience, setAudience] = useState(ALL);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState(""); // debounced copy of `search`
  const [userSearch, setUserSearch] = useState("");
  const [userQuery, setUserQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search.trim());
      setUserQuery(userSearch.trim());
    }, 300);
    return () => clearTimeout(timer);
  }, [search, userSearch]);

  const fetchConversations = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setError(null);
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(PAGE_SIZE),
      });
      if (audience !== ALL) params.set("audience", audience);
      if (query) params.set("q", query);
      if (userQuery) params.set("user", userQuery);
      const res = await fetch(`/api/admin/assistants/conversations?${params}`, {
        signal: controller.signal,
      });
      if (!res.ok) throw new Error("Could not load chat transcripts.");
      const next = await res.json();
      if (!controller.signal.aborted) setData(next);
    } catch (err) {
      if (!controller.signal.aborted)
        setError("Could not load chat transcripts. Please try again.");
    } finally {
      // react-doctor-disable-next-line react-doctor/no-loading-flag-reset-outside-finally -- reset is in finally; an aborted request must not clear its successor’s loading state
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [page, audience, query, userQuery]);

  useEffect(() => {
    void fetchConversations();
    return () => requestRef.current?.abort();
  }, [fetchConversations]);

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="p-8">
      <div className="mb-8 flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            Chat Transcripts
          </h1>
          <p className="mt-1 text-muted-foreground">
            Every student and teacher conversation with the AI assistants, kept
            indefinitely.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => void fetchConversations()}
          disabled={loading}
        >
          <RefreshCw className={cn("mr-2 size-4", loading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {error && (
        <p role="alert" className="mb-4 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="mb-4 flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search transcript text or title…"
            className="pl-9"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(0);
            }}
          />
        </div>
        <Input
          placeholder="Filter by user name or email…"
          className="w-full sm:w-64"
          value={userSearch}
          onChange={(event) => {
            setUserSearch(event.target.value);
            setPage(0);
          }}
        />
        <Select
          value={audience}
          onValueChange={(value) => {
            setAudience(value);
            setPage(0);
          }}
        >
          <SelectTrigger
            className="w-full sm:w-44"
            aria-label="Filter by assistant"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Both assistants</SelectItem>
            <SelectItem value="student">Student</SelectItem>
            <SelectItem value="teacher">Teacher</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {query && (
        <p className="mb-4 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Text search reads the messages of <strong>Live</strong> conversations
          and the titles of all of them. Archived transcripts are stored as
          files, so their message bodies are not searchable — open one to read
          it.
        </p>
      )}

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-border bg-muted/50 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="whitespace-nowrap px-4 py-3 font-medium">
                Last message
              </th>
              <th className="px-4 py-3 font-medium">User</th>
              <th className="px-4 py-3 font-medium">Assistant</th>
              <th className="w-full px-4 py-3 font-medium">Opening message</th>
              <th className="whitespace-nowrap px-4 py-3 font-medium">Turns</th>
              <th className="px-4 py-3 font-medium">Storage</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {loading && !data ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-6 py-8 text-center text-muted-foreground"
                >
                  Loading transcripts…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-6 py-8 text-center text-muted-foreground"
                >
                  {total === 0 && !query && !userQuery && audience === ALL
                    ? "No conversations yet. They appear here as students and teachers use the assistants."
                    : "No conversations match the current filters."}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr
                  key={row.id}
                  className="transition-colors hover:bg-accent/50"
                >
                  <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                    {new Date(row.lastMessageAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-3">
                    <span className="block">{row.userName}</span>
                    <span className="block text-xs text-muted-foreground">
                      {row.userEmail}
                    </span>
                  </td>
                  <td className="px-4 py-3 capitalize">{row.audience}</td>
                  <td className="max-w-0 px-4 py-3">
                    <button
                      type="button"
                      className="block max-w-full truncate text-left hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                      onClick={() => setOpenId(row.id)}
                      aria-label={`Open transcript: ${row.title}`}
                    >
                      {row.title}
                    </button>
                  </td>
                  <td className="px-4 py-3 tabular-nums">{row.messageCount}</td>
                  <td className="px-4 py-3">
                    <TierBadge archived={row.archived} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
        <span>
          {total > 0
            ? `Showing ${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, total)} of ${total}`
            : "0 conversations"}
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page <= 0 || loading}
          >
            <ChevronLeft className="mr-1 size-4" /> Previous
          </Button>
          <span>
            Page {page + 1} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1 || loading}
          >
            Next <ChevronRight className="ml-1 size-4" />
          </Button>
        </div>
      </div>

      {openId && (
        <TranscriptDialog
          key={openId}
          conversationId={openId}
          onClose={() => setOpenId(null)}
        />
      )}
    </div>
  );
}
