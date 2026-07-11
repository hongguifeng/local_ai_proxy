# Operations guide

## Data layout and permissions

`--config-file` selects the JSON configuration. `--log-root` is the default root for targets whose `logRoot` is null. Each effective root contains `traffic.db`; SQLite uses WAL during operation. Configuration and database files are restricted to the service account where the platform permits it.

Use absolute paths for scheduled tasks and services. Do not place live data in the extracted application directory if upgrades replace that directory. Full request/response bodies and API keys are sensitive even when optional redaction is enabled.

## Backup, retention and uninstall

For a consistent offline backup:

1. Stop LLM Proxy and wait for process exit.
2. Copy the config file and every effective log root, including `traffic.db` and any `-wal`/`-shm` files that remain.
3. Verify the copied database with `PRAGMA integrity_check` before expiring the older backup.

The runtime runs bounded retention while storage is idle, using `retention.days` and a task capacity ceiling. Low free disk marks storage degraded but does not interrupt proxy forwarding. Admin cleanup can additionally remove selected tasks or apply age/count policies.

Uninstall by stopping the process, removing the npm package or portable application directory, then separately deciding whether to retain or delete config/log roots. Package removal never intentionally deletes user data.

Python users must follow [the one-time migration guide](migration_guide.md). Rollback keeps the untouched Python source; Node does not dual-write or provide reverse migration.

## Health and monitoring

- `GET /api/v1/health`: liveness, readiness, degraded state, storage state, and proxy counts.
- `GET /api/v1/metrics`: bounded internal request, traffic, storage queue, and label-cardinality metrics.
- stdout/stderr: Pino JSON by default; set `LLM_PROXY_PRETTY_LOGS=1` for local readable logs.

Treat `ready: false`, `storage: failed`, repeated storage warnings, queue drops, or failed proxies as actionable. A degraded storage path keeps forwarding traffic but may omit captures.

## Troubleshooting

| Symptom | Checks and action |
| --- | --- |
| Startup usage error | Run `llm-proxy --help`; validate integer port, paths, and remote-admin flags |
| Admin port in use | Choose `--port`; inspect the owning process; do not reuse a proxy listener port |
| Proxy listener failed | Check duplicate host/port, local firewall, privileges, and the proxy runtime error code |
| Remote admin rejected | Supply both `--allow-remote-admin` and `--admin-token`/`LLM_PROXY_ADMIN_TOKEN`; send `Authorization: Bearer ...` |
| TLS/DNS upstream 502 | Verify target URL, DNS, system trust store, proxy/firewall policy, and upstream availability |
| Upstream 504 | Increase the relevant connect/header/idle timeout only after checking upstream latency |
| SQLite busy/locked | Stop other writers, keep one LLM Proxy instance per database, and avoid network filesystems |
| Storage degraded | Check free disk and permissions; inspect queue/Worker warnings; forwarding remains best-effort |
| UI not loading | Check `/api/v1/health`, confirm package includes `dist/public`, and bypass stale reverse-proxy caches |
| Package/native addon failure | Use supported Windows x64 or glibc Linux x64 with Node 24; reinstall from a clean directory |

Inbound TLS termination is not built in. Bind admin/proxy to loopback or a private interface and place a hardened reverse proxy in front when TLS is required. Preserve streaming and disable response buffering for SSE routes.

## Release and rollback

Release tags are annotated `v*` tags. The release workflow performs clean quality gates, builds npm and Windows portable artifacts, audits dependencies/licenses, creates checksum/SBOM/provenance, optionally signs Node.exe, smokes the exact final files, attests them, and uploads a GitHub Release.

```bash
git tag -a vX.Y.Z -m "LLM Proxy vX.Y.Z"
git push origin vX.Y.Z
```

Before rollout, verify the ZIP checksum and archive the current config/data. Roll forward by extracting/installing to a new application directory while reusing explicit external data paths. Roll back by stopping the new process and starting the previous artifact against a database schema it supports. If a release includes a schema migration, restore the matching offline backup instead of opening a newer database with older code.

Never publish a release if format, lint, typecheck, unit/integration/browser tests, package smoke, checksum, SBOM, license audit, or migration rehearsal fails.
