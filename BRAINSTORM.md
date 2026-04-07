# Harbor

_Working name. Other options: Commons, Workshop, Dock. For now, use Harbor._

## What this is

Harbor is a safe execution layer for AI agents.

The core idea is simple: agents need to do real work, but giving them raw shell access is the wrong long-term abstraction. Bash is useful today because it gives models one flexible bridge to the outside world, but it is untyped, hard to permission, hard to reason about, inconsistent across tools, and awkward to scale safely in shared environments.

Harbor should replace "the agent has a shell" with "the agent runs code in a sandbox and can only act through typed capabilities."

The model should be free to express logic. It should not have ambient authority.

In other words: the agent can think in code, but it can only touch the world through approved, structured APIs.

## Why this matters

Today, agent systems often expose one of two things.

The first is raw shell access. That is flexible, but dangerous and semantically weak. Commands are strings. Inputs and outputs are inconsistent. Safety systems have to guess whether something is read-only, destructive, reversible, or external. Approval UX becomes noisy. Users stop trusting prompts and click through them.

The second is a giant menu of tools. That is safer in theory, but often bloats context, creates discoverability problems, and still lacks a coherent permission and execution model. It also tends to fragment into many ad hoc tool interfaces that the model has to learn separately.

Harbor is meant to be a better execution substrate. It should combine the flexibility of code with the safety and structure of typed capabilities.

A useful mental model is this: Harbor should be for agents what the browser sandbox is for web pages. Web pages can run code, but they do not get raw machine access. They get browser APIs. The browser enforces boundaries. Harbor should do the same for AI work.

## Product thesis

The right architecture separates logic from authority.

The model writes logic in a constrained runtime. All side effects go through host-owned capabilities. Those capabilities have typed inputs and outputs, explicit effect metadata, and policy hooks. Draft work happens in an overlay first. Real-world changes require approval or a policy grant. Every meaningful action is observable and auditable.

This should not be framed as a dev-only product. The kernel is universal. Different domains should plug into it through capability packs. One pack may target codebases. Another may target docs. Another may target browser workflows, support systems, data workflows, or operations tooling.

The broad product should be "a safe workspace for human + AI work," not "a shell replacement for engineers."

## Design principles

Harbor should be built around a few hard principles.

First, no ambient authority. Model-authored code should not get direct filesystem, network, process, or secret access. If it can reach raw OS APIs, the trust model is already compromised.

Second, all effects should be explicit. A capability should say what kind of action it performs and what resource it targets. Policy should reason about those effects instead of trying to infer intent from command strings.

Third, draft before publish. The safest default is that agents can inspect and prepare work freely inside a private overlay, while crossing into real systems requires explicit policy or approval.

Fourth, approval should be about intentions, not low-level mechanics. The user should approve "publish these file changes" or "send this reply" rather than "allow this command."

Fifth, outputs should be structured. If the agent needs to search, filter, transform, compare, or summarize, the data should move through typed objects and artifacts, not brittle terminal text whenever possible.

Sixth, the model-facing API should stay small and stable. Harbor should not become a pile of unrelated tools. It should feel like a coherent runtime with discoverable capabilities.

Seventh, the system should be useful to normal people. Most users should never need to write code or think about policy syntax. They should see a readable description of what the agent did, what draft it produced, and what real-world action it wants to take.

## What Harbor should look like

At the center is a sandboxed runtime where the model can execute small programs. JavaScript or TypeScript is a strong first choice because it is expressive, portable, good at data handling, and easy to embed. But the platform should not be conceptually locked to TS forever. The runtime language is an implementation choice. The core product is the capability model.

The runtime talks to the host through a narrow bridge. That bridge exposes typed capabilities such as searching a repo, reading a file, writing a draft, viewing a diff, running an approved test adapter, calling an approved API, querying a browser session, or storing a large artifact. The runtime should not be allowed to escape this boundary.

A policy engine sits between the capability request and the real action. It should decide whether the requested effect is allowed, requires confirmation, should be redirected into draft-only mode, or should be denied.

A virtualized state layer sits underneath work that changes things. Read-only inputs should be mounted cleanly. Mutable work should land in an overlay first. Publication should be explicit.

An audit and replay layer should capture enough information to answer "what happened?" after the fact.

## Core abstractions

Harbor should revolve around a few simple concepts.

A session is one isolated execution context for a task, conversation, or workflow.

A capability is a typed operation exposed by the host. It has a name, description, input schema, output schema, examples, and effect classification.

An effect is a structured statement about what an operation can do. Examples include reading a file, writing a draft file, publishing a change, reading from the network, sending a network mutation, observing a browser, taking a browser action, using a secret, or running an approved adapter.

