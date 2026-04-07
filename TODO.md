# Harbor v0 TODO

A coding agent can consider Harbor v0 "done" when the items below are implemented and working end to end.

## 1. Core architecture

- [x] Create a monorepo structure for Harbor v0 using Turborepo and PNPM
- [x] Add `apps/harbor-cli`
- [x] Add core packages for runtime, host, capabilities, policy, overlay, artifacts, audit, adapters, and Pi integration
- [x] Define shared schemas for capability input/output and audit events
- [x] Document the Pi integration boundary and keep Harbor semantics in Harbor-owned packages

## 2. Session and resource model

- [x] Implement session creation and lifecycle management
- [x] Support mounting a local repo as a read-only resource
- [x] Create a writable session overlay tied to the mounted repo
- [x] Persist session metadata locally
- [x] Persist overlay state locally

## 3. Sandbox runtime

- [x] Implement a constrained JS/TS runtime for model-authored logic
- [x] Expose only the Harbor SDK bridge to model code
- [x] Block direct filesystem access from model code
- [x] Block direct network access from model code
- [x] Block direct subprocess access from model code
- [x] Enforce execution timeout, memory, and output limits

## 4. Capability host

- [x] Implement capability registration
- [x] Validate all capability inputs against schemas
- [x] Validate all capability outputs against schemas
- [x] Attach explicit effect metadata to every capability
- [x] Route capability calls through the policy engine before execution
- [x] Record capability calls and results in the audit log

## 5. v0 capability set

### Repo capabilities
- [x] `repo.listDir`
- [x] `repo.readFile`
- [x] `repo.search`
- [x] `repo.stat`

### Workspace capabilities
- [x] `workspace.writeFile`
- [x] `workspace.applyPatch`
- [x] `workspace.deleteFile`
- [x] `workspace.readFile`
- [x] `workspace.diff`
- [x] `workspace.listChanges`
- [x] `workspace.reset`

### Test capabilities
- [x] `tests.listAdapters`
- [x] `tests.run`
- [x] `tests.getResult`

### Artifact capabilities
- [x] `artifacts.put`
- [x] `artifacts.get`
- [x] `artifacts.list`

### Publish capabilities
- [x] `publish.preview`
- [x] `publish.request`

## 6. Overlay model

- [x] Store draft file changes in an overlay rather than the real repo
- [x] Support file creation in overlay
- [x] Support file deletion in overlay
- [x] Resolve reads against base repo plus overlay
- [x] Generate diffs between overlay and base repo
- [x] Support discard/reset of overlay state
- [x] Support publish from overlay into the real repo after approval

## 7. Policy and approval

- [x] Implement v0 policy decision types: allow, deny, allow_with_limits, require_approval
- [x] Allow repo reads by default
- [x] Allow draft reads/writes by default
- [x] Restrict test execution to approved adapters
- [x] Require approval for publish to repo
- [x] Deny destructive repo actions outside publish flow
- [x] Support scoped grants: once, this task, this session
- [x] Generate human-readable approval intents

## 8. Adapters

### Search adapter
- [x] Implement structured repo search
- [x] Bound search to mounted repo scope
- [x] Enforce output limits

### Diff adapter
- [x] Implement structured diff generation
- [x] Return file-level and hunk-level diff data

### Test adapter
- [x] Implement approved test adapter configuration
- [x] Allow only allowlisted commands
- [x] Restrict working directory
- [x] Enforce timeout
- [x] Scrub environment variables by default
- [x] Disable network where practical
- [x] Capture stdout/stderr/results as artifacts

## 9. Artifacts and audit

- [x] Implement artifact storage with stable session-local IDs
- [x] Store large logs outside model context
- [x] Link artifacts from capability results and UI
- [x] Implement append-only or tamper-evident audit records
- [x] Record model runs, capability calls, policy decisions, approvals, and publish actions

## 10. Harbor CLI on Pi SDK

- [x] Build `harbor` as a Harbor-branded CLI using the Pi SDK
- [x] Reuse Pi for model/session/event/UI plumbing where useful
- [x] Keep Harbor capability, policy, and approval semantics outside Pi-specific code
- [x] Add a Pi integration package/bridge layer
- [x] Make the Harbor CLI usable on a local repo end to end

## 11. Review and approval UX

- [x] Show a natural-language task summary
- [x] Show changed files
- [x] Show a readable diff view
- [x] Show test summary and artifact links
- [x] Show a publish action with clear intent wording
- [x] Support reject/revise/discard flows
- [x] Avoid low-level command approval spam

## 12. End-to-end coding workflow

- [x] User can open Harbor on a repo
- [x] Agent can inspect the repo through capabilities
- [x] Agent can prepare a draft fix in overlay
- [x] Agent can run approved tests
- [x] User can review diff and test results
- [x] User can approve publish
- [x] Harbor can apply the approved changes to the repo
- [x] Audit log shows the full execution trail

## 13. Hardening and validation

- [x] Add adversarial repo fixtures for prompt injection testing
- [x] Add malformed capability input tests
- [x] Add oversized output tests
- [x] Add adapter misuse tests
- [x] Add publish approval bypass tests
- [x] Add audit integrity tests
- [x] Verify model-authored code cannot escape the intended authority boundary

## 14. Minimum release bar

Harbor v0 is ready when all of the following are true:

- [x] The main user story works: inspect repo, draft fix, run tests, review diff, publish on approval
- [x] The model does useful work without raw shell access
- [x] All side effects go through typed capabilities
- [x] Draft changes stay in overlay until publish approval
- [x] Publish approval is human-readable and low-fatigue
- [x] The Harbor CLI works as a real local developer product
- [x] Core execution steps are auditable
- [x] The architecture leaves Harbor portable beyond Pi
