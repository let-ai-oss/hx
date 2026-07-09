# Security Policy

`hx` is a per-device background daemon that stores a device token
(`~/.let/hx/config.json`, mode `0600`), mints signed upload URLs, and mirrors
local AI session transcripts to a remote gateway. Because it auto-updates and
handles credentials, we take security reports seriously.

## Supported Versions

`hx` auto-updates to the newest released build (`hx update`). Only the latest
released version is supported; older versions cannot be pinned for security
fixes.

| Version        | Supported          |
| -------------- | ------------------ |
| latest release | :white_check_mark: |
| older releases | :x:                |

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report privately through either channel:

- **Preferred:** GitHub Private Vulnerability Reporting — the "Report a
  vulnerability" button under this repository's **Security** tab
  (<https://github.com/let-ai-oss/hx/security/advisories/new>).
- **Email:** security@let.ai. If you would like to encrypt your report, ask for
  our current PGP key in your first (unencrypted) message and we will provide
  its fingerprint before you send any sensitive details.

Please include the affected version/commit, impact, and reproduction steps.
Findings against the self-update path, credential storage, or the
transcript-upload pipeline are prioritized.

## Response Targets

| Stage                              | Target                  |
| ---------------------------------- | ----------------------- |
| Acknowledge receipt                | within 2 business days  |
| Initial assessment / triage        | within 7 days           |
| Fix or coordinated-disclosure plan | within 90 days          |

## Scope

In scope: this repository's source and released binaries. Out of scope:
third-party dependencies (report upstream), social engineering, and physical
attacks. The gateway/host lives in `hx-fortress`; the wire protocol in
`hx-protocol`.

### Self-update trust model

`hx` updates itself by fetching a binary and its SHA-256 from the gateway's
download proxy over HTTPS (HTTP is permitted only for the loopback `--local`
dev gateway). The SHA-256 protects integrity in transit but not provenance:
today the trust chain is **the gateway's honesty plus TLS**, with no publisher
signature verified against a key pinned in the client. A compromised or
successfully impersonated gateway could therefore serve attacker bytes with a
matching checksum. Adding a pinned-key publisher signature over releases is
tracked hardening; see the trust-boundary note at the top of `src/update.ts`.

## Safe Harbor

We will not pursue legal action against researchers who act in good faith,
avoid privacy violations and service disruption, and give us a reasonable
opportunity to remediate before public disclosure.
