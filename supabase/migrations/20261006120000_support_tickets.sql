-- ---------------------------------------------------------------------------
-- Support tickets: an affiliate asks a question or gives feedback, and the two
-- sides talk in the app until it is closed.
--
-- Three tables. The ticket (public.support_tickets) is the conversation's
-- header: whose it is, what it is about, whether it is open, and who spoke
-- last. The messages (public.support_messages) are the conversation. The
-- attachments (public.support_attachments) are the screenshots, kept as base64
-- the way public.payout_requests keeps a receipt, and for the same reason
-- never selected by a list query.
--
-- Unread is two timestamps on the ticket, one per side, compared against
-- last_message_at. Every admin shares admin_read_at: read by one is read for
-- all. Both are only ever written with now() inside this database, never with
-- the app server's clock, so a reader a second behind the database cannot
-- leave a ticket permanently unread.
--
-- The category, status and image type lists are the same lists as in
-- lib/support.ts, and so are 150, 5000 and 3. scripts/support-store-checks.ts
-- reads this file and fails if any of them disagree.
--
-- Same access model as every other table here: RLS on, no policies, revoked
-- from anon and authenticated. Only the server's service role reads or writes.
--
-- Safe to run twice.
-- ---------------------------------------------------------------------------

create table if not exists public.support_tickets (
  id bigint generated always as identity primary key,

  -- The affiliate the ticket belongs to, whoever opened it. Cascade: a ticket
  -- is a conversation with a person, and means nothing once they are gone.
  user_id text not null
    constraint support_tickets_user_id_fkey references public.users (id) on delete cascade,

  subject text not null,
  category text not null,
  status text not null default 'open',

  -- Who pressed the button, as a sentence: "username", or
  -- "username (via Admin Name)" from Client View.
  opened_by text not null default '',
  opened_by_role text not null,
  created_at timestamptz not null default now(),

  -- Kept on the ticket so a list can sort and badge without reading messages.
  last_message_at timestamptz not null default now(),
  last_message_role text not null,

  affiliate_read_at timestamptz,
  admin_read_at timestamptz,

  closed_at timestamptz,
  closed_by text not null default '',

  constraint support_tickets_subject_check check (char_length(subject) between 1 and 150),
  constraint support_tickets_category_check
    check (category in ('question', 'payout', 'bug', 'feedback')),
  constraint support_tickets_status_check
    check (status in ('open', 'closed')),
  constraint support_tickets_opened_by_role_check
    check (opened_by_role in ('affiliate', 'admin')),
  constraint support_tickets_last_message_role_check
    check (last_message_role in ('affiliate', 'admin')),
  -- A status and the timestamp that proves it travel together.
  constraint support_tickets_closed_pair_check
    check ((status = 'closed') = (closed_at is not null))
);

comment on table public.support_tickets is
  'One row per support conversation between an affiliate and the admins: what it is about, whether it is open, who spoke last, and when each side last read it.';

-- An affiliate's own list, newest activity first.
create index if not exists support_tickets_user_idx
  on public.support_tickets (user_id, last_message_at desc);

-- The admin list, which opens on the open ones.
create index if not exists support_tickets_status_idx
  on public.support_tickets (status, last_message_at desc);

alter table public.support_tickets enable row level security;
revoke all on public.support_tickets from anon, authenticated;

create table if not exists public.support_messages (
  id bigint generated always as identity primary key,
  ticket_id bigint not null references public.support_tickets (id) on delete cascade,

  author_role text not null,
  -- No foreign key on purpose: the environment admin writes as 'env:admin',
  -- which has no row in public.users.
  author_id text not null default '',
  author_name text not null default '',

  body text not null,
  created_at timestamptz not null default now(),

  constraint support_messages_author_role_check
    check (author_role in ('affiliate', 'admin')),
  constraint support_messages_body_check check (char_length(body) between 1 and 5000)
);

comment on table public.support_messages is
  'The messages of a support ticket, oldest first. Never edited or deleted.';

create index if not exists support_messages_ticket_idx
  on public.support_messages (ticket_id, id);

alter table public.support_messages enable row level security;
revoke all on public.support_messages from anon, authenticated;

