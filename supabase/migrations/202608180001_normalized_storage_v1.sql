-- Phase A normalized storage foundation.
-- Dormant until explicitly executed and NORMALIZED_STORAGE is enabled in a later phase.
-- This migration never creates, alters, or changes policies on legacy user_state.

create extension if not exists pgcrypto;

create or replace function public.normalized_v1_text_has_nul(value text)
returns boolean
language sql
immutable
as $$
  select position(decode('00', 'hex') in convert_to(value, 'UTF8')) > 0
$$;

create table if not exists public.games (
  user_id uuid not null,
  id text not null,
  title text not null,
  source_format text not null,
  source_text text not null,
  initial_sfen text not null,
  sfens text[] not null,
  moves text[] not null,
  canonical_hash text not null,
  created_at_text text not null,
  perspective text,
  perspective_present boolean not null default false,
  version integer not null default 1,
  primary key (user_id, id),
  constraint games_source_format_check check (source_format in ('KIF', 'KI2', 'CSA')),
  constraint games_perspective_check check (perspective is null or perspective in ('sente', 'gote', 'spectator')),
  constraint games_perspective_presence_check check (perspective_present or perspective is null),
  constraint games_version_check check (version > 0),
  constraint games_text_check check (
    not public.normalized_v1_text_has_nul(title) and not public.normalized_v1_text_has_nul(source_text)
    and not public.normalized_v1_text_has_nul(initial_sfen) and not public.normalized_v1_text_has_nul(created_at_text)
  )
);

create table if not exists public.review_points (
  user_id uuid not null,
  id text not null,
  game_id text not null,
  ply integer not null,
  sfen text not null,
  reason text not null,
  issue_tags text[] not null default '{}',
  notes text,
  external_notes text,
  legacy_notes text,
  created_at_text text not null,
  version integer not null default 1,
  primary key (user_id, id),
  unique (user_id, game_id, ply),
  foreign key (user_id, game_id) references public.games (user_id, id) on delete cascade,
  constraint review_points_ply_check check (ply >= 0),
  constraint review_points_reason_check check (reason in ('不知道怎麼走', '漏看對手的手', '計畫或方向錯誤', '計算錯誤', '終盤失誤', '時間不足', '想記住這個好手', '其他')),
  constraint review_points_tags_check check (issue_tags <@ array['序盤', '攻守判斷', '候選手', '王的安全', '駒的活用', '手筋', '寄せ・詰棋']::text[]),
  constraint review_points_version_check check (version > 0),
  constraint review_points_text_check check (
    not public.normalized_v1_text_has_nul(sfen) and not public.normalized_v1_text_has_nul(created_at_text)
    and (notes is null or not public.normalized_v1_text_has_nul(notes))
    and (external_notes is null or not public.normalized_v1_text_has_nul(external_notes))
    and (legacy_notes is null or not public.normalized_v1_text_has_nul(legacy_notes))
  )
);

create table if not exists public.recommended_moves (
  user_id uuid not null,
  id text not null,
  point_id text not null,
  move text not null,
  comment text,
  sort_order integer not null,
  version integer not null default 1,
  primary key (user_id, id),
  foreign key (user_id, point_id) references public.review_points (user_id, id) on delete cascade,
  constraint recommended_moves_move_check check (length(btrim(move)) > 0),
  constraint recommended_moves_sort_check check (sort_order >= 0),
  constraint recommended_moves_version_check check (version > 0),
  constraint recommended_moves_text_check check (
    not public.normalized_v1_text_has_nul(move) and (comment is null or not public.normalized_v1_text_has_nul(comment))
  )
);

create table if not exists public.user_migrations (
  user_id uuid primary key,
  migration_version integer not null,
  status text not null,
  source_payload jsonb not null,
  source_hash text not null,
  target_hash text,
  counts jsonb not null default '{}'::jsonb,
  migrated_at timestamptz not null default now(),
  verified_at timestamptz,
  finalized_at timestamptz,
  rolled_back_at timestamptz,
  error text,
  constraint user_migrations_version_check check (migration_version > 0),
  constraint user_migrations_status_check check (status in ('migrated', 'verified', 'finalized', 'failed', 'rolled_back'))
);

