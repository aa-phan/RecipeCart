# TikTok Media and Recipe Extraction — Product Requirements Document

**Product:** RecipeCart — TikTok Recipe → Kroger Cart Automation (working name)
**Component:** 2 of 4 — TikTok Media and Recipe Extraction
**Sibling documents:** Component 1 (Mobile Capture & Review) · Component 3 (Kroger Product Matching & Cart Automation) · Component 4 (Backend Platform, Hosting & Orchestration)
**Scope:** Single user / small private beta
**Status:** Draft v1 — July 16, 2026

### Shared assumptions this document relies on
- Runs as a **worker module inside the shared backend**, not a standalone network service (see Component 4 Architecture) — invoked as a job stage, not called over HTTP by the phone directly.
- Claude is used for **reconciliation and judgment calls**, not bulk OCR — conventional OCR does the broad, cheap scanning; Claude is escalated to a small, capped set of frames plus the transcript.
- **No unsupported inference.** Every field either has evidence or is explicitly marked unknown. This is treated as a hard rule, not a style preference — a wrong quantity is worse than a missing one.
- Source media (video/audio/frames) is **deleted immediately after the job reaches a terminal state**, per Component 4's retention policy.

---

## 1. Executive Summary
This component turns a TikTok URL into a structured, evidence-backed recipe. It is the highest-risk part of the system from a quality standpoint: everything downstream — product matching, cart automation, the user's trust in the app — depends on this pipeline correctly distinguishing what a recipe actually said from what a language model might plausibly guess it said. The design center is a hybrid pipeline: cheap, broad conventional OCR and speech-to-text feed a single, bounded Claude call that reconciles everything into structured output, with vision escalation reserved for a small number of frames where text-only signals are insuffient.

## 2. Problem Statement
TikTok recipes encode ingredients across three unreliable channels at once — fast narration, on-screen text overlays that change every few seconds, and the video caption — none of which are structured, and any of which may be incomplete, ambiguous, or contradict the others. A naive "transcribe everything and ask an LLM" approach either misses ingredients shown only visually, hallucinates quantities that were never stated, or burns unnecessary vision tokens sending every frame to a model. This component needs to extract what's actually there, flag what isn't, and do so within a latency and cost budget appropriate for a single-user hobby deployment.

## 3. Product Goals
- Produce a structured recipe with per-field confidence and evidence, not a best-guess wall of text.
- Never invent a quantity, unit, or ingredient that has no evidence in the source video.
- Keep typical extraction latency low enough that "processing" doesn't feel broken (Component 1's non-blocking UX depends on this being fast, not on hiding a slow pipeline).
- Keep per-recipe cost low enough that it's a rounding error against hosting cost (see §18).
- Degrade gracefully — "not a recipe," "no quantities stated," "music only" are expected outcomes, not failures.

## 4. Non-Goals
- Not a general TikTok scraper or archival tool — only enough of a video is retained to extract a recipe, then it's deleted.
- Not a nutrition-analysis or dietary-safety system — inferred dietary tags are explicitly *not* a safety guarantee (see §13).
- Not responsible for product matching (Component 3) or for deciding what's shown to the user (Component 1) — this component's contract ends at a structured recipe object.
- Not building a custom OCR model in v1 (see §11).

## 5. Supported and Unsupported Input Types
| Supported | Unsupported (v1) |
|---|---|
| Public `tiktok.com/@user/video/ID` links | Private, login-gated, deleted, age-restricted, or region-restricted videos |
| `vm.tiktok.com` short links (resolved via redirect) | Non-TikTok URLs (Reels, Shorts — explicitly out of scope) |
| Videos with narration, on-screen text, or both | TikTok LIVE replays and Stories |
| TikTok photo-mode/slideshow posts (image+caption, no audio) — supported with reduced pipeline (OCR + caption only, no ASR) | Non-recipe content — detected and returned as a distinct "not a recipe" result, not an error |
| Single-video recipes | Recipes split across multiple linked videos (Part 1/Part 2) — flagged as a known limitation |

