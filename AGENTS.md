# Project Notes for Coding Agents

- This project is still in active development. Do not preserve old internal API behavior by default.
- When changing UI/admin API contracts, prefer the simplest current design over backward-compatible shims unless the user explicitly asks for compatibility.
- Whenever implementing a new feature, add or update the corresponding documentation.
- When the UI is changed, the README screenshots (`doc/ui_*.png`, referenced by README.md and README.cn.md) must be updated before committing: run `npm run regen:ui-baselines` to re-capture them and refresh the baseline hashes in `docs/refactoring/ui-visual-baseline.md`.