alter table public.games enable row level security;
alter table public.games force row level security;
alter table public.review_points enable row level security;
alter table public.review_points force row level security;
alter table public.recommended_moves enable row level security;
alter table public.recommended_moves force row level security;
alter table public.user_migrations enable row level security;
alter table public.user_migrations force row level security;

drop policy if exists "normalized_games_owner" on public.games;
create policy "normalized_games_owner" on public.games
  for all using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
drop policy if exists "normalized_review_points_owner" on public.review_points;
create policy "normalized_review_points_owner" on public.review_points
  for all using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
drop policy if exists "normalized_recommended_moves_owner" on public.recommended_moves;
create policy "normalized_recommended_moves_owner" on public.recommended_moves
  for all using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
drop policy if exists "normalized_user_migrations_owner" on public.user_migrations;
create policy "normalized_user_migrations_owner" on public.user_migrations
  for all using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create or replace function public.normalized_v1_json_has_nul(value jsonb)
returns boolean
language sql
immutable
as $$
  select case jsonb_typeof(value)
    when 'string' then public.normalized_v1_text_has_nul(value #>> '{}')
    when 'array' then exists (select 1 from jsonb_array_elements(value) item where public.normalized_v1_json_has_nul(item))
    when 'object' then exists (select 1 from jsonb_each(value) item(key, value) where public.normalized_v1_json_has_nul(item.value))
    else false
  end
$$;

create or replace function public.normalized_v1_payload_games(value jsonb)
returns jsonb
language sql
immutable
as $$
  select case
    when jsonb_typeof(value) = 'object' and value ? 'data'
      and jsonb_typeof(value->'data') = 'object'
      and jsonb_typeof(value->'data'->'games') = 'array' then value->'data'->'games'
    else '[]'::jsonb
  end
$$;

create or replace function public.audit_my_state_v1()
returns jsonb
language plpgsql
security invoker
as $$
declare
  uid uuid := (select auth.uid());
  legacy_payload jsonb;
  games jsonb;
  game jsonb;
  point jsonb;
  recommendation jsonb;
  diagnostics jsonb := '[]'::jsonb;
  seen_games text[] := '{}';
  seen_points text[] := '{}';
  seen_recommendations text[];
  game_id text;
  point_id text;
  reason text;
  source_format text;
begin
  if uid is null then return jsonb_build_object('ok', false, 'issues', jsonb_build_array('unauthenticated')); end if;
  select payload into legacy_payload from public.user_state where user_id = uid;
  if not found then return jsonb_build_object('ok', false, 'issues', jsonb_build_array('missing_user_state')); end if;
  if jsonb_typeof(legacy_payload) <> 'object' or (legacy_payload->>'schemaVersion') not in ('1', '2', '3') then
    diagnostics := diagnostics || jsonb_build_array('unsupported_schema');
  end if;
  if public.normalized_v1_json_has_nul(legacy_payload) then diagnostics := diagnostics || jsonb_build_array('nul_or_control_text'); end if;
  games := public.normalized_v1_payload_games(legacy_payload);
  if jsonb_typeof(legacy_payload->'data'->'games') <> 'array' then
    diagnostics := diagnostics || jsonb_build_array('malformed_games');
  end if;
  for game in select value from jsonb_array_elements(games) loop
    game_id := game->>'id';
    source_format := game->>'sourceFormat';
    if game_id is null or game_id = any(seen_games) then diagnostics := diagnostics || jsonb_build_array('duplicate_or_missing_game_id'); else seen_games := array_append(seen_games, game_id); end if;
    if source_format not in ('KIF', 'KI2', 'CSA') then diagnostics := diagnostics || jsonb_build_array('invalid_source_format'); end if;
    if game ? 'perspective' and game->>'perspective' not in ('sente', 'gote', 'spectator') then diagnostics := diagnostics || jsonb_build_array('invalid_perspective'); end if;
    if jsonb_typeof(game->'reviewPoints') <> 'array' then diagnostics := diagnostics || jsonb_build_array('malformed_review_points'); continue; end if;
    for point in select value from jsonb_array_elements(game->'reviewPoints') loop
      point_id := point->>'id';
      reason := point->>'reason';
      if point_id is null or point_id = any(seen_points) then diagnostics := diagnostics || jsonb_build_array('duplicate_or_missing_point_id'); else seen_points := array_append(seen_points, point_id); end if;
      if reason not in ('不知道怎麼走', '漏看對手的手', '計畫或方向錯誤', '計算錯誤', '終盤失誤', '時間不足', '想記住這個好手', '其他') then diagnostics := diagnostics || jsonb_build_array('invalid_reason'); end if;
      if point->>'ply' is null or (point->>'ply') !~ '^[0-9]+$' then diagnostics := diagnostics || jsonb_build_array('invalid_ply'); end if;
      if point ? 'recommendedMoves' and jsonb_typeof(point->'recommendedMoves') <> 'array' then diagnostics := diagnostics || jsonb_build_array('malformed_recommendations'); end if;
      if point ? 'recommendedMoves' and jsonb_typeof(point->'recommendedMoves') = 'array' then
        seen_recommendations := '{}';
        for recommendation in select value from jsonb_array_elements(point->'recommendedMoves') loop
          if coalesce(recommendation->>'id', '') = '' or coalesce(recommendation->>'move', '') = ''
            or recommendation->>'id' = any(seen_recommendations) then diagnostics := diagnostics || jsonb_build_array('invalid_or_duplicate_recommendation'); end if;
          if coalesce(recommendation->>'id', '') <> '' then seen_recommendations := array_append(seen_recommendations, recommendation->>'id'); end if;
        end loop;
      end if;
    end loop;
  end loop;
  return jsonb_build_object('ok', jsonb_array_length(diagnostics) = 0, 'issues', diagnostics,
    'counts', jsonb_build_object('games', coalesce(array_length(seen_games, 1), 0), 'points', coalesce(array_length(seen_points, 1), 0)));
end
$$;

create or replace function public.migrate_my_state_v1(source_hash text)
returns jsonb
language plpgsql
security invoker
as $$
declare
  uid uuid := (select auth.uid());
  legacy_payload jsonb;
  game jsonb;
  point jsonb;
  recommendation jsonb;
  game_count integer := 0;
  point_count integer := 0;
  recommendation_count integer := 0;
  migration public.user_migrations%rowtype;
  game_row_id text;
  point_row_id text;
begin
  if uid is null then raise exception 'normalized migration requires auth.uid()'; end if;
  if source_hash is null or source_hash = '' then raise exception 'source_hash is required'; end if;
  select payload into legacy_payload from public.user_state where user_id = uid for update;
  if not found then raise exception 'legacy user_state row is missing'; end if;
  if not (public.audit_my_state_v1()->>'ok')::boolean then raise exception 'legacy payload failed audit: %', public.audit_my_state_v1()->>'issues'; end if;
  delete from public.recommended_moves where user_id = uid;
  delete from public.review_points where user_id = uid;
  delete from public.games where user_id = uid;
  for game in select value from jsonb_array_elements(public.normalized_v1_payload_games(legacy_payload)) loop
    game_row_id := game->>'id';
    insert into public.games(user_id, id, title, source_format, source_text, initial_sfen, sfens, moves, canonical_hash, created_at_text, perspective, perspective_present)
    values (uid, game_row_id, game->>'title', game->>'sourceFormat', game->>'sourceText', game->>'initialSfen',
      array(select jsonb_array_elements_text(game->'sfens')), array(select jsonb_array_elements_text(game->'moves')),
      game->>'canonicalHash', game->>'createdAt', case when game ? 'perspective' then game->>'perspective' else null end, game ? 'perspective');
    game_count := game_count + 1;
    for point in select value from jsonb_array_elements(game->'reviewPoints') loop
      point_row_id := point->>'id';
      insert into public.review_points(user_id, id, game_id, ply, sfen, reason, issue_tags, notes, external_notes, legacy_notes, created_at_text)
      values (uid, point_row_id, game_row_id, (point->>'ply')::integer, point->>'sfen', point->>'reason',
        array(select jsonb_array_elements_text(coalesce(point->'issueTags', '[]'::jsonb))),
        case when point ? 'note' then point->>'note' else null end,
        case when point ? 'externalNotes' then point->>'externalNotes' else null end,
        case when point ? 'legacyNotes' then point->>'legacyNotes' else null end, point->>'createdAt');
      point_count := point_count + 1;
      if jsonb_typeof(point->'recommendedMoves') = 'array' then
        for recommendation in select value, ordinality - 1 as sort_order from jsonb_array_elements(point->'recommendedMoves') with ordinality as items(value, ordinality) loop
          insert into public.recommended_moves(user_id, id, point_id, move, comment, sort_order)
          values (uid, recommendation.value->>'id', point_row_id, recommendation.value->>'move',
            case when recommendation.value ? 'comment' then recommendation.value->>'comment' else null end, recommendation.ordinality - 1);
          recommendation_count := recommendation_count + 1;
        end loop;
      end if;
    end loop;
  end loop;
  insert into public.user_migrations(user_id, migration_version, status, source_payload, source_hash, counts, error)
  values (uid, 1, 'migrated', legacy_payload, source_hash,
    jsonb_build_object('games', game_count, 'points', point_count, 'recommendations', recommendation_count), null)
  on conflict (user_id) do update set migration_version = excluded.migration_version, status = excluded.status,
    source_payload = excluded.source_payload, source_hash = excluded.source_hash, target_hash = null, counts = excluded.counts,
    migrated_at = now(), verified_at = null, finalized_at = null, rolled_back_at = null, error = null;
  select * into migration from public.user_migrations where user_id = uid;
  return jsonb_build_object('status', migration.status, 'counts', migration.counts, 'source_hash', migration.source_hash);
exception when others then
  insert into public.user_migrations(user_id, migration_version, status, source_payload, source_hash, error)
  values (uid, 1, 'failed', coalesce(legacy_payload, '{}'::jsonb), coalesce(source_hash, ''), sqlerrm)
  on conflict (user_id) do update set status = 'failed', error = sqlerrm;
  raise;
end
$$;

create or replace function public.export_my_state_v3()
returns jsonb
language plpgsql
security invoker
as $$
declare
  uid uuid := (select auth.uid());
  result jsonb;
begin
  if uid is null then raise exception 'normalized export requires auth.uid()'; end if;
  if not exists (select 1 from public.user_migrations where user_id = uid and status in ('migrated', 'verified', 'finalized')) then
    raise exception 'migration is not available';
  end if;
  select jsonb_build_object(
    'schemaVersion', 3,
    'exportedAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'data', jsonb_build_object('games', coalesce(jsonb_agg((
      jsonb_build_object('id', g.id, 'title', g.title, 'sourceFormat', g.source_format, 'sourceText', g.source_text,
        'initialSfen', g.initial_sfen, 'sfens', to_jsonb(g.sfens), 'moves', to_jsonb(g.moves),
        'canonicalHash', g.canonical_hash, 'createdAt', g.created_at_text,
        'reviewPoints', (select coalesce(jsonb_agg((
          jsonb_build_object('id', p.id, 'ply', p.ply, 'sfen', p.sfen, 'reason', p.reason, 'issueTags', to_jsonb(p.issue_tags),
            'createdAt', p.created_at_text)
            || case when p.notes is not null then jsonb_build_object('note', p.notes) else '{}'::jsonb end
            || case when p.external_notes is not null then jsonb_build_object('externalNotes', p.external_notes) else '{}'::jsonb end
            || case when p.legacy_notes is not null then jsonb_build_object('legacyNotes', p.legacy_notes) else '{}'::jsonb end
            || case when exists (select 1 from public.recommended_moves r where r.user_id = uid and r.point_id = p.id)
              then jsonb_build_object('recommendedMoves', (select jsonb_agg((
                jsonb_build_object('id', r.id, 'move', r.move)
                || case when r.comment is not null then jsonb_build_object('comment', r.comment) else '{}'::jsonb end
              ) order by r.sort_order, r.id) from public.recommended_moves r where r.user_id = uid and r.point_id = p.id))
              else '{}'::jsonb end
          ) order by p.ply, p.id), '[]'::jsonb) from public.review_points p where p.user_id = uid and p.game_id = g.id)
        )
        || case when g.perspective_present then jsonb_build_object('perspective', g.perspective) else '{}'::jsonb end
      ) order by g.created_at_text, g.id), '[]'::jsonb))
  ) into result from public.games g where g.user_id = uid;
  return result;
