-- ---------------------------------------------------------------------------
-- The tradelines table: what tradelines there are, issuer by issuer.
--
-- One row per tradeline: which issuer's table it belongs to, what it is (the
-- issuer and type, as the sheet names it), its credit limit, and the day it
-- was opened. There is deliberately no age column. A tradeline's age is today
-- minus its open date, and a number stored here would be wrong the next
-- morning; lib/tradelines.ts works it out each time the page is drawn.
--
-- The issuer list is the same list, in the same order, as TRADELINE_ISSUERS in
-- lib/tradelines.ts. scripts/tradelines-checks.ts reads this file and fails if
-- they disagree.
--
-- Same access model as every other table here: RLS on, no policies, revoked
-- from anon and authenticated. Only the server's service role reads or writes,
-- and the app shows it to admins only.
--
-- Safe to run twice.
-- ---------------------------------------------------------------------------

create table if not exists public.tradelines (
  id bigint generated always as identity primary key,

  issuer text not null,
  -- Issuer and type together, as the sheet writes it: "Capital One/Cabelas".
  name text not null,
  credit_limit numeric(12, 2) not null,
  open_date date not null,

  created_at timestamptz not null default now(),
  created_by text not null default '',
  updated_at timestamptz not null default now(),
  updated_by text not null default '',

  constraint tradelines_issuer_check
    check (issuer in ('capital-one', 'citi', 'discover', 'fidelity-elan', 'pnc', 'us-bank')),
  constraint tradelines_name_check check (char_length(name) between 1 and 120),
  constraint tradelines_limit_check check (credit_limit > 0 and credit_limit <= 10000000)
);

comment on table public.tradelines is
  'The tradelines on offer, by issuer: name, credit limit and open date. Age is worked out from the open date, never stored.';

-- One issuer's table, in the order it was entered.
create index if not exists tradelines_issuer_idx
  on public.tradelines (issuer, id);

alter table public.tradelines enable row level security;
revoke all on public.tradelines from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Replacing one issuer's whole table with a pasted list.
--
-- A function so that "delete what is there, then insert the new rows" is one
-- transaction. As two calls from the app, a failure between them would leave
-- an issuer with no tradelines at all.
--
-- p_rows is a jsonb array of
--   {"name": <text>, "credit_limit": <numeric>, "open_date": <YYYY-MM-DD>}.
-- The app has already checked every row; the table's constraints check again.
-- Inserted in the order given, so the table reads the way the sheet did.
-- Returns how many rows the issuer now has.
-- ---------------------------------------------------------------------------
create or replace function public.replace_tradelines(
  p_issuer text,
  p_rows jsonb,
  p_by text
)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Those rows could not be read. Paste them again.' using errcode = 'LG001';
  end if;

  delete from public.tradelines where issuer = p_issuer;

  insert into public.tradelines (issuer, name, credit_limit, open_date, created_by, updated_by)
  select
    p_issuer,
    e.value ->> 'name',
    (e.value ->> 'credit_limit')::numeric,
    (e.value ->> 'open_date')::date,
    coalesce(p_by, ''),
    coalesce(p_by, '')
  from jsonb_array_elements(p_rows) with ordinality as e(value, position)
  order by e.position;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.replace_tradelines(text, jsonb, text) is
  'Atomically replace one issuer''s tradelines with a new list. Called by the service role only.';

revoke all on function public.replace_tradelines(text, jsonb, text) from public, anon, authenticated;
grant execute on function public.replace_tradelines(text, jsonb, text) to service_role;
