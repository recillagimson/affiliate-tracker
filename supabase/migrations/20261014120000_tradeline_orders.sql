-- ---------------------------------------------------------------------------
-- Tradeline orders: what customers have ordered from the storefront, who sent
-- them, and what that earns.
--
-- An order is placed from the storefront's checkout by somebody who is not
-- signed in. It arrives unpaid. An admin marks it paid once the money is in,
-- and that is the moment the affiliate behind it has earned their commission.
--
-- Three tables.
--
-- tradeline_orders is the order: the customer, where it stands, and the
-- affiliate credited with it (nobody, for a house sale). The customer's SSN
-- and date of birth are sealed by the application before they arrive
-- (AES-256-GCM, lib/secret-box, the same key as W-9s); only the SSN's last
-- four digits are kept readable. The plain numbers are never written here.
--
-- tradeline_order_items is what was bought, one row per tradeline, as a copy.
-- Deliberately not a reference to public.tradelines: pasting a new sheet
-- deletes and re-creates those rows, and an order has to keep saying what it
-- was for. Each row carries its commission, fixed when the order was placed,
-- so changing the rate later does not rewrite what was agreed. The row's id
-- is permanent, which is what a payout will point at.
--
-- tradeline_ssn_reveals records each time an admin reads an order's SSN and
-- date of birth back: who, and when.
--
-- Orders go in through place_tradeline_order, so an order and its lines are
-- one transaction and an order is never saved without them.
--
-- Same access model as every other table here: RLS on, no policies, revoked
-- from anon and authenticated. Only the server's service role reads or writes.
--
-- Needs 20261013120000_tradeline_ref to have been run. Run this before the
-- storefront's checkout is used; until then the checkout says it is not
-- available and every other page works as before.
--
-- Safe to run twice.
-- ---------------------------------------------------------------------------

create table if not exists public.tradeline_orders (
  id bigint generated always as identity primary key,
  -- What the customer is given: LGF- and six digits. Filled in by the trigger.
  order_number text not null default '',
  created_at timestamptz not null default now(),

  status text not null default 'awaiting_payment',
  paid_at timestamptz,
  paid_by text,
  cancelled_at timestamptz,
  cancelled_by text,

  customer_name text not null,
  customer_email text not null,
  customer_mobile text not null,
  address_line1 text not null,
  address_line2 text not null default '',
  city text not null,
  state text not null,
  zip text not null,

  ssn_encrypted text not null,
  ssn_last4 text not null,
  dob_encrypted text not null,

  -- The reference number the order arrived with, as given, for the record.
  tradeline_ref text not null default '',
  -- Who is credited. Null for a house sale. Refuses rather than cascades:
  -- deleting somebody must not make their sales look like nobody's.
  affiliate_user_id text references public.users (id) on delete restrict,

  total numeric(12, 2) not null,

  constraint tradeline_orders_status_check
    check (status in ('awaiting_payment', 'paid', 'cancelled')),
  -- The dates say the same thing the status does. A cancelled order that had
  -- been paid keeps its paid date, as history.
  constraint tradeline_orders_dates_check
    check (
      (status = 'awaiting_payment' and paid_at is null and cancelled_at is null)
      or (status = 'paid' and paid_at is not null and cancelled_at is null)
      or (status = 'cancelled' and cancelled_at is not null)
    ),
  constraint tradeline_orders_number_check
    check (order_number ~ '^LGF-[0-9]{6}$'),
  constraint tradeline_orders_sealed_check
    check (ssn_encrypted <> '' and dob_encrypted <> ''),
  constraint tradeline_orders_last4_check
    check (ssn_last4 ~ '^[0-9]{4}$'),
  constraint tradeline_orders_state_check
    check (state ~ '^[A-Z]{2}$'),
  constraint tradeline_orders_zip_check
    check (zip ~ '^[0-9]{5}(-[0-9]{4})?$'),
  constraint tradeline_orders_total_check
    check (total > 0)
);

comment on table public.tradeline_orders is
  'Orders from the tradelines storefront. ssn_encrypted and dob_encrypted are AES-256-GCM ciphertext; the plain SSN and date of birth are never written here.';

create unique index if not exists tradeline_orders_number_key
  on public.tradeline_orders (order_number);

-- Every order, newest first, for the admin list.
create index if not exists tradeline_orders_created_idx
  on public.tradeline_orders (created_at desc);

-- One affiliate's orders, for their dashboard.
create index if not exists tradeline_orders_affiliate_idx
  on public.tradeline_orders (affiliate_user_id, created_at desc)
  where affiliate_user_id is not null;

alter table public.tradeline_orders enable row level security;
revoke all on public.tradeline_orders from anon, authenticated;

-- ---------------------------------------------------------------------------
-- The order number, drawn at random the way reference numbers are, so that
-- one customer's number says nothing about how many orders there have been.
-- ---------------------------------------------------------------------------

