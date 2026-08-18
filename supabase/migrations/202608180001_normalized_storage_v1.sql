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
  source_order integer not null default 0,
  perspective text,
  perspective_present boolean not null default false,
  version integer not null default 1,
  primary key (user_id, id),
  constraint games_source_format_check check (source_format in ('KIF', 'KI2', 'CSA')),
  constraint games_perspective_check check (perspective is null or perspective in ('sente', 'gote', 'spectator')),
  constraint games_perspective_presence_check check (perspective_present or perspective is null),
  constraint games_version_check check (version > 0),
  constraint games_source_order_check check (source_order >= 0),
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
  source_order integer not null default 0,
  version integer not null default 1,
  primary key (user_id, id),
  unique (user_id, game_id, ply),
  foreign key (user_id, game_id) references public.games (user_id, id) on delete cascade,
  constraint review_points_ply_check check (ply >= 0),
  constraint review_points_reason_check check (reason in ('不知道怎麼走', '漏看對手的手', '計畫或方向錯誤', '計算錯誤', '終盤失誤', '時間不足', '想記住這個好手', '其他')),
  constraint review_points_tags_check check (issue_tags <@ array['序盤', '攻守判斷', '候選手', '王的安全', '駒的活用', '手筋', '寄せ・詰棋']::text[]),
  constraint review_points_version_check check (version > 0),
  constraint review_points_source_order_check check (source_order >= 0),
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

alter table public.user_migrations add column if not exists source_revision integer;

create or replace function public.normalized_v1_canonical_point(raw jsonb)
returns jsonb
language plpgsql
immutable
as $$
declare
  tags jsonb := coalesce(raw->'issueTags', '[]'::jsonb);
  category text := case when jsonb_typeof(raw->'category') = 'string' then raw->>'category' else '' end;
  mapped_reason text := case category
    when '序盤知識' then '計畫或方向錯誤'
    when '候選手不足' then '不知道怎麼走'
    when '漏算對手強手' then '漏看對手的手'
    when '戰術' then '計算錯誤'
    when '終盤' then '終盤失誤'
    when '時間管理' then '時間不足'
    else '其他'
  end;
  mapped_tag text := case category
    when '序盤知識' then '序盤'
    when '候選手不足' then '候選手'
    when '戰術' then '手筋'
    when '終盤' then '寄せ・詰棋'
    else null
  end;
  reason text;
  legacy text[] := '{}';
  item jsonb;
  item_id text;
  normalized_recommendations jsonb := '[]'::jsonb;
  seen_ids text[] := '{}';
