"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CalendarCheck, ClipboardCheck } from "lucide-react";

const PAGES = [
  {
    href: "/admin/research-email/post-survey",
    label: "Post-survey email",
    icon: ClipboardCheck,
  },
  {
    href: "/admin/research-email/interview",
    label: "Interview email",
    icon: CalendarCheck,
  },
];

/** Switches between the post-survey and interview email pages. */
export function ResearchEmailSwitch() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Research email type"
      className="inline-flex rounded-lg border bg-muted p-1"
    >
      {PAGES.map(({ href, label, icon: Icon }) => {
        const active = pathname === href;
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Icon className="size-4" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