create or replace function public.assign_tradeline_order_number()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  candidate text;
begin
  loop
    candidate := 'LGF-' || (100000 + floor(random() * 900000))::int::text;
    exit when not exists (select 1 from public.tradeline_orders where order_number = candidate);
  end loop;
  new.order_number := candidate;
  return new;
end;
$$;

revoke all on function public.assign_tradeline_order_number() from public, anon, authenticated;

drop trigger if exists tradeline_orders_number_trigger on public.tradeline_orders;
create trigger tradeline_orders_number_trigger
  before insert
  on public.tradeline_orders
  for each row
  execute function public.assign_tradeline_order_number();

-- ---------------------------------------------------------------------------
-- What was bought.
-- ---------------------------------------------------------------------------

create table if not exists public.tradeline_order_items (
  id bigint generated always as identity primary key,
  order_id bigint not null references public.tradeline_orders (id) on delete cascade,

  issuer text not null,
  name text not null,
  credit_limit numeric(12, 2) not null,
  open_date date not null,
  age_years numeric,

  unit_price numeric(12, 2) not null,
  quantity integer not null,
  line_total numeric(12, 2) not null,
  -- What the affiliate earns on this line once the order is paid. Nought for
  -- a house sale. Decided when the order was placed.
  commission numeric(12, 2) not null default 0,

  constraint tradeline_order_items_name_check check (char_length(name) between 1 and 120),
  constraint tradeline_order_items_price_check check (unit_price > 0 and line_total > 0),
  constraint tradeline_order_items_quantity_check check (quantity between 1 and 12),
  constraint tradeline_order_items_commission_check check (commission >= 0)
);

comment on table public.tradeline_order_items is
  'The tradelines in an order, copied at the time: an order does not depend on public.tradelines still holding the row.';

create index if not exists tradeline_order_items_order_idx
  on public.tradeline_order_items (order_id, id);

alter table public.tradeline_order_items enable row level security;
revoke all on public.tradeline_order_items from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Who read an SSN back, and when.
-- ---------------------------------------------------------------------------

create table if not exists public.tradeline_ssn_reveals (
  id bigint generated always as identity primary key,
  order_id bigint not null references public.tradeline_orders (id) on delete cascade,
  revealed_at timestamptz not null default now(),
  revealed_by text not null
);

create index if not exists tradeline_ssn_reveals_order_idx
  on public.tradeline_ssn_reveals (order_id, revealed_at desc);

alter table public.tradeline_ssn_reveals enable row level security;
revoke all on public.tradeline_ssn_reveals from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Placing an order: the order and its lines, or neither.
--
-- The app has already checked and priced everything; the tables' constraints
-- check again. The total is worked out here from the lines, so the order's
-- total cannot disagree with them.
-- ---------------------------------------------------------------------------

create or replace function public.place_tradeline_order(
  p_order jsonb,
  p_items jsonb
)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_total numeric(12, 2);
  v_id bigint;
  v_number text;
begin
  if p_order is null or jsonb_typeof(p_order) <> 'object'
     or p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'That order could not be read.' using errcode = 'LG001';
  end if;

  select sum(line_total)
    into v_total
    from jsonb_to_recordset(p_items) as item (line_total numeric);

  insert into public.tradeline_orders (
    customer_name, customer_email, customer_mobile,
    address_line1, address_line2, city, state, zip,
    ssn_encrypted, ssn_last4, dob_encrypted,
    tradeline_ref, affiliate_user_id, total
  )
  values (
    p_order ->> 'customer_name', p_order ->> 'customer_email', p_order ->> 'customer_mobile',
    p_order ->> 'address_line1', coalesce(p_order ->> 'address_line2', ''), p_order ->> 'city',
    p_order ->> 'state', p_order ->> 'zip',
    p_order ->> 'ssn_encrypted', p_order ->> 'ssn_last4', p_order ->> 'dob_encrypted',
    coalesce(p_order ->> 'tradeline_ref', ''), nullif(p_order ->> 'affiliate_user_id', ''), v_total
  )
  returning id, order_number into v_id, v_number;

  insert into public.tradeline_order_items (
    order_id, issuer, name, credit_limit, open_date, age_years,
    unit_price, quantity, line_total, commission
  )
  select v_id, item.issuer, item.name, item.credit_limit, item.open_date, item.age_years,
         item.unit_price, item.quantity, item.line_total, coalesce(item.commission, 0)
    from jsonb_to_recordset(p_items) as item (
      issuer text, name text, credit_limit numeric, open_date date, age_years numeric,
      unit_price numeric, quantity integer, line_total numeric, commission numeric
    );

  return v_number;
end;
$$;

revoke all on function public.place_tradeline_order(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.place_tradeline_order(jsonb, jsonb) to service_role;
