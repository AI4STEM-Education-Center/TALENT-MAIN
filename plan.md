# Branching, Versioning & Release Plan

## Current State

- Single `main` branch, auto-deploys on every push
- No versioning (`package.json` says `0.1.0`, no git tags, no changelog)
- No version UI component

## Proposed Workflow

### 1. `dev` branch as the default working branch

- All feature work happens on `dev` (or feature branches off `dev`)
- `dev` gets a separate CI workflow that builds & tests but does NOT deploy to production

### 2. Release process: `dev` → `main` via squash merge

- When ready to release, bump the version in `version.json` and update `CHANGELOG.md`
- Create a PR from `dev` to `main`, squash merge it
- On merge to `main`, the existing deploy workflow fires and also creates a git tag

### 3. Version tracking files

- `version.json` at repo root: `{ "version": "1.9.3", "date": "2026-03-18" }`
- `CHANGELOG.md` at repo root: structured markdown with version sections
- These get baked into the Docker image at build time

### 4. Updated CI/CD

- `deploy.yml`: triggers on push to `main`, tags the Docker image with the version from `version.json`, creates a git tag
- New `ci.yml`: triggers on push to `dev` and PRs, runs build validation only (no deploy)

### 5. Frontend version display

- A version badge in the sidebar/footer showing e.g. "v1.9.3"
- A modal (matching the design in the screenshots) that shows the changelog when clicked
- Reads version and changelog at build time via Next.js

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `version.json` | Create | Single source of truth for version |
| `CHANGELOG.md` | Create | Human-readable release notes |
| `.github/workflows/deploy.yml` | Modify | Add version tagging, git tag creation |
| `.github/workflows/ci.yml` | Create | Build validation for `dev` branch |
| `src/lib/version.ts` | Create | Read version + changelog at build time |
| `src/components/version-modal.tsx` | Create | The UI modal from the screenshots |
| Sidebar component | Modify | Add version badge that opens the modal |
| `docker/Dockerfile` | Modify | Bake version info into build |
