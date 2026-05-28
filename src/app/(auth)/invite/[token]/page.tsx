"use client";
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { signIn, useSession } from "next-auth/react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { GraduationCap, CheckCircle, XCircle, Loader2 } from "lucide-react";
import { SessionProvider } from "next-auth/react";

interface InviteInfo {
  valid: boolean;
  classId: string;
  className: string;
  teacherName: string;
}

function InviteContent() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const { data: session, status } = useSession();
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [success, setSuccess] = useState(false);

  // Signup form
  const [form, setForm] = useState({ firstName: "", lastName: "", username: "", email: "", password: "" });

  useEffect(() => {
    fetch(`/api/invitations/${token}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.valid) setInfo(data);
        else setError(data.error || "Invalid invitation.");
        setLoading(false);
      })
      .catch(() => { setError("Failed to validate invitation."); setLoading(false); });
  }, [token]);

  async function handleJoinLoggedIn() {
    setJoining(true);
    try {
      const res = await fetch(`/api/invitations/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (res.ok) {
        setSuccess(true);
        setTimeout(() => router.push(`/student/classes/${data.classId}`), 1500);
      } else {
        setError(data.error);
      }
    } finally {
      setJoining(false);
    }
  }

  async function handleSignupAndJoin(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setJoining(true);
    try {
      const res = await fetch(`/api/invitations/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (res.ok) {
        // Auto sign in
        await signIn("credentials", {
          identifier: form.email,
          password: form.password,
          redirect: false,
        });
        setSuccess(true);
        setTimeout(() => router.push(`/student/classes/${data.classId}`), 1500);
      } else {
        setError(data.error);
      }
    } finally {
      setJoining(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-blue-950 to-slate-900 flex items-center justify-center px-4 py-8">
      <Card className="w-full max-w-md">
        {error && !info ? (
          <CardContent className="flex flex-col items-center py-10 text-center">
            <XCircle className="w-12 h-12 text-destructive mb-3" />
            <p className="font-semibold text-lg mb-1">Invalid Invitation</p>
            <p className="text-muted-foreground text-sm mb-4">{error}</p>
            <Button asChild><Link href="/login">Go to Login</Link></Button>
          </CardContent>
        ) : success ? (
          <CardContent className="flex flex-col items-center py-10 text-center">
            <CheckCircle className="w-12 h-12 text-green-500 mb-3" />
            <p className="font-semibold text-lg">Joined successfully!</p>
            <p className="text-muted-foreground text-sm mt-1">Redirecting to your class...</p>
          </CardContent>
        ) : (
          <>
            <CardHeader>
              <div className="flex items-center gap-3 mb-2">
                <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                  <GraduationCap className="w-5 h-5 text-primary" />
                </div>
                <div>
                  <CardTitle>Class Invitation</CardTitle>
                  <CardDescription>You&apos;ve been invited to join a class</CardDescription>
                </div>
              </div>
              {info && (
                <div className="mt-2 p-3 rounded-lg bg-muted">
                  <p className="font-semibold">{info.className}</p>
                  <p className="text-sm text-muted-foreground">Teacher: {info.teacherName}</p>
                </div>
              )}
            </CardHeader>
            <CardContent>
              {error && <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm mb-4">{error}</div>}

              {status === "authenticated" && session?.user?.role === "STUDENT" ? (
                <div className="space-y-4">
                  <p className="text-sm text-muted-foreground">
                    Signed in as <strong>{session.user.firstName} {session.user.lastName}</strong>. Click below to join.
                  </p>
                  <Button className="w-full" onClick={handleJoinLoggedIn} disabled={joining}>
                    {joining ? "Joining..." : `Join ${info?.className}`}
                  </Button>
                </div>
              ) : status === "authenticated" && session?.user?.role === "TEACHER" ? (
                <div className="text-center py-4 text-muted-foreground text-sm">
                  Teachers cannot join student classes. <Link href="/teacher" className="text-primary hover:underline">Go to dashboard</Link>
                </div>
              ) : (
                <div className="space-y-4">
                  <p className="text-sm text-muted-foreground text-center">
                    Already have an account?{" "}
                    <Link href={`/login?callbackUrl=/invite/${token}`} className="text-primary hover:underline">Sign in</Link>
                  </p>
                  <div className="relative">
                    <div className="absolute inset-0 flex items-center"><span className="w-full border-t" /></div>
                    <div className="relative flex justify-center text-xs uppercase">
                      <span className="bg-card px-2 text-muted-foreground">Or create account</span>
                    </div>
                  </div>
                  <form onSubmit={handleSignupAndJoin} className="space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label htmlFor="firstName" className="text-xs">First name</Label>
                        <Input id="firstName" value={form.firstName} onChange={(e) => setForm((p) => ({ ...p, firstName: e.target.value }))} required />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="lastName" className="text-xs">Last name</Label>
                        <Input id="lastName" value={form.lastName} onChange={(e) => setForm((p) => ({ ...p, lastName: e.target.value }))} required />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="username" className="text-xs">Username</Label>
                      <Input id="username" value={form.username} onChange={(e) => setForm((p) => ({ ...p, username: e.target.value }))} required placeholder="e.g. jsmith" />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="email" className="text-xs">Email</Label>
                      <Input id="email" type="email" value={form.email} onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))} required />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="password" className="text-xs">Password</Label>
                      <Input id="password" type="password" value={form.password} onChange={(e) => setForm((p) => ({ ...p, password: e.target.value }))} required />
                    </div>
                    <Button type="submit" className="w-full" disabled={joining}>
                      {joining ? "Creating account & joining..." : "Create account & join class"}
                    </Button>
                  </form>
                </div>
              )}
            </CardContent>
          </>
        )}
      </Card>
    </div>
  );
}

export default function InvitePage() {
  return (
    <SessionProvider>
      <InviteContent />
    </SessionProvider>
  );
}
