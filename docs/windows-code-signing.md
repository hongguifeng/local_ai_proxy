# Windows Code Signing

## Current release policy

Release builds are currently unsigned because no organization certificate or managed signing service
has been provisioned for this project. Electron Builder is configured with `forceCodeSigning: false`,
so CI can produce an installer and portable executable without secret signing material.

Unsigned downloads can trigger Microsoft Defender SmartScreen warnings. Release notes must state this
until signing is enabled, and users should verify `SHA256SUMS.txt` before running an artifact.

## Enabling signing later

Electron Builder supports a certificate supplied through `CSC_LINK` and `CSC_KEY_PASSWORD`. Store both
as protected GitHub Actions secrets, restrict release workflow access, and set `forceCodeSigning: true`
once a test-signed RC has been validated. A managed service such as Azure Trusted Signing can be used
instead, but choosing and funding that service is an operational decision outside this refactor.

Signing must cover both the NSIS installer and portable executable. Timestamping is required so an
artifact remains valid after certificate expiry. Never commit certificate files or passwords.
