# DCS Document Management & Distribution Platform

A secure, high-confidentiality document management and distribution platform tailored for legal and sensitive business documents (NDAs, mandates, engagement agreements, and dynamically configured document types).

Built as a modular monolith:
- `packages/shared`: Shared TypeScript types, schemas (Zod), permissions, password policy, metadata definitions.
- `packages/api`: Node.js (v24), Express, TypeScript, Prisma ORM, PostgreSQL (v14+).
- `packages/web`: React 18, Vite, Tailwind CSS, Radix UI.

---

## 1. Security & Architecture Core Principles

- **Zero-Knowledge Storage / Envelope Encryption:** Files are encrypted at rest using AES-256-GCM chunked envelope encryption. Each version has its own randomly generated Data Encryption Key (DEK), wrapped with a 256-bit Key Encryption Key (KEK) identified by `FILE_ENCRYPTION_KEY_ID`.
- **Integrity & Immutability:** SHA-256 checksums are verified on upload and re-verified on download. The audit log uses a cryptographic SHA-256 hash chain with PostgreSQL triggers preventing `UPDATE`, `DELETE`, or `TRUNCATE`.
- **Quarantine Pipeline:** Files are written directly to quarantine, inspected for malicious PDF structures, scanned via ClamAV (when enabled), and only promoted to clean storage once cleared.
- **Gmail Integration:** Individual user OAuth via Google REST APIs strictly limited to `gmail.send` scope. User tokens are stored encrypted at rest using a dedicated key.

---

## 2. Prerequisites

- **Node.js**: `v24.x`
- **npm**: `v12.x`
- **PostgreSQL**: `14+` running on `127.0.0.1:5432` with extensions `citext` and `pg_trgm` (installed automatically during migration).
- **ClamAV** (optional in development, recommended in production): Running daemon on port 3310.
- **OpenSSL**: For generating high-entropy cryptographic keys and secrets.

---

## 3. Getting Started & Setup

### 3.1 Database Initialization

Connect to your local PostgreSQL instance and create the development and testing databases:

```sql
CREATE DATABASE dcs_docs;
CREATE DATABASE dcs_docs_test;
```

> **Warning:** Never run `prisma migrate reset` or `prisma db push` on `dcs_docs`. The only database that test suites reset is `dcs_docs_test`.

### 3.2 Environment Configuration

Copy the example environment template:

```bash
cp .env.example .env
```

Generate high-entropy secrets and keys:

```bash
# 32-byte base64 keys for encryption and signing
openssl rand -base64 32 # Copy output for JWT_ACCESS_SECRET
openssl rand -base64 32 # Copy output for CSRF_SECRET
openssl rand -base64 32 # Copy output for FILE_ENCRYPTION_MASTER_KEY
openssl rand -base64 32 # Copy output for EMAIL_TOKEN_ENCRYPTION_KEY

# 48-byte base64 keys if desired for additional entropy
```

Edit `.env` (kept strictly git-ignored) and populate:
- `DATABASE_URL=postgresql://<db_user>:<db_password>@127.0.0.1:5432/dcs_docs?schema=public`
- `DATABASE_URL_TEST=postgresql://<db_user>:<db_password>@127.0.0.1:5432/dcs_docs_test?schema=public`
- `STORAGE_LOCAL_ROOT=/path/to/storage/clean` (or `D:/DCS-Docs-Data/storage` on Windows)
- `STORAGE_QUARANTINE_ROOT=/path/to/storage/quarantine` (or `D:/DCS-Docs-Data/quarantine` on Windows)
- Set `MALWARE_SCAN_ENABLED=false` for local offline dev without ClamAV (`true` in production).

### 3.3 Install Dependencies & Apply Migrations

```bash
# Install workspace dependencies cleanly
npm ci

# Deploy additive migrations to dcs_docs (requires owner/admin approval in production)
npm run prisma:deploy

# Generate Prisma Client code
npm run prisma:generate -w packages/api
```

### 3.4 Bootstrap First Administrator

Bootstrap the initial `SUPER_ADMIN` user via the CLI (prompts securely for password without echoing):

```bash
SEED_SUPER_ADMIN_EMAIL="admin@example.internal" npm run bootstrap:admin -w packages/api
```

The bootstrap CLI:
- Refuses to run if a `SUPER_ADMIN` already exists.
- Enforces password policy (minimum 12 characters, max 72 bytes, entropy, common-password dictionary check).
- Requires a mandatory password change on first login.

---

## 4. Development & Running Services

Run API and Web applications concurrently or in separate terminals:

```bash
# Start backend API (defaults to http://127.0.0.1:7800)
npm run dev:api

# Start frontend SPA (defaults to http://127.0.0.1:7801 with proxy to /api)
npm run dev:web
```