An overlay is a draft workspace layered over mounted resources. The agent should be able to prepare changes there without immediately changing the source of truth.

A commit or publish step is the explicit transition from draft work into real-world impact.

Artifacts are larger outputs kept outside the main model context. They are useful for long logs, test results, scraped data, reports, or transformed files.

Grants are temporary policy approvals that allow certain effects within a bounded scope such as once, this task, or this session.

## The user experience

The ideal Harbor experience should feel simple even if the internals are sophisticated.

A user connects some resources. These might be a repo, a documentation space, a browser session, a support inbox, or an API-backed system.

The user asks the agent to do something useful.

The agent explores safely, reads what it needs, and prepares a draft or plan inside the session workspace.

The user sees a readable summary of what happened, a concrete draft or diff, and any requested real-world actions.

The user approves only the meaningful boundary crossing.

This should feel like a workbench and a review gate, not a remote shell.

## Why Bash is not enough

Bash is a useful stepping stone but not a good destination.

A shell command is just a string. It has weak semantics from the platform’s point of view. The system often cannot reliably know ahead of time whether a command is read-only, destructive, reversible, scoped to a workspace, or capable of touching arbitrary external systems. Every CLI has its own syntax, output conventions, and destructive semantics. Safety becomes wrapper logic around a fundamentally broad and low-level interface.

Bash is also a poor place for medium-complexity agent logic. Models quickly end up writing little Python or JS snippets for filtering, grouping, transforming, and combining results. So shell is neither a great authority boundary nor a great long-term programming model.

Harbor should allow code for logic but eliminate shell as the model-facing authority layer.

## Why JS/TS is attractive

JS or TS seems like the best first runtime because it gives the model a real language for control flow and transformation without requiring a full machine. It has strong ecosystem support, good JSON ergonomics, and lightweight embed options. It also fits naturally with schema-based APIs.

But Harbor should not just become "Node with some restrictions." The runtime must be genuinely constrained. The security boundary should rely on the host capability layer and isolate model-authored code away from ambient system access. The design should not depend on trusting arbitrary npm packages or unrestricted imports.

Long term, the platform may support more than one runtime. The abstraction that should stay stable is the capability protocol and effect model.

## What capabilities might look like

The model should see a small, coherent SDK rather than raw tools.

For code work, useful capabilities include searching a mounted repo, listing directories, reading files, writing files into a workspace overlay, applying a patch, generating a diff, and running tests through approved adapters.

For API work, useful capabilities include fetching structured data from approved endpoints, with auth handled by the host instead of exposing secrets directly to the model.

For browser work, useful capabilities include taking snapshots, querying the DOM, clicking, typing, and extracting information, with clear separation between observation and action.

For document or support work, useful capabilities include reading records, drafting responses or edits, and publishing only after review.

The common pattern is that all of these are typed, policy-aware, and discoverable.

## The effect model

The effect model is one of the most important parts of Harbor.

Policy should not only know which capability is being called. It should know what kind of effect that call represents and what target it applies to.

A useful starting taxonomy includes read-like effects, draft-write effects, publish-write effects, destructive effects, sensitive effects, and coordination effects.

Read-like effects include things like filesystem reads, network reads, and browser observation.

Draft-write effects include writing to a workspace overlay or creating artifacts.

Publish-write effects include changing a real repo, sending a message, mutating a remote API, or submitting a browser action.

Sensitive effects include using a secret or invoking a powerful adapter.

The target should be explicit, too. A policy engine should be able to differentiate between reading a mounted repo, writing to a workspace overlay, sending data to an internal API, or submitting a form on a production site.

The point is that Harbor should know the meaning of actions before and during execution, not only after.

## Policy and approval

Policy should be target-aware and effect-aware.

A good policy system lets the platform express ideas like these in a clean, structured way: reads are generally allowed, writes into draft space are allowed, writes to real systems require confirmation, destructive actions are denied or escalated, and different teams or deployment contexts can have different defaults.

Approvals should be scoped and understandable. A user should be able to approve once, for this task, or for this session, depending on what makes sense. Approvals should be tied to meaningful operations and resource scopes, not one-off low-level calls.

The system should present approvals in terms of intent. It should say that the agent wants to publish a draft to four files, send a support reply, or perform a browser submission on a named site. It should not force the user to evaluate command strings or raw HTTP minutiae unless they ask for advanced detail.

## Overlay and draft model

A major product idea in Harbor is that agents should work in a draft space by default.

Mounted resources should usually be read-only. Changes should land in a session overlay. The overlay can contain edited files, generated outputs, transformed data, proposed replies, or structured action plans. The user should be able to inspect these results before they are published.

