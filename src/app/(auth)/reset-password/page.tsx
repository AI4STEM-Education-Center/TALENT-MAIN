"use client";
import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PASSWORD_REQUIREMENTS, validatePassword } from "@/lib/account-validation";
import { CheckCircle2, Loader2 } from "lucide-react";

// react-doctor-disable-next-line react-doctor/no-secrets-in-client-code -- AUTH_BACKDROP is a Tailwind class list, not a credential
const AUTH_BACKDROP =
  "min-h-screen bg-linear-to-br from-slate-900 via-blue-950 to-slate-900 flex items-center justify-center px-4";

function ResetPasswordForm() {
  const { push } = useRouter();
  const token = useSearchParams().get("token") ?? "";

  // null while we're still asking the server whether the link is usable.
  const [tokenValid, setTokenValid] = useState<boolean | null>(null);
  const [tokenError, setTokenError] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  const checkToken = useCallback(async () => {
    if (!token) {
      setTokenValid(false);
      setTokenError("This link is missing its reset token. Request a new one to continue.");
      return;
    }
    try {
      const res = await fetch(`/api/auth/reset-password?token=${encodeURIComponent(token)}`);
      const data = await res.json();
      setTokenValid(!!data.valid);
      if (!data.valid) setTokenError(data.error || "This reset link is no longer valid.");
    } catch {
      setTokenValid(false);
      setTokenError("We couldn't check this link. Please try again.");
    }
  }, [token]);

  useEffect(() => {
    checkToken();
  }, [checkToken]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    const passwordError = validatePassword(password);
    if (passwordError) {
      setError(passwordError);
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Could not reset your password. Please try again.");
      } else {
        setDone(true);
        // Give the confirmation a beat to register before sending them to sign in.
        setTimeout(() => push("/login"), 2500);
      }
    } catch {
      setError("An unexpected error occurred.");
    } finally {
      setSaving(false);
    }
  }

  if (tokenValid === null) {
    return (
      <div className={AUTH_BACKDROP}>
        <Loader2 className="size-6 animate-spin text-white/70" />
      </div>
    );
  }

  return (
    <div className={AUTH_BACKDROP}>
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-1">
          <CardTitle className="text-2xl font-bold">Choose a new password</CardTitle>
          <CardDescription>
            {tokenValid
              ? "Pick something you haven't used here before."
              : "This reset link can't be used."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!tokenValid ? (
            <div className="space-y-4">
              <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">
                {tokenError}
              </div>
              <Button asChild className="w-full">
                <Link href="/forgot-password">Request a new link</Link>
              </Button>
            </div>
          ) : done ? (
            <div className="space-y-4">
              <div className="p-3 rounded-md bg-green-500/10 text-green-700 dark:text-green-400 text-sm flex items-start gap-2">
                <CheckCircle2 className="size-4 shrink-0 mt-0.5" />
                <span>Your password has been reset. Taking you to the sign-in page…</span>
              </div>
              <Button asChild variant="outline" className="w-full">
                <Link href="/login">Sign in now</Link>
              </Button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">{error}</div>
              )}
              <div className="space-y-2">
                <Label htmlFor="password">New password</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="new-password"
                  placeholder="Create a strong password"
                />
                <p className="text-xs text-muted-foreground">{PASSWORD_REQUIREMENTS}</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirmPassword">Confirm new password</Label>
                <Input
                  id="confirmPassword"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  autoComplete="new-password"
                />
              </div>
              <Button type="submit" className="w-full" disabled={saving}>
                {saving ? "Saving..." : "Reset password"}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<div className={AUTH_BACKDROP} />}>
      <ResetPasswordForm />
    </Suspense>
  );
}
