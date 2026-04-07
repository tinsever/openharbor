# Harbor v0 Plan

## Purpose

Harbor v0 is a safe execution layer for AI code agents.

Its goal is to prove one core idea:

> An agent should be able to do useful work by running code in a constrained runtime while all real-world effects are mediated by typed, policy-aware capabilities.

v0 is not the full Harbor vision. It is a focused product for code work that demonstrates the execution model, trust model, and approval UX.

The primary v0 user story is:

> "Inspect a codebase, prepare a fix in draft space, run approved tests, and ask the user to publish the resulting diff."

---

## Product definition

Harbor is a sandboxed runtime for agent logic with host-owned capabilities for side effects.

In v0:

- the model can run JavaScript or TypeScript in a constrained runtime
- the model cannot access the raw OS directly
- the model cannot read arbitrary files, open arbitrary network connections, spawn unrestricted processes, or access secrets directly
- the model performs work through a small SDK of typed capabilities
- mutable work lands in a session overlay first
- publication to the real repo requires explicit approval
- all capability calls and outputs are logged for audit and replay

The product should feel like a reviewable workbench, not a shell.

---

## Non-goals for v0

Harbor v0 should not try to solve every automation use case.

Specifically, v0 does not need:

- multi-language runtimes
- broad browser automation
- generalized remote API integrations
- desktop automation
- arbitrary package installation
- unrestricted shell access
- native integrations for many services
- end-user policy authoring for every advanced case
- a third-party capability marketplace
- perfect determinism across every adapter

v0 should optimize for correctness of the execution model, not breadth.

---

## Success criteria

Harbor v0 succeeds if it can demonstrate the following:

1. **Useful work without ambient authority**  
   The agent can inspect a repo, prepare edits, and run tests without raw shell access.

2. **Readable, low-fatigue approvals**  
   Users approve meaningful actions like publishing a diff, not low-level commands.

3. **Trust through draft-first execution**  
   Users can inspect draft changes and test results before publication.

4. **Small, coherent model-facing API**  
   The capability SDK is compact, typed, and discoverable.

5. **Auditable execution**  
   The system can answer what happened, what was proposed, what was approved, and what was published.

---

## v0 scope

### Primary domain

Code work on a mounted local repository.

### Supported task shape

- inspect repository structure
- search code
- read files
- write draft changes into an overlay
- view diffs between base and overlay
- run approved test adapters
- collect test output as artifacts
- request user approval to publish draft changes back to the repo

### User roles

In v0, assume a single local user or a trusted team pilot. Multi-tenant SaaS hardening can come later.

### Deployment shape

Start with a local-first developer product:

- CLI
- minimal local web UI or TUI for review and approval
- local session store
- local mounted repo

A local-first deployment keeps the trust model narrower and reduces early infra complexity.

### Product packaging and Pi integration strategy

Harbor should be buildable as a standalone execution kernel that can integrate into many hosts.

For v0, the recommended product shape is:

- **Harbor core** as a standalone set of packages for runtime, capability hosting, policy, overlays, artifacts, and audit
- **Harbor CLI** as a Harbor-branded developer product built on top of the Pi SDK rather than as only a thin Pi extension

This is the preferred v0 path because it balances speed and architectural independence.

#### Why this is the preferred v0 option

Using Pi as the host shell gives Harbor a fast path to a usable developer experience:

- model and provider management already exist
- sessions and event streaming already exist
- TUI and interactive workflows already exist
- SDK embedding already exists
- RPC mode remains available for other hosts later

At the same time, Harbor must keep its own execution model and authority boundaries.

That means:

- Harbor should not be defined as "Pi plus some prompts"
- Harbor capabilities, policy, overlays, and approvals should live in Harbor-owned packages
- Pi should be treated as a host interface and agent shell, not as Harbor's security boundary

#### Practical implication for v0

Build a dedicated `harbor` CLI that uses the Pi SDK for:

- model access
- session lifecycle
- event handling
- interactive terminal UI primitives

But keep Harbor-specific logic in separate packages:

- capability host
- policy engine
- overlay workspace
- artifact store
- audit log
- approval flow

This preserves a future path where Harbor can later be embedded into:

- its own native UI
- IDEs
- server products
- other agent shells
- remote orchestration systems

#### Secondary integration path

A Pi extension or Pi package can still be useful as a prototype, demo, or compatibility layer.

