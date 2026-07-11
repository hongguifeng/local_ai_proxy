# Release candidate validation

Candidate: `v0.3.0-rc.1` on Node.js 24.18.0 / pnpm 11.11.0.

## Evidence

- Windows clean gates: frozen install, format, lint, typecheck, 207 unit/component/integration tests, one Playwright workflow, build, npm package smoke, Windows portable smoke and production dependency audit.
- Linux clean environment: Ubuntu WSL isolated copy, fresh Node/pnpm install, frozen workspace install, typecheck, 207 tests, build, npm pack and installed-artifact smoke.
- Mixed-load calibration: 100 concurrent SSE streams plus 10 ordinary-request workers, with 10,000 storage queue events; zero storage failures and zero drops. A longer run remained error-free until the user explicitly approved stopping before 60 minutes.
- Migration/rollback: real redacted Python-format config and SQLite v1 data migrated to Node schema v2; source bytes stayed unchanged, target backup was created, repeat execution was detected, integrity/foreign-key/count checks passed, and invalid input left source untouched. Rollback uses the unchanged source after stopping and discarding the Node target.
- Cleanup: production runtime integration closes admin/proxy sockets; Worker tests drain and terminate storage Workers; package smokes shut down cleanly; migration staging is removed on failure. Tests use isolated temporary directories and remove them in teardown.
- Supply chain: final ZIP SHA-256 is checked by portable smoke; npm and portable artifacts are rebuilt from the annotated RC tag; production licenses and CycloneDX SBOM are generated; release workflow records provenance and attestation.

Known limitations and upgrade instructions are published in `doc/release_notes_v0.3.0-rc.1.md`, `doc/operations.md`, and `doc/migration_guide.md`.

Result: no blocking defect found; candidate is suitable for RC publication on the supported Windows x64 and glibc Linux x64 targets.
