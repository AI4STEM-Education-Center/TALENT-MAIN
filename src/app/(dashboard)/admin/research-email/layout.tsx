import { ResearchEmailSwitch } from "@/components/admin/research/ResearchEmailSwitch";

export default function ResearchEmailLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-3xl font-bold">Research emails</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Each email is written separately for students and teachers, and
            every recipient gets their own copy.
          </p>
        </div>
        <ResearchEmailSwitch />
      </div>
      {children}
    </div>
  );
}
