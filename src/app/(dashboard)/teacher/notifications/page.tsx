"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Inbox, Mail, MailOpen, Loader2, CheckCheck } from "lucide-react";
import { cn } from "@/lib/utils";

interface NotificationItem {
  id: string;
  messageId: string | null;
  kind?: string;
  href: string | null;
  subject: string;
  body: string;
  senderName: string;
  className: string | null;
  createdAt: string;
  readAt: string | null;
}

// Let the sidebar badge know the unread count changed.
function signalUpdate() {
  window.dispatchEvent(new Event("notifications:updated"));
}

async function postRead(body: { id: string } | { all: true }) {
  await fetch("/api/notifications/read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {});
}

export default function TeacherNotificationsPage() {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch("/api/notifications?take=100", {
          signal: controller.signal,
        });
        if (!res.ok) {
          if (!controller.signal.aborted)
            setLoadError(`Could not load notifications (HTTP ${res.status}).`);
          return;
        }
        const data = (await res.json()) as {
          notifications?: NotificationItem[];
        };
        if (!controller.signal.aborted) setItems(data.notifications ?? []);
      } catch {
        if (!controller.signal.aborted)
          setLoadError("Could not load notifications.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, []);

  async function markRead(id: string) {
    await postRead({ id });
    setItems((prev) =>
      prev.map((n) =>
        n.id === id && !n.readAt
          ? { ...n, readAt: new Date().toISOString() }
          : n,
      ),
    );
    signalUpdate();
  }

  async function markAllRead() {
    await postRead({ all: true });
    const now = new Date().toISOString();
    setItems((prev) => prev.map((n) => (n.readAt ? n : { ...n, readAt: now })));
    signalUpdate();
  }

  function toggle(n: NotificationItem) {
    const opening = expandedId !== n.id;
    setExpandedId(opening ? n.id : null);
    if (opening && !n.readAt) void markRead(n.id);
  }

  const unreadCount = items.filter((n) => !n.readAt).length;

  if (loading) {
    return (
      <div className="p-4 md:p-6 flex items-center justify-center min-h-[300px]">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-3xl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Inbox className="size-6" aria-hidden="true" /> Notifications
            {unreadCount > 0 && (
              <span className="inline-flex items-center justify-center min-w-6 h-6 px-2 rounded-full bg-primary text-primary-foreground text-xs font-semibold">
                {unreadCount}
              </span>
            )}
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Generation updates, review reminders, and system notices.
          </p>
        </div>
        {unreadCount > 0 && (
          <Button variant="outline" size="sm" onClick={markAllRead}>
            <CheckCheck className="size-4" /> Mark all read
          </Button>
        )}
      </div>

      {loadError && (
        <p role="alert" className="text-sm text-destructive">
          {loadError}
        </p>
      )}

      {items.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-12 text-center">
            <Inbox className="size-12 text-muted-foreground mb-3" />
            <p className="text-lg font-medium">No notifications yet</p>
            <p className="text-muted-foreground text-sm mt-1">
              Updates about generated exam versions will appear here.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0 divide-y">
            {items.map((n) => {
              const unread = !n.readAt;
              const expanded = expandedId === n.id;
              return (
                <div
                  key={n.id}
                  className={cn(
                    "px-4 py-3 space-y-2 transition-colors hover:bg-muted/40",
                    unread && "bg-primary/5",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => toggle(n)}
                    aria-expanded={expanded}
                    className="w-full text-left flex gap-3"
                  >
                    <span className="mt-0.5 shrink-0 text-muted-foreground">
                      {unread ? (
                        <Mail className="size-4 text-primary" />
                      ) : (
                        <MailOpen className="size-4" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 flex-wrap">
                        <span
                          className={cn(
                            "text-sm",
                            unread ? "font-semibold" : "font-medium",
                          )}
                        >
                          {n.subject}
                        </span>
                        {unread && (
                          <span className="size-2 rounded-full bg-primary shrink-0" />
                        )}
                      </span>
                      <span className="block text-xs text-muted-foreground mt-0.5">
                        {n.senderName}
                        {n.className ? ` · ${n.className}` : ""} ·{" "}
                        {new Date(n.createdAt).toLocaleString()}
                      </span>
                      <span
                        className={cn(
                          "block text-sm text-muted-foreground mt-1 whitespace-pre-wrap",
                          !expanded && "line-clamp-1",
                        )}
                      >
                        {n.body}
                      </span>
                    </span>
                  </button>
                  {n.href && (
                    <Button size="sm" variant="outline" asChild>
                      <Link
                        href={n.href}
                        className="ml-7"
                        onClick={() => {
                          if (!n.readAt) void markRead(n.id);
                        }}
                      >
                        Review versions →
                      </Link>
                    </Button>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
