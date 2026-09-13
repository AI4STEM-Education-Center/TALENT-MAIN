"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { VersionModal } from "@/components/version-modal";
import { NotificationsBadge } from "@/components/dashboard/notifications-badge";
import { ThemeToggle } from "@/components/theme-toggle";
import { AssistantLauncher } from "@/components/assistant/AssistantLauncher";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import {
  BookOpen,
  Users,
  LayoutDashboard,
  GraduationCap,
  BarChart3,
  FileQuestion,
  FileUp,
  LogOut,
  ChevronRight,
  Settings,
  FolderOpen,
  History,
  Mail,
  MessageSquare,
  MessagesSquare,
  Inbox,
  ClipboardCheck,
  Gauge,
  HardDrive,
  PanelLeftClose,
  Atom,
  ScrollText,
  UserRound,
  ShieldCheck,
  KeyRound,
} from "lucide-react";

interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
}

interface SidebarProps {
  role: "TEACHER" | "STUDENT" | "ADMIN";
  firstName: string;
  lastName: string;
  onSignOut: () => void;
  mobileOpen?: boolean;
  onMobileClose?: () => void;
  desktopOpen?: boolean;
  onDesktopClose?: () => void;
}

const teacherNav: NavItem[] = [
  { href: "/teacher", label: "Dashboard", icon: <LayoutDashboard className="size-4" /> },
  { href: "/teacher/classes", label: "My Classes", icon: <Users className="size-4" /> },
  { href: "/teacher/stats", label: "Stats", icon: <BarChart3 className="size-4" /> },
  { href: "/teacher/quizzes", label: "Quizzes", icon: <FileQuestion className="size-4" /> },
  { href: "/teacher/messages", label: "Messages", icon: <MessageSquare className="size-4" /> },
];

const studentNav: NavItem[] = [
  { href: "/student", label: "Dashboard", icon: <LayoutDashboard className="size-4" /> },
  { href: "/student/classes", label: "My Classes", icon: <GraduationCap className="size-4" /> },
  { href: "/student/materials", label: "Course Materials", icon: <FolderOpen className="size-4" /> },
  { href: "/student/simulations", label: "Simulations", icon: <Atom className="size-4" /> },
  { href: "/student/notifications", label: "Notifications", icon: <Inbox className="size-4" /> },
  { href: "/student/history", label: "Exam History", icon: <History className="size-4" /> },
];

const adminNav: NavItem[] = [
  { href: "/admin", label: "Overview", icon: <LayoutDashboard className="size-4" /> },
  { href: "/admin/quizzes", label: "Quiz Pool", icon: <FileQuestion className="size-4" /> },
  { href: "/admin/material-pool", label: "Material Pool", icon: <FolderOpen className="size-4" /> },
  { href: "/admin/pool-submissions", label: "Pool Approvals", icon: <ClipboardCheck className="size-4" /> },
  { href: "/admin/consent", label: "Consent Records", icon: <ShieldCheck className="size-4" /> },
  { href: "/admin/consent-requests", label: "Consent Export Requests", icon: <ClipboardCheck className="size-4" /> },
  { href: "/admin/simulations", label: "Simulations", icon: <Atom className="size-4" /> },
  { href: "/admin/materials", label: "Materials Processing", icon: <FolderOpen className="size-4" /> },
  { href: "/admin/concepts", label: "Concepts", icon: <BookOpen className="size-4" /> },
  { href: "/admin/users", label: "Users", icon: <Users className="size-4" /> },
  { href: "/admin/teacher-codes", label: "Teacher Codes", icon: <KeyRound className="size-4" /> },
  { href: "/admin/ai-config", label: "AI Config", icon: <Settings className="size-4" /> },
  { href: "/admin/assistant-chats", label: "Chat Transcripts", icon: <MessagesSquare className="size-4" /> },
  { href: "/admin/email", label: "Email / SMTP", icon: <Mail className="size-4" /> },
  { href: "/admin/backup", label: "Database Backup", icon: <HardDrive className="size-4" /> },
  { href: "/admin/resources", label: "System Resources", icon: <Gauge className="size-4" /> },
  { href: "/admin/logs", label: "System Logs", icon: <ScrollText className="size-4" /> },
];

// Shared by every role and rendered under the role's own items.
const profileNav: NavItem = {
  href: "/profile",
  label: "My Profile",
  icon: <UserRound className="size-4" />,
};