## 6. End-to-End Processing Pipeline
1. Validate and normalize the URL; resolve short links.
2. Download via yt-dlp to temporary job-scoped storage, with timeout and retry policy (§16).
3. Probe metadata (duration, audio presence, caption/description text, creator handle).
4. FFmpeg: extract full audio track; extract candidate frames via scene-change detection with a fixed-interval fallback.
5. Deduplicate visually similar frames (perceptual hashing).
6. Resize/normalize frames for OCR and potential vision use.
7. Run conventional OCR across all deduplicated candidate frames.
8. Run speech-to-text across the full audio track (skipped gracefully if no audio track/no speech detected).
9. Score OCR blocks and transcript segments for "ingredient-likely" content; select an escalation set of frames for Claude vision (capped, §12).
10. Single Claude call: reconcile transcript + cleaned OCR text + caption + escalation frames → structured recipe JSON with confidence and evidence per field.
11. Deterministic post-processing: unit normalization, pantry-staple classification pass, schema validation.
12. Persist the structured recipe and evidence references; emit `recipe.extraction.completed` (or `.failed`).
13. Delete all temporary media for the job.

## 7. Media Retrieval Requirements
- yt-dlp version pinned in the Docker image, with a monitoring signal (§20) since TikTok's frontend changes frequently and can break extractors without warning — this is treated as an expected operational risk, not a one-time integration task.
- Download timeout: 45s to establish/start the download, 3 minutes total budget for the download stage.
- Retry policy: transient network errors retry twice with backoff; "video not found / private / removed" fails immediately with no retry (retrying won't help).
- Self-imposed rate limiting: sequential, single-video-at-a-time downloads — appropriate for private-beta volume and avoids behaving like a scraper hitting TikTok in parallel.
- Downloaded file is checksum/size-sanity-checked before proceeding (catches partial/corrupt downloads early).

## 8. FFmpeg Processing Requirements
- Audio extracted to a format suitable for the chosen speech-to-text API (mono, speech-appropriate sample rate).
- Frame extraction combines scene-change detection with a fixed-interval fallback (e.g., a sample every ~2 seconds) specifically because recipe videos often hold a static text-overlay frame far longer than a scene-change detector alone would sample — the fallback exists to make sure a long-held ingredient-list frame isn't missed.
- Raw candidate frames capped at ~40 per video pre-deduplication, to bound downstream OCR and storage cost regardless of video length.
- Frames resized so the long edge is roughly 1000–1100px before OCR/vision — enough for on-screen text legibility without paying for unnecessary resolution (see §18 for how this maps to vision token cost).

## 9. OCR Requirements
- Conventional OCR engine (e.g., an open-source engine or a cloud OCR API — implementation choice, not prescribed here) run across every deduplicated candidate frame; this is the "cheap and broad" layer, not the final answer.
- Per-frame and per-text-block confidence scores retained.
- Text block position retained specifically to down-weight or mask known TikTok interface chrome (username, like/comment/share icon column, caption area) versus creator-authored overlay text — this is the primary mechanism for "distinguishing recipe content from TikTok interface text."
- Language detection on OCR output, to support multilingual handling downstream (§17).

## 10. Speech-to-Text Requirements
- Hosted ASR API (implementation choice) run once across the full audio track.
- Segment-level timestamps retained for evidence linking back to a point in the video.
- Automatic language detection; no assumption that narration is in English.
- An empty or near-empty transcript is a normal outcome (music-only videos), not a failure condition.

## 11. Claude Vision and Language-Model Requirements
- **One model, one reconciliation call per extraction attempt** (not a per-frame or per-segment call) — the call receives the cleaned transcript, cleaned/deduplicated OCR text with position metadata, the video caption/description, and a capped set of escalation frames, and returns structured JSON matching the schema in §13.
- **Escalation, not blanket vision.** Frames are only sent to Claude vision when OCR confidence is low on a region flagged as ingredient-likely, or when a frame is needed for context OCR can't provide (e.g., a shown-but-unlabeled ingredient). This is the core cost and latency lever — see the comparison in §11.1.
- The system prompt fixes the output schema and explicitly instructs the model not to infer a quantity or ingredient that isn't evidenced in the provided transcript/OCR/frames, and to mark a field `null` with a stated reason rather than filling it in.
- Recommended default model: **Claude Sonnet 5**, which is currently on introductory pricing ($2/$10 per million input/output tokens through August 31, 2026, standard $3/$15 thereafter) and handles both the vision escalation and the structured-reconciliation reasoning in one call. **Claude Haiku 4.5** ($1/$5 per million tokens) is worth evaluating as a cheaper substitute once there's enough real extraction data to check whether quality holds up for this specific task — flagged as a fast, low-risk post-MVP experiment rather than a day-one decision.
- Structured output is requested as JSON-only (no prose preamble), validated against the schema in §13 before being persisted; a validation failure triggers exactly one corrective re-prompt, then a terminal failure if it still doesn't validate.

### 11.1 OCR/Vision Strategy Comparison
| Approach | Assessment |
|---|---|
| **Hybrid: cheap OCR broad scan → Claude reconciliation → capped vision escalation** (recommended) | Lowest cost and latency; conventional OCR does the volume work, Claude is reserved for judgment and the handful of frames that actually need it. |
| Send all frames directly to Claude | Simplest to build, but scales cost and latency linearly with video length/frame count for no accuracy benefit on the majority of frames that OCR already handles fine. Not recommended even for MVP. |
| Train a TikTok-specific OCR model | Would likely outperform generic OCR on this exact use case eventually, but requires a labeled dataset this product doesn't have yet at private-beta scale. See §21 for the data bar that would justify this later. |
| Speech-to-text only | Misses every ingredient that's shown but not narrated — common in this format. Not viable alone. |
| OCR only | Misses context/quantities given only in narration, and can't disambiguate overlapping or fast-changing overlay text well. Not viable alone. |

**Recommendation:** the hybrid approach, as described in §6, for both MVP and the foreseeable production-like personal deployment.

## 12. Frame-Selection Strategy
- Candidate frames: scene-change detection (moderate, configurable threshold — recipe videos vary widely in editing pace, so this should be tunable rather than hardcoded) plus a fixed ~2-second fallback sample, capped at ~40 raw candidates.
- Deduplication via perceptual hashing typically brings this down to roughly 10–20 visually distinct frames.
- Escalation to Claude vision is capped at **8 frames per job** — the OCR-confidence-and-heuristic-scored top candidates, always including at least one frame from early in the video (title/ingredient-list card, if present) as a fixed inclusion regardless of scoring.

## 13. Structured Recipe Schema
```json
{
  "recipe_id": "uuid",
  "extraction_version": "2026-07-schema-v1",
  "source": {
    "source_url": "https://www.tiktok.com/@realtacotuesday/video/…",
    "video_id": "…",
    "creator_handle": "@realtacotuesday",
    "title_guess": "Weeknight Chicken Tacos"
  },
  "serving_count": { "value": 4, "confidence": "high", "evidence": ["asr:00:03-00:05"] },
  "overall_confidence": "medium",
  "ambiguity_flags": ["quantity_conflict:sour_cream"],
  "warnings": ["Quantities for sour cream conflict between narration and on-screen text"],
  "ingredients": [
    {
      "id": "ing_01",
      "raw_text": "a pound of chicken thighs",
      "canonical_name": "chicken thighs",
      "quantity": { "value": 1, "unit": "lb", "confidence": "high" },
      "preparation_note": "boneless, skinless",
      "optional": false,
      "pantry_staple": false,
      "brand_hint": null,
      "dietary_attributes": { "stated": [], "inferred": [] },
      "substitution_options": [],
      "confidence": "high",
      "evidence": [{ "source_type": "asr", "timestamp": "00:12-00:15" }]
    },
    {
      "id": "ing_04",
      "raw_text": "sour cream — ~1/2 cup? / on screen says 3/4 cup",
      "canonical_name": "sour cream",
      "quantity": { "value": null, "unit": "cup", "confidence": "low" },
      "pantry_staple": false,
      "confidence": "low",
      "evidence": [
        { "source_type": "asr", "timestamp": "01:02-01:04" },
        { "source_type": "ocr", "frame_ref": "f_07", "timestamp": "01:03" }
      ],
      "warnings": ["Narration and on-screen text disagree on quantity; on-screen text (¾ cup) preferred, both retained as evidence"]
    }
  ]
}
```
Full field list: recipe title, creator/source metadata, source URL, serving count, per-ingredient raw text, canonical name, quantity, unit, preparation note, optional/required flag, pantry-staple classification, brand/product attributes, dietary attributes (split into *stated* vs *inferred* — see §13.1), substitution options, confidence score, evidence source(s) and timestamps, warnings/ambiguities, and an extraction schema version for forward compatibility.

### 13.1 A Deliberate Safety Distinction: Stated vs. Inferred Dietary Attributes
Dietary tags (vegan, gluten-free, nut-free, etc.) are only ever populated as `stated` when the creator explicitly says or shows the claim. The model may separately note an `inferred` guess (e.g., "no dairy ingredients observed"), but Component 1 must never present an inferred tag with the same visual weight as a stated one — an inferred "looks gluten-free" is not a safety claim, and presenting it as one could genuinely hurt someone with an allergy. This is a hard schema-level distinction, not a UI nicety.

## 14. Confidence and Evidence Model
| Band | Meaning | Typical basis |
|---|---|---|
| High (≥0.85) | Directly and unambiguously stated | Matching narration and on-screen text, or one clear unambiguous source |
| Medium (0.5–0.85) | Present but partial, single-source, or lightly inferred | OCR-only or ASR-only with no corroboration |
| Low (<0.5) | Inferred, conflicting, or visual-only without text | Shown but unlabeled; conflicting sources; structurally implied |

A field with zero evidence is never silently populated — it's `null` with a `warnings` entry explaining why. Every non-null field carries at least one evidence reference.

## 15. Ambiguity-Handling Rules
- Narration and on-screen text disagree on a quantity → prefer on-screen text (typically more deliberate/precise), retain both values in evidence, and add a warning flag for user review (Component 1 surfaces this explicitly, never silently picks one).
- An ingredient is shown but not clearly named (e.g., an unlabeled cream) → keep the canonical name generic and confidence low; do not guess a specific product variant. Final disambiguation is explicitly deferred to Component 3's matching step and, where material, to the user.
- Vague, non-numeric quantities ("a glug of olive oil," "a handful of spinach") → stored as `quantity: null` with the qualitative phrase preserved in `raw_text`, never converted into a fabricated number.

## 16. Failure Classification and Retry Behavior
| Failure class | Retry? | Terminal behavior |
|---|---|---|
| `download_failed` (private/deleted/region-locked) | No | Immediate terminal failure, specific reason surfaced |
| `download_failed` (network/timeout) | Yes, ×2 with backoff | Terminal failure after retries exhausted |
| `no_speech_detected` | N/A — not a failure | Proceed with empty transcript |
| `ocr_low_yield` | N/A — not a failure | Proceed with lower confidence, more likely to escalate frames |
| `model_call_failed` | Yes, ×3 with backoff | Terminal "extraction service unavailable" after cap |
| `schema_validation_failed` | Yes, ×1 corrective re-prompt | Terminal failure if still invalid |
| `non_recipe_content_detected` | N/A — not a failure | Distinct terminal *result type*, not an error — Component 1 shows a friendly message, not a failure card |

## 17. Performance and Latency Targets
- Typical end-to-end extraction (sub-3-minute video): **60–90 seconds**, dominated by download and ASR, not by the Claude call.
- Hard job timeout: **5 minutes**, after which the job fails with a retry option rather than hanging indefinitely.
- No concurrency requirement for MVP — single-user volume means one job in flight at a time is an acceptable, simplifying constraint (see Component 4).

## 18. Token and Cost Targets
Grounded in current published Claude API pricing: a typical job sends roughly 8 escalation frames at ~1,000–1,100px long edge (on the order of ~1,000–1,300 vision tokens each), plus a transcript and cleaned OCR text for a sub-3-minute video (well under 2,000 tokens combined), plus schema/instruction overhead. That puts a typical reconciliation call at roughly 12,000–15,000 input tokens and a few hundred output tokens. At Claude Sonnet 5's current introductory pricing, that's on the order of **a few cents per recipe extraction, typically well under $0.05** — small enough that Claude cost is a rounding error against hosting cost (Component 4), not a budget driver. Recommendations to keep it that way: cap escalation frames hard at 8; use one reconciliation call, not iterative back-and-forth; set an explicit `max_tokens` on the response; consider prompt caching for the fixed schema/instruction portion of the system prompt once call volume justifies it (negligible benefit at single-user scale, worth revisiting if the beta group grows). The Batch API's 24-hour turnaround doesn't fit this use case — the user is waiting (even if not blocking) on the order of a minute, not a day.

## 19. Temporary-Storage and Deletion Requirements
- Downloaded video, extracted audio, and candidate/escalation frames live under a per-job temp directory.
- Deleted immediately when the job reaches any terminal state (`Completed`, `Failed`, `Expired`).
- A scheduled sweep (owned by Component 4) deletes anything past a 24-hour TTL as a backstop against orphaned files from crashed jobs.
- No evidence frames are persisted to the database by default in MVP — evidence is stored as timestamps and text snippets, not images (see §21 for the post-MVP alternative).

## 20. Observability and Quality Metrics
Extraction success rate; average overall confidence; % of jobs requiring vision escalation and average frames escalated; ASR empty-transcript rate; average OCR confidence; download failure rate by category (private/deleted/network/etc. — this specifically doubles as the "is yt-dlp breaking against a TikTok change" signal); Claude call failure/retry rate; average end-to-end latency by stage (download / media processing / model call).

## 21. Human Review and Correction Feedback Loop
Every ingredient edit or removal made in Component 1's Review screen is logged against that recipe's extraction record as an implicit quality signal — not used for real-time model fine-tuning (far too little data at private-beta scale to justify that), but retained for offline review of where extraction tends to go wrong. **What would justify training or fine-tuning a specialized OCR model:** a labeled corpus on the order of a few thousand diverse recipe-video frames with human-verified ground-truth text, which realistically only becomes available if the product scales meaningfully past personal/private-beta use. Below that scale, general-purpose OCR plus Claude reconciliation comfortably covers the volume and diversity of a single household's recipe sharing.

## 22. Dependencies on the Other Three Components
- **From Component 1:** the source URL and job id; nothing else is required to begin extraction.
- **From Component 4:** job orchestration/worker invocation, temp storage, and securely injected API credentials (ASR provider, OCR provider, Claude).
- **To Component 3:** the structured recipe schema (§13) is the entire matching input contract.
- **To Component 1:** the same structured recipe, plus confidence/evidence, for display.

## 23. API and Event Contracts
This component exposes no public HTTP API in MVP — it is invoked as an internal worker stage by Component 4.
| Event | Emitted when | Payload |
|---|---|---|
| `recipe.extraction.requested` | Job enters `Validating`/`Downloading` | `job_id`, `source_url` |
| `recipe.extraction.completed` | Reconciliation succeeds and validates | `job_id`, structured recipe (§13) |
| `recipe.extraction.failed` | Any terminal failure class in §16 | `job_id`, `failure_class`, message |
| `recipe.not_a_recipe` | Model classifies content as non-recipe | `job_id`, brief reason |

## 24. MVP Scope
Single-video public TikTok URLs; hybrid OCR+ASR+Claude pipeline as described; the full schema in §13 with stated/inferred dietary distinction; capped vision escalation; immediate media deletion; no persisted evidence images; no multi-video recipe stitching; no comment-thread ingestion (caption/description text only).

## 25. Post-MVP Roadmap
Optional per-user evidence-image retention (requires object storage, Component 4); multi-video recipe stitching (a manual "combine" action in Component 1); pinned-comment ingestion if a reliable source becomes available; content-hash-based repost detection to catch duplicate recipes shared via different URLs; evaluation of Haiku-tier models for the reconciliation call once real quality data exists.

## 26. Acceptance Criteria
- A valid single-video public TikTok recipe URL produces a structured recipe with confidence and evidence for every populated field within the 5-minute hard timeout.
- No field is populated without at least one evidence reference; unsupported fields are `null` with a stated reason.
- A non-recipe video returns the distinct `recipe.not_a_recipe` result, not a garbled recipe or a generic error.
- A private/deleted/region-locked video fails immediately with a specific, non-retryable reason.
- A conflicting quantity between narration and on-screen text is retained as a flagged warning, never silently resolved without a trace.
- No temp media file for a completed job exists on disk more than a few seconds after the job reaches a terminal state, and none exist past the 24-hour TTL backstop under any circumstance.

## 27. Open Questions and Recommended Decisions
| Question | Recommendation |
|---|---|
| How many frames extracted? | ~40 raw candidates pre-dedup (scene-change + 2s fallback), typically 10–20 after dedup, ≤8 escalated to vision. |
| How should frames be selected? | Hybrid scene-change detection with a fixed-interval fallback, since static text-overlay frames don't trigger scene-change alone. |
| What resolution? | Long edge ~1000–1100px — legible for OCR/vision without paying for unneeded resolution. |
| How should scene-change threshold be configured? | Moderate default, exposed as a tunable config value rather than hardcoded, since editing pace varies a lot across creators. |
| How is OCR confidence measured? | Native engine word/line confidence, aggregated per frame as the mean of the top-N most confident text blocks (avoids one blurry corner tanking an otherwise-clear frame). |
| How to detect changing overlays? | Treated as a tuned case of scene-change detection in text-dense regions, not a separate system, for MVP. |
| Music-only videos? | Proceed on OCR + vision only; empty transcript is not a failure. |
| No stated quantities? | `quantity: null` with the qualitative phrase preserved and a "not stated" evidence flag — never guessed. |
| Recipes across multiple videos? | Out of scope for MVP; each shared link is its own recipe. Flagged as a known limitation, with manual "combine" as a post-MVP idea. |
| Multiple spoken languages? | ASR auto-detects language; extraction proceeds regardless of language; canonical fields are output in English for consistent downstream matching, while `raw_text` preserves the original language. |
| Visually-shown, unspoken ingredients? | This is precisely what vision escalation exists for — treated as a standard case, not a special code path. |
| Creator captions/comments with corrections? | Video caption/description text is included in the reconciliation call by default (reliably available via yt-dlp metadata). Full comment-thread ingestion is likely out of reach for MVP given added scraping complexity/reliability risk — flagged as post-MVP, contingent on a reliable source. |
| How long is source media retained? | Zero retention beyond job completion; 24-hour TTL backstop for orphaned files. |
| Store thumbnails/evidence frames? | No, by default, in MVP — evidence is timestamps and text snippets. An opt-in "keep evidence images" setting is a reasonable post-MVP feature once object storage exists. |
| How to estimate/limit token usage? | Hard cap on escalation frames and transcript length; one reconciliation call; explicit `max_tokens`; revisit prompt caching if call volume grows. |
| How to safely retry failed model calls? | Idempotent by `job_id`; backoff; capped at 3 attempts; clear terminal failure rather than silent looping. |

---

## Appendix: Representative Edge Cases
1. **Language mismatch** — narration in Spanish, on-screen text in English (or vice versa). ASR detects the spoken language; OCR reads the overlay independently; reconciliation is expected to combine both without forcing a single "recipe language," preserving `raw_text` per source.
2. **Narration-only recipe** — fast-talking creator, zero on-screen text overlays. Extraction relies entirely on ASR + escalation frames for visual confirmation of ingredients that may be shown but not described in enough detail.
3. **Not actually a recipe** — a restaurant review or mukbang video with no cookable ingredient list. Expected result: `recipe.not_a_recipe`, not a fabricated ingredient list.
4. **Non-numeric quantities** — "a glug of olive oil," "a handful of spinach." Stored as `quantity: null` with the qualitative phrase retained verbatim; never converted to a fabricated number (e.g., never silently becomes "1 tbsp").
5. **Conflicting quantities** — narration says "one cup sugar," on-screen text says "¾ cup." Ambiguity rule in §15 applies: on-screen preferred, both retained, flagged for user review.
6. **Dead short link** — a `vm.tiktok.com` link that resolves to a video since deleted. Redirect resolves successfully; download then fails cleanly with "video no longer available," not a redirect-resolution error.
7. **Slideshow/photo-mode post** — images and captions only, no video or audio track. Pipeline runs OCR + caption reconciliation only; ASR stage is skipped entirely rather than erroring on a missing audio track.
