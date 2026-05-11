# Security and deployment

This document is the **canonical place** for how we expect the harness to be **run**, who is **trusted**, and what **not** to assume about safety. It complements [`architecture.md`](architecture.md) (what exists) with **operational posture** (how to expose it responsibly).

## Canonical deployment shapes

These are **supported mental models**, not cloud SKUs.

### A — Local single-user (recommended default)

- **Server** and **browser** on the same machine; UI at `http://localhost:<PORT>` (default `3000`).
- **Workspace** is a directory you control (or an ephemeral temp clone the server creates).
- **Trust boundary:** the OS user running Node + `agent` is fully trusted; the server has no multi-tenant isolation.

**Why this is canonical:** the codebase has **no authentication**, **no authorization**, and **no per-user quotas**. Anything that can call the HTTP API can start pipelines and read whitelisted artefacts for **known task IDs**.

### B — UI on one machine, API on another (LAN or VPN)

- Open `web/index.html` or host `web/` statically; set **API URL** in the sidebar to `http://<server-host>:3000` (see root README “Alternate: UI only”).
- **Trust boundary expands** to everyone who can reach that host/port on the network.

**Requirements if you use B:**

- Treat the bind address as sensitive (`PORT` is not magic security).
- Prefer binding to **loopback only** on the API host unless you intentionally expose it (reverse proxy + TLS + auth is **out of scope** for this repo — you would add that in your own layer).

### C — Exposed to the internet (discouraged without a gateway)

The stock server is **not** designed as a public SaaS API. If you must:

- Put an **authenticating reverse proxy** in front (your responsibility).
- Rate-limit and audit at that layer.
- Never forward raw `POST /voice-command` without identity checks.

**Consequences of skipping a gateway:** arbitrary third parties could enqueue expensive agent work and read artefact endpoints for guessed UUIDs (see threat model below).

## Threat model (practical)

| Actor | Trust level | Notes |
|-------|-------------|--------|
| **OS user running the server** | Full trust | Can read `.env.local`, spawn `agent`, read/write workspace, SQLite logs |
| **Browser tabs on the same machine** | Trusted in model A | Same user context |
| **Anyone who can HTTP to the server** | **Untrusted** in models B/C | No session model; CORS is permissive (see below) |
| **LLM providers (OpenAI, etc.)** | Data processor | Prompts may include file excerpts; do not point at secrets in workspace |

## HTTP surface (facts from current implementation)

- **CORS** is set to **allow any origin** (`Access-Control-Allow-Origin: *`) for simple browser setups. That helps local file:// or alternate static hosts; it does **not** replace auth — it means **any website the user visits cannot be “protected” by same-origin policy alone** if their browser can reach the API (unusual for localhost-only, relevant for LAN exposure).
- **No login** on `/voice-command`, `/tasks/:id/approve`, `/tasks/:id/cancel`, SSE, or artefact reads.
- **`GET /tasks/:id/artefacts/:file`** — **whitelist only** of root markdown names; path traversal is rejected in [`server/src/artefact-endpoint.ts`](../server/src/artefact-endpoint.ts). Task IDs are still **unguessable in practice** but not cryptographic secrets; treat leaked task URLs like leaked session URLs.

## Data sensitivity

| Data | Location | Sensitivity |
|------|----------|-------------|
| **User prompts / transcripts** | SQLite logs, in-memory task | Often high — product ideas, credentials in prose |
| **Workspace** | Disk | **Source code** — may contain secrets if the user put them there |
| **`OPENAI_API_KEY`** | `server/.env.local` | **High** — file must stay out of git |

## Operational checklist (before “wider than localhost”)

1. Confirm **who can TCP-connect** to the API port.
2. Confirm **workspace path** is not a shared home directory unless you intend that.
3. Rotate keys if a prompt ever pasted a **secret** (models and logs may retain echoes).
4. Re-read **whitelist** when adding new artefact types (UI + server must stay aligned).

## Related reading

- [`architecture.md`](architecture.md) — persistence, module map
- [`decisions.md`](decisions.md) — D-001 (local harness), D-010 (artefact whitelist)
- [`operations.md`](operations.md) — cost and workflow knobs that interact with deployment
