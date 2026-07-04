# Eco-Transit IA — Page marketing + Espace Admin

## Ce qui a été ajouté

1. **Page marketing** (`view-marketing`) : c'est maintenant la première
   chose que voit un visiteur, avant tout écran de connexion. Elle explique
   le concept (passager / chauffeur), met en avant l'impact (carburant, CO₂,
   zéro commission) et propose deux boutons — "Se connecter" et "Créer un
   compte" — qui ouvrent l'écran d'authentification existant. Un visiteur
   qui a déjà une session active saute directement dans l'application, sans
   repasser par la page marketing.

2. **Espace Admin** (`view-admin`), un troisième rôle en plus de
   Passager/Chauffeur :
   - Statistiques : passagers inscrits, chauffeurs inscrits, chauffeurs
     disponibles maintenant, demandes en attente.
   - Liste des chauffeurs avec une action contextuelle : **Suspendre** un
     chauffeur disponible, **Réactiver** un chauffeur suspendu, ou
     **Débloquer** un chauffeur resté coincé en "en course" (par exemple
     après un plantage de son tableau de bord pendant une tournée).
   - Liste des demandes en attente avec un bouton **Annuler** pour les
     demandes fantômes ou bloquées.
   - Une carte de supervision globale (tous les chauffeurs + toutes les
     demandes en attente).
   - Comme pour les autres rôles, l'admin ne voit que son propre onglet —
     impossible de basculer vers Passager/Chauffeur depuis l'interface.

## ⚠️ Étape obligatoire : exécuter `supabase_setup.sql`

Ce fichier crée la brique qui manquait pour que tout ça fonctionne :

1. Allez dans votre projet Supabase → **SQL Editor**.
2. Collez le contenu de `supabase_setup.sql` et exécutez-le.

Ce script :
- crée une table `profiles` (miroir public de `auth.users`, avec un champ
  `role`) — indispensable car le client ne peut pas lire `auth.users`
  directement avec la clé anonyme ;
- installe un trigger qui remplit `profiles` automatiquement à chaque
  inscription. **C'est ce trigger qui empêche la création d'un compte
  admin** : quoi que le navigateur envoie, seuls `passager` ou `chauffeur`
  peuvent être enregistrés — appliqué côté base de données, donc impossible
  à contourner même en modifiant le JavaScript ou en appelant l'API
  Supabase directement depuis la console du navigateur ;
- ajoute les policies RLS qui autorisent un compte `role = 'admin'` à
  modifier les chauffeurs et les demandes de course (suspendre, débloquer,
  annuler) ;
- rétro-remplit `profiles` pour les comptes déjà existants.

## Créer votre compte admin

Il n'existe **aucun moyen de créer un admin depuis le site** — c'est
volontaire. Pour obtenir un accès admin :

1. Inscrivez-vous normalement sur le site (Passager ou Chauffeur, peu
   importe le choix).
2. Dans Supabase → SQL Editor, exécutez :
   ```sql
   update public.profiles set role = 'admin' where email = 'vous@exemple.com';
   ```
3. Rechargez la page (ou reconnectez-vous) : vous arrivez directement sur
   l'espace Admin.

## Limite connue

Les compteurs et la carte admin dépendent de `supabase_setup.sql`. Tant que
ce script n'a pas été exécuté, l'espace Admin affiche un message d'erreur
clair plutôt que de planter silencieusement.
