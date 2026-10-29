# Guided reading

Choose **带读** in the sidebar, paste a web article URL and send. The existing
per-session model and provider setup powers the guide. There is no preliminary
probe, mandatory quiz or plan-acceptance gate. Chinese explanations follow the
article's argument; each passage's original is collapsed beside its explanation.
The first version accepts HTTP(S) web articles, up to 200,000 extracted characters.
Fetch errors and oversized sources are reported rather than saved as a partial
article. The original snapshot is reused for the life of the session.

## Reading and discussion

The guide reads the complete source before creating a concise reading route.
Structure identification is a model task: the reading prompt gives principles
for finding the author's purpose, actual argument, evidence, turns and useful
reading units across different kinds of articles. There is no fixed article
template or algorithm that turns headings into route nodes. Tools only preserve
the model's route, source citations and reading state.
Main nodes partition all source blocks exactly once, in source order. Their
arrows mean reading order, not prerequisite/entailment. Sustained questions grow
branches, with dashed links to their originating node. Short explanations can
remain inline. The route can be revised while retaining visited/bookmarked
nodes, their original anchors, and existing discussion branches.

The article bookmark and active discussion position are separate. A detour
moves the discussion highlight while preserving the exact original passage.
Return restores the bookmark; Continue, Skip and node jumps are explicit learner
inputs. They confer no evidence of comprehension. Node inspection shows the
corresponding source, actual discussion history and personal records; inspection
alone never moves the reading position. Older branches can be collapsed.

## Records and connected knowledge

Personal records distinguish understanding, discoveries and unresolved questions.
Each records actual learner-message quotations, the source blocks, and the route
node. Notes can be revised through conversation by reusing their stable id; the
event log retains earlier versions. The guide cannot save a personal note with
fabricated learner-message ids/quotations or nonexistent graph references.

Reading uses the existing extraction → identity audit → deterministic merger.
Unlike teaching coverage, its extraction view includes the learner's words and
personal records as well as the guide's prose. Its own extraction instructions
distinguish established claims from questions, hypotheses, analogies and author
reports. Only genuine entailments become reasoning chains. Reading-route and
discussion edges never become knowledge edges. Equivalent propositions reuse
global nodes, adding the reading's provenance. Optional related-node references
on personal records remain references, not new implication edges.

Short reading exchanges trigger extraction without waiting for the teaching
chunk threshold. The normal batching budget still bounds each extraction job.
A reading exchange arriving during a run coalesces a follow-up, so the final
discovery does not wait for another conversation turn. Graph settings and the
existing background provider consent still apply. Failed extractions leave
their content uncovered and honestly retryable using the existing coverage UI.

## Architecture

- `src/core/reading.ts`: browser-safe source blocks, route validation, two
  positions, note provenance, event fold and per-node conversation history.
- `src/agent/tools/reading.ts`: `reading_load`, `reading_source`, `reading_plan`,
  `reading_focus`, `reading_note`; source extraction reuses Readability/Turndown.
- `src/agent/prompts/reading/`: independent reading doctrine, available through
  the existing prompt editor.
- `components/reading.tsx`: original-text expanders, persistent controls, route
  map, personal records and knowledge connections. The map reuses `PlanDiagram`.

All reading state is stored as server-authored tool results in the native chat
record. There is no competing reading-state store. Explicit navigation uses a
`reading-navigation` marker, with a human label in the transcript and an exact
target id for the model. It is classified as learner input for provider consent.
The guide is reconstructed each turn from the full persisted reading log. Context
compaction reduces model history without deleting the source snapshot, routes,
branches, evidence or personal records; `reading_source` retrieves the saved text.

Chat schema v2 adds reading sessions/navigation. Old records remain readable
and receive the current stamp on their next write; graph ledgers retain v1.
An older application correctly refuses a v2 chat rather than teaching from it
using the wrong agent.

## Verification

The deterministic reading tests cover nested detours and return, source/code
preservation, route completeness, note evidence, exact navigation, reload and
compaction recovery, and cross-session identity merging using the real turn,
extraction and persistence paths with scripted engines. Render tests cover the
two position markers, discussion collapse and source disclosure.
