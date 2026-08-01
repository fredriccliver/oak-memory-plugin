# Context recall — design document

Written 2026-08-01 · Status: reviewed, ready to build · Repos: `fredriccliver/oak-memory-plugin`
(application layer), `fredriccliver/Memory` (core memory engine)

This document establishes **what the measurements allow**, and keeps the choices made on top of
them separate. Section 10 collects both — what has been decided and why, and the few values that
should be settled by using the feature rather than by discussing it.

One naming convention first. The existing path is called **query recall** — the model composes a
search phrase and calls `recallMemory`. The path proposed here is called **context recall** — the
recent conversation itself is the search key. Those two terms carry the rest of the document.

A note on the examples. Several sections quote real measurements taken against the author's own
memory database. The **contents of those memories and the names of the projects are withheld** —
different projects appear only as **A**, **B**, and **C**, and memories are described by their
nature. Which project is which has no bearing on any argument here.

---

## 1. Why this is needed

There is exactly one way memory gets read today. The model has to **first suspect** that
something is stored about this user. Three separate mechanisms exist to encourage that suspicion:
the instructions injected once at session start, the tool descriptions, and the hook that restates
the recall rule alongside every prompt (`src/hook.ts`). All three do the same thing — they
**persuade**.

Persuasion leaves one hole it cannot close. The turn that looks like it has nothing personal in it
is precisely the turn where the search gets skipped — and often precisely the turn where one
stored fact would have changed the answer. Worse, **a search that never happened leaves no
trace.** A wrong answer is visible. An unread memory is not.

## 2. The shape of the fix

Context recall asks the model nothing. It takes the last few lines of conversation, embeds them
as they are, finds the nearest memories, and puts them in front of the model. There is no
judgement, so there is nothing to skip.

The two paths do not replace each other. Query recall is precise, can chase a hunch, and can ask
several times from several angles — but it only fires when suspicion fires. Context recall is
neither precise nor able to dig. What it does is **never miss a turn**. Context recall sets a
floor; the digging stays with query recall.

---

## 3. What the measurements establish

Every number in this section was measured on this machine on 2026-08-01, or read out of real
files. Nothing here is an estimate. The samples are 115–143 real sessions (the count varies with
the filter) and the 52 memories currently stored. The measurement scripts live in the session
scratchpad.

### 3.1 The hook already receives everything it needs

The payload delivered to the `UserPromptSubmit` hook includes `transcript_path`. The current code
reads it and throws it away (`src/hook.ts:50`). **The path to the conversation, and the
permission to read it, are already in hand** — they are simply unused.

The conversation is stored as JSONL, one object per line, at
`~/.claude/projects/<project>/<session-id>.jsonl`. Two record shapes are useful: `type: "user"`
whose content is a **plain string** is something the user actually typed, and the `text` blocks of
`type: "assistant"` are what was said back. Everything else has to be filtered out — tool results,
tool-call arguments, thinking blocks, and anything flagged `isSidechain: true`.

### 3.2 The feedback loop is closed for free — the first piece of luck in this design

The frightening failure mode is this. Injected memories become part of the conversation. On the
next turn they get mixed into the search key, and they retrieve themselves. Within a few turns
recall collapses onto the same three memories — and it looks, from outside, like it is working
beautifully.

Reading the actual files shows that **content injected by a hook is stored as a separate
`attachment` record, not inside the user message** (`attachment.type ===
"hook_additional_context"`). That is a record type 3.1 already discards. The loop is not something
to filter out; it structurally cannot enter the search key in the first place.

### 3.3 User prompts are short — the prompt alone is not a usable search key

Across 143 real sessions and 1,282 user prompts:

| | 25% | median | 75% | 90% |
|---|---|---|---|---|
| user prompt length (chars) | 29 | **85** | 155 | 245 |
| one assistant text message (chars) | 56 | 96 | 243 | 883 |

Half of all prompts are 85 characters or shorter. Embedding one such prompt and searching returned
a memory with a similarity of 0.473 that had nothing to do with the conversation. That is
effectively a random draw.

**So the naive design — embed the current prompt — fails.** Preceding conversation has to come
along.

