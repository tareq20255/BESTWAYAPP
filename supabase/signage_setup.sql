-- ===== نظام الشاشات (Signage) لتطبيق BESTWAY =====
-- شغّل الملف كله مرة واحدة في Supabase → SQL Editor على مشروع bestway-ops.
-- لا يلمس أي جدول أو bucket موجود (مثل product-images).

create schema if not exists sg_private;
revoke all on schema sg_private from public, anon;
grant usage on schema sg_private to authenticated;

-- ---------- الجداول ----------
create table public.sg_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.sg_settings (
  key text primary key,
  value text not null
);
insert into public.sg_settings(key, value) values ('tz', 'Africa/Cairo');

create table public.sg_branches (
  id bigint generated always as identity primary key,
  name text not null unique check (char_length(btrim(name)) between 1 and 80),
  created_at timestamptz not null default now()
);

create table public.sg_locations (
  id bigint generated always as identity primary key,
  name text not null unique check (char_length(btrim(name)) between 1 and 80),
  created_at timestamptz not null default now()
);

create table public.sg_screens (
  id bigint generated always as identity primary key,
  device_id text not null unique check (device_id ~ '^[A-Za-z0-9_-]{16,64}$'),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  branch_id bigint references public.sg_branches(id),
  location_id bigint references public.sg_locations(id),
  created_at timestamptz not null default now(),
  last_seen timestamptz
);
create index sg_screens_branch_idx on public.sg_screens(branch_id);
create index sg_screens_location_idx on public.sg_screens(location_id);

create table public.sg_pending (
  device_id text primary key check (device_id ~ '^[A-Za-z0-9_-]{16,64}$'),
  code text not null unique check (code ~ '^[0-9]{6}$'),
  created_at timestamptz not null default now()
);
create index sg_pending_created_idx on public.sg_pending(created_at);

create table public.sg_content (
  id bigint generated always as identity primary key,
  title text not null check (char_length(btrim(title)) between 1 and 120),
  type text not null check (type in ('image','video','text','url')),
  file text check (file is null or (char_length(file) <= 300 and file !~ '\.\.')),
  text_body text check (text_body is null or char_length(text_body) <= 2000),
  url text check (url is null or url ~* '^https?://'),
  bg text not null default '#111111' check (bg ~ '^#[0-9a-fA-F]{6}$'),
  fg text not null default '#ffffff' check (fg ~ '^#[0-9a-fA-F]{6}$'),
  fit text not null default 'contain' check (fit in ('contain','cover','fill')),
  duration integer not null default 10 check (duration between 2 and 3600),
  sort integer not null default 0,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.sg_rules (
  id bigint generated always as identity primary key,
  content_id bigint not null references public.sg_content(id) on delete cascade,
  branch_id bigint references public.sg_branches(id),
  location_id bigint references public.sg_locations(id),
  screen_id bigint references public.sg_screens(id) on delete cascade,
  days integer[] not null default '{}' check (days <@ array[0,1,2,3,4,5,6]),
  start_time time,
  end_time time,
  start_date date,
  end_date date,
  check (start_date is null or end_date is null or start_date <= end_date)
);
create index sg_rules_content_idx on public.sg_rules(content_id);
create index sg_rules_branch_idx on public.sg_rules(branch_id);
create index sg_rules_location_idx on public.sg_rules(location_id);
create index sg_rules_screen_idx on public.sg_rules(screen_id);

-- ---------- دوال مساعدة (غير معروضة في الـ API) ----------
create function sg_private.is_admin() returns boolean
language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.sg_admins a where a.user_id = (select auth.uid())) $$;
revoke all on function sg_private.is_admin() from public, anon;
grant execute on function sg_private.is_admin() to authenticated;

create function sg_private.touch_updated_at() returns trigger
language plpgsql set search_path = ''
as $$ begin new.updated_at := now(); return new; end $$;

create trigger sg_content_touch before update on public.sg_content
for each row execute function sg_private.touch_updated_at();

-- هل القاعدة سارية الآن؟ (الأيام: 0=الأحد .. 6=السبت، النافذة الليلية 22:00→02:00 مدعومة)
create function sg_private.rule_active(
  p_days integer[], p_start time, p_end time, p_sdate date, p_edate date, p_now timestamp
) returns boolean
language plpgsql immutable set search_path = ''
as $$
declare
  t time := p_now::time;
  d date := p_now::date;
begin
  if p_start is not null and p_end is not null then
    if p_start <= p_end then
      if t < p_start or t >= p_end then return false; end if;
    else
      if t >= p_start then
        null; -- نفس اليوم
      elsif t < p_end then
        d := d - 1; -- بعد منتصف الليل: يتبع يوم بداية النافذة
      else
        return false;
      end if;
    end if;
  elsif p_start is not null and t < p_start then
    return false;
  elsif p_end is not null and t >= p_end then
    return false;
  end if;

  if p_days is not null and cardinality(p_days) > 0
     and not (extract(dow from d)::int = any (p_days)) then
    return false;
  end if;
  if p_sdate is not null and d < p_sdate then return false; end if;
  if p_edate is not null and d > p_edate then return false; end if;
  return true;
