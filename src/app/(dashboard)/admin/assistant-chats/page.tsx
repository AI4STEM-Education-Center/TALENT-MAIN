"use client";

// Admin browser for stored chat transcripts. Deliberately exempt from the
// retention window the chat panel enforces on its own users: an admin reads hot
// and archived conversations alike, which is the whole reason the archive
// exists.

import { useCallback, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Archive,
  ChevronLeft,
  ChevronRight,
  Database,
  Paperclip,
  RefreshCw,
  Search,
  X,
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
import { cn } from "@/lib/utils";
import type { AssistantTurn } from "@/lib/assistant/types";

const ALL = "ALL";

const MARKDOWN_CLASS =
  "text-sm [&_p]:mb-2 [&_p:last-child]:mb-0 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:font-semibold [&_ul]:mb-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:mb-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:mb-1 [&_strong]:font-semibold [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-xs [&_table]:w-full [&_table]:text-xs [&_th]:border-b [&_th]:border-border [&_th]:px-1 [&_th]:py-1 [&_th]:text-left [&_td]:border-b [&_td]:border-border/50 [&_td]:px-1 [&_td]:py-1";

type ConversationRow = {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  audience: string;
  title: string;
  messageCount: number;
  createdAt: string;
  lastMessageAt: string;
  archived: boolean;
};

type ListResponse = {
  rows: ConversationRow[];
  total: number;
};

type TranscriptResponse = ConversationRow & {
  turns: AssistantTurn[];
  transcriptUnavailable: boolean;
};

const PAGE_SIZE = 25;

function TierBadge({ archived }: { archived: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        archived
          ? "bg-muted text-muted-foreground"
          : "bg-blue-500/10 text-blue-600 dark:text-blue-400"
      )}
      title={
        archived
          ? "Archived: the transcript lives in object storage"
          : "Live: the transcript is still in the database and is full-text searchable"
      }
    >
      {archived ? <Archive className="size-3" /> : <Database className="size-3" />}
      {archived ? "Archived" : "Live"}
    </span>
  );
}

function TranscriptDialog({
  conversationId,
  onClose,
}: {
  conversationId: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<TranscriptResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/admin/assistants/conversations/${conversationId}`);
        if (!res.ok) {
          if (!cancelled) setFailed(true);
          return;
        }
        const body = (await res.json()) as TranscriptResponse;
        if (!cancelled) setData(body);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Chat transcript"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-start gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold">{data?.title ?? "Transcript"}</p>
            {data && (
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {data.userName} · {data.userEmail} · {data.audience} assistant ·{" "}
                {new Date(data.createdAt).toLocaleString()}
              </p>
            )}
          </div>
          {data && <TierBadge archived={data.archived} />}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close transcript"
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
          {failed && (
            <p className="text-sm text-destructive">This transcript could not be loaded.</p>
          )}
          {!failed && !data && <p className="text-sm text-muted-foreground">Loading…</p>}
          {data?.transcriptUnavailable && (
            <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
              The conversation record exists, but its archived transcript could not be read
              from object storage. This is a storage problem, not an empty conversation.
            </p>
          )}
          {data?.turns.map((turn, index) => (
            <div
              key={index}
              className={cn("flex", turn.role === "user" ? "justify-end" : "justify-start")}
            >
              <div
                className={cn(
                  "max-w-[85%] rounded-lg px-3 py-2",
                  turn.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-foreground"
                )}
              >
                {turn.role === "user" ? (
                  <p className="whitespace-pre-wrap text-sm">{turn.content}</p>
                ) : (
                  <div className={MARKDOWN_CLASS}>
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{turn.content}</ReactMarkdown>
                  </div>
                )}
                {turn.attachmentNames && turn.attachmentNames.length > 0 && (
                  <p className="mt-1 text-xs opacity-80">
                    <Paperclip className="mr-1 inline size-3" />
                    {turn.attachmentNames.join(", ")}
                  </p>
                )}
              </div>
            </div>
          ))}
          {data && !data.transcriptUnavailable && data.turns.length === 0 && (
            <p className="text-sm text-muted-foreground">This conversation has no turns.</p>
          )}
        </div>
      </div>
    </div>
  );
}

export default function AdminAssistantChatsPage() {
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
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
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(PAGE_SIZE),
      });
      if (audience !== ALL) params.set("audience", audience);
      if (query) params.set("q", query);
      if (userQuery) params.set("user", userQuery);
      const res = await fetch(`/api/admin/assistants/conversations?${params}`);
      if (res.ok) setData(await res.json());
    } catch (err) {
      console.error("Failed to fetch chat transcripts", err);
    } finally {
      setLoading(false);
    }
  }, [page, audience, query, userQuery]);

  useEffect(() => {
    void fetchConversations();
  }, [fetchConversations]);

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="p-8">
      <div className="mb-8 flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Chat Transcripts</h1>
          <p className="mt-1 text-muted-foreground">
            Every student and teacher conversation with the AI assistants, kept indefinitely.
          </p>
        </div>
        <Button variant="outline" onClick={() => void fetchConversations()} disabled={loading}>
          <RefreshCw className={cn("mr-2 size-4", loading && "animate-spin")} />
          Refresh
        </Button>
      </div>

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
          <SelectTrigger className="w-full sm:w-44" aria-label="Filter by assistant">
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
          Text search reads the messages of <strong>Live</strong> conversations and the titles
          of all of them. Archived transcripts are stored as files, so their message bodies are
          not searchable — open one to read it.
        </p>
      )}

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-border bg-muted/50 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="whitespace-nowrap px-4 py-3 font-medium">Last message</th>
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
                <td colSpan={6} className="px-6 py-8 text-center text-muted-foreground">
                  Loading transcripts…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-6 py-8 text-center text-muted-foreground">
                  {total === 0 && !query && !userQuery && audience === ALL
                    ? "No conversations yet. They appear here as students and teachers use the assistants."
                    : "No conversations match the current filters."}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr
                  key={row.id}
                  className="cursor-pointer transition-colors hover:bg-accent/50"
                  onClick={() => setOpenId(row.id)}
                >
                  <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                    {new Date(row.lastMessageAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-3">
                    <span className="block">{row.userName}</span>
                    <span className="block text-xs text-muted-foreground">{row.userEmail}</span>
                  </td>
                  <td className="px-4 py-3 capitalize">{row.audience}</td>
                  <td className="max-w-0 truncate px-4 py-3">{row.title}</td>
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

      {openId && <TranscriptDialog conversationId={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}
