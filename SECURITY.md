# Security policy

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/Galinum/galinum/security/advisories/new) for suspected vulnerabilities.

If GitHub private reporting is unavailable, email
[nahuel@galinum.com](mailto:nahuel@galinum.com).

Include:

- The affected commit or version.
- Reproduction steps or a minimal proof.
- The expected and actual security boundary.
- Any known workaround.

Do not include secrets, customer data, or an exploit in a public issue.

## Supported versions

Galinum has not published a stable release. Security fixes currently target the latest `main` commit. This policy will list supported release lines before the first public release.

## Product boundary

This repository does not contain Galinum Cloud billing, tenant provisioning, managed credentials, or operations. Report a boundary violation as a security issue even when no credential is present.
