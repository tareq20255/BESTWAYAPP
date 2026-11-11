-- ===== شاشات BESTWAY — تحديث 2 =====
-- شغّل الملف كله مرة واحدة في Supabase → SQL Editor على مشروع bestway-ops، بعد signage_setup.sql.
-- يضيف: اتجاه الشاشة (عرضي / طولي)، المحتوى المجمّع (عدة صور أو فيديوهات معًا)، ورد مختصر للشاشة لو قائمتها لم تتغير.
-- لا يحذف أي بيانات. الشاشات والمحتوى الحالي يكملون كما هم.

-- ---------- الشاشة: مقاسها واتجاهها ----------
-- orientation: auto = حسب المقاس الذي ترسله الشاشة نفسها، أو تثبيت يدوي
alter table public.sg_screens
  add column view_w integer check (view_w between 1 and 20000),
  add column view_h integer check (view_h between 1 and 20000),
  add column orientation text not null default 'auto' check (orientation in ('auto', 'landscape', 'portrait'));

-- ---------- القاعدة: استهداف باتجاه الشاشة (الفارغ = الكل) ----------
alter table public.sg_rules
  add column orientation text check (orientation is null or orientation in ('landscape', 'portrait'));

-- ---------- المحتوى: نوع «مجموعة» ----------
-- parts: مصفوفة من 2 إلى 4 عناصر، كل عنصر {"file": "c/….mp4", "kind": "video" | "image"}
alter table public.sg_content
  add column parts jsonb check (
    parts is null or case when jsonb_typeof(parts) = 'array' then jsonb_array_length(parts) between 2 and 4 else false end
  );
alter table public.sg_content drop constraint sg_content_type_check;
alter table public.sg_content add constraint sg_content_type_check
  check (type in ('image', 'video', 'text', 'url', 'group'));
alter table public.sg_content add constraint sg_content_group_parts_check
  check ((type = 'group') = (parts is not null));

-- الاتجاه الفعلي للشاشة: المثبّت يدويًا، وإلا من مقاسها، وإلا عرضي
create function sg_private.screen_orientation(p_orientation text, p_w integer, p_h integer) returns text
language sql immutable set search_path = ''
as $$
  select case
    when p_orientation in ('landscape', 'portrait') then p_orientation
    when p_w is not null and p_h is not null and p_h > p_w then 'portrait'
    else 'landscape'
  end
$$;

-- ---------- دالة الشاشات: مقاس الشاشة، الاتجاه، المجموعات، ورد مختصر ----------
-- المعاملات الجديدة اختيارية، فالشاشات التي لم تتحدث صفحتها بعد تكمل بالاستدعاء القديم.
drop function public.sg_player_poll(text, boolean);
create function public.sg_player_poll(
  p_device_id text, p_hb boolean default true,
  p_w integer default null, p_h integer default null, p_version text default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  s public.sg_screens;
  v_tz text;
  v_now timestamp;
  v_items jsonb;
  v_version text;
  v_orientation text;
  v_sized boolean := p_w between 1 and 20000 and p_h between 1 and 20000;
begin
  if p_device_id is null or p_device_id !~ '^[A-Za-z0-9_-]{16,64}$' then
    raise exception 'bad device id';
  end if;

  select * into s from public.sg_screens where device_id = p_device_id;
  if not found then
    return sg_private.register_device(p_device_id);
  end if;

  -- hb=false معاينة من الإدارة: لا تُسجَّل اتصالًا ولا تغيّر مقاس الشاشة المحفوظ
  if p_hb and (
       s.last_seen is null or s.last_seen < now() - interval '15 seconds'
       or (v_sized and (s.view_w is distinct from p_w or s.view_h is distinct from p_h))
     ) then
    update public.sg_screens
       set last_seen = now(),
           view_w = case when v_sized then p_w else view_w end,
           view_h = case when v_sized then p_h else view_h end
     where id = s.id
     returning * into s;
  end if;
  v_orientation := sg_private.screen_orientation(s.orientation, s.view_w, s.view_h);

  select coalesce((select value from public.sg_settings where key = 'tz'), 'Africa/Cairo') into v_tz;
  v_now := now() at time zone v_tz;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id,
           'type', c.type,
           'file', c.file,
           'parts', c.parts,
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
        and (r.orientation is null or r.orientation = v_orientation)
        and sg_private.rule_active(r.days, r.start_time, r.end_time, r.start_date, r.end_date, v_now)
    );
  v_version := md5(v_items::text);

  -- الشاشة عندها نفس القائمة: رد صغير بدل القائمة كاملة
  if p_version is not null and p_version = v_version then
    return jsonb_build_object('paired', true, 'unchanged', true, 'version', v_version);
  end if;

  return jsonb_build_object(
    'paired', true,
    'name', s.name,
    'version', v_version,
    'items', v_items,
    'now', to_char(v_now, 'YYYY-MM-DD"T"HH24:MI:SS')
  );
end $$;
revoke all on function public.sg_player_poll(text, boolean, integer, integer, text) from public;
grant execute on function public.sg_player_poll(text, boolean, integer, integer, text) to anon, authenticated;

-- ---------- حفظ القواعد: مع اتجاه الشاشة ----------
create or replace function public.sg_replace_rules(p_content_id bigint, p_rules jsonb) returns void
language plpgsql set search_path = ''
as $$
begin
  if jsonb_typeof(p_rules) is distinct from 'array' then
    raise exception 'rules must be an array';
  end if;
  delete from public.sg_rules where content_id = p_content_id;
  insert into public.sg_rules(content_id, branch_id, location_id, screen_id, orientation, days, start_time, end_time, start_date, end_date)
  select p_content_id,
         nullif(x->>'branch_id','')::bigint,
         nullif(x->>'location_id','')::bigint,
         nullif(x->>'screen_id','')::bigint,
         nullif(x->>'orientation',''),
         coalesce((select array_agg(v::int order by v::int) from jsonb_array_elements_text(coalesce(x->'days','[]'::jsonb)) v), '{}'),
         nullif(x->>'start_time','')::time,
         nullif(x->>'end_time','')::time,
         nullif(x->>'start_date','')::date,
         nullif(x->>'end_date','')::date
  from jsonb_array_elements(p_rules) x;
  update public.sg_content set updated_at = now() where id = p_content_id;
end $$;

-- PostgREST يعيد قراءة شكل الجداول والدوال
notify pgrst, 'reload schema';
