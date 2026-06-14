"use client";
import { useCallback, useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Inbox, Mail, MailOpen, Loader2, CheckCheck } from "lucide-react";
import { cn } from "@/lib/utils";

interface NotificationItem {
  id: string;
  subject: string;
  body: string;
  senderName: string;
  className: string | null;
  createdAt: string;
  readAt: string | null;
}

export default function StudentNotificationsPage() {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/notifications?take=100");
      if (res.ok) {
        const data = await res.json();
        setItems(data.notifications ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Let the sidebar badge know the unread count changed.
  function signalUpdate() {
    window.dispatchEvent(new Event("notifications:updated"));
  }

  async function markRead(id: string) {
    await fetch("/api/notifications/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    }).catch(() => {});
    setItems((prev) => prev.map((n) => (n.id === id && !n.readAt ? { ...n, readAt: new Date().toISOString() } : n)));
    signalUpdate();
  }

  async function markAllRead() {
    await fetch("/api/notifications/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ all: true }),
    }).catch(() => {});
    const now = new Date().toISOString();
    setItems((prev) => prev.map((n) => (n.readAt ? n : { ...n, readAt: now })));
    signalUpdate();
  }

  function toggle(n: NotificationItem) {
    const opening = expandedId !== n.id;
    setExpandedId(opening ? n.id : null);
    if (opening && !n.readAt) markRead(n.id);
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
            <Inbox className="size-6" /> Notifications
            {unreadCount > 0 && (
              <span className="inline-flex items-center justify-center min-w-6 h-6 px-2 rounded-full bg-primary text-primary-foreground text-xs font-semibold">
                {unreadCount}
              </span>
            )}
          </h1>
          <p className="text-muted-foreground text-sm mt-1">Messages from your teachers.</p>
        </div>
        {unreadCount > 0 && (
          <Button variant="outline" size="sm" onClick={markAllRead}>
            <CheckCheck className="size-4" /> Mark all read
          </Button>
        )}
      </div>

      {items.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-12 text-center">
            <Inbox className="size-12 text-muted-foreground mb-3" />
            <p className="text-lg font-medium">No notifications yet</p>
            <p className="text-muted-foreground text-sm mt-1">
              Announcements from your teachers will appear here.
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
                <button
                  type="button"
                  key={n.id}
                  onClick={() => toggle(n)}
                  className={cn(
                    "w-full text-left px-4 py-3 flex gap-3 transition-colors hover:bg-muted/40",
                    unread && "bg-primary/5"
                  )}
                >
                  <span className="mt-0.5 shrink-0 text-muted-foreground">
                    {unread ? <Mail className="size-4 text-primary" /> : <MailOpen className="size-4" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 flex-wrap">
                      <span className={cn("text-sm", unread ? "font-semibold" : "font-medium")}>{n.subject}</span>
                      {unread && <span className="size-2 rounded-full bg-primary shrink-0" />}
                    </span>
                    <span className="block text-xs text-muted-foreground mt-0.5">
                      {n.senderName}
                      {n.className ? ` · ${n.className}` : ""} · {new Date(n.createdAt).toLocaleString()}
                    </span>
                    <span
                      className={cn(
                        "block text-sm text-muted-foreground mt-1 whitespace-pre-wrap",
                        !expanded && "line-clamp-1"
                      )}
                    >
                      {n.body}
                    </span>
                  </span>
                </button>
              );
            })}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