But it should be treated as an integration target, not the full definition of Harbor.

---

## Core product experience

### Happy path

1. User opens Harbor on a repo.
2. Harbor mounts the repo read-only.
3. Harbor creates a new session with a writable overlay.
4. The user asks for a task such as fixing a bug.
5. The model runs JS/TS in the Harbor runtime.
6. The runtime calls typed capabilities to inspect the repo and prepare edits.
7. Draft edits accumulate in the overlay.
8. The model requests a test run through an approved adapter.
9. Test results are stored as artifacts.
10. Harbor presents:
    - a natural-language summary
    - a structured list of changed files
    - a diff view
    - a test summary
    - a publish action
11. The user approves or rejects publication.
12. On approval, Harbor applies the overlay changes to the repo and records the publish event.

### What the user should see

The user should not see tool spam.

They should see:

- what the agent investigated
- what draft it produced
- what tests it ran
- what effect requires approval
- what exactly will be published

---

## System architecture

Harbor v0 should be built as a small host system around an untrusted execution runtime.

### Major components

#### 1. Session manager

Responsible for:

- creating sessions
- assigning session IDs
- attaching resources such as the mounted repo
- tracking lifecycle state
- coordinating overlay, artifacts, and audit logs

#### 2. Sandbox runtime

Responsible for:

- executing model-authored JS/TS
- exposing only the Harbor SDK bridge
- enforcing time, memory, and output limits
- denying direct filesystem, network, subprocess, and secret access

This runtime is where agent logic lives, but it is not where authority lives.

#### 3. Capability host

Responsible for:

- registering capabilities
- validating inputs and outputs with schemas
- routing calls to implementations
- attaching effect metadata
- collecting audit events

This is the main host-owned API surface.

#### 4. Policy engine

Responsible for:

- evaluating whether a capability request is allowed, denied, draft-only, or approval-gated
- considering effect type, resource target, session context, and grants
- producing human-readable approval intents

#### 5. Overlay workspace

Responsible for:

- maintaining a writable draft layer over a read-only repo
- storing edited file versions
- generating diffs against the base repo
- supporting publish or discard

#### 6. Adapter layer

Responsible for wrapping low-level systems safely.

In v0 this includes:

- search adapter, likely backed by `rg`
- diff adapter, likely backed by `git diff` or an internal diff engine
- test adapter, backed by tightly scoped subprocess execution

Adapters are host-side implementation details, not model-facing abstractions.

#### 7. Artifact store

Responsible for:

- storing large outputs outside model context
- test logs
- search result bundles
- generated reports
- replayable outputs

#### 8. Approval and review UI

Responsible for:

- showing intent-level approval requests
- diff review
- test summaries
- publish confirmation
- grant scoping such as once or this session

#### 9. Audit log

Responsible for append-only or tamper-evident recording of:

- model runs
- capability calls
- policy decisions
- approvals
- artifacts
- publish actions

---

## Data flow

### Execution flow

1. User task enters the session.
2. Model generates JS/TS logic.
3. Sandbox executes that logic.
4. Logic calls a Harbor capability.
5. Capability host validates request schema.
6. Policy engine evaluates the effect and target.
7. If allowed, the host executes via capability implementation or adapter.
8. Output is schema-validated and returned to the runtime.
9. Audit events are recorded.
10. If the effect is publish-scoped, Harbor creates an approval request instead of executing immediately.
11. On approval, the host performs the action and records the result.

### Publish flow

1. Agent prepares overlay changes.
2. User opens diff review.
3. Harbor presents a single intent such as:
   - publish 4 file changes to repo X
4. User approves once or rejects.
5. Harbor applies overlay changes to the repo.
6. Audit log records the approval and commit-like publish result.

---

## Trust model

### Core principle

Model-authored code is untrusted.

The real authority boundary is the host capability layer, not the script language.

### What is trusted in v0

- Harbor host process
- policy engine
- capability implementations
- adapter implementations
- local approval UI
- local storage for sessions, overlays, and artifacts

### What is untrusted or less trusted

- model-authored code
- model-produced inputs
- model-produced plans and patches
- potentially repo contents, because they can contain prompt injection or malicious fixtures
- adapter outputs, which should be treated as untrusted data

### Threats to defend against in v0

1. **Ambient authority escape**  
   Model code attempts direct filesystem, network, subprocess, or secret access.

2. **Confused deputy behavior**  
   Model attempts to use a broad capability to act outside intended resource scope.