end
$$;

create or replace function public.verify_my_migration(source_hash text, target_hash text)
returns jsonb
language plpgsql
security invoker
as $$
declare uid uuid := (select auth.uid()); current public.user_migrations%rowtype;
begin
  if uid is null then raise exception 'migration verification requires auth.uid()'; end if;
  select * into current from public.user_migrations where user_id = uid for update;
  if not found or current.status <> 'migrated' then raise exception 'migration must be migrated before verification'; end if;
  if current.source_hash <> source_hash or target_hash is null or target_hash = '' then raise exception 'migration hash mismatch'; end if;
  update public.user_migrations set status = 'verified', target_hash = verify_my_migration.target_hash, verified_at = now(), error = null where user_id = uid;
  return jsonb_build_object('status', 'verified', 'target_hash', target_hash);
end
$$;

create or replace function public.finalize_my_cutover()
returns jsonb
language plpgsql
security invoker
as $$
declare uid uuid := (select auth.uid()); current public.user_migrations%rowtype; live_payload jsonb;
begin
  if uid is null then raise exception 'cutover finalization requires auth.uid()'; end if;
  select payload into live_payload from public.user_state where user_id = uid for update;
  if not found then raise exception 'legacy user_state row is missing'; end if;
  select * into current from public.user_migrations where user_id = uid for update;
  if not found or current.status <> 'verified' then raise exception 'migration must be verified before finalization'; end if;
  if live_payload is distinct from current.source_payload then
    update public.user_migrations set status = 'failed', error = 'legacy payload changed after snapshot' where user_id = uid;
    raise exception 'legacy payload changed after snapshot';
  end if;
  update public.user_migrations set status = 'finalized', finalized_at = now(), error = null where user_id = uid;
  return jsonb_build_object('status', 'finalized');
