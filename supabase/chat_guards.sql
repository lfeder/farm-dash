-- Applied 2026-08-14. Recorded here for review; already live in prod.
--
-- WHY
-- chat_query() is SECURITY DEFINER, so it executes as the function owner and
-- row-level security does not apply to it. Both credential tables below have
-- RLS enabled with zero policies — which correctly blocks the anon key
-- directly, and did nothing at all through chat_query.
--
-- The Farm AI chat calls chat_query with the public anon key, and that key
-- ships in lib/data-source.js in a public repo. So in practice anyone could
-- read a service_role key and the QuickBooks OAuth tokens. Found when the
-- assistant enumerated the schema unprompted and flagged sandbox_branch.
--
-- Two gates added. The credential gate keys off COLUMN names rather than a
-- table list, so a table created tomorrow holding a token is covered without
-- anyone remembering to update this file.
--
-- NOTE ON STRENGTH: this is string matching against the query text, which is a
-- mitigation and not a privilege boundary. A view that selects a credential
-- column and renames it would not be caught. The durable fix is to run the
-- EXECUTE under a restricted role (SET LOCAL ROLE chat_reader) so Postgres
-- grants do the work instead of a regex. Worth doing.

-- ---------------------------------------------------------------------------
-- 1. Relations hidden from the chat (visibility + readability)
-- ---------------------------------------------------------------------------

create table if not exists public.chat_hidden_table (
  pattern    text primary key,
  reason     text,
  created_at timestamptz not null default now()
);

comment on table public.chat_hidden_table is
  'Relations hidden from the Farm AI chat. `pattern` is a SQL LIKE pattern matched against relation names by chat_schema() and chat_query(). Insert to hide, delete to unhide; takes effect within 5 minutes (edge function schema cache TTL).';

-- Admin-only: no grants to anon/authenticated, so PostgREST never exposes it.
alter table public.chat_hidden_table enable row level security;

insert into public.chat_hidden_table (pattern, reason) values
  ('fix\_%',                        'one-off migration fix tables'),
  ('%backup%',                      'migration backups'),
  ('%rollback%',                    'migration rollback snapshots'),
  ('%\_bak',                        'ad-hoc backups'),
  ('%\_old',                        'superseded copies'),
  ('%\_tmp',                        'scratch'),
  ('%\_temp',                       'scratch'),
  ('%deprecated%',                  'superseded'),
  ('weather_view_baseline_20260813','dated baseline snapshot'),
  ('chat\_hidden\_table',           'this control table itself'),
  ('sandbox_branch',                'holds anon_key / service_key'),
  ('org_quickbooks_token',          'holds QuickBooks OAuth tokens')
on conflict (pattern) do nothing;

-- ---------------------------------------------------------------------------
-- 2. chat_schema(): keep hidden relations out of the model's prompt
-- ---------------------------------------------------------------------------
-- hr_* stays hardcoded: that is policy, not configuration, and should not be
-- removable with a DELETE.

create or replace function public.chat_schema()
returns jsonb
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $function$
  SELECT COALESCE(jsonb_agg(t ORDER BY t->>'table'), '[]'::jsonb)
  FROM (
    SELECT jsonb_build_object(
      'table', c.relname,
      'kind', CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'view' ELSE 'table' END,
      'columns', (
        SELECT jsonb_agg(jsonb_build_object('name', a.attname, 'type', format_type(a.atttypid, a.atttypmod)) ORDER BY a.attnum)
        FROM pg_attribute a
        WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      )
    ) AS t
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r','v','m')
      AND c.relname NOT LIKE 'hr\_%'
      AND c.relname NOT LIKE 'app\_hr\_%'
      AND NOT EXISTS (
        SELECT 1 FROM public.chat_hidden_table h
        WHERE c.relname LIKE h.pattern
      )
  ) sub;
$function$;

-- ---------------------------------------------------------------------------
-- 3. chat_query(): make hidden actually mean unreadable
-- ---------------------------------------------------------------------------
-- Hiding from the prompt alone is not enough — the model reaches
-- information_schema on its own and will happily query what it finds there.

create or replace function public.chat_query(q text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
DECLARE
  result jsonb;
  q_low  text := lower(q);
  q_trim text := regexp_replace(q, ';\s*$', '');
  bad    text;
BEGIN
  IF q_low !~ '^\s*(select|with)\s' THEN
    RAISE EXCEPTION 'Only SELECT/WITH queries are allowed';
  END IF;
  IF q_low ~ '\y(insert|update|delete|drop|alter|create|truncate|grant|revoke|comment|copy|vacuum|analyze|reindex|cluster|listen|notify|do|call|set|reset|begin|commit|rollback|savepoint|lock)\y' THEN
    RAISE EXCEPTION 'Write/DDL keywords are not permitted';
  END IF;
  IF q_low ~ '\y(hr_|app_hr_)\y' THEN
    RAISE EXCEPTION 'Restricted tables (hr_*) are not accessible';
  END IF;
  IF regexp_replace(q_trim, ';\s*$', '') ~ ';\s*\S' THEN
    RAISE EXCEPTION 'Multiple statements are not allowed';
  END IF;

  SELECT c.relname INTO bad
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r','v','m')
    AND a.attname ~* '(service_key|secret|password|passwd|api_key|access_token|refresh_token|private_key|credential)'
    AND q_low ~ ('\y' || lower(c.relname) || '\y')
  LIMIT 1;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'Table % holds credentials and is not accessible', bad;
  END IF;

  SELECT c.relname INTO bad
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r','v','m')
    AND EXISTS (SELECT 1 FROM public.chat_hidden_table h WHERE c.relname LIKE h.pattern)
    AND q_low ~ ('\y' || lower(c.relname) || '\y')
  LIMIT 1;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'Table % is excluded from the chat', bad;
  END IF;

  PERFORM set_config('statement_timeout', '20000', true);
  PERFORM set_config('transaction_read_only', 'on', true);

  EXECUTE format('SELECT COALESCE(jsonb_agg(row_to_json(t)), ''[]''::jsonb) FROM (%s) t', q_trim) INTO result;
  RETURN result;
END;
$function$;
