# MCP Troubleshooting

## Server does not start

Run:

```bash
pnpm harbor mcp serve
```

If the process exits immediately:

- run `pnpm build`
- confirm Node.js 20+ is installed
- confirm the client is launching the built CLI, not the TypeScript source

## Client cannot connect

Print a fresh client config:

```bash
pnpm harbor mcp config claude-code
pnpm harbor mcp config codex
pnpm harbor mcp config cursor
```

Use the exact `command` and `args` from the generated output.

## Missing session id

List local sessions:

```bash
pnpm harbor sessions list
```

Inspect one:

```bash
pnpm harbor sessions inspect <session-id>
```

If you do not have a session yet, create one from the client with `harbor_open_session` or from the CLI with:

```bash
pnpm harbor init /path/to/repo
```

## Approval loop

Harbor approvals are explicit and do not auto-retry.

The expected sequence is:

1. a tool returns `approval_required`
2. the user approves
3. the client calls `harbor_grant_approval`
4. the client retries the original tool

If the loop continues:

- check that the retried tool is using the same `sessionId`
- check that `effectClass` and `targetId` from the approval request were passed to `harbor_grant_approval`
- if using `scope: "task"`, make sure the same `taskId` is reused

Inspect active grants:

```bash
pnpm harbor approvals list <session-id>
```

## Publish denied

Preview what Harbor wants to publish:

```bash
pnpm harbor review <session-id>
pnpm harbor publish <session-id> --yes
```

If publish returns `approval_required`, grant publish approval and retry.

If publish returns `denied`, inspect the policy preset:

```bash
OPENHARBOR_POLICY_PRESET=strict pnpm harbor review <session-id>
```

## Adapter approval confusion

List test adapters:

```bash
pnpm harbor call <session-id> tests.listAdapters
```

Run an adapter with explicit approval:

```bash
pnpm harbor test <session-id> pnpm-test --approve --approve-scope once
```

If you want less friction, use the `permissive` preset for local testing:

```bash
pnpm harbor init ./repo --policy-preset permissive
```

## Artifact lookup failures

Artifacts are session-scoped. Make sure both ids are correct:

```bash
pnpm harbor artifact get <session-id> <artifact-id> --text
```

If the artifact came from a test run, inspect recent runs first:

```bash
pnpm harbor review <session-id>
pnpm harbor call <session-id> tests.listRuns --input '{}'
```