end $$;

-- تسجيل جهاز جديد وإرجاع كود الربط
create function sg_private.register_device(p_device_id text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_code text;
  v_tries int := 0;
begin
  if p_device_id is null or p_device_id !~ '^[A-Za-z0-9_-]{16,64}$' then
    raise exception 'bad device id';
  end if;

  delete from public.sg_pending where created_at < now() - interval '7 days';

  select code into v_code from public.sg_pending where device_id = p_device_id;
  if v_code is not null then
    return jsonb_build_object('paired', false, 'code', v_code);
  end if;

  if (select count(*) from public.sg_pending) >= 300 then
    raise exception 'too many pending devices';
  end if;

  loop
    v_tries := v_tries + 1;
    v_code := lpad(floor(random() * 1000000)::int::text, 6, '0');
    begin
      insert into public.sg_pending(device_id, code) values (p_device_id, v_code);
      exit;
    exception when unique_violation then
      select code into v_code from public.sg_pending where device_id = p_device_id;
      if v_code is not null then exit; end if;
      if v_tries >= 10 then raise exception 'could not allocate code'; end if;
    end;
  end loop;

  return jsonb_build_object('paired', false, 'code', v_code);
end $$;
revoke all on function sg_private.register_device(text) from public, anon, authenticated;

-- ---------- دوال المشغّل (متاحة للشاشات بدون تسجيل دخول) ----------
create function public.sg_player_register(p_device_id text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  if exists (select 1 from public.sg_screens where device_id = p_device_id) then
    return jsonb_build_object('paired', true);
  end if;
  return sg_private.register_device(p_device_id);
end $$;

create function public.sg_player_poll(p_device_id text, p_hb boolean default true) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  s public.sg_screens;
  v_tz text;
  v_now timestamp;
  v_items jsonb;
begin
  if p_device_id is null or p_device_id !~ '^[A-Za-z0-9_-]{16,64}$' then
    raise exception 'bad device id';
  end if;

  select * into s from public.sg_screens where device_id = p_device_id;
  if not found then
    return sg_private.register_device(p_device_id);
  end if;

  if p_hb and (s.last_seen is null or s.last_seen < now() - interval '15 seconds') then
    update public.sg_screens set last_seen = now() where id = s.id;
  end if;

  select coalesce((select value from public.sg_settings where key = 'tz'), 'Africa/Cairo') into v_tz;
  v_now := now() at time zone v_tz;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id,
           'type', c.type,
           'file', c.file,
           'url', c.url,
           'text', c.text_body,
           'bg', c.bg,
           'fg', c.fg,
           'fit', c.fit,
           'duration', c.duration,
           'updated', (extract(epoch from c.updated_at) * 1000)::bigint
         ) order by c.sort, c.id), '[]'::jsonb)
    into v_items
  from public.sg_content c
  where c.enabled
    and exists (
      select 1 from public.sg_rules r
      where r.content_id = c.id
        and (r.branch_id is null or r.branch_id = s.branch_id)
        and (r.location_id is null or r.location_id = s.location_id)
        and (r.screen_id is null or r.screen_id = s.id)
        and sg_private.rule_active(r.days, r.start_time, r.end_time, r.start_date, r.end_date, v_now)
    );

  return jsonb_build_object(
    'paired', true,
    'name', s.name,
    'version', md5(v_items::text),
    'items', v_items,
    'now', to_char(v_now, 'YYYY-MM-DD"T"HH24:MI:SS')
  );
end $$;

revoke all on function public.sg_player_register(text) from public;
revoke all on function public.sg_player_poll(text, boolean) from public;
grant execute on function public.sg_player_register(text) to anon, authenticated;
grant execute on function public.sg_player_poll(text, boolean) to anon, authenticated;

-- ---------- دوال الإدارة (تعتمد على صلاحيات RLS للمدير) ----------
create function public.sg_pair_screen(
  p_code text, p_name text, p_branch_id bigint default null, p_location_id bigint default null
) returns bigint
language plpgsql set search_path = ''
as $$
declare
  v_device text;
  v_id bigint;
begin
  select device_id into v_device from public.sg_pending where code = btrim(p_code);
  if v_device is null then
    raise exception 'الكود غير صحيح أو منتهي';
  end if;
  insert into public.sg_screens(device_id, name, branch_id, location_id)
  values (v_device, btrim(p_name), p_branch_id, p_location_id)
  returning id into v_id;
  delete from public.sg_pending where device_id = v_device;
  return v_id;
end $$;