3. **Prompt injection through repository content**  
   A file tells the model to exfiltrate data or expand scope.

4. **Unsafe test execution**  
   A test command becomes a path to broad shell access or external side effects.

5. **Capability misuse through malformed inputs**  
   Model submits invalid, oversized, or malicious payloads.

6. **Approval fatigue**  
   Users stop understanding what they are approving.

7. **Audit gaps**  
   The system cannot reconstruct what actions occurred.

### Out-of-scope threats for early local v0

- full multi-tenant hostile isolation guarantees
- kernel-level adversaries on the host machine
- nation-state-grade local compromise

These matter later, but should not block a local-first pilot.

---

## Security model

### Security invariants

Harbor v0 should enforce the following invariants:

1. Model code cannot directly access the host OS.
2. All side effects must flow through capabilities.
3. Every capability call must have schema validation.
4. Every capability must carry explicit effect metadata.
5. The repo mount is read-only to the runtime.
6. Draft changes only affect the overlay until publish approval.
7. Test execution runs through explicit adapters with bounded scope.
8. Publish actions are approval-gated by default.
9. All meaningful actions are auditable.

### Sandboxing requirements

The runtime should:

- expose no Node filesystem APIs
- expose no unrestricted network APIs
- expose no child process APIs
- expose no dynamic package installation
- expose no unrestricted module loading
- enforce execution timeout
- enforce memory limits
- enforce output size limits
- limit serialization payload sizes

### Adapter isolation requirements

Host-side adapters should run with minimal privileges.

For v0:

- test adapters should only run approved commands from a project config allowlist
- adapter working directories should be constrained to the mounted repo or session workspace
- network for test adapters should be disabled by default if practical
- environment variables should be scrubbed by default
- secret injection should not exist in v0 unless explicitly required

---

## Capability model

Harbor v0 should expose a very small model-facing SDK.

### Capability shape

Every capability should define:

- name
- description
- input schema
- output schema
- effect classification
- target/resource descriptor
- example calls
- approval behavior
- audit payload shape

### Initial capability set

#### Repo capabilities

- `repo.listDir(path)`
- `repo.readFile(path)`
- `repo.search(query, options)`
- `repo.stat(path)`

Effects:
- read:repo

#### Workspace capabilities

- `workspace.writeFile(path, content)`
- `workspace.applyPatch(patch)`
- `workspace.deleteFile(path)`
- `workspace.readFile(path)`
- `workspace.diff(options)`
- `workspace.listChanges()`
- `workspace.reset(paths?)`

Effects:
- write:draft
- read:draft

#### Test capabilities

- `tests.listAdapters()`
- `tests.run(adapter, args?)`
- `tests.getResult(runId)`

Effects:
- execute:adapter
- read:artifact

#### Artifact capabilities

- `artifacts.put(data, metadata)`
- `artifacts.get(id)`
- `artifacts.list()`

Effects:
- write:artifact
- read:artifact

#### Publish capabilities

- `publish.preview()`
- `publish.request()`

Effects:
- publish:repo

Actual publication should remain approval-gated and host-mediated.

### Effect taxonomy for v0

Keep the taxonomy simple.

- `read.repo`
- `read.draft`
- `write.draft`
- `execute.adapter`
- `read.artifact`
- `write.artifact`
- `publish.repo`
- `destructive.repo` if needed later

### Target model

Every call should identify its target in structured form.

Examples:

- repo path subtree
- workspace overlay path
- named test adapter
- artifact ID
- mounted resource ID

This allows policy to reason about scope without interpreting strings heuristically.

---

## Policy model

### Policy decisions

For v0, policy can return one of four outcomes:

- `allow`
- `deny`
- `allow_with_limits`
- `require_approval`

### Default v0 policy

- repo reads: allow
- draft reads: allow
- draft writes: allow
- artifact writes: allow
- test adapter execution: allow only for approved adapters
- publish to repo: require approval
- destructive repo actions outside publish flow: deny

### Grants

Support lightweight grants with narrow scope:

- once
- this task
- this session

In v0, grants should probably only apply to repeated test execution or repeated publish previews, not broad privilege escalation.

### Policy authoring

Do not build a fully general policy language yet.

Start with a structured configuration format such as:

- mounted resource definitions
- adapter allowlists
- approval defaults by effect class
- target scopes

A code-level policy engine is acceptable for v0 if the decision outputs are structured.

