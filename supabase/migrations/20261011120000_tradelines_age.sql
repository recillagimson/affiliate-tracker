-- ---------------------------------------------------------------------------
-- A tradeline's age, kept as it was given.
--
-- 20261010120000 left age out, and had the app work it out from the open
-- date. That is not what is wanted: the sheet the tradelines come from
-- carries an "Age (Years)" figure, and the table has to show that figure,
-- exactly, not a number of the app's own that drifts away from the sheet a
-- little more each day. So it is a column now, filled from the paste or typed
-- in, and never calculated.
--
-- numeric with no scale, so every digit pasted is every digit kept.
-- Nullable: a row pasted without an age has none, and shows none, rather than
-- having one made up for it.
--
-- Safe to run twice.
-- ---------------------------------------------------------------------------

alter table public.tradelines
  add column if not exists age_years numeric;

alter table public.tradelines drop constraint if exists tradelines_age_check;
alter table public.tradelines
  add constraint tradelines_age_check
    check (age_years is null or (age_years >= 0 and age_years <= 150));

comment on column public.tradelines.age_years is
  'The tradeline''s age in years, exactly as pasted or typed. Never calculated. Null when none was given.';

comment on table public.tradelines is
  'The tradelines on offer, by issuer: name, credit limit, open date and age. The age is stored as given, not worked out from the open date.';

-- ---------------------------------------------------------------------------
-- Replacing one issuer's table, as before, carrying each row's age.
--
-- p_rows is a jsonb array of
--   {"name": <text>, "credit_limit": <numeric>, "open_date": <YYYY-MM-DD>,
--    "age_years": <numeric or null>}.
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

  insert into public.tradelines (issuer, name, credit_limit, open_date, age_years, created_by, updated_by)
  select
    p_issuer,
    e.value ->> 'name',
    (e.value ->> 'credit_limit')::numeric,
    (e.value ->> 'open_date')::date,
    (e.value ->> 'age_years')::numeric,
    coalesce(p_by, ''),
    coalesce(p_by, '')
  from jsonb_array_elements(p_rows) with ordinality as e(value, position)
  order by e.position;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
