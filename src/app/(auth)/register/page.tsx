"use client";
import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { GraduationCap, Info } from "lucide-react";
import {
  PASSWORD_REQUIREMENTS,
  validatePassword,
} from "@/lib/account-validation";
import { formatTeacherCode, normalizeTeacherCode } from "@/lib/teacher-codes";

function RegisterForm() {
  const { push } = useRouter();
  // Codes issued in the admin panel are shared as /register?code=… links, so
  // the invitee only fills in their own details. A hand-typed code still works.
  const codeFromLink = normalizeTeacherCode(
    useSearchParams().get("code") ?? "",
  );
  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    username: "",
    email: "",
    password: "",
    confirmPassword: "",
    teacherToken: codeFromLink,
  });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  function updateFormField(e: React.ChangeEvent<HTMLInputElement>) {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  }

  async function handleSubmit(e: React.FormEvent) {
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

    setLoading(true);
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Registration failed.");
      } else {
        push("/login?registered=1");
      }
    } catch {
      setError("An unexpected error occurred.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-linear-to-br from-slate-900 via-blue-950 to-slate-900 flex items-center justify-center px-4 py-8">
      <div className="w-full max-w-md space-y-4">
        {/* Student notice */}
        <div className="flex items-start gap-3 p-4 rounded-lg bg-blue-500/10 border border-blue-400/20 text-sm text-blue-200">
          <Info className="size-4 mt-0.5 shrink-0 text-blue-400" />
          <span>
            <strong>Students:</strong> You cannot sign up here. Ask your teacher
            for an invitation link: you&apos;ll need your 81 number to verify
            your identity and create your account.
          </span>
        </div>

        <Card>
          <CardHeader className="space-y-1">
            <div className="flex items-center gap-2">
              <GraduationCap className="size-5 text-primary" />
              <CardTitle className="text-2xl font-bold">
                Teacher Registration
              </CardTitle>
            </div>
            <CardDescription>
              You need a teacher registration code to create an account.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">
                  {error}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="firstName">First name</Label>
                  <Input
                    id="firstName"
                    name="firstName"
                    value={form.firstName}
                    onChange={updateFormField}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="lastName">Last name</Label>
                  <Input
                    id="lastName"
                    name="lastName"
                    value={form.lastName}
                    onChange={updateFormField}
                    required
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="username">Username</Label>
                <Input
                  id="username"
                  name="username"
                  value={form.username}
                  onChange={updateFormField}
                  required
                  placeholder="e.g. jsmith"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  value={form.email}
                  onChange={updateFormField}
                  required
                  placeholder="you@school.edu"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  value={form.password}
                  onChange={updateFormField}
                  required
                  placeholder="Create a strong password"
                />
                <p className="text-xs text-muted-foreground">
                  {PASSWORD_REQUIREMENTS}
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="confirmPassword">Confirm password</Label>
                <Input
                  id="confirmPassword"
                  name="confirmPassword"
                  type="password"
                  value={form.confirmPassword}
                  onChange={updateFormField}
                  required
                />
              </div>

              <div className="space-y-2 pt-1">
                <Label htmlFor="teacherToken">Teacher registration code</Label>
                {/* A code that arrived in the link is already on screen in the
                    URL bar, so masking it would only stop the invitee checking
                    it against what they were sent. */}
                <Input
                  id="teacherToken"
                  name="teacherToken"
                  type={codeFromLink ? "text" : "password"}
                  value={form.teacherToken}
                  onChange={updateFormField}
                  required
                  placeholder="Enter the code provided by your administrator"
                  className={
                    codeFromLink ? "font-mono tracking-wider" : undefined
                  }
                />
                <p className="text-xs text-muted-foreground">
                  {codeFromLink
                    ? `Filled in from your invitation link (${formatTeacherCode(codeFromLink)}).`
                    : "This code is provided by the platform administrator."}
                </p>
              </div>

              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? "Creating account..." : "Create teacher account"}
              </Button>
            </form>

            <div className="mt-4 text-center text-sm text-muted-foreground">
              Already have an account?{" "}
              <Link href="/login" className="text-primary hover:underline">
                Sign in
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export default function RegisterPage() {
  // useSearchParams needs a Suspense boundary in the App Router; same shape as
  // the login page's ?callbackUrl handling.
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-linear-to-br from-slate-900 via-blue-950 to-slate-900" />
      }
    >
      <RegisterForm />
    </Suspense>
  );
}