create function public.sg_create_screen(
  p_name text, p_branch_id bigint default null, p_location_id bigint default null
) returns text
language plpgsql set search_path = ''
as $$
declare
  v_device text := replace(gen_random_uuid()::text, '-', '');
begin
  insert into public.sg_screens(device_id, name, branch_id, location_id)
  values (v_device, btrim(p_name), p_branch_id, p_location_id);
  return v_device;
end $$;

create function public.sg_replace_rules(p_content_id bigint, p_rules jsonb) returns void
language plpgsql set search_path = ''
as $$
begin
  if jsonb_typeof(p_rules) is distinct from 'array' then
    raise exception 'rules must be an array';
  end if;
  delete from public.sg_rules where content_id = p_content_id;
  insert into public.sg_rules(content_id, branch_id, location_id, screen_id, days, start_time, end_time, start_date, end_date)
  select p_content_id,
         nullif(x->>'branch_id','')::bigint,
         nullif(x->>'location_id','')::bigint,
         nullif(x->>'screen_id','')::bigint,
         coalesce((select array_agg(v::int order by v::int) from jsonb_array_elements_text(coalesce(x->'days','[]'::jsonb)) v), '{}'),
         nullif(x->>'start_time','')::time,
         nullif(x->>'end_time','')::time,
         nullif(x->>'start_date','')::date,
         nullif(x->>'end_date','')::date
  from jsonb_array_elements(p_rules) x;
  update public.sg_content set updated_at = now() where id = p_content_id;
end $$;

revoke all on function public.sg_pair_screen(text, text, bigint, bigint) from public, anon;
revoke all on function public.sg_create_screen(text, bigint, bigint) from public, anon;
revoke all on function public.sg_replace_rules(bigint, jsonb) from public, anon;
grant execute on function public.sg_pair_screen(text, text, bigint, bigint) to authenticated;
grant execute on function public.sg_create_screen(text, bigint, bigint) to authenticated;
grant execute on function public.sg_replace_rules(bigint, jsonb) to authenticated;

-- ---------- RLS ----------
alter table public.sg_admins    enable row level security;
alter table public.sg_settings  enable row level security;
alter table public.sg_branches  enable row level security;
alter table public.sg_locations enable row level security;
alter table public.sg_screens   enable row level security;
alter table public.sg_pending   enable row level security;
alter table public.sg_content   enable row level security;
alter table public.sg_rules     enable row level security;

revoke all on public.sg_admins, public.sg_settings, public.sg_branches, public.sg_locations,
              public.sg_screens, public.sg_pending, public.sg_content, public.sg_rules from anon;
revoke all on public.sg_admins from authenticated;
grant select on public.sg_admins to authenticated;
grant select, insert, update, delete on
  public.sg_settings, public.sg_branches, public.sg_locations, public.sg_screens,
  public.sg_pending, public.sg_content, public.sg_rules to authenticated;

create policy sg_admins_self on public.sg_admins for select to authenticated
  using (user_id = (select auth.uid()));

create policy sg_settings_admin  on public.sg_settings  for all to authenticated
  using ((select sg_private.is_admin())) with check ((select sg_private.is_admin()));
create policy sg_branches_admin  on public.sg_branches  for all to authenticated
  using ((select sg_private.is_admin())) with check ((select sg_private.is_admin()));
create policy sg_locations_admin on public.sg_locations for all to authenticated
  using ((select sg_private.is_admin())) with check ((select sg_private.is_admin()));
create policy sg_screens_admin   on public.sg_screens   for all to authenticated
  using ((select sg_private.is_admin())) with check ((select sg_private.is_admin()));
create policy sg_pending_admin   on public.sg_pending   for all to authenticated
  using ((select sg_private.is_admin())) with check ((select sg_private.is_admin()));
create policy sg_content_admin   on public.sg_content   for all to authenticated
  using ((select sg_private.is_admin())) with check ((select sg_private.is_admin()));
create policy sg_rules_admin     on public.sg_rules     for all to authenticated
  using ((select sg_private.is_admin())) with check ((select sg_private.is_admin()));

-- ---------- مخزن الملفات ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('signage', 'signage', true, 52428800,
        array['image/png','image/jpeg','image/webp','image/gif','video/mp4','video/webm'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create policy sg_storage_select on storage.objects for select to authenticated
  using (bucket_id = 'signage' and (select sg_private.is_admin()));
create policy sg_storage_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'signage' and (select sg_private.is_admin()));
create policy sg_storage_update on storage.objects for update to authenticated
  using (bucket_id = 'signage' and (select sg_private.is_admin()))
  with check (bucket_id = 'signage' and (select sg_private.is_admin()));
create policy sg_storage_delete on storage.objects for delete to authenticated
  using (bucket_id = 'signage' and (select sg_private.is_admin()));

-- ---------- أول مستخدم = مدير (بدون كتابة أي إيميل) ----------
insert into public.sg_admins(user_id)
select id from auth.users order by created_at asc limit 1
on conflict do nothing;
