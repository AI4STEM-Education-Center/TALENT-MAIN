"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { VersionModal } from "@/components/version-modal";
import {
  BookOpen,
  Users,
  LayoutDashboard,
  GraduationCap,
  FileQuestion,
  FileUp,
  LogOut,
  ChevronRight,
} from "lucide-react";

interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
}

interface SidebarProps {
  role: "TEACHER" | "STUDENT";
  firstName: string;
  lastName: string;
  onSignOut: () => void;
}

export function Sidebar({ role, firstName, lastName, onSignOut }: SidebarProps) {
  const pathname = usePathname();

  const teacherNav: NavItem[] = [
    { href: "/teacher", label: "Dashboard", icon: <LayoutDashboard className="w-4 h-4" /> },
    { href: "/teacher/classes", label: "My Classes", icon: <Users className="w-4 h-4" /> },
    { href: "/teacher/topics", label: "Topics & Modules", icon: <BookOpen className="w-4 h-4" /> },
    { href: "/teacher/questions", label: "Question Bank", icon: <FileQuestion className="w-4 h-4" /> },
    { href: "/teacher/materials", label: "Materials", icon: <FileUp className="w-4 h-4" /> },
  ];

  const studentNav: NavItem[] = [
    { href: "/student", label: "Dashboard", icon: <LayoutDashboard className="w-4 h-4" /> },
    { href: "/student/classes", label: "My Classes", icon: <GraduationCap className="w-4 h-4" /> },
  ];

  const navItems = role === "TEACHER" ? teacherNav : studentNav;

  return (
    <aside className="w-64 min-h-screen bg-sidebar flex flex-col border-r border-sidebar-border">
      {/* Logo */}
      <div className="p-6 border-b border-sidebar-border">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-blue-500/20 flex items-center justify-center">
            <BookOpen className="w-4 h-4 text-blue-400" />
          </div>
          <span className="font-bold text-sidebar-foreground">AI4Talent</span>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 p-4 space-y-1">
        {navItems.map((item) => {
          const isActive = pathname === item.href || (item.href !== "/teacher" && item.href !== "/student" && pathname.startsWith(item.href));
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
                isActive
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
              )}
            >
              {item.icon}
              {item.label}
              {isActive && <ChevronRight className="w-3 h-3 ml-auto" />}
            </Link>
          );
        })}
      </nav>

      {/* User */}
      <div className="p-4 border-t border-sidebar-border">
        <div className="flex items-center gap-3 px-3 py-2 mb-2">
          <div className="w-8 h-8 rounded-full bg-blue-500/20 flex items-center justify-center text-xs font-bold text-blue-400">
            {firstName[0]}{lastName[0]}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-sidebar-foreground truncate">{firstName} {lastName}</p>
            <p className="text-xs text-sidebar-foreground/50 capitalize">{role.toLowerCase()}</p>
          </div>
        </div>
        <button
          onClick={onSignOut}
          className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground transition-colors"
        >
          <LogOut className="w-4 h-4" />
          Sign out
        </button>
        <div className="mt-3 px-3">
          <VersionModal />
        </div>
      </div>
    </aside>
  );
}
