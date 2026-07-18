# Spec 2 — TikTok Media & Recipe Extraction

**Source PRD:** `component-2-tiktok-extraction-prd.md` (Draft v1, July 16, 2026)
**Siblings:** Spec 1 (Capture & Review) · Spec 3 (Matching & Cart) · Spec 4 (Backend Platform) · `phases.md`
**Status:** Draft for review — July 16, 2026
**Phase tags:** `[P0]` risk spike · `[P1]` barebones pipeline · `[P2]` hardening · `[P3+]` service integration

## 1. Overview & Scope

Turns a TikTok URL into an evidence-backed structured recipe (the canonical schema in §4 — **this spec owns that contract**; Specs 1 and 3 consume it). Runs as a library/worker module with no network API of its own: invoked by a CLI in Phases 1–2, by the Spec 4 worker from Phase 3 on. Hard rule inherited from the PRD: **no unsupported inference** — every populated field has evidence, or it's `null` with a stated reason.

## 2. Technical Design

### 2.1 Module breakdown `[P1]`

**Caption-first retrieval.** Most TikTok recipe creators paste the ingredient list into
the caption/description as a matter of habit — it's free, structured-ish text that
costs nothing to fetch (it comes back with `download`, no extra request). Checking it
first and only paying for frame extraction + OCR when it falls short is both cheaper
and lower-latency than always running the full vision path. This reorders the chain
around a `parse_caption` gate: cheap, broad OCR is still the fallback "cheap and
broad" layer from the PRD, but the caption is now the *first* cheap layer, checked
before OCR rather than alongside it.

Each stage is a pure-ish function taking a job context (job id, temp dir, config) so the same code runs under CLI or worker orchestration:

```
extract(url, ctx) →
  normalize_url      resolve vm.tiktok.com redirects; validate tiktok.com host; extract video id
  download           yt-dlp → {video, metadata(caption, creator, duration, has_audio)}; checksum/size sanity check
  probe              ffprobe: duration, audio track presence; detect photo-mode posts
  parse_caption      score caption text for an ingredient-list pattern (§2.3a); caption_sufficient: bool
  IF caption_sufficient:
    media_split        FFmpeg: audio only → 16kHz mono WAV/FLAC (frames NOT extracted)
    ocr                skipped entirely — no frames to run it on
  ELSE:
    media_split        FFmpeg: audio → 16kHz mono WAV/FLAC; frames → scene-change detect + 2s-interval fallback, ≤40 raw
    dedup_frames       perceptual hash (e.g., dHash, hamming distance threshold) → typically 10–20 distinct frames
    resize_frames      long edge ~1000–1100px
    ocr                per-frame text blocks with confidence + bounding boxes; chrome-region masking (§2.3b); language detect
  asr                 full audio → transcript with segment timestamps; auto language; empty transcript is a normal result
  escalate_select     score OCR blocks + transcript for ingredient-likelihood; pick ≤8 frames (§2.4) — no-op (0 frames) when caption_sufficient
  reconcile           ONE Claude call (§2.5) → recipe JSON
  postprocess         unit normalization, pantry-staple classification, schema validation (1 corrective re-prompt max)
  persist + cleanup   save recipe + evidence refs; delete temp media immediately
```

`asr` always runs regardless of `caption_sufficient` — captions carry the ingredient
list but essentially never carry cooking steps/method, which still need narration or
on-screen text as evidence. Only the *frame/OCR* branch is conditional.

`[P1]` builds this chain with happy-path behavior; `[P2]` adds the failure classes, retries, escalation scoring refinement, and photo-mode reduced pipeline (skip `media_split` audio + `asr` entirely).

