-- ---------------------------------------------------------------------------
-- A tradeline's user price: what the user pays us for it.
--
-- A fifth fact on each row, beside the name, the credit limit, the open date
-- and the age. Money, so two decimal places. Nullable: the tradelines already
-- loaded have no price yet, and a row pasted without one has none, which is
-- shown as a blank rather than as $0.
--
-- Safe to run twice.
-- ---------------------------------------------------------------------------

alter table public.tradelines
  add column if not exists user_price numeric(12, 2);

alter table public.tradelines drop constraint if exists tradelines_user_price_check;
alter table public.tradelines
  add constraint tradelines_user_price_check
    check (user_price is null or (user_price >= 0 and user_price <= 1000000));

comment on column public.tradelines.user_price is
  'What the user pays us for this tradeline. Null when no price has been set.';

comment on table public.tradelines is
  'The tradelines on offer, by issuer: name, credit limit, open date, age and user price. The age is stored as given, not worked out from the open date.';

-- ---------------------------------------------------------------------------
-- Replacing one issuer's table, as before, carrying each row's age and price.
--
-- p_rows is a jsonb array of
--   {"name": <text>, "credit_limit": <numeric>, "open_date": <YYYY-MM-DD>,
--    "age_years": <numeric or null>, "user_price": <numeric or null>}.
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

  insert into public.tradelines (issuer, name, credit_limit, open_date, age_years, user_price, created_by, updated_by)
  select
    p_issuer,
    e.value ->> 'name',
    (e.value ->> 'credit_limit')::numeric,
    (e.value ->> 'open_date')::date,
    (e.value ->> 'age_years')::numeric,
    (e.value ->> 'user_price')::numeric,
    coalesce(p_by, ''),
    coalesce(p_by, '')
  from jsonb_array_elements(p_rows) with ordinality as e(value, position)
  order by e.position;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
