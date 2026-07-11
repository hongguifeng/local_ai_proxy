# Security Policy

Report suspected vulnerabilities privately to the project maintainers. Do not include production secrets, API keys, captured prompts, database files, or personal data in an issue.

The supported development line is the latest commit on the active release branch. Security fixes may remove or change internal APIs without compatibility shims.

Admin access is loopback-only by default. Remote binding requires both `--allow-remote-admin` and an admin bearer token. Deployments should additionally restrict network access with an operating-system firewall or reverse proxy and use TLS before traffic leaves the host.
