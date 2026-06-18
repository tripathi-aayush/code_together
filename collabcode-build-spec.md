# Project Build Spec: CodeTogether (Real-Time Collaborative Coding Workspace)

**Read this entire document before writing any code.** This is a phased build. Complete and verify each phase fully before moving to the next. Do not skip ahead, do not silently expand scope, and do not implement anything listed under "Out of Scope" unless explicitly asked later.

## Project Summary

Build a web application where two or more developers can join a shared "room" and edit the same code file simultaneously, seeing each other's changes, cursors, and presence in real time — a simplified version of VS Code Live Share / Replit multiplayer. The project must end in a **fully working, cleanly polished, demoable product**, not a half-finished feature pile. A finished Intermediate-scope app is the success condition — not an unfinished Advanced one.

## Tech Stack (fixed — do not substitute without asking)

- **Frontend:** React + TypeScript (Vite), Monaco Editor via `@monaco-editor/react`
- **Backend:** Node.js + TypeScript, Express, Socket.IO (server)
- **Realtime transport:** Socket.IO (client + server) — plain broadcast-based sync, NOT Yjs/CRDT (that's explicitly out of scope, see below)
- **Database:** PostgreSQL (via Prisma ORM)
- **Auth:** Simple — name/display-name entry only for now, no real account system needed (see Phase 2)
- **Containerization:** Docker + docker-compose for local dev (Postgres + backend + frontend)
- **Deployment target (later phase):** Render/Railway/Fly.io for backend, Vercel for frontend — decide at Phase 6

## Hard Scope Boundary

### IN SCOPE (build this)
- Real-time synchronized code editing between multiple users in a shared room
- Live cursor positions and user presence (who's online, colored labels)
- Room creation, joining via room code/link
- File explorer with multiple files per room (create/rename/delete files)
- Basic activity log (who edited what, simple text log — NOT a fancy git-style diff system)
- Clean, polished, responsive UI

### OUT OF SCOPE (do not build, do not start, do not "lay groundwork for" unless explicitly asked)
- CRDTs (Yjs or otherwise) / Operational Transform — explicitly excluded, raw broadcast sync only
- Replay/time-travel slider system
- AI collaboration analytics / contribution heatmaps
- Built-in compiler / shared code execution / Docker-sandboxed running of user code
- Collaborative whiteboard
- Real user authentication system, OAuth, password storage
- Mobile app / native clients
- Production-grade horizontal scaling (Redis pub/sub for multi-server Socket.IO) — single-server is fine for this scope

If you (the AI agent) find yourself about to write code related to anything in the Out of Scope list, stop and flag it instead of proceeding.

---

## Phase 0 — Project Scaffolding

**Goal:** Empty but correctly structured monorepo that runs.

Tasks:
1. Create a monorepo with two top-level folders: `client/` (React+Vite+TS) and `server/` (Node+TS+Express).
2. Initialize `client/` with Vite React-TS template. Install `@monaco-editor/react`, `socket.io-client`, `react-router-dom`.
3. Initialize `server/` with TypeScript, Express, Socket.IO, Prisma, `ts-node-dev` for hot reload.
4. Set up `docker-compose.yml` with a Postgres service, and Dockerfiles for client and server (dev-mode, hot reload friendly).
5. Set up a root `.env.example` and per-service `.env` files (DB connection string, server port, client API URL).
6. Add a root `README.md` with setup instructions (`docker-compose up`, how to run migrations, how to access the app).
7. Verify: `docker-compose up` boots Postgres + server + client, server logs "listening on port X", client loads a blank page at localhost with no console errors.

**Done when:** `docker-compose up` works cleanly from a fresh clone with zero manual steps beyond copying `.env.example` to `.env`.

---

## Phase 1 — Core Real-Time Sync (Beginner scope: 2 users, one file, no persistence yet)

**Goal:** Two browser tabs can open the same room and see each other's typing in real time. This is the proof-of-concept core — get this rock solid before anything else.

Tasks:
1. Backend: Socket.IO server with a `join-room` event (client sends roomId), maintaining an in-memory map of `roomId -> { users, currentCode }`.
2. Backend: `code-change` event — when a client sends an edit, broadcast it to all other clients in the same room (NOT back to sender).
3. Frontend: Single page with a room code input, a "Join Room" button, and a Monaco Editor instance once joined.
4. Frontend: On Monaco `onChange`, emit `code-change` to the server (debounce or send full content — full content is fine for this phase, optimize later if needed).
5. Frontend: On receiving `code-change` from server, programmatically update the Monaco editor content WITHOUT re-triggering a local `onChange` emit (use an `isRemoteUpdate` guard flag — this is the standard pattern to prevent feedback loops and cursor-jump bugs; without this guard the editor will infinite-loop or jump the user's cursor on every keystroke).
6. Handle the "new user joins existing room" case: server must send the current room code state to a newly joined client immediately on join, not just future changes.
7. Manual test: open two browser tabs, join the same room code in both, type in one, confirm instant appearance in the other, with no cursor-jumping or flicker in either tab while idle.

**Done when:** Two tabs, same room, typing in either updates the other within ~100ms with no glitches, no infinite loops, no duplicate-character bugs from rapid typing.

---

## Phase 2 — Presence, Identity, and Multiple Files

**Goal:** Users have names/colors, can see who else is in the room, and a room can contain multiple files.

Tasks:
1. On join, prompt for a display name (stored client-side only, e.g. localStorage-equivalent via React state — no real auth). Assign each user a random consistent color (hash name → color, or random on join).
2. Backend: track connected users per room (`socketId -> { name, color }`), broadcast `user-joined` / `user-left` events.
3. Frontend: presence bar/sidebar showing avatars or colored name chips of everyone currently in the room.
4. Backend: extend room state to support multiple files: `roomId -> { files: { fileName: content }, activeFile-per-user-or-shared }`. Decide and document: is there one "active file" shared by the whole room, or can each user view a different file? (Recommendation: shared active file for this scope — simpler and still impressive; note this decision in code comments.)
5. Frontend: simple file explorer sidebar (list of files, "+ New File" button, click to switch, basic rename/delete).
6. Backend: persist file list + content per room to Postgres (Prisma schema: `Room`, `File`, with `roomId`, `fileName`, `content`, `updatedAt`). Sync in-memory state to DB periodically (e.g., on every change with debounce, or every N seconds) — don't hit the DB on every keystroke.
7. Manual test: 3 tabs join one room with distinct names/colors, all see each other in presence bar, file creation in one tab appears in others, switching files updates everyone's editor view (if shared-file model) or correctly isolates view (if per-user model).

**Done when:** Multi-file rooms work, presence is visible and accurate (joins/leaves update live), and room state survives a server restart (loaded from Postgres).

---

## Phase 3 — Live Cursors and Selections

**Goal:** Users see colored cursor markers and selection highlights showing where collaborators are working, not just what they typed.

Tasks:
1. Frontend: capture local cursor position / selection range from Monaco's `onDidChangeCursorPosition` / `onDidChangeCursorSelection`.
2. Emit cursor position (throttled, e.g. max once every 50-100ms) via a `cursor-update` socket event including `{ userId, fileName, position, selection }`.
3. Backend: broadcast `cursor-update` to other users in the room (do not persist cursor positions to DB — ephemeral only).
4. Frontend: render remote users' cursors as colored vertical bar decorations in Monaco (use Monaco's decoration API), with a small name label tag at the cursor position, and highlight their selection ranges in their assigned color.
5. Handle cleanup: when a user disconnects, remove their cursor decoration immediately for everyone else.
6. Manual test: with 2-3 tabs open, confirm each user sees the others' live cursor position and color-coded selection while editing, and disconnecting a tab removes its cursor everywhere else within ~1-2 seconds.

**Done when:** Cursors feel alive and accurate — this is the single most visually impressive piece of the whole project, so it should look clean, not laggy or jumpy.

---

## Phase 4 — Activity Log

**Goal:** A simple, real-time feed of who did what, lightweight — not a full git-style diff system.

Tasks:
1. Backend: on meaningful events (file created, file deleted, user joined/left, and optionally periodic "X edited Y" on debounce), append an entry to an in-memory (or DB-backed) activity log per room: `{ timestamp, userName, action, target }`.
2. Persist activity log entries to Postgres (`ActivityLog` table: `roomId`, `userName`, `action`, `target`, `timestamp`).
3. Frontend: a collapsible side panel or tab showing the live activity feed, newest at top, auto-updating via socket broadcast of new log entries.
4. Keep this simple: plain text lines like "Rahul created login.js", "Aditi joined the room", "Rahul edited index.html" — no diffs, no line-by-line tracking.
5. Manual test: perform various actions across multiple tabs, confirm the activity log updates live and accurately for everyone in the room, and reloading the page still shows the historical log (loaded from DB).

**Done when:** Activity log is accurate, live, persists across reloads, and doesn't clutter the UI.

---

## Phase 5 — Polish Pass (treat this phase as mandatory, not optional)

This phase exists because a clean finished Intermediate product is explicitly worth more (for both portfolio and any future use) than a sloppy attempt at Advanced features. Do not skip this.

Tasks:
1. UI/UX pass: consistent spacing, a real color theme (dark theme strongly recommended — matches developer-tool expectations), loading states for room join/file switch, empty states (e.g. "No files yet — create one to get started").
2. Error handling: invalid/nonexistent room codes, server disconnect/reconnect handling (show a "reconnecting..." banner, attempt to resync state on reconnect rather than silently failing), basic input validation (filenames, room codes).
3. Responsive layout check at common desktop widths (this is a desktop-first tool, but don't let it break at smaller laptop screen sizes).
4. Add a simple landing page: project name, one-line pitch, "Create Room" / "Join Room" entry points — this is what a recruiter or visitor sees first, so it matters.
5. Write a proper `README.md`: what the project is, screenshots/GIF if possible, tech stack, how to run locally, architecture overview (a simple diagram of client <-> Socket.IO server <-> Postgres is enough).
6. Code cleanup pass: remove dead code, console.logs, ensure consistent TypeScript typing (no stray `any` where avoidable), consistent file/folder structure.

**Done when:** A stranger could clone the repo, run `docker-compose up`, and have a working, good-looking, bug-free demo within 5 minutes — and a recruiter skimming the README understands the project's value in 30 seconds.

---

## Phase 6 — Deployment (optional but recommended if time allows)

**Goal:** A live, shareable URL — this matters more for both resume credibility and showing friends than most people expect; "here's a link, try it" beats "clone my repo" every time.

Tasks:
1. Deploy Postgres + backend to Render or Railway (pick one, document the choice and steps).
2. Deploy frontend to Vercel.
3. Configure CORS/env vars correctly between deployed frontend and backend.
4. Test the live deployed version end-to-end with 2+ real devices/networks (not just localhost — confirm WebSocket connections work through real network conditions).
5. Add the live URL prominently to the README.

**Done when:** You can send a friend a link and they can join a room and collaborate with you live, from a different network, with no setup.

---

## Explicit Stretch Goals (DO NOT BUILD NOW — only revisit after Phases 0–6 are fully complete and stable)

Listed here only so the AI agent knows these were considered and deliberately deferred, not forgotten:
- CRDT-based sync (Yjs) replacing the broadcast model, for true offline-merge conflict resolution
- Replay/time-travel slider over historical edits
- AI-generated contribution analytics / heatmaps
- Shared terminal / in-browser code execution sandbox
- Collaborative whiteboard alongside the code editor

---

## Working Agreement for the AI Agent

- After completing each phase, stop and summarize what was built, what was tested, and explicitly confirm the "Done when" criteria for that phase before proceeding to the next.
- If a phase's tasks reveal a design decision not specified here (e.g., shared vs. per-user active file), make a reasonable choice, document it clearly in a code comment and in the phase summary, and proceed — don't block on it, but don't hide it either.
- Prioritize a working, polished Phase 5 over a half-built Phase 6 or any stretch goal. If time/resources run short, it is always correct to stop at a fully polished earlier phase rather than leave a later phase half-done.
- Keep commits small and incremental, with clear messages, so the git history itself is somewhat readable (this also helps for portfolio purposes).