---

## Overlay model

The overlay is central to Harbor v0.

### Requirements

- mounted repo is read-only
- overlay stores draft file contents and deletions
- reads can resolve against base repo plus overlay
- diffs compare overlay against base repo
- publish applies overlay changes to the real repo only after approval
- discard clears overlay state

### Design choice

Use a simple session-local overlay representation:

- base resource ID
- changed files map
- deleted files set
- metadata for author, timestamp, and rationale

Do not over-engineer a full virtual filesystem if a straightforward layered file model is sufficient for v0.

---

## Artifacts

Artifacts should keep large or noisy outputs out of the model context.

### v0 artifact types

- test logs
- diff bundles
- search result sets
- execution traces

### Requirements

- artifact IDs are stable within a session
- artifact metadata is typed
- large text is truncated for model display but fully stored for review
- artifacts are linkable from audit entries and UI panels

---

## Runtime recommendation for v0

### Recommendation

Use a JavaScript-first constrained runtime based on V8 isolates or a similarly embeddable, sandbox-friendly JS engine.

If implementation speed matters more than perfect isolation for the first local pilot, a tightly restricted JS runtime with explicit host bridge and no Node ambient APIs is acceptable, but the architecture should preserve a path to stronger isolation.

### Why JS/TS first

- strong fit for agent-generated control flow and data transformation
- natural JSON and schema ergonomics
- portable SDK design
- easier to embed than a full general-purpose machine
- aligns with future capability packs and typed APIs

### Runtime tradeoff analysis

#### Option A: V8 isolates / Workers-style runtime

Pros:
- stronger conceptual separation from the host
- natural capability bridge model
- good long-term path

Cons:
- more implementation effort
- limits around module support may complicate early ergonomics

#### Option B: QuickJS

Pros:
- lightweight
- embeddable
- easy to reason about

Cons:
- smaller ecosystem expectations
- weaker developer familiarity
- may need more custom plumbing

#### Option C: Node `vm` as a prototype

Pros:
- fastest path to developer iteration
- low setup cost

Cons:
- weakest trust story
- easiest to misuse
- should not be the long-term security foundation

### Recommended stance

For Harbor v0:

- prototype quickly if needed
- but structure the host/runtime boundary as if the runtime were fully untrusted
- avoid designs that depend on Node ambient APIs
- plan to move to isolate-style execution before broader deployment

---

## Adapters and low-level tooling

Harbor should use low-level tools internally where practical, but not expose them directly to the model.

### v0 adapters

#### Search adapter

Likely backed by `rg`.

Requirements:
- bounded working directory
- structured results
- line/column metadata
- output size limits

#### Diff adapter

May be backed by:
- internal textual diff
- `git diff --no-index`
- libgit bindings later

Return structured file-level and hunk-level diff objects.

#### Test adapter

Run only project-approved commands such as:

- `npm test -- --runInBand`
- `bun test`
- `pnpm vitest run path/to/test`

The adapter should expose a typed interface like:

- adapter name
- allowed arguments shape
- timeout
- environment policy
- artifact output

### Principle

Shell may still exist under the hood, but only inside host-owned adapters with fixed semantics.

---

## Developer experience

### Model-facing DX

The SDK should be small and obvious.

Example shape:

```ts
const files = await harbor.repo.search({ query: "createUser", glob: "src/**/*.ts" })
const current = await harbor.repo.readFile({ path: "src/user.ts" })
await harbor.workspace.writeFile({ path: "src/user.ts", content: updated })
const diff = await harbor.workspace.diff({ paths: ["src/user.ts"] })
const testRun = await harbor.tests.run({ adapter: "unit", target: "src/user.test.ts" })
const publish = await harbor.publish.preview()
```

The model should not need to learn many unrelated tools.

### Human-facing DX

Users should get:

- session history
- diff review
- test summary
- publish button
- discard button
- clear explanation of denied or approval-gated actions

### Capability discovery

For v0, avoid dynamic capability discovery complexity.

Ship a fixed core SDK and expose capability metadata to the model in a compact manifest.

---

## Repository structure proposal

A monorepo is the simplest v0 choice.

```text
harbor/
  apps/
    harbor-cli/
    review-ui/
  packages/
    core/
    runtime/
    sdk/
    host/
    capabilities-core/
    policy/
    overlay/
    artifacts/
    audit/
    adapters-search/
    adapters-diff/
    adapters-test/
    pi-integration/
    schemas/
    shared/
  examples/
    sample-repo/
  docs/
    architecture.md
    threat-model.md
    capability-spec.md
    policy-spec.md
    pi-integration.md
```