begin
  if jsonb_typeof(raw) <> 'object' or not (raw ? 'id') or jsonb_typeof(raw->'id') <> 'string'
     or not (raw ? 'ply') or jsonb_typeof(raw->'ply') <> 'number' or not (raw ? 'sfen')
     or jsonb_typeof(raw->'sfen') <> 'string' or not (raw ? 'createdAt')
     or jsonb_typeof(raw->'createdAt') <> 'string' then
    raise exception 'invalid review point';
  end if;
  if raw ? 'issueTags' and jsonb_typeof(raw->'issueTags') <> 'array' then raise exception 'invalid issue tags'; end if;
  if exists (select 1 from jsonb_array_elements(tags) tag where jsonb_typeof(tag) <> 'string'
    or tag #>> '{}' not in ('序盤', '攻守判斷', '候選手', '王的安全', '駒的活用', '手筋', '寄せ・詰棋')) then
    raise exception 'invalid issue tags';
  end if;
  if raw ? 'thinking' and jsonb_typeof(raw->'thinking') <> 'string' then raise exception 'invalid legacy text'; end if;
  if raw ? 'thinking' and btrim(raw->>'thinking') <> '' then legacy := array_append(legacy, '當時想法：' || (raw->>'thinking')); end if;
  if raw ? 'tag' and jsonb_typeof(raw->'tag') <> 'string' then raise exception 'invalid legacy text'; end if;
  if raw ? 'tag' and btrim(raw->>'tag') <> '' then legacy := array_append(legacy, '標籤：' || (raw->>'tag')); end if;
  if raw ? 'candidates' and jsonb_typeof(raw->'candidates') <> 'string' then raise exception 'invalid legacy text'; end if;
  if raw ? 'candidates' and btrim(raw->>'candidates') <> '' then legacy := array_append(legacy, '候選手：' || (raw->>'candidates')); end if;
  if raw ? 'opponentResponse' and jsonb_typeof(raw->'opponentResponse') <> 'string' then raise exception 'invalid legacy text'; end if;
  if raw ? 'opponentResponse' and btrim(raw->>'opponentResponse') <> '' then legacy := array_append(legacy, '對手應手：' || (raw->>'opponentResponse')); end if;
  if category <> '' and category not in ('序盤知識', '候選手不足', '漏算對手強手', '戰術', '終盤', '時間管理', '其他') then
    legacy := array_append(legacy, '舊分類：' || category);
  end if;
  if raw ? 'nextConsideration' and jsonb_typeof(raw->'nextConsideration') <> 'string' then raise exception 'invalid legacy text'; end if;
  if raw ? 'externalNotes' and jsonb_typeof(raw->'externalNotes') <> 'string' then raise exception 'invalid legacy text'; end if;
  if raw ? 'legacyNotes' and jsonb_typeof(raw->'legacyNotes') <> 'string' then raise exception 'invalid legacy text'; end if;
  if raw ? 'note' and jsonb_typeof(raw->'note') <> 'string' then raise exception 'invalid note'; end if;
  if raw ? 'reason' and (jsonb_typeof(raw->'reason') <> 'string' or raw->>'reason' not in ('不知道怎麼走', '漏看對手的手', '計畫或方向錯誤', '計算錯誤', '終盤失誤', '時間不足', '想記住這個好手', '其他')) then
    raise exception 'invalid reason';
  end if;
  if raw ? 'ply' and ((raw->>'ply') !~ '^[0-9]+$' or (raw->>'ply')::numeric > 2147483647) then raise exception 'invalid ply'; end if;
  reason := case when raw ? 'reason' then raw->>'reason' else mapped_reason end;
  if raw ? 'recommendedMoves' then
    if jsonb_typeof(raw->'recommendedMoves') <> 'array' then raise exception 'invalid recommendations'; end if;
    for item in select value from jsonb_array_elements(raw->'recommendedMoves') loop
      if jsonb_typeof(item) <> 'object' or jsonb_typeof(item->'id') <> 'string'
        or btrim(item->>'id') = '' or btrim(item->>'id') = any(seen_ids)
        or jsonb_typeof(item->'move') <> 'string' or btrim(item->>'move') = '' then
        raise exception 'invalid recommendations';
      end if;
      if item ? 'comment' and jsonb_typeof(item->'comment') <> 'string' then raise exception 'invalid recommendation comment'; end if;
      item_id := btrim(item->>'id');
      seen_ids := array_append(seen_ids, item_id);
      normalized_recommendations := normalized_recommendations || jsonb_build_array(
        jsonb_build_object('id', item_id, 'move', btrim(item->>'move'))
        || case when item ? 'comment' and btrim(item->>'comment') <> '' then jsonb_build_object('comment', btrim(item->>'comment')) else '{}'::jsonb end);
    end loop;
  end if;
  return jsonb_build_object('id', raw->>'id', 'ply', (raw->>'ply')::integer, 'sfen', raw->>'sfen',
    'reason', reason, 'issueTags', tags,
    'createdAt', raw->>'createdAt')
    || case when raw ? 'note' and btrim(raw->>'note') <> '' then jsonb_build_object('note', raw->>'note')
      when raw ? 'nextConsideration' and btrim(raw->>'nextConsideration') <> '' then jsonb_build_object('note', raw->>'nextConsideration')
      else '{}'::jsonb end
    || case when raw ? 'externalNotes' and btrim(raw->>'externalNotes') <> '' then jsonb_build_object('externalNotes', raw->>'externalNotes') else '{}'::jsonb end
    || case when cardinality(legacy) > 0 or (raw ? 'legacyNotes' and btrim(raw->>'legacyNotes') <> '') then
      jsonb_build_object('legacyNotes', concat_ws(E'\n', nullif(array_to_string(legacy, E'\n'), ''), nullif(raw->>'legacyNotes', ''))) else '{}'::jsonb end
    || case when mapped_tag is not null and not tags @> jsonb_build_array(mapped_tag) then jsonb_build_object('issueTags', tags || jsonb_build_array(mapped_tag)) else '{}'::jsonb end
    || case when jsonb_array_length(normalized_recommendations) > 0 then jsonb_build_object('recommendedMoves', normalized_recommendations) else '{}'::jsonb end;
end
$$;

create or replace function public.normalized_v1_canonical_game(raw jsonb)
returns jsonb
language plpgsql
immutable
as $$
declare point jsonb; points jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(raw) <> 'object' or not (raw ? 'id') or jsonb_typeof(raw->'id') <> 'string'
    or not (raw ? 'title') or jsonb_typeof(raw->'title') <> 'string'
    or not (raw ? 'sourceFormat') or jsonb_typeof(raw->'sourceFormat') <> 'string'
    or not (raw ? 'sourceText') or jsonb_typeof(raw->'sourceText') <> 'string'
    or not (raw ? 'initialSfen') or jsonb_typeof(raw->'initialSfen') <> 'string'
    or not (raw ? 'sfens') or jsonb_typeof(raw->'sfens') <> 'array'
    or not (raw ? 'moves') or jsonb_typeof(raw->'moves') <> 'array'
    or not (raw ? 'canonicalHash') or jsonb_typeof(raw->'canonicalHash') <> 'string'
    or not (raw ? 'createdAt') or jsonb_typeof(raw->'createdAt') <> 'string'
    or not (raw ? 'reviewPoints') or jsonb_typeof(raw->'reviewPoints') <> 'array' then raise exception 'invalid game'; end if;
  if raw ? 'perspective' and (jsonb_typeof(raw->'perspective') <> 'string'
    or raw->>'perspective' not in ('sente', 'gote', 'spectator')) then raise exception 'invalid perspective'; end if;
  for point in select value from jsonb_array_elements(raw->'reviewPoints') loop
    points := points || jsonb_build_array(public.normalized_v1_canonical_point(point));
  end loop;
  return jsonb_build_object('id', raw->>'id', 'title', raw->>'title', 'sourceFormat', raw->>'sourceFormat',
    'sourceText', raw->>'sourceText', 'initialSfen', raw->>'initialSfen', 'sfens', raw->'sfens',
    'moves', raw->'moves', 'canonicalHash', raw->>'canonicalHash', 'createdAt', raw->>'createdAt',
    'reviewPoints', points)
    || case when raw ? 'perspective' then jsonb_build_object('perspective', raw->'perspective') else '{}'::jsonb end;
end
$$;

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

grant select, insert, update, delete on public.games, public.review_points, public.recommended_moves, public.user_migrations to authenticated;
grant select on public.games, public.review_points, public.recommended_moves, public.user_migrations to anon;

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

create or replace function public.normalized_v1_canonical_games(value jsonb)
returns jsonb
language sql
immutable
as $$
  select coalesce(jsonb_agg(public.normalized_v1_canonical_game(game) order by ordinality), '[]'::jsonb)
  from jsonb_array_elements(public.normalized_v1_payload_games(value)) with ordinality as items(game, ordinality)
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
  seen_recommendations text[] := '{}';
  game_id text;
  point_id text;
  reason text;
  category text;
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
    if coalesce(source_format, '') not in ('KIF', 'KI2', 'CSA') then diagnostics := diagnostics || jsonb_build_array('invalid_source_format'); end if;
    if game ? 'perspective' and game->>'perspective' not in ('sente', 'gote', 'spectator') then diagnostics := diagnostics || jsonb_build_array('invalid_perspective'); end if;
    if jsonb_typeof(game->'reviewPoints') <> 'array' then diagnostics := diagnostics || jsonb_build_array('malformed_review_points'); continue; end if;
    for point in select value from jsonb_array_elements(game->'reviewPoints') loop
      point_id := point->>'id';
      reason := point->>'reason';
      if point_id is null or point_id = any(seen_points) then diagnostics := diagnostics || jsonb_build_array('duplicate_or_missing_point_id'); else seen_points := array_append(seen_points, point_id); end if;
      category := case when jsonb_typeof(point->'category') = 'string' then point->>'category' else null end;
      if point ? 'reason' and coalesce(reason, '') not in ('不知道怎麼走', '漏看對手的手', '計畫或方向錯誤', '計算錯誤', '終盤失誤', '時間不足', '想記住這個好手', '其他') then diagnostics := diagnostics || jsonb_build_array('invalid_reason'); end if;
      if exists (select 1 from jsonb_each(point) field where field.key = any(array['thinking', 'tag', 'candidates', 'opponentResponse', 'nextConsideration', 'externalNotes', 'legacyNotes', 'note']) and jsonb_typeof(field.value) <> 'string') then
        diagnostics := diagnostics || jsonb_build_array('invalid_review_text');
      end if;
      if point ? 'issueTags' and jsonb_typeof(point->'issueTags') <> 'array' then
        diagnostics := diagnostics || jsonb_build_array('invalid_issue_tags');
      elsif point ? 'issueTags' and exists (select 1 from jsonb_array_elements(point->'issueTags') tag where jsonb_typeof(tag) <> 'string'
        or tag #>> '{}' not in ('序盤', '攻守判斷', '候選手', '王的安全', '駒的活用', '手筋', '寄せ・詰棋')) then
        diagnostics := diagnostics || jsonb_build_array('invalid_issue_tags');
      end if;
      if point->>'ply' is null or (point->>'ply') !~ '^[0-9]+$' then diagnostics := diagnostics || jsonb_build_array('invalid_ply'); end if;
      if point ? 'recommendedMoves' and jsonb_typeof(point->'recommendedMoves') <> 'array' then diagnostics := diagnostics || jsonb_build_array('malformed_recommendations'); end if;
      if point ? 'recommendedMoves' and jsonb_typeof(point->'recommendedMoves') = 'array' then
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
  legacy_revision integer;
  game jsonb;
  point jsonb;
  recommendation jsonb;
  recommendation_sort_order integer;
  game_count integer := 0;
  point_count integer := 0;
  recommendation_count integer := 0;
  game_source_order integer;
  point_source_order integer;
  migration public.user_migrations%rowtype;
  game_row_id text;
  point_row_id text;
begin
  if uid is null then raise exception 'normalized migration requires auth.uid()'; end if;
  if source_hash is null or source_hash = '' then raise exception 'source_hash is required'; end if;
  select payload, revision into legacy_payload, legacy_revision from public.user_state where user_id = uid for update;
  if not found then raise exception 'legacy user_state row is missing'; end if;
  if exists (select 1 from public.user_migrations where user_id = uid and status = 'finalized') then
    raise exception 'migration is finalized; normalized writes require export/manual rollback';
  end if;
  if not (public.audit_my_state_v1()->>'ok')::boolean then raise exception 'legacy payload failed audit: %', public.audit_my_state_v1()->>'issues'; end if;
  delete from public.recommended_moves where user_id = uid;
  delete from public.review_points where user_id = uid;
  delete from public.games where user_id = uid;
  for game, game_source_order in
    select value, ordinality - 1 from jsonb_array_elements(public.normalized_v1_canonical_games(legacy_payload)) with ordinality as items(value, ordinality) loop
    game_row_id := game->>'id';
    insert into public.games(user_id, id, title, source_format, source_text, initial_sfen, sfens, moves, canonical_hash, created_at_text, source_order, perspective, perspective_present)
    values (uid, game_row_id, game->>'title', game->>'sourceFormat', game->>'sourceText', game->>'initialSfen',
      array(select jsonb_array_elements_text(game->'sfens')), array(select jsonb_array_elements_text(game->'moves')),
      game->>'canonicalHash', game->>'createdAt', game_source_order,
      case when game ? 'perspective' then game->>'perspective' else null end, game ? 'perspective');
    game_count := game_count + 1;
    for point, point_source_order in
      select value, ordinality - 1 from jsonb_array_elements(game->'reviewPoints') with ordinality as items(value, ordinality) loop
      point_row_id := point->>'id';
      insert into public.review_points(user_id, id, game_id, ply, sfen, reason, issue_tags, notes, external_notes, legacy_notes, created_at_text, source_order)
      values (uid, point_row_id, game_row_id, (point->>'ply')::integer, point->>'sfen', point->>'reason',
        array(select jsonb_array_elements_text(coalesce(point->'issueTags', '[]'::jsonb))),
        case when point ? 'note' then point->>'note' else null end,
        case when point ? 'externalNotes' then point->>'externalNotes' else null end,
        case when point ? 'legacyNotes' then point->>'legacyNotes' else null end, point->>'createdAt', point_source_order);
      point_count := point_count + 1;
      if jsonb_typeof(point->'recommendedMoves') = 'array' then
        for recommendation, recommendation_sort_order in
          select value, ordinality - 1 from jsonb_array_elements(point->'recommendedMoves') with ordinality as items(value, ordinality) loop
          insert into public.recommended_moves(user_id, id, point_id, move, comment, sort_order)
          values (uid, recommendation->>'id', point_row_id, recommendation->>'move',
            case when recommendation ? 'comment' then recommendation->>'comment' else null end, recommendation_sort_order);
          recommendation_count := recommendation_count + 1;
        end loop;
      end if;
    end loop;
  end loop;
  insert into public.user_migrations(user_id, migration_version, status, source_payload, source_hash, counts, error, source_revision)
  values (uid, 1, 'migrated', legacy_payload, source_hash,
    jsonb_build_object('games', game_count, 'points', point_count, 'recommendations', recommendation_count), null, legacy_revision)
  on conflict (user_id) do update set migration_version = excluded.migration_version, status = excluded.status,
    source_payload = excluded.source_payload, source_hash = excluded.source_hash, target_hash = null, counts = excluded.counts,
    migrated_at = now(), verified_at = null, finalized_at = null, rolled_back_at = null, error = null,
    source_revision = excluded.source_revision;
  select * into migration from public.user_migrations where user_id = uid;
  return jsonb_build_object('status', migration.status, 'counts', migration.counts, 'source_hash', migration.source_hash);
exception when others then
  insert into public.user_migrations(user_id, migration_version, status, source_payload, source_hash, error, source_revision)
  values (uid, 1, 'failed', coalesce(legacy_payload, '{}'::jsonb), coalesce(source_hash, ''), sqlerrm, legacy_revision)
  on conflict (user_id) do update set status = 'failed', source_payload = excluded.source_payload,
    source_hash = excluded.source_hash, source_revision = excluded.source_revision, error = sqlerrm;
  return jsonb_build_object('status', 'failed', 'error', sqlerrm);
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
          ) order by p.source_order, p.ply, p.id), '[]'::jsonb) from public.review_points p where p.user_id = uid and p.game_id = g.id)
        )
        || case when g.perspective_present then jsonb_build_object('perspective', g.perspective) else '{}'::jsonb end
      ) order by g.source_order, g.id), '[]'::jsonb))
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
    return jsonb_build_object('status', 'failed', 'error', 'legacy payload changed after snapshot');
  end if;
  update public.user_migrations set status = 'finalized', finalized_at = now(), error = null where user_id = uid;
  return jsonb_build_object('status', 'finalized');
