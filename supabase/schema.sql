-- foyer schema
--
-- Tables are prefixed so several apps can share one Supabase project without
-- colliding. The default is `foyer_`; if you change it here, pass the same
-- prefix to createFoyer({ prefix }).
--
-- The shape is deliberately generic. Anything specific to your app -- a map
-- name, a time control, a difficulty -- belongs in the `metadata` blob on a
-- room, or the `state` blob on a player. Those are yours; foyer never reads
-- them. What foyer owns is the part every multiplayer app rebuilds: who is
-- here, who is in charge, and who is not allowed back.

-- ---------------------------------------------------------------- profiles
-- One row per signed-in player. Anonymous auth is the normal case, and the
-- row survives an upgrade to a real account, so history is not lost when
-- someone claims their identity later.
create table if not exists public.foyer_profiles (
	id         uuid primary key references auth.users(id) on delete cascade,
	name       text not null check (char_length(name) between 1 and 32),
	created_at timestamptz not null default now()
);

-- ------------------------------------------------------------------- rooms
create table if not exists public.foyer_rooms (
	id          uuid primary key default gen_random_uuid(),
	-- Short, unambiguous, and readable down a phone line: no O/0 or I/1.
	code        text not null unique,
	name        text not null default '',
	host_id     uuid not null references public.foyer_profiles(id) on delete cascade,
	max_players integer not null default 8 check (max_players between 2 and 64),
	-- Yours. foyer stores and broadcasts it; it never interprets it.
	metadata    jsonb not null default '{}'::jsonb,
	-- 'lobby' and 'active' are conventions, not constraints -- an app is free
	-- to use its own words for its own phases.
	status      text not null default 'lobby',
	is_open     boolean not null default true,
	created_at  timestamptz not null default now(),
	updated_at  timestamptz not null default now()
);
create index if not exists foyer_rooms_open_idx
	on public.foyer_rooms (is_open, created_at desc);

-- ------------------------------------------------------------ room_players
create table if not exists public.foyer_room_players (
	room_id   uuid not null references public.foyer_rooms(id) on delete cascade,
	player_id uuid not null references public.foyer_profiles(id) on delete cascade,
	is_host   boolean not null default false,
	-- Per-player app state: a colour, a team, a download percentage. Yours.
	state     jsonb not null default '{}'::jsonb,
	joined_at timestamptz not null default now(),
	primary key (room_id, player_id)
);

-- -------------------------------------------------------------------- bans
-- A ban is enforced by the rejoin policy below rather than by asking the
-- client to behave. That is the whole reason this library needs a database.
create table if not exists public.foyer_bans (
	room_id   uuid not null references public.foyer_rooms(id) on delete cascade,
	player_id uuid not null references public.foyer_profiles(id) on delete cascade,
	banned_at timestamptz not null default now(),
	primary key (room_id, player_id)
);

-- ---------------------------------------------------------------- messages
-- Chat and system notices share one table. They are the same thing to a
-- reader -- "gg" and "ranger left" belong in one scrollback -- and splitting
-- them only makes every consumer merge them again.
create table if not exists public.foyer_messages (
	id         bigint generated always as identity primary key,
	room_id    uuid not null references public.foyer_rooms(id) on delete cascade,
	player_id  uuid references public.foyer_profiles(id) on delete set null,
	body       text not null check (char_length(body) between 1 and 500),
	system     boolean not null default false,
	created_at timestamptz not null default now()
);
create index if not exists foyer_messages_room_idx
	on public.foyer_messages (room_id, created_at);

-- ------------------------------------------------------------------- rls
alter table public.foyer_profiles     enable row level security;
alter table public.foyer_rooms        enable row level security;
alter table public.foyer_room_players enable row level security;
alter table public.foyer_bans         enable row level security;
alter table public.foyer_messages     enable row level security;

