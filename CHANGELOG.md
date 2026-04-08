# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-04-08

### Added
- `harbor review --json` machine-readable review bundle and `--verbose` diff detail mode.
- CLI UX validation doc for top 10 end-to-end command flows.
- `@openharbor/agent-bridge` as a protocol-agnostic integration layer over Harbor host APIs.
- `@openharbor/mcp-server` with `stdio` transport and task-oriented MCP tools for agent shells.
- `harbor mcp serve` and `harbor mcp config <client>` commands for MCP-first setup.
- `harbor sessions list`, `harbor sessions inspect`, and `harbor artifact get` CLI commands.
- Session overview APIs and local session enumeration support in the Harbor host.
- MCP troubleshooting documentation and MCP smoke/integration coverage.

### Changed
- Unified CLI help output from a single command usage catalog with core-flow examples.
- Added CLI error taxonomy metadata and remediation guidance across usage, validation, approval, and denial outcomes.
- Improved inspect -> draft -> test -> review -> publish messaging with explicit `Next:` guidance.
- Added integration coverage for review/publish UX and taxonomy metadata, including Pi bridge parity checks.
- Repositioned Harbor around an MCP-first, local-first workflow for `Claude Code`, `Codex`, and `Cursor`.
- Reduced Pi integration to a compatibility wrapper over the new agent bridge.
- Extended the policy/effect model with external effect classes for future incident and cross-app workflows.

## [0.1.0] - 2026-04-08

### Added
- CI workflow for build, lint, test, and demo smoke.
- Release guardrails workflow for tagged releases.
- Release checklist and process guide.

## [0.0.1] - 2026-04-08

### Added
- Initial Harbor v0 implementation.
