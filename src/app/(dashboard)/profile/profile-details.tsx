"use client";
import { useCallback, useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertTriangle, Check, Loader2, Save, UserRound } from "lucide-react";

interface Profile {
  firstName: string;
  lastName: string;
  email: string;
  username: string;
  role: string;
  createdAt: string;
}

/** Fixed locale + UTC so the server and the browser render the same string. */
function formatJoined(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function ProfileDetails() {
  // update() re-issues the JWT so the sidebar picks up a renamed account.
  const { update } = useSession();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [form, setForm] = useState({ firstName: "", lastName: "", email: "" });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/profile");
      if (res.ok) {
        const { profile: p } = (await res.json()) as { profile: Profile };
        setProfile(p);
        setForm({
          firstName: p.firstName,
          lastName: p.lastName,
          email: p.email,
        });
      } else {
        setBanner({ type: "error", text: "Could not load your profile." });
      }
    } catch {
      setBanner({ type: "error", text: "Could not load your profile." });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setBanner(null);
    setSaving(true);
    try {
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) {
        setBanner({
          type: "error",
          text: data.error || "Could not save your changes.",
        });
      } else {
        setProfile(data.profile);
        setBanner({ type: "success", text: "Profile updated." });
        // Must pass an argument: next-auth's update() only POSTs (and so only
        // fires the jwt callback's "update" trigger, which re-reads the row)
        // when it is given data. update() with no arguments silently degrades
        // to a plain GET of the existing cookie, refreshing nothing. The value
        // itself is unused — src/lib/auth.ts re-reads from the database rather
        // than trusting a client-supplied patch.
        await update({});
      }
    } catch {
      setBanner({ type: "error", text: "An unexpected error occurred." });
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[200px]">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-2xl">
      {banner && (
        <div
          className={`p-3 rounded-md text-sm flex items-start gap-2 ${
            banner.type === "success"
              ? "bg-green-500/10 text-green-700 dark:text-green-400"
              : "bg-destructive/10 text-destructive"
          }`}
        >
          {banner.type === "success" ? (
            <Check className="size-4 shrink-0 mt-0.5" />
          ) : (
            <AlertTriangle className="size-4 shrink-0 mt-0.5" />
          )}
          <span>{banner.text}</span>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <UserRound className="size-4" /> Account details
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSave} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="firstName">First name</Label>
                <Input
                  id="firstName"
                  value={form.firstName}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, firstName: e.target.value }))
                  }
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="lastName">Last name</Label>
                <Input
                  id="lastName"
                  value={form.lastName}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, lastName: e.target.value }))
                  }
                  required
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={form.email}
                onChange={(e) =>
                  setForm((p) => ({ ...p, email: e.target.value }))
                }
                required
                autoComplete="email"
              />
              <p className="text-xs text-muted-foreground">
                Used to sign in and to reach you — password reset links go here.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="username">Username</Label>
                <Input
                  id="username"
                  value={profile?.username ?? ""}
                  disabled
                  readOnly
                />
                <p className="text-xs text-muted-foreground">
                  Your username can&apos;t be changed. Ask an administrator if
                  you need it updated.
                </p>
              </div>
              <div className="space-y-2">
                <Label>Role</Label>
                <p className="text-sm capitalize pt-2">
                  {profile?.role.toLowerCase()}
                </p>
                {profile && (
                  <p className="text-xs text-muted-foreground">
                    Member since {formatJoined(profile.createdAt)}
                  </p>
                )}
              </div>
            </div>

            <Button type="submit" disabled={saving}>
              {saving ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Save className="size-4" />
              )}
              {saving ? "Saving..." : "Save changes"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
