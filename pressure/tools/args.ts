/**
 * Minimal argv parser shared by every TypeScript tool in the harness.
 *
 * Accepts BOTH `--key value` and `--key=value`. That is not gold-plating: the
 * shell runners pass `--key value`, a human typing a command usually writes
 * `--key=value`, and a parser that silently handles only one form turns every
 * flag from the other into the string "true" — a bug that produces a run that
 * looks fine and measured the defaults.
 */
export type Args = {
  /** Named options. A bare `--flag` is `true`. */
  opts: Record<string, string | true>;
  /** Positional arguments, in order. */
  rest: string[];
};

export function parseArgs(argv: string[] = process.argv.slice(2)): Args {
  const opts: Record<string, string | true> = {};
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      rest.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) {
      opts[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    // A following token that itself starts with `--` is the NEXT flag, not this
    // flag's value, so `--dry-run --count 5` parses as {dry-run: true, count: "5"}.
    if (next !== undefined && !next.startsWith("--")) {
      opts[body] = next;
      i++;
    } else {
      opts[body] = true;
    }
  }

  return { opts, rest };
}

export function str(args: Args, name: string, fallback?: string): string {
  const value = args.opts[name];
  if (value === undefined || value === true) {
    if (fallback !== undefined) return fallback;
    throw new Error(`--${name} is required and needs a value`);
  }
  return value;
}

export function num(args: Args, name: string, fallback: number): number {
  const value = args.opts[name];
  if (value === undefined || value === true) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} must be a number, got "${value}"`);
  return parsed;
}

export function bool(args: Args, name: string): boolean {
  const value = args.opts[name];
  // `--flag`, `--flag=true` and `--flag true` all mean true; `--flag=false` means false.
  if (value === undefined) return false;
  if (value === true) return true;
  return value !== "false" && value !== "0";
}