### Package responsibilities

#### `packages/core`
Harbor-owned domain layer for capability semantics, effect types, approval objects, and shared execution contracts.

#### `packages/runtime`
Sandbox execution environment and host bridge.

#### `packages/sdk`
Model-facing SDK types and helpers.

#### `packages/host`
Session orchestration, resource mounting, capability routing.

#### `packages/capabilities-core`
Repo, workspace, publish, test, and artifact capability definitions.

#### `packages/policy`
Decision engine and grant handling.

#### `packages/overlay`
Draft storage, reads, writes, and diff input preparation.

#### `packages/artifacts`
Artifact store and retrieval.

#### `packages/audit`
Audit event schema and persistence.

#### `packages/adapters-*`
Low-level tool wrappers.

#### `packages/pi-integration`
Bridge layer between Harbor core and the Pi SDK. This package should adapt Harbor sessions, approvals, and review flows into Pi-hosted CLI behavior without making Pi the source of Harbor semantics.

#### `packages/schemas`
Shared zod or JSON Schema definitions for inputs and outputs.

#### `apps/harbor-cli`
Harbor-branded CLI built on the Pi SDK plus Harbor integration packages.

---

## Implementation milestones

## Milestone 0: Design lock

### Deliverables

- written architecture doc
- written threat model
- capability spec for v0
- policy defaults
- overlay semantics
- adapter contract
- Pi integration boundary doc describing what is borrowed from Pi versus what remains Harbor-owned

### Exit criteria

- all core abstractions are named and stable enough to implement
- team agrees on runtime approach for prototype and target hardening path

---

## Milestone 1: Core host skeleton

### Build

- session manager
- capability registry
- schema validation layer
- audit event model
- local session persistence
- Harbor core package boundaries independent of Pi

### Exit criteria

- host can register a capability, validate input/output, execute implementation, and write audit records

---

## Milestone 2: Runtime bridge

### Build

- constrained JS execution environment
- Harbor SDK bridge
- timeout and memory controls
- basic execution trace capture

### Exit criteria

- model-authored JS can call host capabilities
- direct filesystem/network/process access is unavailable in the runtime

---

## Milestone 3: Repo + overlay capabilities

### Build

- read-only repo mount
- overlay storage
- repo read capabilities
- workspace read/write capabilities
- diff generation

### Exit criteria

- the agent can inspect files, write drafts, and produce a reviewable diff without touching the real repo

---

## Milestone 4: Test adapter

### Build

- adapter definition format
- approved local test adapter
- artifact capture for stdout/stderr/results
- timeout and environment restrictions

### Exit criteria

- agent can run approved tests and attach results to the session

---

## Milestone 5: Approval UX and publish flow

### Build

- review UI or TUI panels
- publish preview
- approval request objects
- publish execution to the mounted repo
- discard overlay
- Pi-hosted Harbor CLI review flow using the Pi SDK

### Exit criteria

- user can inspect a diff, inspect tests, approve publish, and see an audit trail

---

## Milestone 6: End-to-end agent workflow

### Build

- prompt and orchestration loop for coding tasks
- sample task suite
- dogfood against small repos
- failure mode instrumentation

### Exit criteria

- Harbor completes the target user story repeatedly on real example repos

---

## Milestone 7: Hardening pass

### Build

- adversarial repo fixtures
- prompt injection tests
- oversized output tests
- adapter misuse tests
- audit integrity checks
- tighter runtime isolation if prototype started weaker

### Exit criteria

- v0 is robust enough for pilot users

---

## What to defer

To keep v0 real, defer the following:

- browser capabilities
- remote API mutation capabilities
- secrets mediation UX
- multi-tenant hosted deployment
- third-party capability packs
- generalized policy language for enterprises
- complex resource graphs across many systems
- collaborative approval workflows
- deterministic replay of every runtime step
- non-JS runtimes

---

## Policy and approval UX proposal

### UX principles

- approvals must describe intent, not mechanics
- repeated low-risk actions should not spam the user
- draft work should be visible by default
- publication should be a single meaningful boundary crossing

### Approval objects

An approval request should include:

- action type: publish diff
- target: repo name and path scope
- summary: changed files and high-level description
- evidence: diff and test results
- scope: once / task / session when applicable

### Example approval text

- Publish 3 file changes to `openharbor`
- Run approved test adapter `unit` again for this session

### Rejection handling

If the user denies publication, Harbor should allow:

- revise draft
- discard draft
- request clarification

---

## Evaluation plan

Harbor v0 should be evaluated on both usefulness and safety.

### Usefulness metrics

- task completion rate on small repo tasks
- number of successful fix-and-test workflows
- average time to publish-ready diff
- number of manual user interventions required

### Safety and trust metrics

- number of approval prompts per task
- percentage of prompts judged understandable by users
- number of blocked unsafe actions
- number of actions with incomplete audit trace
- success rate under prompt injection fixtures

### Quality metrics

- diff correctness
- test pass rate after publish
- artifact usefulness
- user confidence rating

---

## Top technical risks and mitigations

### 1. Runtime isolation is weaker than intended

Mitigation:
- keep the host boundary strict from day one
- avoid Node ambient APIs in the model runtime
- plan an isolate-based hardening path early

### 2. Test adapters become shell escape hatches

Mitigation:
- allowlist adapter commands
- restrict arguments
- scrub environment
- enforce timeouts and directory bounds
- disable network where possible

### 3. Capability surface grows too quickly

Mitigation:
- freeze a minimal v0 SDK
- route complexity into host-side adapters, not model-facing APIs

### 4. Overlay implementation becomes too magical

Mitigation:
- keep the model simple: layered file map over a read-only repo
- defer generalized VFS complexity

### 5. Approval UX becomes noisy

Mitigation:
- only gate publish and high-risk adapter execution
- batch related actions into one intent
- support narrow grants for repetition

### 6. Prompt injection in repo contents causes scope drift

Mitigation:
- treat repo content as untrusted
- keep target scope fixed by mounted resources and policy
- do not allow model text to expand authority

### 7. Audit logs become incomplete or inconsistent

Mitigation:
- make audit writes part of the capability execution path
- define audit schemas early
- fail closed on missing critical audit events

---

## Relationship to existing ecosystems

Harbor should integrate with existing tools without inheriting their abstractions.

### CLIs

CLIs are useful implementation backends for adapters.
They should not be the model-facing interface.

### Git and repository tooling

Git can power diffs and publication mechanics, but Harbor should present changes as typed draft and publish concepts.

### Tool servers and external protocols

External tool ecosystems can be wrapped as capabilities when useful.
The wrapping layer must add:

- schemas
- effect metadata
- target scoping
- policy hooks
- audit semantics

### Existing "safe shell" systems

Systems like `just-bash` are relevant as inspiration or substrate, but Harbor should remain centered on capability-mediated authority rather than shell-mediated execution.

---

## Rollout strategy

### Phase 1: Local developer alpha

Target users:
- technical founders
- friendly design partners
- internal dogfooding

Distribution shape:
- Harbor-branded CLI built on the Pi SDK
- optional Pi package for early internal testing

Goal:
- validate execution model and approval UX on code tasks

### Phase 2: Team pilot

Add:
- shared session history
- clearer policy presets
- stronger audit exports
- better adapter management

Goal:
- validate trust and review workflows for small teams

### Phase 3: Generalized capability packs

Expand into:
- docs drafting and publishing
- support reply drafting and sending
- browser observation and action plans
- approved API reads and mutations

Goal:
- prove Harbor is a general execution layer, not only a code agent tool

---

## Recommended first build choices

To keep momentum high, choose the simplest options that preserve the architecture.

### Recommended v0 choices

- local-first deployment
- JS-first runtime
- minimal fixed capability SDK
- repo read + workspace draft + tests + publish only
- code-level policy engine with structured rules
- session-local overlay storage
- file-backed artifact and audit stores
- TUI or very lightweight web UI for review and publish

These choices are enough to prove the Harbor thesis without overcommitting to premature platform complexity.

---

## Final recommendation

Harbor v0 should be built as a narrow but principled code-agent product.

Do not build a safer shell.
Build a constrained runtime with a tiny capability SDK, a draft overlay, a readable approval boundary, and an audit trail.

If v0 can reliably deliver:

- inspect repo
- draft fix
- run approved tests
- show diff
- publish on approval

without granting ambient machine authority, then Harbor will have proven its core claim.

That is the right foundation for everything that comes next.