do $$ begin
	-- Profiles are public: a lobby has to show who is in it.
	create policy "foyer_profiles read" on public.foyer_profiles
		for select using (true);
	create policy "foyer_profiles self-insert" on public.foyer_profiles
		for insert with check (auth.uid() = id);
	create policy "foyer_profiles self-update" on public.foyer_profiles
		for update using (auth.uid() = id) with check (auth.uid() = id);
exception when duplicate_object then null; end $$;

do $$ begin
	create policy "foyer_rooms read" on public.foyer_rooms
		for select using (true);
	create policy "foyer_rooms create" on public.foyer_rooms
		for insert with check (auth.uid() = host_id);
	-- Only the host may change a room. This is why metadata is a single blob:
	-- one policy covers every setting an app will ever add.
	create policy "foyer_rooms host-update" on public.foyer_rooms
		for update using (auth.uid() = host_id) with check (auth.uid() = host_id);
	create policy "foyer_rooms host-delete" on public.foyer_rooms
		for delete using (auth.uid() = host_id);
exception when duplicate_object then null; end $$;

do $$ begin
	create policy "foyer_room_players read" on public.foyer_room_players
		for select using (true);

	-- The ban check lives here, in the join. A banned player can ask to
	-- rejoin all they like; the row will not be written.
	create policy "foyer_room_players self-join" on public.foyer_room_players
		for insert with check (
			auth.uid() = player_id
			and not exists (
				select 1 from public.foyer_bans b
				where b.room_id = room_id and b.player_id = auth.uid()
			)
		);

	-- A player edits their own state; the host may remove anyone, which is
	-- what a kick is.
	create policy "foyer_room_players self-update" on public.foyer_room_players
		for update using (auth.uid() = player_id) with check (auth.uid() = player_id);
	create policy "foyer_room_players leave-or-kick" on public.foyer_room_players
		for delete using (
			auth.uid() = player_id
			or auth.uid() = (select host_id from public.foyer_rooms r where r.id = room_id)
		);
exception when duplicate_object then null; end $$;

do $$ begin
	create policy "foyer_bans read" on public.foyer_bans
		for select using (true);
	create policy "foyer_bans host-insert" on public.foyer_bans
		for insert with check (
			auth.uid() = (select host_id from public.foyer_rooms r where r.id = room_id)
		);
	create policy "foyer_bans host-delete" on public.foyer_bans
		for delete using (
			auth.uid() = (select host_id from public.foyer_rooms r where r.id = room_id)
		);
exception when duplicate_object then null; end $$;

do $$ begin
	create policy "foyer_messages read" on public.foyer_messages
		for select using (true);
	-- A player may only speak as themselves. System notices are posted by
	-- whoever observed the event, so they carry a player_id too.
	create policy "foyer_messages self-insert" on public.foyer_messages
		for insert with check (auth.uid() = player_id);
exception when duplicate_object then null; end $$;

-- --------------------------------------------------------------- realtime
-- The lobby is live: room lists, player lists and chat all arrive over
-- postgres_changes. Adding a table twice to a publication is an error rather
-- than a no-op, so each is guarded.
do $$
declare t text;
begin
	foreach t in array array['foyer_rooms', 'foyer_room_players', 'foyer_messages']
	loop
		if not exists (
			select 1 from pg_publication_tables
			where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
		) then
			execute format('alter publication supabase_realtime add table public.%I', t);
		end if;
	end loop;
end $$;

-- ------------------------------------------------------------------ reaping
-- Rooms outlive the tabs that made them: a closed laptop sends no goodbye.
-- Close any room whose last player has gone, and sweep anything stale.
create or replace function public.foyer_close_empty_room()
returns trigger language plpgsql security definer as $$
begin
	if not exists (
		select 1 from public.foyer_room_players p where p.room_id = old.room_id
	) then
		update public.foyer_rooms set is_open = false, updated_at = now()
		where id = old.room_id;
	end if;
	return old;
end $$;

drop trigger if exists foyer_close_empty_room on public.foyer_room_players;
create trigger foyer_close_empty_room
	after delete on public.foyer_room_players
	for each row execute function public.foyer_close_empty_room();