### 2.2 Media retrieval `[P1]`
- yt-dlp version **pinned** (requirements/lockfile in P1, Docker image in P4) — TikTok breakage is an expected operational event; the download-failure-rate metric (§8) is the alarm.
- Timeouts: 45s to start download, 3min total for the stage. Retries `[P2]`: transient network ×2 with backoff; private/deleted/removed → immediate terminal failure, no retry.
- Sequential, one video at a time (matches Spec 4's single-job worker).

### 2.3a Caption sufficiency check `[P1]`
Reuses the same ingredient-likelihood scorer as escalation selection (§2.4: quantity/unit/food-noun pattern matches) against the caption text instead of OCR blocks. `caption_sufficient` is true when the caption contains at least `extraction.captionMinIngredientLines` (config, default 3 — see A2-7) distinct ingredient-pattern lines/segments — a loose heuristic, not a parse of a "real" list, since captions are free text and often mix ingredients with hashtags/commentary. False positives are cheap to catch downstream: `reconcile` still validates every field against the schema, and a caption that only *looked* sufficient but was missing quantities simply yields more `null` + `null_reason` fields, not a wrong answer. False negatives just cost an OCR pass that would have run anyway pre-revision, so the heuristic is deliberately biased toward skipping OCR only when confident.

### 2.3b OCR chrome masking `[P1]`, tuned `[P2]`
TikTok UI chrome occupies predictable regions (right-edge icon column, bottom caption/username band). Text blocks whose bounding boxes fall in these regions are down-weighted/tagged `chrome`, not deleted — this is the primary mechanism for separating creator overlay text from interface text. Region definitions are config, not code. Only relevant when `caption_sufficient` is false and OCR actually runs.

### 2.4 Escalation selection `[P2]` (P1 can send the top-N frames by simple OCR-confidence heuristic)
- Score = ingredient-likelihood of OCR text (quantity/unit/food-noun patterns) × inverse OCR confidence (low confidence on likely-ingredient text is exactly what needs vision) + bonus for early-video frames.
- Hard cap **8 frames/job**; always include at least one early frame (title/ingredient-card heuristic).
- Scene-change threshold and interval are config values (`extraction.scene_threshold`, `extraction.frame_interval_s`), not constants.

### 2.5 Claude reconciliation call `[P1]`, tightened `[P2]`
- **Model:** Claude Sonnet 5 (`claude-sonnet-5`). Haiku 4.5 evaluation is post-MVP once real data exists.
- **One call per attempt.** Inputs: caption/description, cleaned transcript (segment timestamps), deduplicated OCR blocks (text + frame ref + position + confidence, chrome-tagged) — empty when `caption_sufficient`, ≤8 escalation frames as images — also empty when `caption_sufficient`.
- System prompt: fixes the §4 schema; explicit instruction to never infer unevidenced quantities/ingredients — `null` + reason instead; **evidence-source conflict rule, in priority order: on-screen text (OCR) > caption > narration (ASR)** when two sources disagree on the same value — captions are convenient but sometimes stale/copy-pasted from a different video or recipe, so a directly-shown on-screen quantity still wins; when only caption evidence exists for a field (the `caption_sufficient` path), it's used as given, `source_type: caption`; `not_a_recipe` classification path.
- JSON-only output, explicit `max_tokens` (~4000), validated against the schema. One corrective re-prompt on validation failure, then terminal `schema_validation_failed`.
- Cost envelope: ~12–15k input tokens (8 frames ≈ 1,000–1,300 vision tokens each + <2k text), few hundred output → **well under $0.05/recipe** at Sonnet 5 introductory pricing. **On the `caption_sufficient` path, vision tokens drop to zero** — the call is just caption + transcript + schema/instruction overhead, well under 2k input tokens, cutting both cost and the dominant source of latency (frame extraction + OCR + vision tokens). Prompt caching deferred (negligible at single-user volume).

### 2.5a Alternative investigated: self-hosted local LLM instead of Claude (TABLED, not adopted)

Investigated 2026-07-18 as a possible way to remove the project's one remaining paid
API dependency entirely, in the same spirit as the OCR/ASR local-only pivot (§6
A2-1/A2-2). Real, live-tested against real evidence data via a throwaway spike
(`spikes/ollama-reconcile-spike.ts`, kept in the repo) — not a paper evaluation.

**Method:** `llama3.1:8b` via Ollama, run locally (CPU only, no GPU), tested three ways
against real extracted evidence from two real TikTok videos:
1. Plain prompting (same system prompt reconcile.ts sends Claude), no structural
   constraint → model ignored the schema entirely, returned an unrelated generic
   chatbot-shaped JSON object.
2. Same model + Ollama's JSON-Schema-constrained output (`format: <schema>`, not just
   `format: "json"` — grammar-constrained token sampling, forces the structural shape
   regardless of the model's own instruction-following) → structurally perfect JSON,
   but **fabricated a wrong recipe** ("chicken and onion stir fry" for a video that was
   actually beef bulgogi) — worse than a format failure, since it directly violates
   this project's core no-unsupported-inference guarantee. Input for this run included
   291 real but noisy OCR blocks (from a video needing the vision-escalation path,
   including garbage from degenerate too-small frames).
3. Same model + same schema constraint, but against a **clean, caption-sufficient**
   video (no OCR noise at all) → passed schema validation, correctly identified all 19
   real ingredients (not a hallucinated substitute), reasonably clean canonical names,
   plausible pantry-staple flagging.

**Conclusion — genuinely mixed, not a clean yes or no:**
- OCR noise was a real, confirmed contributing factor to the worst failure — clean
  text input performs dramatically better than noisy input on the same model.
- On clean caption-only input, quality is workable-verging-on-good for the happy path
  this spec's `caption_sufficient` gate already isolates.
- **Two disqualifying gaps remain, even on the clean case:** (a) latency — 172s for one
  reconcile call on CPU, vs. this spec's 60–90s target for the *entire* pipeline; a
  GPU-backed instance would help but changes the deployment shape and cost away from
  the Railway-Hobby-tier target (Spec 4 §Cost target); (b) evidence-citation
  precision — the ingredient list was factually right, but individual evidence
  snippets sometimes pointed at transcript segments that didn't actually mention that
  specific ingredient (right fact, imprecise citation) — a real gap against this
  project's evidence-traceability guarantee, short of fabrication but not clean either.
- **The harder case (vision-escalation path, needed when `caption_sufficient` is
  false) was never validated positively** — the one real test that exercised it
  (attempt 2 above) produced the worst failure of the three, and `llama3.1` has no
  vision capability at all, so a genuinely fair test would need a different,
  vision-capable local model not yet tried.

**Status: tabled, not adopted.** Claude remains the reconciliation model for now. This
is recorded as a real, partially-promising alternative worth revisiting — with a
vision-capable model, and/or on GPU-backed hosting, and/or restricted only to the
`caption_sufficient` path where it performed best — not a dead end, and not something
to re-litigate from scratch next time; start from this writeup and the spike script.

### 2.5b Escalation-frame path: correct usage boundary (finding, 2026-07-18)

**The vision-escalation path (§2.4/§2.5, `caption_sufficient: false`) is for reading
on-screen TEXT/graphics — a printed ingredient list, quantity call-outs, a recipe
card, or a photo-mode slideshow where the recipe is written out across slides. It is
NOT a general "watch the video and guess what food is being prepared" input.**

Found via an agent-simulated end-to-end smoke test (real download/OCR/ASR, a
subagent standing in for the Claude API call against real evidence — see session
notes) on `@shreddedandfed`'s beef bulgogi video: the only text ever legible on
screen or in the caption was "beef bulgogi" itself. Everything else the model
produced — `green onion (scallion)`, `bulgogi sauce`, and every prep/freeze step —
came from the model visually recognizing objects and actions in the 8 escalation
frame images (raw meat and scallions in a bowl, sauce being poured, bags being
sealed), not from any legible text. Nothing was fabricated (the frames really do
show those things), but it was tagged `source_type: "ocr"` — which the schema and
the rest of this doc define as on-screen *text* evidence — when it was actually
general visual inference the schema's evidence taxonomy has no category for.

**This is now a hard rule in the reconcile system prompt** (`reconcile.ts` rule 6):
frame images may only support a field when the frame also contains legible text
naming that value; visually recognizing food by appearance alone is explicitly
disallowed and must fall back to `null` + `null_reason` instead. Practical effect:
a video like the beef-bulgogi one above — plenty of visual cooking footage, almost
no on-screen text — should mostly yield `null_reason`s past the title, not a guessed
ingredient list. The vision-escalation path is only expected to produce a rich,
evidenced result on the two cases it was actually designed for: (a) videos with a
genuinely text-dense on-screen ingredient list/recipe card, or (b) photo-mode
slideshow posts where the recipe is printed across multiple slides. A video that
triggers escalation but turns out to have sparse on-screen text is a legitimate
`ocr_low_yield` case (§3) that should mostly resolve to nulls, not a signal to fall
back on visual guessing.

## 3. Failure Classification `[P2]`

| Class | Retry | Terminal behavior |
|---|---|---|
| `download_failed` (private/deleted/region) | No | Specific reason surfaced to Spec 1 failure card |
| `download_failed` (network/timeout) | ×2 backoff | Terminal after retries |
| `no_speech_detected` | not a failure | Proceed, empty transcript |
| `ocr_low_yield` | not a failure | Proceed, lower confidence, likelier escalation |
| `model_call_failed` | ×3 backoff | Terminal "extraction service unavailable" |
| `schema_validation_failed` | ×1 corrective re-prompt | Terminal |
| `non_recipe_content_detected` | not a failure | Distinct result type `recipe.not_a_recipe` |

Hard job timeout: 5 minutes. Latency target: 60–90s typical for sub-3-minute videos.

## 4. Data Contract — Canonical Recipe Schema `[P1]`

The full schema from PRD C2 §13, versioned `extraction_version: "2026-07-schema-v1"`. Key structural rules (enforced by validation, not convention):
- Every non-null field carries ≥1 evidence ref (`{source_type: asr|ocr|caption, timestamp?, frame_ref?}`).
- `quantity.value: null` + preserved `raw_text` for vague quantities ("a glug") — never a fabricated number.
- `dietary_attributes` split `stated` vs `inferred` — **schema-level safety distinction**; Spec 1 must render them with different weight and Spec 3 must not filter on `inferred` as if it were a claim.
- Canonical fields output in English; `raw_text` preserves source language.
- Evidence is timestamps + text snippets only in MVP — no persisted images.

Emitted events (worker-mode, `[P3]`): `recipe.extraction.requested` / `.completed` / `.failed` / `recipe.not_a_recipe` per PRD C2 §23, written to Spec 4's `events` table.

## 5. Setup & Environment

- **`[P0/P1]` local:** Node runtime (A4-1 resolved: TypeScript/Node), `yt-dlp`, `ffmpeg` (Homebrew locally), `ANTHROPIC_API_KEY` in `.env` — the **only** API key this spec needs; OCR and ASR both run on-device (A2-1/A2-2 below), no vendor account or key for either. Per-job temp dir under the local data dir, deleted at terminal state.
- **`[P4]` Docker:** all of the above layered into the single Spec 4 image; `ANTHROPIC_API_KEY` via a Railway env var; temp dir on the worker volume with the 24h TTL sweep as backstop. No OCR/ASR provider secret to manage in any environment.

## 6. Open Action Items

- [x] **A2-1 — OCR engine selection. RESOLVED: Tesseract.js (local, on-device).** Product decision: Claude is the only cloud AI dependency this project uses — no Google Cloud Vision or any other hosted OCR/ASR vendor. `tesseract.js` (pure JS/WASM, no external binary, runs identically local or in a container) does per-frame text detection; chrome-region tagging (§2.3b) works the same regardless of OCR backend. Real API-shape gotcha hit during implementation: tesseract.js's word-level output is nested `blocks[].paragraphs[].lines[].words[]`, not a flat list, and `blocks` is `null` unless explicitly requested via `recognize(image, {}, {blocks: true})` — a naive port of the original Vision-based code would have silently returned zero OCR blocks.
- [x] **A2-2 — ASR provider selection. RESOLVED: local Whisper (on-device), not the OpenAI Whisper API.** Same reasoning as A2-1 — via `@huggingface/transformers` (ONNX runtime), running a Whisper model entirely locally after a one-time model download from Hugging Face Hub (not a per-call cloud dependency). Deliberately a **multilingual** model variant (not `whisper-*.en`), matching this spec's existing "no English special-casing" requirement (§8). Real gotcha hit during implementation: the library's own `read_audio()` helper requires a browser `AudioContext`, unavailable in Node — a hand-written WAV-PCM parser feeds raw sample data to the pipeline directly instead. Model choice (`Xenova/whisper-base`, config value `extraction.whisperModel`) trades off download size/speed against quality for P1; revisit once real data exists on whether quality is sufficient.
- [ ] **A2-3 — Escalation frame cap and raw-candidate cap.** PRD proposes ≤8 escalated / ~40 raw. Recommendation: accept as config defaults; revisit only with cost/quality data.
- [ ] **A2-4 — Confidence band thresholds** (high ≥0.85, medium 0.5–0.85, low <0.5). Recommendation: accept as speced; they only need to be consistent, not perfect. Confirm before P2.
- [ ] **A2-5 — Evidence snippet format.** How much surrounding transcript/OCR text to store per evidence ref (recommendation: the matched segment ±1 segment, capped ~200 chars).
- [ ] **A2-6 — Test-set curation.** Pick the ~10 varied real TikToks for the P2 exit gate (narration-only, text-only, music-only, non-recipe, photo-mode, conflict, vague-quantity cases). **Add a caption-has-full-list case and a caption-has-partial/no-list case specifically to exercise the §2.3a gate both ways.**
- [ ] **A2-7 — Caption-sufficiency threshold.** Minimum distinct ingredient-pattern lines in the caption to set `caption_sufficient = true` (recommendation: 3, config value `extraction.captionMinIngredientLines`). Starting default only — revisit once real caption-vs-OCR outcomes are observable; a threshold that's too low risks silently accepting a caption that only has 2 of 8 real ingredients (schema validation and ingredient-count sanity checks are the backstop, not a substitute for tuning this).

## 7. Blockers

- **B2-1 — yt-dlp viability against current TikTok.** The whole component depends on it. Resolved by the Phase 0 spike; if it fails, fallback conversation needed (browser-automation download, or manual transcript-paste input as the PRD's post-MVP idea pulled forward).
- **B2-2 — Photo-mode post support in yt-dlp.** Slideshow posts are in scope with a reduced pipeline; confirm yt-dlp actually retrieves the images. Also P0.
- ~~B2-3 — ASR/OCR vendor accounts + keys.~~ **Obsolete** — both run locally now (A2-1/A2-2), no vendor account or key needed for either.
- **B2-4 — Anthropic API key with billing.** Gates P1.

## 8. Considerations

- **Setup:** yt-dlp pin + the download-failure-by-category metric double as the TikTok-breakage early-warning system — build the failure-class logging even in P1, since it costs little and the signal matters immediately. The Docker image (P4) needs no Chromium (Spec 3's Kroger pivot removed that entirely) — ffmpeg + local OCR/ASR model weights are the bulk of it; set up build caching from the first Dockerfile regardless, and consider baking the Whisper model weights into the image rather than downloading on first run in production.
- **Functionality:** The no-inference rule is the trust foundation for the entire product — when tuning prompts in P2, resist "fixing" missing quantities by loosening it; a rising ingredient-edit rate in Spec 1's metrics is the regression signal. Multi-video recipes and comment ingestion are explicitly out of scope; each link is its own recipe. Multilingual content is handled by design (ASR/OCR auto-detect, English canonical fields, original-language `raw_text`) — don't special-case English anywhere. The caption-sufficiency gate (§2.3a) is a heuristic, not a guarantee — `reconcile`/`postprocess` schema validation is what actually catches an under-specified caption, not the gate itself; if P2 data shows the gate is too eager (accepting captions that miss real ingredients), tighten A2-7's threshold before considering removing the gate.
- **Quality loop:** Log every Spec 1 ingredient edit against the extraction record (`[P3]`) as an offline quality signal. A custom OCR model is explicitly not justified below a few-thousand-frame labeled corpus.
- **Observability (`[P2]` counters, `[P3]` persisted):** extraction success rate, avg confidence, escalation rate + frames/job, empty-transcript rate, download-failure breakdown, Claude retry rate, per-stage latency, **caption-sufficient rate (% of jobs that skip OCR entirely) — the primary signal for whether A2-7's threshold is well-tuned.**
