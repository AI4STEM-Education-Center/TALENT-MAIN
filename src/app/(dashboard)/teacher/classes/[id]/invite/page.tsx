"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, Copy, Check, Link2, Plus } from "lucide-react";

interface Invitation {
  id: string;
  token: string;
  url: string;
  expiresAt: string | null;
  maxUses: number | null;
  usedCount: number;
  active: boolean;
}

export default function InvitePage() {
  const { id: classId } = useParams<{ id: string }>();
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [expiresInDays, setExpiresInDays] = useState("");
  const [maxUses, setMaxUses] = useState("");
  const [loading, setLoading] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [msg, setMsg] = useState("");

  const appUrl = typeof window !== "undefined" ? window.location.origin : "";

  useEffect(() => {
    fetch(`/api/classes/${classId}`)
      .then((r) => r.json())
      .then((data) => {
        const invs = (data.invitations || []).map((inv: { token: string } & Invitation) => ({
          ...inv,
          url: `${appUrl}/invite/${inv.token}`,
        }));
        setInvitations(invs);
      });
  }, [classId, appUrl]);

  async function generateLink() {
    setLoading(true);
    try {
      const res = await fetch("/api/invitations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          classId,
          expiresInDays: expiresInDays ? Number(expiresInDays) : undefined,
          maxUses: maxUses ? Number(maxUses) : undefined,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setInvitations((prev) => [data, ...prev]);
        setMsg("Invitation link created!");
        setExpiresInDays("");
        setMaxUses("");
      }
    } finally {
      setLoading(false);
    }
  }

  async function copyLink(url: string, id: string) {
    await navigator.clipboard.writeText(url);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  }

  return (
    <div className="p-6 space-y-6 max-w-2xl">
      <Button variant="ghost" size="sm" asChild>
        <Link href={`/teacher/classes/${classId}`}><ArrowLeft className="w-4 h-4" /> Back to class</Link>
      </Button>

      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2"><Link2 className="w-5 h-5" /> Invite Students</h1>
        <p className="text-muted-foreground text-sm mt-1">Share an invitation link with students to let them join this class.</p>
      </div>

      {msg && <div className="p-3 rounded-md bg-primary/10 text-primary text-sm">{msg}</div>}

      {/* Generate Form */}
      <Card>
        <CardHeader><CardTitle>Generate New Link</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="expires">Expires in (days)</Label>
              <Input id="expires" type="number" min="1" placeholder="Never" value={expiresInDays} onChange={(e) => setExpiresInDays(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="maxUses">Max uses</Label>
              <Input id="maxUses" type="number" min="1" placeholder="Unlimited" value={maxUses} onChange={(e) => setMaxUses(e.target.value)} />
            </div>
          </div>
          <Button onClick={generateLink} disabled={loading}>
            <Plus className="w-4 h-4" /> {loading ? "Generating..." : "Generate Link"}
          </Button>
        </CardContent>
      </Card>

      {/* Existing Links */}
      {invitations.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Active Links</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {invitations.map((inv) => (
              <div key={inv.id} className="p-3 rounded-lg border space-y-2">
                <div className="flex items-center gap-2">
                  <code className="flex-1 text-sm bg-muted px-2 py-1 rounded font-mono truncate">{inv.url}</code>
                  <Button size="sm" variant="outline" onClick={() => copyLink(inv.url, inv.id)}>
                    {copiedId === inv.id ? <><Check className="w-3 h-3" /> Copied</> : <><Copy className="w-3 h-3" /> Copy</>}
                  </Button>
                </div>
                <div className="flex gap-4 text-xs text-muted-foreground">
                  <span>{inv.usedCount}{inv.maxUses ? `/${inv.maxUses}` : ""} uses</span>
                  {inv.expiresAt && <span>Expires {new Date(inv.expiresAt).toLocaleDateString()}</span>}
                  {!inv.expiresAt && !inv.maxUses && <span>No expiry or use limit</span>}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