This is not only a safety feature. It is the key to making the product understandable and trustworthy for non-technical users. They can see what the agent prepared before it becomes real.

This draft-first model should exist across domains. For code, it is a diff. For docs, it is a document revision. For support, it is a draft reply. For browser actions, it may be a queued action plan plus a final confirmation before submission.

## How Harbor should scale to everyone

The kernel should be universal. The domain-specific parts should come from capability packs and different product surfaces.

One person may use Harbor locally on their laptop to work with personal files and browser workflows.

A team may use Harbor with shared policy, approval workflows, identity integration, and audit history.

A software platform may embed Harbor as its own agent execution engine.

That suggests three main deployment shapes: personal, team, and platform.

The same trust model should carry across all of them.

To make Harbor broadly usable, the top-layer experiences should differ by audience even if the core stays the same. Developers may use an SDK or CLI. Everyone else should get a simple interface where they connect resources, ask the agent to work, inspect the draft, and approve publication.

## Relationship to existing ecosystems

Harbor should not require the world to start over.

Existing CLIs, APIs, and tool servers can be wrapped behind Harbor capabilities. Bash and other command-line tools may still exist inside adapters, but they should no longer be the model-facing abstraction.

Likewise, external tool protocols can be integrated if they are useful, but Harbor’s core responsibility is different. The point here is not just transport. The point is safe execution, typed effects, overlays, policy, and approvals.

Harbor can be compatible with other ecosystems without inheriting their weakest abstractions.

## First target use case

The first implementation should probably focus on code work because it is concrete and easy to demonstrate.

A good initial user story is: "Find a bug, prepare a fix, run tests, and show me the diff."

That story naturally exercises read capabilities, draft writes, adapter execution, artifact handling, and a final publish approval. It is also a familiar benchmark workflow for agent tooling.

But the implementation should be careful not to bake repo-specific assumptions too deeply into the kernel. The code use case is the proving ground, not the whole product.

## Suggested v0

A practical v0 should allow a model to run JS in a constrained runtime with access to a small SDK for repo and workspace operations.

The mounted repo should be read-only. A writable session workspace should hold draft changes. Search may be backed by ripgrep under the hood. Diffs may be backed by git or a custom patch layer. Tests may be run through tightly controlled adapters rather than raw subprocess access. Large outputs should become artifacts rather than flooding model context.

The approval UI can be simple at first. It only needs to show the resulting diff, a test summary, and a publish action. If that flow feels clean, the architecture is probably on the right path.

## Technical constraints

The security model should not rely on "please don't use this API." The runtime should genuinely lack ambient authority.

Raw filesystem access, raw network access, unrestricted subprocess creation, arbitrary package installation, and unrestricted module loading should not be available to model-authored code in v0.

The host should validate capability inputs and outputs at runtime using schemas. The system should impose resource limits such as time, memory, output size, and network usage. Adapters that wrap risky external tools should be isolated and minimal. Audit logs should be append-only or at least tamper-evident enough for debugging and trust.

A core principle is that the capability boundary, not the script language itself, is the real permission boundary.

## Product goals

The product should aim for a few clear outcomes.

It should let agents do real work without giving them broad machine power.

It should make policies and approvals understandable enough that normal users can trust what is happening.

It should let a single execution model support many domains, not just coding.

It should reduce context burden by replacing giant tool menus with a compact capability SDK and capability discovery.

It should scale from personal use to team use to embedded platform use.

It should be practical to build incrementally, with CLI wrappers as early adapters and more native integrations later.

## Non-goals for the first version

The first version does not need to solve all automation forever.

It does not need full desktop automation, arbitrary package installation, unrestricted language runtimes, perfect standardization, or native integrations for every service.

It does not need to expose every internal mechanism to end users.

It should focus on proving that a capability-first execution layer is a better foundation than shell-first agents.

## Open questions

There are still important choices to make.

Should the first runtime be based on V8 isolates, Deno-like permissions, a Workers-style environment, QuickJS, or something else?

How much of the capability layer should be schema-driven versus code-driven?

How should policy rules be represented and edited for non-technical users without becoming too simplistic for advanced users?

How should capability discovery work so the model can learn tools just in time rather than carrying a giant system prompt?

How should secrets be mediated so the model can use identities and auth profiles without seeing raw credentials?

How should browser actions be represented so that "observe" and "act" remain clearly separated?

How should the system support replay, evaluation, and deterministic debugging?

What is the right packaging model for capability packs so that third parties can extend Harbor safely?

How much should Harbor standardize versus merely host arbitrary adapters?

What is the best migration path from today's shell-heavy agents to Harbor-powered agents?

## What I want from the planning model

Please take this brainstorm and turn it into a concrete plan for building Harbor.

