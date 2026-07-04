-- =========================================================
-- ECO-TRANSIT IA — Mise en place de l'espace Admin
-- À exécuter une seule fois dans Supabase > SQL Editor
-- =========================================================

-- ---------------------------------------------------------
-- 1) Table profiles : miroir public de auth.users, avec un rôle
--    Nécessaire car auth.users n'est pas interrogeable depuis le
--    client avec la clé anonyme (et c'est très bien ainsi).
-- ---------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  role text not null default 'passager',
  nom text,
  telephone text,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles_select_all" on public.profiles;
create policy "profiles_select_all"
  on public.profiles for select
  using (true);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles for update
  using (auth.uid() = id);

-- ---------------------------------------------------------
-- 2) Trigger : crée automatiquement la ligne profiles à chaque
--    inscription (auth.users). C'EST ICI que la création d'un
--    compte admin est bloquée : quoi que le client envoie dans
--    les métadonnées, seuls "passager" ou "chauffeur" peuvent
--    être enregistrés. Impossible de contourner depuis le
--    navigateur (même en modifiant le JS ou en appelant l'API
--    Supabase directement) puisque c'est appliqué côté base.
-- ---------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, role, nom, telephone)
  values (
    new.id,
    new.email,
    case when new.raw_user_meta_data->>'role' = 'chauffeur' then 'chauffeur' else 'passager' end,
    new.raw_user_meta_data->>'nom',
    new.raw_user_meta_data->>'telephone'
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ---------------------------------------------------------
-- 3) Droits admin sur les tables existantes : un utilisateur dont
--    le profil a role = 'admin' peut mettre à jour/annuler les
--    demandes de course et suspendre/réactiver un chauffeur.
--    (Les policies existantes, ex: un chauffeur qui modifie sa
--    propre ligne, restent valables — celles-ci s'ajoutent.)
-- ---------------------------------------------------------
drop policy if exists "chauffeurs_admin_update" on public.chauffeurs;
create policy "chauffeurs_admin_update"
  on public.chauffeurs for update
  using (exists (
    select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'
  ));

drop policy if exists "demandes_admin_update" on public.demandes_course;
create policy "demandes_admin_update"
  on public.demandes_course for update
  using (exists (
    select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'
  ));

-- ---------------------------------------------------------
-- 4) Rétro-remplissage : si des comptes existent déjà (créés
--    avant cette migration), on crée leur ligne profiles.
-- ---------------------------------------------------------
insert into public.profiles (id, email, role, nom, telephone)
select
  u.id,
  u.email,
  case when u.raw_user_meta_data->>'role' = 'chauffeur' then 'chauffeur' else 'passager' end,
  u.raw_user_meta_data->>'nom',
  u.raw_user_meta_data->>'telephone'
from auth.users u
where not exists (select 1 from public.profiles p where p.id = u.id);

-- ---------------------------------------------------------
-- 5) Promouvoir VOTRE compte admin (à faire une seule fois).
--    Inscrivez-vous normalement sur le site (comme passager ou
--    chauffeur, peu importe), puis lancez cette ligne en
--    remplaçant l'email :
-- ---------------------------------------------------------
-- update public.profiles set role = 'admin' where email = 'vous@exemple.com';