create table if not exists public.support_attachments (
  id bigint generated always as identity primary key,
  message_id bigint not null references public.support_messages (id) on delete cascade,
  -- Repeated from the message so the file route can find the owner in one
  -- small read before it ever asks for the bytes.
  ticket_id bigint not null references public.support_tickets (id) on delete cascade,

  name text not null,
  type text not null,
  size integer not null,
  -- Bare base64. Never selected by a list or a thread read: see
  -- lib/support-store.ts, where the columns are spelled out.
  data text not null,

  constraint support_attachments_type_check
    check (type in ('image/png', 'image/jpeg', 'image/webp')),
  constraint support_attachments_size_check check (size > 0),
  constraint support_attachments_data_check check (char_length(data) > 0)
);

comment on table public.support_attachments is
  'Images attached to a support message, as base64. Served one at a time through a signed-in route.';

create index if not exists support_attachments_message_idx
  on public.support_attachments (message_id);

create index if not exists support_attachments_ticket_idx
  on public.support_attachments (ticket_id);

alter table public.support_attachments enable row level security;
revoke all on public.support_attachments from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Opening a ticket: the ticket, its first message and its images, in one
-- transaction or not at all.
--
-- p_attachments is a jsonb array of
--   {"name": <text>, "type": <text>, "size": <int>, "data": <base64 text>}.
-- The app has already checked each file's signature; this function only
-- counts them, and the table's constraints refuse a type that is not an image.
--
-- Errors, which lib/support-store.ts maps to its own classes:
--   LG001  a subject, message, category or image list it cannot accept (422)
--   LG003  the account is not an affiliate, or does not exist          (422)
-- ---------------------------------------------------------------------------
create or replace function public.create_support_ticket(
  p_user_id text,
  p_subject text,
  p_category text,
  p_opened_by text,
  p_opened_by_role text,
  p_author_id text,
  p_body text,
  p_attachments jsonb
)
returns bigint
language plpgsql
set search_path = ''
as $$
declare
  v_ticket_id bigint;
  v_message_id bigint;
  v_subject text := btrim(coalesce(p_subject, ''));
  v_body text := btrim(coalesce(p_body, ''));
  v_files jsonb := coalesce(p_attachments, '[]'::jsonb);
  v_now timestamptz := now();
begin
  if char_length(v_subject) not between 1 and 150 then
    raise exception 'A ticket needs a subject of up to 150 characters.' using errcode = 'LG001';
  end if;
  if char_length(v_body) not between 1 and 5000 then
    raise exception 'A message needs some text, up to 5,000 characters.' using errcode = 'LG001';
  end if;
  if p_category is null or p_category not in ('question', 'payout', 'bug', 'feedback') then
    raise exception 'Choose what the ticket is about.' using errcode = 'LG001';
  end if;
  if p_opened_by_role is null or p_opened_by_role not in ('affiliate', 'admin') then
    raise exception 'That ticket could not be read. Reload the page and try again.' using errcode = 'LG001';
  end if;
  if jsonb_typeof(v_files) <> 'array' then
    raise exception 'Those images could not be read. Attach them again.' using errcode = 'LG001';
  end if;
  if jsonb_array_length(v_files) > 3 then
    raise exception 'Up to 3 images can be attached to a message.' using errcode = 'LG001';
  end if;

  if not exists (select 1 from public.users u where u.id = p_user_id and u.role = 'affiliate') then
    raise exception 'A ticket can only be opened for an affiliate account.' using errcode = 'LG003';
  end if;

  insert into public.support_tickets (
    user_id, subject, category, status, opened_by, opened_by_role,
    created_at, last_message_at, last_message_role, affiliate_read_at, admin_read_at
  )
  values (
    p_user_id, v_subject, p_category, 'open', coalesce(p_opened_by, ''), p_opened_by_role,
    v_now, v_now, p_opened_by_role,
    case when p_opened_by_role = 'affiliate' then v_now end,
    case when p_opened_by_role = 'admin' then v_now end
  )
  returning id into v_ticket_id;

  insert into public.support_messages (ticket_id, author_role, author_id, author_name, body, created_at)
  values (v_ticket_id, p_opened_by_role, coalesce(p_author_id, ''), coalesce(p_opened_by, ''), v_body, v_now)
  returning id into v_message_id;

  insert into public.support_attachments (message_id, ticket_id, name, type, size, data)
  select v_message_id, v_ticket_id, coalesce(x.name, 'image'), x.type, x.size, x.data
  from jsonb_to_recordset(v_files) as x(name text, type text, size integer, data text);

  return v_ticket_id;
end;
$$;

comment on function public.create_support_ticket(text, text, text, text, text, text, text, jsonb) is
  'Atomically open a support ticket with its first message and images. Called by the service role only.';

