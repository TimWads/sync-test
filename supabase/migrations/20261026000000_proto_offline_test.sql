-- Throwaway offline/sync test tables. NOT the real app. Holds TEST data only.
-- Safe to drop later with:  drop table public.proto_revisions, public.proto_records;
--                           drop function public.proto_resolve_conflict();

create table public.proto_records (
  id          uuid primary key,              -- made on the device
  label       text not null,
  payload     text not null,
  created_at  timestamptz not null,
  updated_at  timestamptz not null,
  device_id   text not null
);

create table public.proto_revisions (
  id          uuid primary key default gen_random_uuid(),
  record_id   uuid not null references public.proto_records(id),
  old_row     jsonb not null,                -- the LOSING version
  new_row     jsonb not null,                -- the WINNING version
  changed_at  timestamptz not null default now()
);

-- Conflict rule, enforced on the server so every device follows it:
-- on update, the row with the later updated_at wins; the loser goes to proto_revisions.
-- An identical retry (same label, payload, updated_at) changes nothing and records nothing,
-- which keeps the upsert idempotent.
create function public.proto_resolve_conflict() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.label, new.payload, new.updated_at) is not distinct from (old.label, old.payload, old.updated_at) then
    return old;
  end if;

  if new.updated_at >= old.updated_at then
    insert into public.proto_revisions (record_id, old_row, new_row) values (old.id, to_jsonb(old), to_jsonb(new));
    new.created_at := old.created_at;
    return new;
  else
    insert into public.proto_revisions (record_id, old_row, new_row) values (old.id, to_jsonb(new), to_jsonb(old));
    return old;                              -- keep the server row; upsert returns it so the device can adopt it
  end if;
end;
$$;

create trigger proto_records_resolve_conflict
  before update on public.proto_records
  for each row execute function public.proto_resolve_conflict();

-- Row Level Security: signed-in users only. Nothing for anon.
alter table public.proto_records   enable row level security;
alter table public.proto_revisions enable row level security;

create policy "authenticated select" on public.proto_records   for select to authenticated using (true);
create policy "authenticated insert" on public.proto_records   for insert to authenticated with check (true);
create policy "authenticated update" on public.proto_records   for update to authenticated using (true) with check (true);
create policy "authenticated select" on public.proto_revisions for select to authenticated using (true);
create policy "authenticated insert" on public.proto_revisions for insert to authenticated with check (true);

-- Explicit privileges (new tables are not exposed automatically in this project).
revoke all on public.proto_records, public.proto_revisions from anon, authenticated;
grant select, insert, update on public.proto_records   to authenticated;
grant select, insert         on public.proto_revisions to authenticated;

notify pgrst, 'reload schema';