function SidebarContent({
  role,
  firstName,
  lastName,
  onSignOut,
  onNavigate,
  onCollapse,
}: {
  role: "TEACHER" | "STUDENT" | "ADMIN";
  firstName: string;
  lastName: string;
  onSignOut: () => void;
  onNavigate?: () => void;
  onCollapse?: () => void;
}) {
  const pathname = usePathname();

  const roleNav = role === "ADMIN" ? adminNav : role === "TEACHER" ? teacherNav : studentNav;
  const navItems = [...roleNav, profileNav];

  return (
    <div className="flex flex-col min-h-full">
      {/* Logo */}
      <div className="p-6 border-b border-sidebar-border">
        <div className="flex items-center gap-2">
          <div className="size-8 rounded-lg bg-sidebar-primary/15 flex items-center justify-center">
            <BookOpen className="size-4 text-sidebar-primary" />
          </div>
          <span className="font-bold text-sidebar-foreground">AI4Talent</span>
          {onCollapse && (
            <button type="button"
              aria-label="Hide sidebar"
              onClick={onCollapse}
              className="ml-auto p-1.5 rounded-md text-sidebar-foreground/50 hover:text-sidebar-foreground hover:bg-sidebar-accent/50 transition-colors"
            >
              <PanelLeftClose className="size-4" />
            </button>
          )}
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 p-4 space-y-1">
        {navItems.map((item) => {
          // Sub-pages light up their section, but only on a full path-segment
          // boundary: a bare startsWith made /admin/consent-requests light up
          // "Consent Records" (/admin/consent) as well as its own item.
          const isActive =
            pathname === item.href ||
            (item.href !== "/teacher" &&
              item.href !== "/student" &&
              item.href !== "/admin" &&
              pathname.startsWith(`${item.href}/`));
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              className={cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
                isActive
                  ? "bg-sidebar-accent text-sidebar-accent-foreground ring-1 ring-inset ring-sidebar-primary/40"
                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
              )}
            >
              {item.icon}
              {item.label}
              <span className="ml-auto flex items-center gap-1.5">
                {item.href === "/student/notifications" && <NotificationsBadge />}
                {isActive && <ChevronRight className="size-3" />}
              </span>
            </Link>
          );
        })}
      </nav>

      {/* User */}
      <div className="p-4 border-t border-sidebar-border">
        {/* Sits above the signed-in user; renders nothing when this role has no
            assistant, so the rail keeps its previous shape for everyone else. */}
        <AssistantLauncher onOpen={onNavigate} />
        <div className="flex items-center gap-3 px-3 py-2 mb-2">
          <div className="size-8 rounded-full bg-sidebar-primary/15 flex items-center justify-center text-xs font-bold text-sidebar-primary shrink-0">
            {firstName[0]}{lastName[0]}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-sidebar-foreground truncate">
              {firstName} {lastName}
            </p>
            <p className="text-xs text-sidebar-foreground/50 capitalize">
              {role.toLowerCase()}
            </p>
          </div>
        </div>
        <ThemeToggle
          showLabel
          className="w-full px-3 py-2.5 rounded-lg text-sm text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
        />
        <button type="button"
          onClick={onSignOut}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground transition-colors"
        >
          <LogOut className="size-4" />
          Sign out
        </button>
        <div className="mt-3 px-3">
          <VersionModal />
        </div>
      </div>
    </div>
  );
}

export function Sidebar({
  role,
  firstName,
  lastName,
  onSignOut,
  mobileOpen = false,
  onMobileClose,
  desktopOpen = true,
  onDesktopClose,
}: SidebarProps) {
  const contentProps = { role, firstName, lastName, onSignOut };

  return (
    <>
      {/* Desktop sidebar — hidden below md, collapsible on md+ */}
      <aside
        className={cn(
          "w-64 h-screen sticky top-0 overflow-y-auto bg-sidebar flex-col border-r border-sidebar-border shrink-0",
          desktopOpen ? "hidden md:flex" : "hidden"
        )}
      >
        <SidebarContent {...contentProps} onCollapse={onDesktopClose} />
      </aside>

      {/* Mobile drawer — shown below md */}
      <Sheet open={mobileOpen} onOpenChange={(open) => !open && onMobileClose?.()}>
        <SheetContent side="left" className="p-0 w-64 overflow-y-auto">
          <SidebarContent
            {...contentProps}
            onNavigate={onMobileClose}
          />
        </SheetContent>
      </Sheet>
    </>
  );
}
