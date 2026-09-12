# Project Notes for Coding Agents

- This project is still in active development. Do not preserve old internal API behavior by default.
- When changing UI/admin API contracts, prefer the simplest current design over backward-compatible shims unless the user explicitly asks for compatibility.
- Whenever implementing a new feature, add or update the corresponding documentation.
- When the UI is changed, the README screenshots (`doc/ui_*.png`, referenced by README.md and README.cn.md) must be updated before committing: run `npm run regen:ui-baselines` to re-capture them and refresh the baseline hashes in `docs/refactoring/ui-visual-baseline.md`.
- The recent execution history logs are located in the D:\Portable Program\llm_proxy\logs directory. Check them when needed. 
- UI-related modifications must be tested in practice by taking screenshots to verify that the interface meets expectations and is aesthetically pleasing and reasonable.
- After development is complete, the temporarily created files and processes must be cleaned up.
- After each task is completed, generate a new portable exe by executing the command: `npm run build && npm run rebuild:electron && npx electron-builder -w portable --publish never` 命令。