### 3.4 The right unit is neither message count nor character budget, but the conversational turn

The first idea was to take "the last N messages". That unit is wrong. Counting the assistant
messages that fall between two consecutive user prompts gives a median of 1, a 75th percentile of
4, a 90th of 9 — and a **maximum of 78**. Cutting by count means one session contributes three
sentences and another contributes an essay.

The second idea was a character budget. That fixes the volume problem but cuts at a meaningless
place: wherever the budget happens to run out.

The third idea is the right one. **Take everything back to the previous user message.** The
window is "the current prompt, plus the previous prompt, plus everything exchanged between them".
That is the natural unit of a conversation — one thing asked, answered, and followed up on,
arriving whole. Throughout this document, **window** means exactly that, and **depth** means how
many user messages back it reaches. What was just described is depth 2.

Measured across 14 real sessions:

| depth | lowest top-1 similarity | 25% | median | median window length |
|---|---|---|---|---|
| 1 (current prompt only) | 0.555 | 0.579 | 0.600 | 741 chars |
| **2 (back to previous user message)** | **0.585** | **0.639** | **0.654** | **2,146 chars** |
| 3 (two user messages back) | 0.586 | 0.630 | 0.661 | 3,334 chars |

Depth 2 beat depth 1 in 11 of 14 sessions. Depth 3 is effectively tied with depth 2 while being
55% longer. **Depth 2 is the answer** — it is exactly where adding more stops helping.

### 3.5 But a longer window starts hurting — because topics blend

This is the most important finding of the whole exercise. Taking one session from **project A**:

- With only the last message (1,211 chars) → similarity **0.710**, returning the memory holding
  **project A's deployment operating rules**. That conversation was about deployment environment
  variables being empty. **Exactly the right memory.**
- With eight messages (2,953 chars) → similarity 0.626, returning a memory about **project B's
  repository setup**. **A different project entirely.**

More context pushed the correct answer out. A single embedding lands at the **average position**
of the text fed to it. When one window covers two topics, the vector sits somewhere between them
and ends up close to neither.

**Where it turns over was measured too.** Cutting the same sessions at 1,200 and at 2,500
characters, the 2,500 version won 5 of 8 (one session went from 0.572 to 0.694) and lost slightly
in 2. So quality is still climbing at 2,500. Yet at 2,953 characters, as above, topics had already
blended. **The peak sits roughly between 2,000 and 2,500 characters, and it declines after that.**
That number later becomes the basis for "how long before we split" (section 8).

So a longer window alone cannot get past this wall. **Getting past it means not using a single
vector** (3.6).

### 3.6 When the window is long, split it and search the pieces

Splitting a window into pieces, searching each separately and merging the results, was measured
across 14 long windows (3,000+ characters), with pieces cut at message boundaries every 2,000
characters.

The result does not lean one way. Splitting won 5, lost 7, and tied 2. **That tally should not be
read at face value.** The losses are simply pieces holding less text, so the peak score comes down
with it. The wins are a different animal — they are **the windows where the topic blending of 3.5
actually happened**:

- Project A window (4,406 chars): whole 0.654 (wrong memory) → split **0.719, returning project
  A's deployment operating rules**. The exact answer lost in 3.5 came back.
- Project C window (4,775 chars): whole 0.567 (close enough to the floor to nearly be discarded) →
  split 0.639.

It was also common for each piece to have a **different** memory as its top hit — four pieces
producing four distinct top hits. Given that only a couple of memories get injected anyway, the
value of splitting is not raising the peak score; it is **recovering what a single averaged vector
misses**.

So the rule is neither "always split" nor "never split". **Short windows go in whole; long ones get
split and merged.** The distribution of depth-2 window lengths shows how that plays out:

| depth-2 window length | median | 75% | 90% | 97% | max |
|---|---|---|---|---|---|
| chars | 2,146 | 3,678 | 5,396 | 9,461 | 16,752 |

More than half of all turns have a window short enough to go in whole. Splitting handles the tail.
It also happens to solve the input-length problem of 3.9.

