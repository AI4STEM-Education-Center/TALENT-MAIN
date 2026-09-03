"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, KeyRound, Loader2, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatDateTime } from "./format";

interface IngestionToken {
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokedUseCount?: number | null;
  lastRevokedUseAt?: string | null;
  lastRevokedIp?: string | null;
}

function formatDate(value: string | null) {
  return value ? formatDateTime(value) : "Never";
}

/** One-time reveal of a freshly minted secret, with copy-to-clipboard. */
function NewSecret({ secret }: { secret: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-4">
      <p className="text-sm font-medium">Copy this token now — it is not shown again.</p>
      <p className="mt-1 text-xs text-muted-foreground">
        Paste it into the GitHub Actions secret for this environment, or into{" "}
        <code className="font-mono">pressure/.env</code> for local runs. Nothing needs to be added
        to the server&apos;s <code className="font-mono">.env</code>.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded bg-background px-3 py-2 font-mono text-xs">
          {secret}
        </code>
        <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
          {copied ? <Check className="mr-2 size-4" /> : <Copy className="mr-2 size-4" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}

function TokenRow({ token, onRevoke }: { token: IngestionToken; onRevoke: (id: string) => void }) {
  const revokedUsed = !!token.revokedAt && (token.revokedUseCount ?? 0) > 0;
  return (
    <tr className={`border-b last:border-0 ${revokedUsed ? "bg-destructive/10" : ""}`}>
      <td className="py-3 pr-4">
        <div className="font-medium flex items-center gap-2">
          {token.name}
          {revokedUsed && <ShieldAlert className="size-4 text-destructive" aria-label="Possible leak" />}
        </div>
        <div className="mt-1 font-mono text-xs text-muted-foreground">{token.tokenPrefix}…</div>
        {revokedUsed && (
          <div className="mt-1 text-xs text-destructive">
            Used {token.revokedUseCount}× after revocation
            {token.lastRevokedUseAt ? ` — last ${formatDate(token.lastRevokedUseAt)}` : ""}
            {token.lastRevokedIp ? ` from ${token.lastRevokedIp}` : ""}. Possible leak — check where the old
            value is still stored.
          </div>
        )}
      </td>
      <td className="py-3 pr-4">
        {token.revokedAt ? (
          <span className="flex flex-col gap-1 items-start">
            <Badge variant="destructive">Revoked</Badge>
            {revokedUsed && <Badge variant="destructive">Used after revoke</Badge>}
          </span>
        ) : (
          <Badge variant="default">Active</Badge>
        )}
      </td>
      <td className="py-3 pr-4 whitespace-nowrap">{formatDate(token.createdAt)}</td>
      <td className="py-3 pr-4 whitespace-nowrap">{formatDate(token.lastUsedAt)}</td>
      <td className="py-3 text-right">
        {!token.revokedAt && (
          <Button type="button" variant="ghost" size="sm" onClick={() => onRevoke(token.id)}>
            Revoke
          </Button>
        )}
      </td>
    </tr>
  );
}

/**
 * Generates and revokes this deployment's result-ingestion tokens. Dev and
 * production each keep their own, so switching environments means visiting that
 * site's admin page rather than editing server configuration.
 */
export function IngestionTokens() {
  const [tokens, setTokens] = useState<IngestionToken[]>([]);
  const [name, setName] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // `creating` re-renders the button; these refs are what actually block a
  // second in-flight request, since a state update is not visible synchronously.
  const creatingRef = useRef(false);
  const revokingRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/admin/pressure-tokens", { cache: "no-store" });
      if (!response.ok) throw new Error(`Request failed (${response.status})`);
      const body = await response.json();
      setTokens(body.tokens ?? []);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load ingestion tokens.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    const label = name.trim();
    if (!label || creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/pressure-tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: label }),
      });
      if (!response.ok) {
        const failure = await response.json().catch(() => ({}));
        throw new Error(failure.error ?? `Request failed (${response.status})`);
      }
      const body = await response.json();
      setSecret(body.secret);
      setName("");
      await load();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Could not create token.");
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  const revoke = async (id: string) => {
    if (revokingRef.current) return;
    revokingRef.current = true;
    setError(null);
    try {
      const response = await fetch(`/api/admin/pressure-tokens/${id}`, { method: "DELETE" });
      if (!response.ok) throw new Error(`Request failed (${response.status})`);
      await load();
    } catch (revokeError) {
      setError(revokeError instanceof Error ? revokeError.message : "Could not revoke token.");
    } finally {
      revokingRef.current = false;
    }
  };

  const leaked = tokens.filter((t) => t.revokedAt && (t.revokedUseCount ?? 0) > 0);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle>Result ingestion tokens</CardTitle>
        <KeyRound className="size-4 text-muted-foreground" />
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Tokens generated here authorize <code className="font-mono">POST /api/pressure-results</code>{" "}
          on this deployment only. Generate one on dev and one on production, then store each in the
          matching GitHub Actions secret.
        </p>

        {leaked.length > 0 && (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive flex items-start gap-2"
          >
            <ShieldAlert className="size-4 shrink-0 mt-0.5" />
            <span>
              {leaked.length === 1 ? (
                <>
                  Revoked token <strong>{leaked[0].name}</strong> was used {leaked[0].revokedUseCount}× after
                  revocation{leaked[0].lastRevokedIp ? ` (last from ${leaked[0].lastRevokedIp})` : ""}. Every
                  admin was emailed — this may point to a token leak. Remove the old value wherever it is
                  still stored.
                </>
              ) : (
                <>
                  {leaked.length} revoked tokens were used after revocation — this may point to a token leak.
                  Every admin was emailed. Remove the old values wherever they are still stored.
                </>
              )}
            </span>
          </div>
        )}

        {error && (
          <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {secret && <NewSecret secret={secret} />}

        <form onSubmit={create} className="flex flex-wrap items-end gap-3">
          <label className="grid min-w-56 flex-1 gap-1.5 text-sm">
            <span className="font-medium">Label</span>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="GitHub Actions — dev"
              maxLength={80}
            />
          </label>
          <Button type="submit" disabled={creating || name.trim().length === 0}>
            {creating && <Loader2 className="mr-2 size-4 animate-spin" />}
            Generate token
          </Button>
        </form>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-3 pr-4">Label</th>
                <th className="py-3 pr-4">Status</th>
                <th className="py-3 pr-4">Created</th>
                <th className="py-3 pr-4">Last used</th>
                <th className="py-3" />
              </tr>
            </thead>
            <tbody>
              {!loading && tokens.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-muted-foreground">
                    No tokens yet. Generate one to let CI publish results here.
                  </td>
                </tr>
              )}
              {tokens.map((token) => (
                <TokenRow key={token.id} token={token} onRevoke={(id) => void revoke(id)} />
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
