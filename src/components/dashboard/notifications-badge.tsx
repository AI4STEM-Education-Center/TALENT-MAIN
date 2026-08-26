"use client";
import { useEffect, useState } from "react";

/**
 * Unread-count pill for the student "Notifications" sidebar entry. Loads once on
 * mount and refreshes when the mailbox dispatches a "notifications:updated"
 * window event (e.g. after marking messages read). The fetcher lives inside the
 * effect: it closes over nothing that changes, so the listener still subscribes
 * once, without the render-phase ref write this used to rely on (React may
 * replay or discard a render, so mutations must not happen during one).
 * Renders nothing when there are no unread notifications.
 */
export function NotificationsBadge() {
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    const load = () => {
      fetch("/api/notifications?take=1")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (d) setUnread(d.unreadCount ?? 0);
        })
        .catch(() => {});
    };

    load();
    window.addEventListener("notifications:updated", load);
    return () => window.removeEventListener("notifications:updated", load);
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
