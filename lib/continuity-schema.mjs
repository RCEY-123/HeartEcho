export const CONTINUITY_SCHEMA = `
create table if not exists conversation_evaluations (
 message_id integer primary key, character_id text not null, account_id text not null,
 scope_key text not null, generation integer not null, importance real not null,
 confidence real not null, reason text not null, state text not null, retry_at integer not null default 0,
 attempts integer not null default 0, at integer not null
);
create table if not exists conversation_facts (
 id integer primary key, message_id integer not null, character_id text not null, account_id text not null,
 scope_key text not null, category text not null, slot text not null, content text not null,
 confidence real not null, importance real not null, at integer not null,
 unique(message_id, category, content)
);
create table if not exists reflection_owners(reflection_id integer primary key,account_id text not null);
create table if not exists forgotten_fact_sources(message_id integer primary key);
create table if not exists body_profiles(character_id text primary key, profile_json text not null, created_at integer not null);
create table if not exists body_days(character_id text not null, day text not null, state_json text not null, primary key(character_id,day));
create table if not exists character_evolution(character_id text primary key, enabled integer not null, original_json text not null, traits_json text not null, iterations integer not null,last_at integer not null);
create table if not exists evolution_history(id integer primary key,character_id text not null,scope_key text not null,change_json text not null,at integer not null);
create table if not exists birthday_owners(birthday_id integer primary key,character_id text not null,account_id text not null,scope_key text not null);
`;
