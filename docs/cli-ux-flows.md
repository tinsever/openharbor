# CLI UX Flows (Top 10)

This checklist defines the top 10 end-to-end CLI flows used to validate Harbor v1 UX and review ergonomics.

## Flow coverage

1. `init -> read -> write -> diff -> review -> publish`
2. `init -> run --code/--file -> review -> publish`
3. `test` with approval scopes (`once`, `task`, `session`)
4. `publish` approval-required/denied remediation path
5. `discard` specific paths then `review`
6. `reject` then `revise`
7. `approvals list/revoke` lifecycle flow
8. `audit inspect/search/replay` follow-up flow
9. policy preset switching (`permissive`, `balanced`, `strict`) impact flow
10. Pi bridge flow with approval-required/denied messaging parity

## Validation expectations

- Successful steps include a clear `Next:` action.
- Approval-required, denied, and validation outcomes include taxonomy metadata (`category`, `errorCode`) and remediation guidance.
- `harbor review --json` returns a stable machine-readable review bundle.
- Existing script-oriented JSON output contracts remain parse-compatible.