One property worth recording: pieces hold less text, so they score lower across the board. Setting
the floor of 3.7 tightly against whole-window scores would therefore cut every piece result away —
but since 3.7 settles on a deliberately permissive floor, this stops being a problem. Whole windows
and pieces pass through the same door, and how many get through is decided by the count limit.

### 3.7 There is a real boundary between unrelated and related conversation — and the value is 0.53

The claim "context recall must be able to return nothing" appeared in an earlier draft with no
evidence behind it. So it was measured.

Eight conversations unrelated to anything stored were constructed. Four are far away in subject
(sourdough fermentation, VAT filing, football, tax paperwork) and four are **technical but still
unrelated to this user's memories** (the Rust borrow checker, a Kubernetes 502, a pandas index, a
flexbox height). The second four are the genuinely dangerous ones, which is why they are there.

| | top-1 similarity |
|---|---|
| 8 unrelated conversations | 0.446 – **0.529** (mean 0.488) |
| 14 real work sessions, depth 2 | **0.585** – 0.694 (median 0.654) |

The technical ones did score higher, as expected (Rust 0.529, Kubernetes 0.522, flexbox 0.515).
Even so, **the ranges do not overlap.** The interval between 0.529 and 0.585 is empty.

**The floor is set at 0.53.** What matters more than the number is that its **job** was decided
first.

The floor must not be used to tune precision. That job belongs to **how many memories get
injected** (6.2). The floor has exactly one job — **inject nothing into a conversation that is
plainly unrelated.** The most permissive value that still does that job is 0.53: it rejects all
eight measured unrelated conversations (highest 0.529) and cannot go lower without letting one in.

Picking 0.56, the midpoint of the empty interval, was the alternative and was rejected. A midpoint
biases toward silence on borderline conversations, which means the floor is quietly doing the
count limit's work. Keeping the two jobs from overlapping is what makes it possible to tell
**which one is wrong** when something is wrong.

Three caveats belong with this number. First, the 0.45 written in an earlier draft is **below the
scores of unrelated conversations** and would have filtered nothing; that value was simply wrong.
Second, this boundary only holds for the depth-2 windows of 3.4 — with a single prompt, real
conversations drop to 0.47–0.48 and become indistinguishable from unrelated ones. **How the window
is cut comes first; the floor comes second.** Third, this is a property of the embedding model in
use (`bge-m3`). The hosted server's `text-embedding-3-small` has a different distribution and would
need its own measurement, which is why this must be a **setting** rather than a constant in code.

The samples — 8 unrelated, 14 real — are not generous. The empty interval is wide enough to be
visible, which makes this a sound starting value, but it should be treated as a number to
re-measure in use.

One approach was also confirmed *not* to work: separating on the gap between the 1st and 4th
scores. Unrelated conversations gave 0.021–0.069 and real ones 0.022–0.108 — fully overlapping.

### 3.8 Some memories act as magnets and attract any conversation

Sessions from four different projects returned **the same memory** as their top hit. A second
memory kept surfacing across many windows. Both are long and carry several topics in one node,
which plausibly leaves them middling-close to everything.

For something that runs every turn, this is a real problem: the same memory injected repeatedly
costs tokens and delivers nothing new. The session-level suppression of 6.5 is the guard against
it. The deeper fix is to split such memories with `/memory-organise`.

### 3.9 The embedding input limit is a wall that actually gets hit

During the experiments the error `the input length exceeds the context length` came back for real.
The limit is counted in tokens, not characters, so it varies with content: ordinary prose passed at
20,000 characters, while a conversation carrying code and tables failed at 6,000.

The splitting of 3.6 is the main answer, since long windows get divided anyway. But a single piece
can still trip it, so **on that error the text must be shortened and retried.** This is not a nicety;
it is a requirement confirmed by measurement.

### 3.10 Speed is not a concern — and splitting is free

| step | time |
|---|---|
| loading the `pg` module | 35ms |
| connecting to Postgres | 45ms |
| a query | 15ms |
| embedding 1 input | 150–230ms |
| **embedding 3 inputs in one batch** | **195ms** |
| Ollama reloading the model after idling | ~1,270ms |

