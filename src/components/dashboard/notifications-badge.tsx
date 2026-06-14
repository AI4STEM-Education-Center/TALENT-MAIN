"use client";
import { useEffect, useRef, useState } from "react";

/**
 * Unread-count pill for the student "Notifications" sidebar entry. Loads once on
 * mount and refreshes when the mailbox dispatches a "notifications:updated"
 * window event (e.g. after marking messages read). The fetcher is held in a ref
 * so the window listener subscribes once and always runs the latest logic.
 * Renders nothing when there are no unread notifications.
 */
export function NotificationsBadge() {
  const [unread, setUnread] = useState(0);

  const loadRef = useRef<() => void>(() => {});
  loadRef.current = () => {
    fetch("/api/notifications?take=1")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) setUnread(d.unreadCount ?? 0);
      })
      .catch(() => {});
  };

  useEffect(() => {
    loadRef.current();
    const handler = () => loadRef.current();
    window.addEventListener("notifications:updated", handler);
    return () => window.removeEventListener("notifications:updated", handler);
  }, []);

  if (unread <= 0) return null;

  return (
    <span
      aria-label={`${unread} unread notifications`}
      className="inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full bg-primary text-primary-foreground text-[10px] font-semibold"
    >
      {unread > 9 ? "9+" : unread}
    </span>
  );
}