end
$$;

create or replace function public.rollback_my_cutover(payload jsonb, target_hash text, expected_revision integer)
returns jsonb
language plpgsql
security invoker
as $$
declare uid uuid := (select auth.uid()); current public.user_migrations%rowtype; live_revision integer; live_payload jsonb;
begin
  if uid is null then raise exception 'cutover rollback requires auth.uid()'; end if;
  select * into current from public.user_migrations where user_id = uid for update;
  if not found or current.status not in ('migrated', 'verified', 'finalized') then raise exception 'migration is not inside rollback window'; end if;
  if target_hash is null or target_hash <> current.source_hash then raise exception 'rollback hash mismatch'; end if;
  if payload is distinct from current.source_payload then raise exception 'rollback payload does not match migration snapshot'; end if;
  if expected_revision is null or current.source_revision is null or expected_revision <> current.source_revision then
    raise exception 'rollback revision guard is missing or stale';
  end if;
  select us.payload, us.revision into live_payload, live_revision from public.user_state as us where us.user_id = uid for update;
  if not found then raise exception 'legacy user_state row is missing'; end if;
  if live_revision <> expected_revision or live_payload is distinct from current.source_payload then
    update public.user_migrations set status = 'failed', error = 'legacy payload changed after snapshot' where user_id = uid;
    return jsonb_build_object('status', 'failed', 'error', 'legacy payload changed after snapshot', 'revision', live_revision);
  end if;
  update public.user_state set payload = rollback_my_cutover.payload, revision = revision + 1 where user_id = uid and revision = expected_revision;
  if not found then raise exception 'legacy user_state row is missing'; end if;
  update public.user_migrations set status = 'rolled_back', rolled_back_at = now(), error = null where user_id = uid;
  return jsonb_build_object('status', 'rolled_back');
end
$$;

create or replace function public.rollback_my_cutover(payload jsonb, target_hash text)
returns jsonb
language plpgsql
security invoker
as $$
begin
  raise exception 'rollback revision guard is required';
end
$$;

grant execute on function public.audit_my_state_v1() to authenticated;
grant execute on function public.migrate_my_state_v1(text) to authenticated;
grant execute on function public.export_my_state_v3() to authenticated;
grant execute on function public.verify_my_migration(text, text) to authenticated;
grant execute on function public.finalize_my_cutover() to authenticated;
grant execute on function public.rollback_my_cutover(jsonb, text, integer) to authenticated;
grant execute on function public.rollback_my_cutover(jsonb, text) to authenticated;
