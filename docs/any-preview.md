# LearnHarness Any Preview

LearnHarness Any Preview is an independent desktop trial of LearnHarness with
[official Any v0.3.5](https://github.com/anyproto/any/releases/tag/v0.3.5) as its
local learning-data backend. It retains the TypeScript agents, guided reading,
knowledge graph, and English/Simplified Chinese interface. The ordinary
LearnHarness application keeps its file backend and existing data.

This preview does not migrate old data, synchronize devices, or publish an
update to the ordinary application.

## Run and build

Use the repository's existing Node and desktop build prerequisites described in
[development](development.md) and [desktop releases](desktop-release.md).
From the repository root:

```bash
npm install
npm run any:fetch          # verify and cache the pinned release for this host
npm run desktop:any:dev    # build the standalone server and launch the preview
npm run desktop:any:dist   # package the preview; publication is disabled
```

`desktop:any:dev` owns its standalone Next server and Any process. It deliberately
does not attach to `next dev` through `LH_DEV_URL`. For ordinary file-backed web
development, continue to use `npm run dev`.

The release manifest is [electron/any-release.json](../electron/any-release.json).
`any:fetch` checks the official archive's SHA-256, extracts the full runtime and
its dependencies, includes the Any license, and records a file inventory in
`vendor/any/<platform>-<arch>/verified.json`. A valid cached runtime is reused.
Packaging copies those resources outside the application archive. The installed
application never downloads a newer Any release at startup.

The pinned assets cover `darwin-arm64`, `darwin-x64`, `linux-x64`, and
`win32-x64`. To prepare an additional target, run, for example,
`npm run any:fetch -- darwin-arm64`; use the corresponding platform's desktop
build prerequisites and electron-builder target. Packaging is configured in
[electron-builder.any.yml](../electron-builder.any.yml), with output under
`dist/any-preview/`. A successful build on one platform does not verify the
others.

## Separate application, local workspace

The preview uses the product name **LearnHarness Any Preview** and app ID
`com.sockingpanda.learnharness.anypreview`. Its Electron `userData` directory,
single-instance lock, browser preferences, provider keys, and subscription
credentials are separate from LearnHarness. Both applications can run at the
same time. In-app automatic updates are disabled for the preview.

Under the preview's Electron `userData` directory:

| Location | Contents |
|---|---|
| `any/` | The owned Any account, workspace, local network configuration and recovery metadata |
| `data/` | Local application settings, prompt overrides and other local configuration |
| `auth.json` and provider credential files | This application's model credentials |

Any runs in its official **standalone** account mode. The first launch initializes
one account in the owned directory; initialization output containing account
recovery information is discarded and never enters application logs. The app
refuses an unowned or incompatible directory rather than adopting another
running Any instance.

The checked-in [placeholder network](../electron/any-placeholder.yml) is pinned
to the same release. Local discovery/P2P, global P2P, push and Any embedding are
disabled; local queries remain available. The preview therefore has no working
sync network. **Enabling real synchronization later requires migration to a new
space; replacing this network configuration in place is not supported.**

Local database storage does not make model processing offline. Existing model
providers, subscription connections, web fetching, research and dictation retain
their existing network behavior. Disabling Any's embedder does not disable
LearnHarness's separately configured model services.

## What is stored

The workspace selects one complete learning-data backend: `ChatStore`,
`GraphStore`, `JobStore` and `ReadingSourceStore`. The preview selects Any;
the ordinary application selects files. Any failure never causes a fallback to
the file backend. Credentials, application preferences and prompt overrides stay
in each application's own local configuration.

- **Conversations:** messages keep their native IDs and complete payloads,
  including tool results, provider signatures, usage and compaction markers.
  Appends serialize and replaying the same ID with the same payload is a no-op;
  conflicting payloads are rejected. Large payloads may use Any Files internally.
- **Reading:** the route, current article position, discussion return points and
  personal records are derived from native messages. There is no separately
  editable reading-state document. Each session has one immutable source archive.
- **Originals:** PDFs retain their original bytes; web articles retain Markdown
  and their original link. Any Files holds the content, with a separately saved
  SHA-256 and file reference. Upload, verification and reference registration are
  recoverable; retries reuse registered content. Downloads serve the saved source.
- **Knowledge:** logical proposition/chain IDs remain distinct from storage row
  IDs. Different sessions can supply separate evidence for one logical idea.
  Node assertions, reasoning chains, coverage, checkpoints and operation receipts
  live in the same application object. Stable operation IDs and a recoverable
  batch protocol prevent duplicate commits. Graph reads use opaque string
  revisions; the UI compares equality, not clock order. Canvas arrows are derived
  from reasoning chains; reading-order edges do not become knowledge edges.
- **Deletion:** a durable deletion marker first blocks new writes. Cleanup then
  handles graph evidence, jobs and attachments before removing the session.
  Interrupted cleanup resumes at startup. Both existing choices—preserve the
  graph or delete the session's nodes—remain available, and surviving sessions'
  evidence is retained.

The file adapters implement the same asynchronous ports, message append contract,
and recoverable graph/deletion protocol, including a pending graph journal.
Domain reducers, graph merge calculations and layout calculations stay detached
from storage IO.

## Requests, notifications and recovery

User input must finish saving before a model request starts. A turn's reply and
required settlement writes must finish before the stream reports completion.
Subscription dispatch awaits its persistence hook, then rechecks cancellation,
account scope and authorization immediately before sending. Saved and dispatched
inputs are tracked separately, so cancellation during a slow save does not
silently requeue the same automatic input.

Any Preview records a pending-turn receipt before saving the input. An interrupted
turn remains visible for an explicit retry; opening the session does not replay
its model request. Orphaned jobs without a saved result become interrupted jobs.
Saved results stay available, but recovery does not automatically start a model
turn to consume them; the next explicit learner interaction can deliver them.
The ordinary file application's existing restart policy is retained.

The browser continues to use the application's HTTP API and SSE channels.
The server subscribes to Any changes and forwards small change notifications
through the existing notify-then-fetch mechanism. Subscription reconnection
triggers fresh reads. Browsers do not connect directly to Any.

Electron starts Any through a supervisor on a random `127.0.0.1` port and obtains
the owned endpoint. It checks the pinned version, account, initialization state
and application schema before opening the workspace. Importing routes during
`next build` does not initialize or connect to a database.

On normal exit, the server stops accepting new work, cancels active model work,
and drains messages, job receipts, graph work, compaction usage and pending
storage operations before closing the backend. Electron then stops the server
and Any. The drain is bounded; a timeout or failed write is not reported as a
cleanly saved shutdown. The supervisor also terminates Any if its host disappears.
An unexpected Any exit stops business work and prompts an application restart;
it does not reconnect to another service or automatically replay model requests.

## Verification

```bash
npm run any:fetch
npm run typecheck
npm run lint
npm test
npm run build
```

The real-service suites are [any-store.integration.test.ts](../tests/any-store.integration.test.ts),
[any-reading.integration.test.ts](../tests/any-reading.integration.test.ts) and
[any-desktop.test.ts](../tests/any-desktop.test.ts). They use a temporary local
account and the pinned runtime. Reading/extraction responses are deterministic
fixtures, so these tests make no external LLM calls. Real Any tests use local
loopback HTTP; the release download itself needs network access.

Real-service cases are **skipped if the executable is absent**. Populate
`vendor/any/<platform>-<arch>/` with `any:fetch` before treating a full test run as
Any integration validation. An explicit binary path can be supplied with
`LH_ANY_TEST_BINARY` for storage/reading integration or `LH_TEST_ANY_BINARY` for
desktop tests; it must still match the pinned version. Deterministic unit and
runtime tests also cover delayed-save cancellation, authority changes, native
message fidelity, graph commit recovery, attachment registration, interrupted
deletion, deferred results and shutdown draining.

### Validation on 2026-10-29

The Linux workspace passed all **3,091 tests with zero skips**, type checking,
lint, and the production build. Real Any integration exercised web and PDF
reading, discussion and return, learner notes, graph extraction, original-byte
hashes, restart recovery and interrupted deletion. Model responses used fixtures.

Production browser checks verified source downloads and SHA-256, English and
Chinese UI, narrow layouts, and interrupted sessions with both saved input and
an empty opening draft. Neither recovery view automatically posted a model request.

Linux AppImage and deb packages were built. The packaged Preview and ordinary
application both ran under Xvfb, used their respective Any/file backends, and
saved separate sessions. A second Preview launch respected its own instance lock;
normal exit stopped its Any child. The server payload excludes the build-time
Any cache; only the selected platform's runtime ships in `resources/any`.
The AppImage executable also passed launch and shutdown checks with its
FUSE-free extraction runtime. Artifact hashes accompany the packages in
`dist/any-preview/SHA256SUMS`.

macOS Apple Silicon and Windows x64 Any resources were downloaded and their
pinned hashes and layouts checked. Those operating systems were not available
for installer, signing or application-launch validation in this workspace.