A full pass costs **350–450ms** against a hook timeout of 10 seconds. And decisively: **three
inputs batched together cost the same as one.** That is what makes the splitting of 3.6 free —
pieces are embedded in a single batched call rather than one at a time.

---

## 4. The layer boundary

An earlier draft used the rule "engine changes are expensive, so implement in the plugin where
possible". That is not a criterion; it is laziness. The right criterion is this.

> **The plugin is the application layer and the engine is the core memory layer. Anything that
> holds true outside Claude Code belongs in the engine.**

Applying that changes the earlier conclusions considerably.

**What belongs to the engine (`Memory`).** "Recall from conversational context" is a general
concept. Any application with a conversation needs it — the hosted MCP server, any other client.
So the engine gets a recall path that takes a list of `{role, text}` and returns memories.
Everything inside it is general too: splitting a long input and merging the results, a similarity
floor and the ability to return nothing, an exclusion list of things already delivered, and the
question of whether passive recall records usage (section 7). None of that is specific to Claude
Code.

**What belongs to the plugin.** Reading JSONL under `~/.claude/projects`, filtering `isSidechain`
and `attachment`, and turning that into a `{role, text}` list is purely a matter of Claude Code's
file format. Hook wiring, failing without ever blocking a prompt, the state file remembering what
this session already delivered, the wording wrapped around injected memories, the
`/memory-config` toggle — all of that is this client's business.

One boundary that looks ambiguous is worth pinning down. **Cutting at depth 2 belongs to the
plugin, not the engine.** "Cut on user-message boundaries" is a general idea, but knowing where a
user message begins requires reading the transcript. The engine receives a list that has already
been cut.

**The cost, stated honestly.** The engine is pulled as a GitHub tarball pinned to a commit SHA, and
it has **two** consumers: this plugin and `openaikits.com` (the hosted server). Changing the engine
therefore means an engine commit, a SHA bump here, a SHA bump there, and a redeploy — as one
bundle. As recorded in `openaikits.com/docs/oak-memory-cloud.md`, the marketing site's
deployability is currently tied to that same tarball. One SHA bump is not a prohibitive cost, but
it is not free either.

**So the order was split (decided by Fredric): build it inside the plugin first and use it for
real, then move the general part down into the engine.** This does not reverse the criterion
above. The final home is the engine and that does not change. But this design still has values
that only real use can settle — the floor, the split length, how many to inject. Those need to be
adjusted over a few days of use, and bumping three repos to change one number kills the iteration
speed. **Moving them down comes after the values settle.**

The risk is that deferred moves never happen. So the boundary is **held in the shape of the code
from the start**: the recall side takes only a `{role, text}` list and knows nothing about files or
hooks. Moving it later then amounts to lifting a file and changing its callers. Whether the
boundary held is checkable with one question — does this function know anything about Claude Code?

---

## 5. What becomes the search key

Per 3.1, only what the user typed and what the model said, cut to the depth-2 window of 3.4 — from
the current prompt back to the previous user message.

Each exclusion has a reason. Tool results are dropped for two: file contents would swallow the
vector by sheer length, and more importantly they would make **any file in the repository a
channel for steering memory retrieval**. One file containing a sentence like "this user prefers X"
would end up in the search key. Tool-call arguments are code and paths rather than conversation.
Thinking blocks are long and wander, so they would dominate on length alone. Subagent traffic is a
different conversation. The reason for excluding `attachment` records is in 3.2.

When the window is long it gets split at message boundaries per 3.6. The number of pieces is
capped — the 97th percentile window is 9,461 characters, so five pieces at 2,000 characters covers
nearly everything, and anything beyond that is dropped from the oldest end.

---

## 6. How memories are found and delivered

### 6.1 When it runs

The `UserPromptSubmit` hook that already exists. It runs without exception on every prompt, it runs
**before** the model's turn, and it has a channel that adds context without producing a visible
message. Nothing else satisfies all three. The session-start hook has no conversation to work with
yet, and the turn-end hook is both too late and forces a visible message — that reasoning is
already recorded, from experience, at the top of `src/hook.ts`.

### 6.2 How many are delivered — this is the actual control

