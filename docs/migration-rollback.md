# Migration and Rollback Procedure

## Before starting Node or Electron

1. Stop every Python proxy/tray process so no process is writing `traffic.db`.
2. Copy the configured `proxies.json` and the complete log directory to a backup location on another
   disk when possible. Preserve `traffic.db`, `traffic.db-wal`, and `traffic.db-shm` together if they
   exist.
3. Ensure free disk space is at least 2.4 times the current `traffic.db` size.
4. Start the Node CLI once with the intended `--config-file` and `--log-root`, then verify `/api/health`,
   the proxy list, and several History records before enabling production traffic.
5. Run `npm run validate:migration -- <log-root>` from a built checkout and save its JSON output.

The first Node config save also creates `proxies.json.before-node-<timestamp>.bak` beside the config.
This automatic file is an additional safeguard, not a replacement for the external backup.

## Roll back configuration only

1. Exit the tray application or send SIGTERM to the Node CLI and wait until all listening ports close.
2. Rename the current `proxies.json` for diagnosis.
3. Copy the selected `proxies.json.before-node-*.bak` (or external backup) to the configured config path.
4. Start the previous release and verify its proxy list before enabling pairs.

## Roll back configuration and history

1. Stop Node/Electron and confirm no process has `traffic.db` open.
2. Rename the current log directory; do not delete it until rollback is accepted.
3. Restore the backed-up log directory as one unit, including any WAL/SHM files captured with it.
4. Restore the config as described above.
5. Start the previously accepted release artifact or the previous Git tag checkout. For the legacy
   Python release, use its own virtual environment and documented Python command from that tag.
6. Confirm task/record counts and sample content, send a test request through each enabled pair, then
   retain both the failed and restored copies until the incident is closed.

Never copy only a live `traffic.db` while writers are active. Use the application's SQLite backup path
or stop all writers first; otherwise recent WAL transactions may be omitted.
