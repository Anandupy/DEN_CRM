create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique not null,
  full_name text not null,
  phone text,
  role text not null default 'member' check (role in ('owner', 'trainer', 'member')),
  created_at timestamptz not null default now()
);

create table if not exists public.members (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid unique not null references public.profiles(id) on delete cascade,
  member_code text unique not null default ('MEM-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))),
  plan_name text not null default 'General',
  monthly_fee numeric(10,2) not null default 0,
  join_date date not null default current_date,
  status text not null default 'active' check (status in ('active', 'paused', 'left')),
  assigned_trainer uuid references public.profiles(id) on delete set null,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists public.attendance (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.members(id) on delete cascade,
  attendance_date date not null default current_date,
  status text not null check (status in ('Present', 'Absent')),
  source text not null default 'trainer_entry' check (source in ('trainer_entry', 'owner_update', 'member_location')),
  marked_by uuid not null references public.profiles(id) on delete restrict,
  check_in_time timestamptz not null default now(),
  latitude numeric(10,6),
  longitude numeric(10,6),
  distance_meters numeric(10,2),
  notes text,
  unique (member_id, attendance_date)
);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.members(id) on delete cascade,
  amount numeric(10,2) not null check (amount > 0),
  payment_date date not null default current_date,
  billing_month date not null default date_trunc('month', current_date)::date,
  note text,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);

create or replace function public.current_role()
returns text
language sql
stable
as $$
  select role from public.profiles where id = auth.uid()
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)),
    'member'
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

create or replace function public.sync_member_row()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role = 'member' then
    insert into public.members (profile_id)
    values (new.id)
    on conflict (profile_id) do nothing;
  else
    delete from public.members where profile_id = new.id;
  end if;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

drop trigger if exists on_profile_sync_member on public.profiles;
create trigger on_profile_sync_member
after insert or update of role on public.profiles
for each row execute procedure public.sync_member_row();

alter table public.profiles enable row level security;
alter table public.members enable row level security;
alter table public.attendance enable row level security;
alter table public.payments enable row level security;

drop policy if exists "profiles_select" on public.profiles;
create policy "profiles_select" on public.profiles
for select to authenticated
using (
  public.current_role() = 'owner'
  or id = auth.uid()
  or role in ('owner', 'trainer')
);

drop policy if exists "profiles_update_owner" on public.profiles;
create policy "profiles_update_owner" on public.profiles
for update to authenticated
using (public.current_role() = 'owner')
with check (public.current_role() = 'owner');

drop policy if exists "members_select" on public.members;
create policy "members_select" on public.members
for select to authenticated
using (
  public.current_role() in ('owner', 'trainer')
  or profile_id = auth.uid()
);

drop policy if exists "members_insert_owner" on public.members;
create policy "members_insert_owner" on public.members
for insert to authenticated
with check (public.current_role() = 'owner');

drop policy if exists "members_update_owner" on public.members;
create policy "members_update_owner" on public.members
for update to authenticated
using (public.current_role() = 'owner')
with check (public.current_role() = 'owner');

drop policy if exists "attendance_select" on public.attendance;
create policy "attendance_select" on public.attendance
for select to authenticated
using (
  public.current_role() in ('owner', 'trainer')
  or member_id in (select id from public.members where profile_id = auth.uid())
);

drop policy if exists "attendance_insert_owner_trainer_member" on public.attendance;
create policy "attendance_insert_owner_trainer_member" on public.attendance
for insert to authenticated
with check (
  public.current_role() in ('owner', 'trainer')
  or (
    public.current_role() = 'member'
    and member_id in (select id from public.members where profile_id = auth.uid())
    and source = 'member_location'
    and marked_by = auth.uid()
  )
);

drop policy if exists "attendance_update_owner" on public.attendance;
create policy "attendance_update_owner" on public.attendance
for update to authenticated
using (public.current_role() = 'owner')
with check (public.current_role() = 'owner');

drop policy if exists "payments_select" on public.payments;
create policy "payments_select" on public.payments
for select to authenticated
using (
  public.current_role() in ('owner', 'trainer')
  or member_id in (select id from public.members where profile_id = auth.uid())
);

drop policy if exists "payments_insert_owner_trainer" on public.payments;
create policy "payments_insert_owner_trainer" on public.payments
for insert to authenticated
with check (
  public.current_role() in ('owner', 'trainer')
  and created_by = auth.uid()
);

drop policy if exists "payments_update_owner" on public.payments;
create policy "payments_update_owner" on public.payments
for update to authenticated
using (public.current_role() = 'owner')
with check (public.current_role() = 'owner');

insert into public.profiles (id, email, full_name, role)
select id, email, coalesce(raw_user_meta_data ->> 'full_name', split_part(email, '@', 1)), 'member'
from auth.users
on conflict (id) do nothing;

insert into public.members (profile_id)
select id from public.profiles
where role = 'member'
on conflict (profile_id) do nothing;

delete from public.members
where profile_id in (
  select id from public.profiles where role <> 'member'
);