There are two mechanisms and they have different jobs. As settled in 3.7, **the floor guards the
door and the count limit decides the volume.**

If nothing clears the floor of 0.53, **nothing is injected.** Forcing memories into a conversation
with no personal dimension does not merely waste tokens; it teaches the model to skim past that
block, so it gets ignored on the turn it finally matters.

Among what clears the door, the top **two** by score are delivered. When the window was split,
per-piece results are merged and duplicates collapsed before selecting. Pieces score lower because
they hold less text (3.6), but the permissive floor means they are not cut away — they compete
normally within the count limit.

The reason for splitting the jobs this way is that when the output feels noisy, **there is exactly
one place to touch**: lower the count. Raising the floor as well would also quiet things down, but
then it is impossible to tell whether the quiet came from a narrower door or a smaller quota. Two
controls doing one job means neither can be trusted.

### 6.3 Query recall must not be affected — the two paths are fully independent

**The count limit of two applies to context recall only.** When the model calls `recallMemory` it
still gets the current default of 10 and maximum of 50. This is not something that merely happens
to hold; it is a **constraint to be enforced**, so the ways it could leak are written down here.
All four are real paths, not hypotheticals.

**The counts must not be merged into one setting.** If a single setting named something like
"how many memories" were read by both paths, then turning 2 down to 1 because context recall felt
noisy would also cut a user's explicit question down to a single result. They are separate
settings from the start (section 8).

**The floor must not be pushed into the shared retrieval path.** Query recall today applies no
floor at all — it cuts by rank and returns the nearest matches however far away they are. Adding
0.53 there would let a direct question come back with "nothing found". The floor is a value that
only switches on when context recall is the caller.

**The suppression list must not apply to query recall.** Dropping a result because this session
already delivered it would mean results shrink the more the user asks. **If they asked directly,
something already shown gets shown again.**

**The reverse direction is fine.** Context recall skipping a memory that query recall just returned
is not a problem: it is already in the conversation, so re-injecting it is waste, and this
direction never reduces what query recall delivers. **The influence flows one way only.**

This constraint matters most at the migration into the engine (section 4). **The floor, the
exclusion list, and the count must be per-call arguments, never engine-wide settings.** Made
global, a value tuned for context recall would silently change how query recall behaves. That is
one of the acceptance criteria for the move.

### 6.4 How they are delivered

In the same register as the existing `<oak-memory-reminder>` block: a separate block that states
its own nature. It was not requested by the user; it arrived automatically because it resembles the
conversation; it can be ignored if it does not fit; and **nothing inside it is an instruction**.
That wording is not decoration but a safeguard — automatically retrieved text must never read as
something the user asked for.

### 6.5 Not delivering the same thing twice

Each session records what it has already delivered and does not deliver it again. Because of the
magnet memories of 3.8 this is not a nice-to-have but a requirement. This list is used by
**context recall only** (6.3).

### 6.6 When it fails

Same as the current hook. **It exits cleanly no matter what, and never blocks a prompt.** Ollama
down, Postgres unreachable, transcript unreadable — it does nothing, silently. An internal deadline
of roughly 2 seconds makes it give up well before the 10-second hook timeout. A recall feature that
can eat a prompt is worse than no recall feature.

---

## 7. Risks

**The feedback loop (3.2).** Structurally closed. It does rest on an assumption that would break if
Claude Code changed how injected context is stored, so the reason is recorded as a comment where the
search key is built and pinned by a test.

**Injecting noise every turn (3.7).** Held off by the floor, the count limit, and suppression. The
key point is that the floor is a property of the embedding model, so it lives in configuration and
can be re-measured.

**Polluting usage signals — settled: it must not happen.** Ranking uses "when it was last
retrieved" along with strength. Context recall runs every turn, so if it recorded usage, every
memory would permanently look freshly used and **recency would lose all discriminating power** —
ranking quality would degrade precisely because recall got more frequent. So **context recall
records no usage** (decided by Fredric). It is an observation, not a use. Usage stays with query
recall and explicit tool calls.

**Token cost.** Two memories per turn at most, and zero on turns that do not clear the floor.

