"use client";
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { signIn, useSession } from "next-auth/react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { GraduationCap, CheckCircle, XCircle, Loader2, User } from "lucide-react";
import { SessionProvider } from "next-auth/react";
import { PASSWORD_REQUIREMENTS, validatePassword } from "@/lib/account-validation";

interface InviteInfo {
  valid: boolean;
  classId: string;
  className: string;
  teacherName: string;
}

interface LookupResult {
  found: boolean;
  firstName?: string;
  lastName?: string;
  error?: string;
}

function InviteContent() {
  const { token } = useParams<{ token: string }>();
  const { push } = useRouter();
  const { data: session, status } = useSession();
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [success, setSuccess] = useState(false);
  const [successName, setSuccessName] = useState({ firstName: "", lastName: "" });

  // Step 1: 81 number verification
  const [orgDefinedId, setOrgDefinedId] = useState("");
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupResult, setLookupResult] = useState<LookupResult | null>(null);

  // Step 2: Signup form (shown after successful lookup)
  const [form, setForm] = useState({
    username: "",
    email: "",
    password: "",
    confirmPassword: "",
  });

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

  async function handleVerify(e?: React.FormEvent) {
    e?.preventDefault();
    const cleanId = orgDefinedId.replace(/^#/, "").trim();
    if (!cleanId) {
      setLookupResult({ found: false, error: "Please enter your 81 number." });
      return;
    }

    setLookupLoading(true);
    setLookupResult(null);
    try {
      const res = await fetch(
        `/api/invitations/${token}/lookup?orgDefinedId=${encodeURIComponent(cleanId)}`
      );
      const data: LookupResult = await res.json();
      setLookupResult(data);
    } catch {
      setLookupResult({ found: false, error: "Failed to verify. Please try again." });
    } finally {
      setLookupLoading(false);
    }
  }

  async function handleJoinLoggedIn() {
    setJoining(true);
    setError("");
    try {
      const res = await fetch(`/api/invitations/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgDefinedId: orgDefinedId.replace(/^#/, "").trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        setSuccessName({ firstName: data.firstName, lastName: data.lastName });
        setSuccess(true);
        setTimeout(() => push(`/student/classes/${data.classId}`), 2000);
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

    if (form.password !== form.confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    const passwordError = validatePassword(form.password);
    if (passwordError) {
      setError(passwordError);
      return;
    }

    setJoining(true);
    try {
      const res = await fetch(`/api/invitations/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orgDefinedId: orgDefinedId.replace(/^#/, "").trim(),
          ...form,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        // Auto sign in
        await signIn("credentials", {
          identifier: form.email,
          password: form.password,
          redirect: false,
        });
        setSuccessName({ firstName: data.firstName, lastName: data.lastName });
        setSuccess(true);
        setTimeout(() => push(`/student/classes/${data.classId}`), 2000);
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
        <Loader2 className="size-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-linear-to-br from-slate-900 via-blue-950 to-slate-900 flex items-center justify-center px-4 py-8">
      <Card className="w-full max-w-md">
        {error && !info ? (
          <CardContent className="flex flex-col items-center py-10 text-center">
            <XCircle className="size-12 text-destructive mb-3" />
            <p className="font-semibold text-lg mb-1">Invalid Invitation</p>
            <p className="text-muted-foreground text-sm mb-4">{error}</p>
            <Button asChild><Link href="/login">Go to Login</Link></Button>
          </CardContent>
        ) : success ? (
          <CardContent className="flex flex-col items-center py-10 text-center">
            <CheckCircle className="size-12 text-green-500 mb-3" />
            <p className="font-semibold text-lg">Sign up success!</p>
            <p className="text-muted-foreground text-sm mt-1">
              Welcome, {successName.firstName} {successName.lastName}
            </p>
            <p className="text-muted-foreground text-xs mt-2">Redirecting to your class…</p>
          </CardContent>
        ) : (
          <>
            <CardHeader>
              <div className="flex items-center gap-3 mb-2">
                <div className="size-10 rounded-full bg-primary/10 flex items-center justify-center">
                  <GraduationCap className="size-5 text-primary" />
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

              {/* Step 1: Verify 81 number */}
              <div className="space-y-3">
                <Label htmlFor="orgDefinedId" className="text-sm font-medium">
                  Enter your 81 Number to verify your identity
                </Label>
                <form onSubmit={handleVerify} className="flex gap-2">
                  <Input
                    id="orgDefinedId"
                    value={orgDefinedId}
                    onChange={(e) => {
                      setOrgDefinedId(e.target.value);
                      // Reset lookup when input changes
                      if (lookupResult) setLookupResult(null);
                    }}
                    placeholder="e.g. 811947904"
                    className="font-mono"
                  />
                  <Button
                    type="submit"
                    disabled={lookupLoading || !orgDefinedId.trim()}
                  >
                    {lookupLoading ? <Loader2 className="size-4 animate-spin" /> : "Verify"}
                  </Button>
                </form>

                {/* Lookup result */}
                {lookupResult && !lookupResult.found && (
                  <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">
                    {lookupResult.error || "81 not found for class retry again"}
                  </div>
                )}

                {lookupResult?.found && (
                  <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/20 flex items-center gap-3">
                    <User className="size-5 text-green-600 shrink-0" />
                    <div>
                      <p className="font-semibold text-green-600">Identity verified</p>
                      <p className="text-sm">
                        {lookupResult.firstName} {lookupResult.lastName}
                      </p>
                    </div>
                  </div>
                )}
              </div>

              {/* Step 2: Sign up form (only shown after successful lookup) */}
              {lookupResult?.found && (
                <>
                  <div className="relative my-4">
                    <div className="absolute inset-0 flex items-center"><span className="w-full border-t" /></div>
                    <div className="relative flex justify-center text-xs uppercase">
                      <span className="bg-card px-2 text-muted-foreground">
                        {status === "authenticated" ? "Confirm enrollment" : "Complete registration"}
                      </span>
                    </div>
                  </div>

                  {status === "authenticated" && session?.user?.role === "STUDENT" ? (
                    <div className="space-y-4">
                      <p className="text-sm text-muted-foreground">
                        Signed in as <strong>{session.user.firstName} {session.user.lastName}</strong>. Click below to join.
                      </p>
                      <Button className="w-full" onClick={handleJoinLoggedIn} disabled={joining}>
                        {joining ? "Joining..." : `Join ${info?.className}`}
                      </Button>
                    </div>
                  ) : status === "authenticated" && (session?.user?.role === "TEACHER" || session?.user?.role === "ADMIN") ? (
                    <div className="text-center py-4 text-muted-foreground text-sm">
                      {session?.user?.role === "TEACHER" ? "Teachers" : "Admins"} cannot join student classes. <Link href={session?.user?.role === "TEACHER" ? "/teacher" : "/admin"} className="text-primary hover:underline">Go to dashboard</Link>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <p className="text-sm text-muted-foreground text-center">
                        Already have an account?{" "}
                        <Link href={`/login?callbackUrl=/invite/${token}`} className="text-primary hover:underline">Sign in</Link>
                      </p>

                      {/* Name display (read-only) */}
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <Label className="text-xs">First name</Label>
                          <Input value={lookupResult.firstName} disabled className="bg-muted" />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Last name</Label>
                          <Input value={lookupResult.lastName} disabled className="bg-muted" />
                        </div>
                      </div>

                      <form onSubmit={handleSignupAndJoin} className="space-y-3">
                        <div className="space-y-1">
                          <Label htmlFor="username" className="text-xs">Username</Label>
                          <Input
                            id="username"
                            value={form.username}
                            onChange={(e) => setForm((p) => ({ ...p, username: e.target.value }))}
                            required
                            placeholder="Choose a display username"
                          />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor="email" className="text-xs">Email</Label>
                          <Input
                            id="email"
                            type="email"
                            value={form.email}
                            onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))}
                            required
                          />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor="password" className="text-xs">Password</Label>
                          <Input
                            id="password"
                            type="password"
                            value={form.password}
                            onChange={(e) => setForm((p) => ({ ...p, password: e.target.value }))}
                            required
                          />
                          <p className="text-xs text-muted-foreground">
                            {PASSWORD_REQUIREMENTS}
                          </p>
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor="confirmPassword" className="text-xs">Confirm password</Label>
                          <Input
                            id="confirmPassword"
                            type="password"
                            value={form.confirmPassword}
                            onChange={(e) => setForm((p) => ({ ...p, confirmPassword: e.target.value }))}
                            required
                          />
                        </div>
                        <Button type="submit" className="w-full" disabled={joining}>
                          {joining ? "Creating account & joining..." : "Create account & join class"}
                        </Button>
                      </form>
                    </div>
                  )}
                </>
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
