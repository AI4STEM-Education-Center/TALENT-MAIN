"use client";
import { useState } from "react";
import { signOut, useSession } from "next-auth/react";
import { redirect } from "next/navigation";
import { Sidebar } from "@/components/dashboard/sidebar";
import { SetContentFullWidthContext } from "@/components/dashboard/content-width";
import { ConsentGate } from "@/components/consent/ConsentGate";
import { AssistantWidget } from "@/components/assistant/AssistantWidget";
import { AssistantProvider } from "@/components/assistant/assistant-context";
import { SessionProvider } from "next-auth/react";
import { Menu, BookOpen, PanelLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "@/components/theme-toggle";

function DashboardContent({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [desktopSidebarOpen, setDesktopSidebarOpen] = useState(true);
  // Pages toggle this via useContentFullWidth when they need the whole
  // viewport (e.g. exam results while a simulation is open).
  const [contentFullWidth, setContentFullWidth] = useState(false);

  if (status === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full size-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (!session) {
    redirect("/login");
  }

  const role = session.user.role as "TEACHER" | "STUDENT" | "ADMIN";

  return (
    <AssistantProvider>
      <div className="flex min-h-screen bg-background">
        <ConsentGate />
        <Sidebar
          role={role}
          firstName={session.user.firstName}
          lastName={session.user.lastName}
          onSignOut={async () => {
            await signOut({ redirect: false });
            window.location.href = `${window.location.origin}/login`;
          }}
          mobileOpen={sidebarOpen}
          onMobileClose={() => setSidebarOpen(false)}
          desktopOpen={desktopSidebarOpen}
          onDesktopClose={() => setDesktopSidebarOpen(false)}
        />

        <div className="flex-1 flex flex-col min-w-0">
          {/* Top bar — always on mobile; on md+ only when the sidebar is collapsed */}
          <header
            className={cn(
              "sticky top-0 z-40 flex items-center gap-3 px-4 py-3 bg-background border-b border-border",
              desktopSidebarOpen && "md:hidden"
            )}
          >
            <button type="button"
              aria-label="Open navigation menu"
              onClick={() => setSidebarOpen(true)}
              className="md:hidden p-2 rounded-md text-foreground/70 hover:text-foreground hover:bg-accent transition-colors"
            >
              <Menu className="size-5" />
            </button>
            <button type="button"
              aria-label="Show sidebar"
              onClick={() => setDesktopSidebarOpen(true)}
              className="hidden md:block p-2 rounded-md text-foreground/70 hover:text-foreground hover:bg-accent transition-colors"
            >
              <PanelLeft className="size-5" />
            </button>
            <div className="flex items-center gap-2">
              <div className="size-7 rounded-lg bg-primary/10 flex items-center justify-center">
                <BookOpen className="size-3.5 text-primary" />
              </div>
              <span className="font-bold text-sm text-foreground">AI4Talent</span>
            </div>
            <ThemeToggle className="ml-auto p-2 rounded-md text-foreground/70 hover:text-foreground hover:bg-accent" />
          </header>

          <main className="flex-1 overflow-auto">
            {/* Cap content width so inputs/bars/boxes don't stretch the full
                viewport, but stay left-aligned (no mx-auto) so content hugs the
                sidebar instead of floating centered. Pages can lift the cap via
                useContentFullWidth when they need the whole viewport. */}
            <SetContentFullWidthContext.Provider value={setContentFullWidth}>
              <div className={cn("w-full", !contentFullWidth && "max-w-7xl")}>{children}</div>
            </SetContentFullWidthContext.Provider>
          </main>
        </div>

        {/* The assistant panel. Its trigger lives in the sidebar (AssistantLauncher);
            the panel is mounted here so it overlays the viewport rather than the
            16rem rail, and so the transcript survives navigation. It self-hides
            unless this user's audience has an assistant an admin turned on. */}
        <AssistantWidget />
      </div>
    </AssistantProvider>
  );
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <DashboardContent>{children}</DashboardContent>
    </SessionProvider>
  );
}
