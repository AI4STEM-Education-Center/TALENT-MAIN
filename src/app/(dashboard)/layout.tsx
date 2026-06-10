"use client";
import { useState } from "react";
import { signOut, useSession } from "next-auth/react";
import { redirect } from "next/navigation";
import { Sidebar } from "@/components/dashboard/sidebar";
import { SessionProvider } from "next-auth/react";
import { Menu, BookOpen, PanelLeft } from "lucide-react";
import { cn } from "@/lib/utils";

function DashboardContent({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [desktopSidebarOpen, setDesktopSidebarOpen] = useState(true);

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
    <div className="flex min-h-screen bg-background">
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
            <div className="size-7 rounded-lg bg-blue-500/20 flex items-center justify-center">
              <BookOpen className="size-3.5 text-blue-400" />
            </div>
            <span className="font-bold text-sm text-foreground">AI4Talent</span>
          </div>
        </header>

        <main className="flex-1 overflow-auto">
          {children}
        </main>
      </div>
    </div>
  );
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <DashboardContent>{children}</DashboardContent>
    </SessionProvider>
  );
}