---

## 5. Testing & Verification

Run the full verification suite:

```bash
# Typecheck all packages (shared, api, web)
npm run typecheck

# Build all packages
npm run build

# Run unit, contract, and integration tests (uses dcs_docs_test)
npm test

# Run single test suite
cd packages/api && npx vitest run test/documents.test.ts

# Verify the audit log cryptographic hash chain
npm run audit:verify -w packages/api
```

---

## 6. Linux Storage Directory Permissions

For production Linux environments, ensure storage and quarantine roots are secured with strict POSIX permissions:

```bash
# Dedicated service user (e.g., dcs-docs)
sudo chown -R dcs-docs:dcs-docs /var/dcs-docs/storage /var/dcs-docs/quarantine
sudo chmod 0700 /var/dcs-docs/storage /var/dcs-docs/quarantine

# Files written by the service will have 0600 mode
```

---

## 7. ClamAV Antivirus Daemon Setup

For scanning uploaded files:

1. Install ClamAV daemon (`clamav-daemon` on Debian/Ubuntu) or run via Docker:
   ```bash
   docker run -d --name clamav -p 3310:3310 clamav/clamav:latest
   ```
2. Set in `.env`:
   ```env
   MALWARE_SCAN_ENABLED=true
   CLAMAV_HOST=127.0.0.1
   CLAMAV_PORT=3310
   ```
Files are scanned using the streaming `INSTREAM` protocol inside quarantine before any file can be promoted to `CLEAN`.

---

## 8. Gmail OAuth Client Setup (Google Workspace)

To allow employees to send documents from their own mailboxes:

1. In the **Google Cloud Console**, create a project for your organization.
2. Configure the **OAuth Consent Screen**:
   - User Type: **Internal** (strictly restricted to workspace domain users).
   - Scopes: Add strictly `https://www.googleapis.com/auth/gmail.send`. Do not request any read or profile scopes.
3. Under **Credentials**, create an **OAuth 2.0 Client ID**:
   - Application Type: **Web application**
   - Authorized Redirect URIs: `https://<your-app-domain>/api/v1/email/connection/callback`
4. Populate in `.env`:
   ```env
   GMAIL_OAUTH_CLIENT_ID=<your-client-id>.apps.googleusercontent.com
   GMAIL_OAUTH_CLIENT_SECRET=<your-client-secret>
   GMAIL_OAUTH_REDIRECT_URI=https://<your-app-domain>/api/v1/email/connection/callback
   ```
5. Flow safety:
   - Uses PKCE (`S256`) and single-use cryptographically bound state tokens.
   - User refresh tokens are stored encrypted with `EMAIL_TOKEN_ENCRYPTION_KEY`.
   - On employee deactivation, all Gmail connection tokens are immediately wiped.

---

## 9. Backups and Master Key Escrow

- **Database Backups:** Daily physical or `pg_dump` backups.
- **Storage Backups:** Storage directory backups (e.g., via `restic` or `borg`) must use a separate backup encryption key.
- **Master Key Escrow:**
  - `FILE_ENCRYPTION_MASTER_KEY` and `EMAIL_TOKEN_ENCRYPTION_KEY` must **never** be stored on the same volume or backup snapshot as the ciphertext files.
  - Escrow the master keys offline in a physical safe / hardware security module (HSM) or an enterprise secrets manager (e.g., AWS KMS, HashiCorp Vault, OCI Vault).
  - *Losing the master key means all stored document versions are irrevocably unrecoverable.*

---

## 10. Master Key Rotation Procedure

To rotate the file encryption master key without rewriting multi-gigabyte document files:

1. Add the new 32-byte key as `FILE_ENCRYPTION_MASTER_KEY` and increment `FILE_ENCRYPTION_KEY_ID=v2`.
2. Keep the previous key available as `FILE_ENCRYPTION_MASTER_KEY_V1` (decrypt-only).
3. All new uploads and version additions will wrap DEKs with `v2`.
4. Run the key re-wrapping background task:
   - Reads each version row where `encryption_key_id = 'v1'`.
   - Unwraps the DEK using key `v1`.
   - Re-wraps the DEK using key `v2`.
   - Updates `wrapped_data_key` and sets `encryption_key_id = 'v2'`.
   - Underlying ciphertext on disk remains untouched.
5. Once all rows are updated to `v2`, retire the `v1` key to secure offline escrow.

---

## 11. Production Nginx Reverse Proxy

An example Nginx configuration file is provided in `packages/web/nginx.example.conf`.

Key settings:
- Strict CSP (`default-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`).
- `client_max_body_size 30m` for uploads.
- HSTS (`max-age=31536000; includeSubDomains`).
- API proxying to `127.0.0.1:7800` with buffering and forwarded headers.

