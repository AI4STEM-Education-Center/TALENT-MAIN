/**
 * Minimal CLI flag parsing, shared by the harness's Node entry points.
 *
 * It exists because the shell runners and a human at a terminal write flags
 * differently — `--run path` from run-local.sh, `--run=path` when typing by hand
 * — and a parser that silently accepted only one form turned every
 * space-separated flag into the string "true". That failed late, with a
 * confusing message about the wrong path.
 */

export type Flags = {
  /** Raw string value, or the fallback when absent. */
  str(name: string, fallback?: string): string | undefined;
  /** Non-negative integer, rejecting junk rather than coercing it to NaN. */
  int(name: string, fallback: number): number;
  /** Present-and-not-"false". */
  bool(name: string, fallback?: boolean): boolean;
  /** Whether the flag appeared at all (to distinguish "absent" from "false"). */
  has(name: string): boolean;
};

/**
 * Accepts `--key=value`, `--key value`, and bare `--key` (as "true").
 *
 * A bare flag immediately followed by another `--flag` is treated as a boolean
 * rather than swallowing the next flag as its value.
 */
export function parseFlags(argv: string[]): Flags {
  const values = new Map<string, string>();

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const match = /^--([^=]+)(?:=(.*))?$/.exec(token);
    if (!match) continue;

    const [, name, inlineValue] = match;
    if (inlineValue !== undefined) {
      values.set(name, inlineValue);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(name, next);
      i += 1;
    } else {
      values.set(name, "true");
    }
  }

  return {
    has: (name) => values.has(name),
    str: (name, fallback) => values.get(name) ?? fallback,
    bool: (name, fallback = false) => {
      const raw = values.get(name);
      if (raw === undefined) return fallback;
      return raw !== "false";
    },
    int: (name, fallback) => {
      const raw = values.get(name);
      if (raw === undefined) return fallback;
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`--${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
      }
      return parsed;
    },
  };
}