end
$$;

create or replace function public.rollback_my_cutover(payload jsonb, target_hash text)
returns jsonb
language plpgsql
security invoker
as $$
declare uid uuid := (select auth.uid()); current public.user_migrations%rowtype;
begin
  if uid is null then raise exception 'cutover rollback requires auth.uid()'; end if;
  select * into current from public.user_migrations where user_id = uid for update;
  if not found or current.status not in ('migrated', 'verified', 'finalized') then raise exception 'migration is not inside rollback window'; end if;
  if target_hash is null or target_hash <> current.source_hash then raise exception 'rollback hash mismatch'; end if;
  update public.user_state set payload = rollback_my_cutover.payload, revision = revision + 1 where user_id = uid;
  if not found then raise exception 'legacy user_state row is missing'; end if;
  update public.user_migrations set status = 'rolled_back', rolled_back_at = now(), error = null where user_id = uid;
  return jsonb_build_object('status', 'rolled_back');
end
$$;

grant execute on function public.audit_my_state_v1() to authenticated;
grant execute on function public.migrate_my_state_v1(text) to authenticated;
grant execute on function public.export_my_state_v3() to authenticated;
grant execute on function public.verify_my_migration(text, text) to authenticated;
grant execute on function public.finalize_my_cutover() to authenticated;
grant execute on function public.rollback_my_cutover(jsonb, text) to authenticated;
