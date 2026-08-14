# `chat` edge function

Runs the Farm AI agent loop server-side and streams the result to `chat/index.html`.

## Why server-side

- The Anthropic key stays out of the browser.
- One user turn is several Anthropic calls plus several Postgres round-trips.
- Result sets get split: Claude sees a 30-row sample plus aggregates, the
  browser gets the full rows. Doing that split in the page would mean shipping
  the whole result to the model.

## Request

```
POST /functions/v1/chat
Authorization: Bearer <supabase publishable key>
Content-Type: application/json

{ "messages": [ ...Anthropic message array... ] }
```

The client owns conversation state and replays the whole array each turn; this
function is stateless apart from a 5-minute in-memory schema cache.

## Response — SSE

One JSON object per `data:` line. Unknown event types should be ignored, so new
ones can be added without breaking older clients.

| `type` | Fields | Meaning |
|---|---|---|
| `status` | `text` | Coarse progress label ("Thinking", "Reading results"). |
| `text` | `delta` | Assistant text chunk. Append. |
| `tool_start` | `id`, `name`, `query_id`, `sql`, `purpose` | A query is starting. |
| `tool_end` | `id`, `query_id`, `ms`, `row_count`, `columns`, `rows`, `truncated`, `error` | Query finished. `rows` is capped at 5,000; `error` non-null means it failed and Claude will retry. |
| `chart` | `query_id`, `spec` | Draw a chart from an earlier `tool_end`'s rows. |
| `followups` | `questions` | Up to three suggested next questions. |
| `done` | `usage`, `cost`, `messages` | Turn complete. **`messages` is the updated array — persist it and send it back next turn.** |
| `error` | `message` | Turn failed. May arrive after partial text. |

## Tools Claude has

- **`run_sql(sql, purpose)`** — goes through the `chat_query` RPC, which is
  `SECURITY DEFINER` and enforces SELECT/WITH only, a write/DDL keyword
  blocklist, no `hr_*` or `app_hr_*`, single statement, read-only transaction,
  20s timeout. Guardrails live there, not here — do not duplicate them.
- **`render_chart(query_id, chart_type, x, y, title, stacked?)`** — references a
  previous `run_sql` by id rather than re-emitting data, so charting a 5,000-row
  result costs no extra tokens.

## Configuration

| Env var | Source |
|---|---|
| `ANTHROPIC_API_KEY` | Must be set: `supabase secrets set ANTHROPIC_API_KEY=...` |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Injected by the platform. |

Model and loop limits are constants at the top of `index.ts`: `MODEL`,
`EFFORT`, `MAX_TOOL_ITERATIONS`, `MODEL_ROW_SAMPLE`, `CLIENT_ROW_CAP`.

## The business context block

`BUSINESS_CONTEXT` in `index.ts` is the semantic layer, and it is deliberately
thin. It sits above the prompt-cache breakpoint, so after the first request of
each 5-minute window it bills at cache-read rates — length is cheap there.
Curated material to move in lives in `chat/org-knowledge.md` and
`chat/context-rank-keep.json`.
