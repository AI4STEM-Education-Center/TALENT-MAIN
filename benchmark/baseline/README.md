# Committed baselines

Each file here is one passing tier-1 run's `summary.json`, used by
`benchmark/collect/compare.ts` as the reference a new run is judged against.

`local-<scenario>.json` — the tier-1 baseline for that scenario. `local-regression.json`
is the one CI gates on.

## Why baselines are committed but run artifacts are not

Absolute latency from the local Docker image is not portable — a dev machine has
more cores than the EC2 host and an NVMe fsync profile EBS cannot match. What
*is* portable is the delta between two commits measured on the same machine with
the same dataset, and that requires a reference in the repository, versioned
alongside the code it describes.

Everything else a run produces (raw k6 JSON, metric series, container logs) is
large and reproducible from the scenario plus the dataset seed, so `results/` is
gitignored.

## Establishing or updating one

```bash
benchmark/run-local.sh --update-baseline
```

`compare.ts` only promotes a run that passes. That is deliberate: writing a
regressed run into the baseline would ratchet the budget upward and hide the
regression permanently.

## When to re-baseline on purpose

- **An intentional performance change.** A new index or a removed N+1 should move
  the numbers; re-baseline so later runs are judged against the new normal.
- **A dataset change.** Changing the seed's scale or shape invalidates every
  stored number. `compare.ts` warns when the seed or scale differs, but it cannot
  correct for it.
- **A new machine.** Baselines are machine-specific. A laptop and a CI runner
  need separate baselines; comparing across them produces confident nonsense,
  which is why `compare.ts` refuses to compare across *tiers* outright.

Do **not** re-baseline to make a red CI run go green. That is the one use of this
directory that defeats its purpose.