I want a plan that covers product shape, architecture, security model, developer experience, and rollout strategy.

Please produce the following:

A concise product definition in plain language.

A proposed system architecture with major components and data flow.

A clear trust and threat model, including how untrusted model-authored code is contained and where the real authority boundary lives.

A capability model proposal, including how schemas, effect classification, policy evaluation, overlays, approvals, and artifacts should work together.

A recommended runtime approach for v0, with tradeoffs.

A proposed repository structure and service breakdown for implementation.

A v0 build plan with milestones, dependencies, and what to defer.

A roadmap from code-agent v0 toward a broader "for everyone" platform with capability packs for docs, browser workflows, support, and data work.

A policy and approval UX proposal that avoids prompt fatigue and keeps semantics human-readable.

A list of top technical risks and how to mitigate them.

A view on how Harbor should relate to existing ecosystems such as CLIs, remote tools, and external protocols.

A recommendation on branding and product packaging if Harbor is the chosen name.

Please optimize for clarity and practicality over maximal scope. The goal is to build a real product, not just describe an ideal future.

## Closing thought

The core bet behind Harbor is that agents need a real execution layer, but that layer should look more like a sandboxed capability runtime than a shell.

If this is right, then Harbor is not "another tool API." It is a safer operating model for AI work.

# just-bash
You can take a look at just-bash: https://github.com/vercel-labs/just-bash

Right — this isn’t “it” yet.

It’s very good work, and it’s moving in the right direction, but it’s still mostly solving the problem of “how do we give an agent a safer shell-like environment?” Your idea is bigger than that. You want “how do we give an agent a safe execution model?”

That difference matters.

`just-bash` clearly improves on raw shell access. It gives you a virtual filesystem, overlays, network allow-lists, execution limits, optional JS/Python, and a threat model. That’s all real progress. It means the industry is already feeling the same pressure you’re describing: plain Bash is too loose, so people are adding structure, sandboxing, and policy around it.

But the center of gravity is still the shell.

The main abstraction is still: create a bash environment, run commands, optionally let those commands call extra runtimes. Even `js-exec` is basically “run JavaScript inside the shell world.” That is useful, but it still means the model is operating inside a fairly low-level execution environment rather than against a first-class capability system.

What’s still missing is intent.

In the system you’re describing, the platform should know, in a structured way, that the agent is reading a repo file, drafting a change, publishing a change, reading from an API, or taking an external action. Those meanings should exist before execution as part of the API contract. In `just-bash`, most of the semantics still come from interpreting commands or from the host deciding what filesystem and network options to expose. That is safer than raw shell, but it’s not the same as effect-typed capabilities.

Another way to say it: `just-bash` is still centered on environment restriction. What you want is authority modeling.

That’s the gap.

A few examples make this clearer. In your system, a write to a draft workspace and a write to a real system should be different kinds of action. In `just-bash`, that distinction mostly comes from which filesystem implementation you mounted, not from the command interface itself. In your system, approval should happen on a meaningful intent like “publish these 3 changes.” In `just-bash`, there isn’t really a native approval model at that level. In your system, policy should be able to say “allow reads, allow draft writes, confirm publish, deny destructive external mutation.” In `just-bash`, policy is much more about what environment exists and which low-level features are turned on.

That means it is an excellent substrate, but not yet the final abstraction.

Also, the README says something important very plainly: “All execution happens without VM isolation.” That’s a completely reasonable tradeoff for many use cases, but it tells you this is not yet the universal multi-tenant trust foundation for “everyone” by itself. It may be great for local workflows, testing, controlled environments, and as a building block. But the product you’re imagining needs a stronger story around host-mediated authority, approvals, auditability, and broad non-technical usability.

So my honest read is:

`just-bash` is a strong evolutionary step away from raw shell.
It is not yet the full model you want.

The cleanest framing is probably this:

`just-bash` solves “safe-ish shell execution for agents.”
Harbor should solve “safe agent execution, with shell only as an optional backend.”

That means you probably should not think of it as a competitor to your idea. You should think of it as one possible implementation component.

For example, Harbor could expose a typed capability like `repo.search()`, and under the hood that capability might use `just-bash` with `rg` or shell-compatible tooling in a constrained overlay. Or Harbor could use pieces of the same ideas: virtual filesystems, overlays, allow-listed networking, isolated language runtimes. But the model-facing abstraction would still be capabilities and effects, not “please write commands.”

So no — this ain’t it yet.

It is closer than plain Bash.
It is evidence the direction is real.
But it is still one layer too low.

If you want, I can do the next useful thing and write a very sharp “Harbor vs just-bash” note you can drop into your brainstorm, so the planning LLM understands exactly what exists already and what gap Harbor is supposed to fill.