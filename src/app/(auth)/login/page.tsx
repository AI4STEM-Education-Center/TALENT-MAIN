"use client";
import { useState, Suspense } from "react";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

// Accept only same-origin relative paths from the URL to prevent open redirects
// (reject protocol-relative "//host" and absolute URLs).
function safeRelativeCallbackUrl(value: string | null): string | undefined {
  return value && value.startsWith("/") && !value.startsWith("//") ? value : undefined;
}

function LoginForm() {
  const { push, refresh } = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = safeRelativeCallbackUrl(searchParams.get("callbackUrl"));
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const result = await signIn("credentials", {
        identifier,
        password,
        remember: remember ? "true" : "false",
        redirect: false,
      });

      if (result?.error) {
        setError("Invalid email/username or password.");
      } else {
        // Get fresh session to determine role
        const res = await fetch("/api/auth/session");
        if (!res.ok) {
          setError("Signed in, but we couldn't load your account. Please try again.");
          return;
        }
        const session = await res.json();
        const role = session?.user?.role;
        if (callbackUrl) {
          push(callbackUrl);
        } else if (role === "TEACHER") {
          push("/teacher");
        } else if (role === "ADMIN") {
          push("/admin");
        } else {
          push("/student");
        }
        refresh();
      }
    } catch {
      setError("An unexpected error occurred.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-linear-to-br from-slate-900 via-blue-950 to-slate-900 flex items-center justify-center px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-1">
          <CardTitle className="text-2xl font-bold">Sign in</CardTitle>
          <CardDescription>Enter your email or username to sign in</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">
                {error}
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="identifier">Email or Username</Label>
              <Input
                id="identifier"
                type="text"
                placeholder="you@example.com or username"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                required
                autoComplete="username"
              />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="password">Password</Label>
                <Link
                  href="/forgot-password"
                  className="text-xs text-muted-foreground hover:text-primary hover:underline"
                >
                  Forgot password?
                </Link>
              </div>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
            </div>
            <div className="flex items-start gap-3">
              <input
                id="remember"
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                className="mt-0.5 size-4 rounded border-input accent-primary"
              />
              <div className="grid gap-0.5">
                <Label htmlFor="remember" className="font-normal">
                  Remember this computer
                </Label>
                <p className="text-xs text-muted-foreground">
                  Stay signed in for 30 days. Otherwise, your sign-in expires after 1 day.
                </p>
              </div>
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Signing in..." : "Sign in"}
            </Button>
          </form>
          <div className="mt-4 text-center text-sm text-muted-foreground">
            Don&apos;t have an account?{" "}
            <Link href="/register" className="text-primary hover:underline">
              Register
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-linear-to-br from-slate-900 via-blue-950 to-slate-900" />}>
      <LoginForm />
    </Suspense>
  );
}