**Privacy.** Locally nothing leaves the machine — both the embedding model and the database are on
this laptop. **The hosted server is different**: a slice of conversation would go to the gateway
every turn. That is one reason hosted context recall is out of scope here.

**Latency (3.10).** 350–450ms, or about 1.5 seconds if the model has been unloaded. The internal
deadline of 6.6 bounds the worst case.

---

## 8. Settings

The policy is to **expose everything while demanding nothing** (decided by Fredric). Hiding values
leaves no room to adjust; laying out five of them and asking someone to choose is its own burden.
So all of it appears in `/memory-config`, with **a recommended value marked on each so that leaving
them alone is a valid choice**. The standard is that someone who opens the settings for the first
time and closes it without touching anything still gets correct behaviour.

| setting | recommended | what it means |
|---|---|---|
| context recall | **on** | automatically find and attach memories matching the conversation |
| memories per turn (context recall) | **2** | if it feels like too much, lower this first (6.2) |
| relevance floor | **0.53** | below this, nothing is delivered at all (3.7) |
| how far back to reach | **previous user message** | measured in 3.4 |
| length that triggers splitting | **2,000 chars** | longer conversations are searched in pieces (3.5, 3.6) |

These are all context-recall settings. **Query recall keeps its own separate limits** — default 10,
maximum 50 — and none of the above touches them (6.3).

There is a reason for marking values as *recommended* rather than as defaults full stop. They were
measured against the current embedding model (`bge-m3`) and the current number of stored memories,
so they are not permanent truths. Calling them recommendations keeps the settings screen honest
when they change.

Only the on/off switch sits at the top of `/memory-config`; the other four are grouped beneath it.
Most people can read the first line and close it.

---

## 9. Build order

**First, the part that cuts the conversation.** Read the transcript, build the window per section
5, split it when long. It needs neither the database nor the embedding model, so it is a pure
function and easy to test. It is also the part resting most heavily on the measurements — if this
is wrong, everything after it is wrong.

**Second, the part that searches and attaches.** All of section 6. The feature works once this
lands. Per section 4, the recall side takes only a `{role, text}` list so that moving it later is a
lift-and-shift.

**Third, settings and the toggle.** Section 8.

**Fourth, re-measure the values after some real use.** The floor, the count, the split length. This
is a measurement step, not a coding step.

**Fifth, move the general part into the engine.** After the values settle. The reasoning is in
section 4, and the non-interference requirements of 6.3 are part of its acceptance criteria.

---

## 10. What is settled and what is not

**Settled.**

| item | value | basis |
|---|---|---|
| default state | on | Fredric |
| where it is toggled | `/memory-config` | Fredric |
| how far the window reaches | back to the previous user message | Fredric's proposal, measured in 3.4 |
| long windows | split, search each, merge | Fredric's proposal, measured in 3.6 |
| relevance floor | 0.53, deliberately permissive | Fredric's direction, measured in 3.7 |
| volume control | the count limit, not the floor | Fredric's direction, 6.2 |
| interference with query recall | none, in either count, floor, or suppression | Fredric's direction, 6.3 |
| usage records | context recall records none | Fredric, section 7 |
| settings exposure | show everything, mark recommendations | Fredric, section 8 |
| which repo first | plugin first, engine later | Fredric, section 4 |

**To be settled by use, not by discussion** (section 9, fourth step).

- **Memories per turn** — start at 2. Drop to 1 if it stops carrying new information, raise to 3 if
  it feels thin.
- **Split length** — start at 2,000 characters. The peak sits between 2,000 and 2,500, so anywhere
  in that band is reasonable.
- **Relevance floor** — start at 0.53. Raise it if unrelated conversations start attracting
  memories.

---

## 11. Tracking

Tracked as a single issue on `oak-memory-plugin`, with the build order of section 9 as its
checklist. Engine work is deliberately not opened yet: the move happens after the values settle
(section 4), and by then the plugin code itself will say what needs moving. Opening it now would
leave an issue nobody has started sitting in the list.

Issue: **#1 — Context recall: retrieve memories from the recent conversation, not just from
model-issued queries** (https://github.com/fredriccliver/oak-memory-plugin/issues/1)
