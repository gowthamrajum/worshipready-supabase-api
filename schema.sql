-- presentations
create table if not exists presentations (
  id bigserial primary key,
  random_id text not null unique,
  presentation_name text not null,
  slide_order integer,
  slide_data jsonb not null,
  created_datetime timestamptz not null default now(),
  updated_datetime timestamptz not null default now()
);

create index if not exists presentations_name_created_idx
  on presentations (presentation_name, created_datetime);

-- songs
create table if not exists songs (
  song_id bigserial primary key,
  song_name text not null,
  main_stanza jsonb not null,
  stanzas jsonb not null,
  created_at timestamptz default now(),
  last_updated_at timestamptz default now(),
  created_by text default 'System',
  last_updated_by text default ''
);

create index if not exists songs_name_idx on songs (lower(song_name));

-- psalms
create table if not exists psalms (
  id bigserial primary key,
  chapter integer not null,
  verse integer not null,
  telugu text not null,
  english text not null
);

create unique index if not exists psalms_ch_v_idx
  on psalms (chapter, verse);

-- helpful updated_at trigger for presentations & songs
create or replace function set_updated_datetime() returns trigger as $$
begin
  new.updated_datetime = now();
  return new;
end; $$ language plpgsql;

drop trigger if exists t_pres_updated on presentations;
create trigger t_pres_updated
before update on presentations
for each row execute procedure set_updated_datetime();

create or replace function set_last_updated_at() returns trigger as $$
begin
  new.last_updated_at = now();
  return new;
end; $$ language plpgsql;

drop trigger if exists t_songs_updated on songs;
create trigger t_songs_updated
before update on songs
for each row execute procedure set_last_updated_at();

-- (Optional) If you plan to call from a browser with RLS ON, add policies.
-- Since this server will use the Service Role key (bypasses RLS), you can leave RLS ON with no policies.