"use client";
import { signOut, useSession } from "next-auth/react";
import { redirect } from "next/navigation";
import { Sidebar } from "@/components/dashboard/sidebar";
import { SessionProvider } from "next-auth/react";

function DashboardContent({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession();

  if (status === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (!session) {
    redirect("/login");
  }

  const role = session.user.role as "TEACHER" | "STUDENT";

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
      />
      <main className="flex-1 overflow-auto">
        {children}
      </main>
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
