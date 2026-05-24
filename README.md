# WebCodex Demo

SQLite + Aliyun OSS demo for a Web Codex-style application.

This demo separates metadata from file content:

- SQLite stores users, workspaces, workspace file indexes, version history, conversations, messages, runs, and run events.
- Aliyun OSS stores file blobs by SHA-256 under a fixed object key prefix such as `beta/objects/`.
- A Python worker runs the OpenAI Agents Python SDK `SandboxAgent` with the official Docker sandbox client. Each browser run can choose the model, reasoning effort, and standard or fast service tier.
- The agent works in `/workspace` through official sandbox capabilities such as shell, `apply_patch`, and `view_image`.
- When `OPENAI_API_KEY` is empty, the backend can expose a local Codex-compatible `/v1/responses` relay backed by `docs/auth.json`.
- The browser consumes replayable SSE events from the Python backend.

## Project Structure

```text
webcodex/
  backend/       FastAPI API, SQLite business store, SSE stream gateway
  worker-py/     OpenAI Agents Python SDK sandbox worker
  frontend/      Vite + React + Tailwind browser UI
  data/          SQLite database location
  docs/          Product and architecture documents
  external/      Ignored source clones for SDK analysis
```

## Run

Fast start from the repo root:

```powershell
.\start.ps1
```

Useful options:

```powershell
.\start.ps1 -Restart      # stop existing listeners on 8000/5173 before starting
.\start.ps1 -SkipInstall  # skip dependency checks
.\start.ps1 -Open         # open the frontend after startup
```

One-time setup:

```powershell
cd F:\code0923\webcodex
Copy-Item .\.env.example .\.env
cd .\backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
pip install -e ..\worker-py
cd ..\frontend
npm install
```

Before starting the backend, choose one model credential path:

- Official OpenAI API: fill `OPENAI_API_KEY`, leave `OPENAI_BASE_URL` empty unless you intentionally use a compatible `/v1` endpoint, and keep `OPENAI_API_PROTOCOL=responses`. The fallback defaults are `OPENAI_MODEL=gpt-5.5`, `OPENAI_REASONING_EFFORT=xhigh`, `OPENAI_REASONING_SUMMARY=detailed`, and `OPENAI_SERVICE_TIER=priority`.
- Compatible `/v1` endpoint: fill `OPENAI_API_KEY`, set `OPENAI_BASE_URL`, and verify the endpoint supports the Responses API features used by the OpenAI Agents Python SDK sandbox runtime.
- The runtime is fixed to the Python worker in `worker-py/`; the legacy Node worker is not part of this project.
- Responses API compaction uses the active run model directly. With the default catalog that means compaction runs on `gpt-5.5` and is billed through the same usage ledger.
- Local Codex relay: leave `OPENAI_API_KEY` empty and keep `CODEX_RELAY_AUTH_FILE=../docs/auth.json`. The worker will use `CODEX_RELAY_MODEL` for this path.

Also fill the Aliyun OSS access key, secret, endpoint, bucket, and fixed `OSS_KEY_PREFIX`.

Terminal 1:

```powershell
cd F:\code0923\webcodex\backend
.\.venv\Scripts\Activate.ps1
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Terminal 2:

```powershell
cd F:\code0923\webcodex\frontend
npm run dev -- --host 127.0.0.1 --port 5173
```

Open:

```text
http://127.0.0.1:5173
```

## Flow

```text
Browser
  -> FastAPI creates user/workspace/conversation/run metadata in SQLite
  -> Browser sends per-run model, reasoning effort, and speed mode
  -> FastAPI starts Python worker as a per-run process
  -> Python worker materializes workspace files and uploads into a run workspace
  -> OpenAI Agents Python SDK creates an official Docker sandbox at /workspace
  -> Agent uses official sandbox tools for shell, patches, and local image viewing
  -> Python worker diffs the final sandbox workspace and writes changes back
  -> FastAPI stores run events in SQLite
  -> Browser consumes replayable SSE stream
```

Codex relay flow:

```text
OpenAI Agents Python SDK
  -> POST {API_BASE_URL}/codex-relay/v1/responses with CODEX_RELAY_API_KEY
  -> Fast mode sends top-level service_tier=priority; standard mode sends service_tier=default
  -> FastAPI reads docs/auth.json, refreshes the ChatGPT access token when needed
  -> FastAPI forwards the request to chatgpt.com/backend-api/codex/responses when relay mode is supported
  -> FastAPI streams the Codex SSE response back to the worker
```

Workspace file flow:

```text
PUT /api/workspaces/{workspace_id}/files/{path}
  -> file content is written to Aliyun OSS at {OSS_KEY_PREFIX}/objects/{sha-prefix}/{sha}
  -> SQLite records path, blob key, blob sha, version id, and file op history
```

## Useful API Calls

Create or update a user:

```powershell
Invoke-RestMethod -Method Post `
  -Uri http://127.0.0.1:8000/api/users `
  -ContentType 'application/json' `
  -Body '{"id":"demo-user","name":"Demo User"}'
```

Create a workspace:

```powershell
Invoke-RestMethod -Method Post `
  -Uri http://127.0.0.1:8000/api/workspaces `
  -ContentType 'application/json' `
  -Body '{"id":"demo-workspace","user_id":"demo-user","name":"Demo Workspace"}'
```

Write a workspace file:

```powershell
Invoke-RestMethod -Method Put `
  -Uri http://127.0.0.1:8000/api/workspaces/demo-workspace/files/README.md `
  -ContentType 'application/json' `
  -Body '{"content":"hello workspace","message":"seed README"}'
```

Read a workspace file:

```powershell
Invoke-RestMethod `
  -Uri http://127.0.0.1:8000/api/workspaces/demo-workspace/files/README.md
```

List current workspace files:

```powershell
Invoke-RestMethod `
  -Uri http://127.0.0.1:8000/api/workspaces/demo-workspace/files
```

## Demo Limitations

- SQLite polling is used for SSE; this is fine for a demo and should be replaced by Redis/NATS/Kafka later.
- Workspace indexing and persistence still go through the Python API and OSS blobs; agent command execution now runs in the local Docker sandbox configured by `WORKER_RUNTIME=docker`.
- The worker token is a local demo secret from `.env.example`.
