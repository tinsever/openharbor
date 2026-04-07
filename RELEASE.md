# Release Guardrails

This repository uses release guardrails to keep releases reproducible and reviewable.

## Branch and merge policy

- Merge to `main` only after CI is green.
- Require pull requests for changes to `main`.
- Keep `main` releasable at all times.

## Required checks

Before release, ensure these pass on the target commit:

- `pnpm build`
- `pnpm lint`
- `pnpm test`
- `pnpm demo`

## Versioning policy

- Use semantic version tags: `vMAJOR.MINOR.PATCH`.
- Tag from `main` only.
- Do not reuse or move tags.

## Release checklist

1. Confirm local branch is up to date with `main`.
2. Run `pnpm install --frozen-lockfile`.
3. Run required checks locally.
4. Update `CHANGELOG.md`:
   - Move relevant items from `Unreleased` into a new version section.
   - Add release date in `YYYY-MM-DD` format.
5. Commit changelog updates on `main`.
6. Create and push tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
7. Verify `Release Guardrails` workflow passes for the tag.
8. Create GitHub release notes from the new changelog section.

## Rollback guidance

- If a tagged release fails guardrails, fix on `main`, retag with a new patch version, and release again.
- Never force-move release tags.
