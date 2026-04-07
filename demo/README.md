# Demo

Small scripted walkthrough of the Harbor host: session creation, `repo.readFile`, `workspace.writeFile`, `workspace.diff`, `publish.preview`, and a `publish.request` that stops at policy (`ApprovalRequiredError`).

## Run

From the repository root (after `pnpm install` and `pnpm build`):

```bash
pnpm demo
```

Or from this folder:

```bash
pnpm start
```

## Outputs

- **Session data** is written under `demo/.harbor-data/` (gitignored). Delete that folder to reset local session storage for the demo.
- The sample repo under `sample-repo/` is not modified by the demo script; overlay drafts are stored in the session store until a future publish flow applies them.