revoke all on function public.create_support_ticket(text, text, text, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.create_support_ticket(text, text, text, text, text, text, text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Adding a message: the message, its images, and everything on the ticket that
-- has to move with it. The last-message fields, the sender's own read time,
-- and the status: a reply to a closed ticket reopens it in the same write.
--
--   LG001  a message or image list it cannot accept       (validation, 422)
--   LG005  no such ticket                                 (not found, 404)
-- ---------------------------------------------------------------------------
create or replace function public.add_support_message(
  p_ticket_id bigint,
  p_author_role text,
  p_author_id text,
  p_author_name text,
  p_body text,
  p_attachments jsonb
)
returns bigint
language plpgsql
set search_path = ''
as $$
declare
  v_found bigint;
  v_message_id bigint;
  v_body text := btrim(coalesce(p_body, ''));
  v_files jsonb := coalesce(p_attachments, '[]'::jsonb);
  v_now timestamptz := now();
begin
  if char_length(v_body) not between 1 and 5000 then
    raise exception 'A message needs some text, up to 5,000 characters.' using errcode = 'LG001';
  end if;
  if p_author_role is null or p_author_role not in ('affiliate', 'admin') then
    raise exception 'That message could not be read. Reload the page and try again.' using errcode = 'LG001';
  end if;
  if jsonb_typeof(v_files) <> 'array' then
    raise exception 'Those images could not be read. Attach them again.' using errcode = 'LG001';
  end if;
  if jsonb_array_length(v_files) > 3 then
    raise exception 'Up to 3 images can be attached to a message.' using errcode = 'LG001';
  end if;

  -- For update, so two replies landing together write last_message_at one
  -- after the other rather than racing for it.
  select t.id into v_found from public.support_tickets t where t.id = p_ticket_id for update;
  if v_found is null then
    raise exception 'That ticket no longer exists.' using errcode = 'LG005';
  end if;

  insert into public.support_messages (ticket_id, author_role, author_id, author_name, body, created_at)
  values (p_ticket_id, p_author_role, coalesce(p_author_id, ''), coalesce(p_author_name, ''), v_body, v_now)
  returning id into v_message_id;

  insert into public.support_attachments (message_id, ticket_id, name, type, size, data)
  select v_message_id, p_ticket_id, coalesce(x.name, 'image'), x.type, x.size, x.data
  from jsonb_to_recordset(v_files) as x(name text, type text, size integer, data text);

  update public.support_tickets
    set last_message_at = v_now,
        last_message_role = p_author_role,
        affiliate_read_at = case when p_author_role = 'affiliate' then v_now else affiliate_read_at end,
        admin_read_at = case when p_author_role = 'admin' then v_now else admin_read_at end,
        status = 'open',
        closed_at = null,
        closed_by = ''
    where id = p_ticket_id;

  return v_message_id;
end;
$$;

comment on function public.add_support_message(bigint, text, text, text, text, jsonb) is
  'Atomically add a message and its images to a support ticket, reopening it if it was closed. Called by the service role only.';

revoke all on function public.add_support_message(bigint, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.add_support_message(bigint, text, text, text, text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Marking a ticket read, for one side.
--
-- A function rather than an UPDATE from the app, for one reason: the time has
-- to be this database's now(), the same clock last_message_at was written
-- with. A read time taken from an app server a second behind would sit before
-- the message it was reading, and the ticket would stay unread for good.
--
-- An affiliate can only mark their own: the user id is in the WHERE clause.
-- Returns whether a row matched.
-- ---------------------------------------------------------------------------
create or replace function public.mark_support_read(
  p_ticket_id bigint,
  p_side text,
  p_user_id text
)
returns boolean
language plpgsql
set search_path = ''
as $$
begin
  if p_side = 'affiliate' then
    update public.support_tickets
      set affiliate_read_at = now()
      where id = p_ticket_id and user_id = p_user_id;
  elsif p_side = 'admin' then
    update public.support_tickets
      set admin_read_at = now()
      where id = p_ticket_id;
  else
    raise exception 'That ticket could not be read. Reload the page and try again.' using errcode = 'LG001';
  end if;
  return found;
end;
$$;

comment on function public.mark_support_read(bigint, text, text) is
  'Record that one side of a support ticket has read it, using the database clock. Called by the service role only.';

revoke all on function public.mark_support_read(bigint, text, text) from public, anon, authenticated;
grant execute on function public.mark_support_read(bigint, text, text) to service_role;
