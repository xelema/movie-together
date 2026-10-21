# Livraison continue

Deux workflows GitHub Actions, tous les deux exécutés par le runner self-hosted
installé sur la VM de production :

- `.github/workflows/ci.yml` (**Checks**) : tests unitaires, e2e Playwright et
  construction de l'image, sur chaque push de `main` et chaque pull request.
- `.github/workflows/deploy.yml` (**Deploy**) : déploiement en production dès que
  **Checks** passe sur `main`.
- `.github/workflows/preview.yml` (**Preview**) : URL temporaire par pull request.

## Déploiement de la production

### Déclenchement

Le workflow **Deploy** écoute la fin du workflow **Checks** sur `main`
(`workflow_run`) et ne fait rien si la conclusion n'est pas `success`. Il peut aussi
être lancé à la main (`workflow_dispatch`, avec un `sha` en option) pour redéployer un
commit précis.

Le commit déployé est `workflow_run.head_sha`, c'est-à-dire **exactement le commit
testé**, et non la tête de `main` au moment du déploiement.

### Ce qui est déployé

1. l'image du commit est construite sur le runner et étiquetée
   `movie-together-app:main-<sha court>` ;
2. un fichier d'override Compose, écrit hors du répertoire de production, épingle le
   service `app` sur cette image (`pull_policy: never`, donc jamais de tirage depuis un
   registre) ;
3. la configuration résolue est contrôlée avant toute action : nom du projet Compose
   `movie-together`, volume de films `movie-data`, service `app` sans port publié, en
   lecture seule, `APP_ORIGIN` en HTTPS. Au moindre écart, le déploiement s'arrête
   sans rien toucher ;
4. seul le service `app` est recréé. Le proxy Caddy de production n'est pas recréé : il
   résout le nouveau conteneur par son nom DNS à la requête suivante ;
5. la vérification finale interroge `https://movie-together.duckdns.org/healthz` depuis
   la VM et compare l'image du conteneur en service au tag construit.

Le répertoire de production (`/home/ubuntu/movie-together`) n'est **jamais écrit** par
la chaîne : le `.env` de production, le `compose.yaml` de production et la configuration
Caddy de production restent tels quels. Le déploiement se contente de recréer le
conteneur `app` à partir du `compose.yaml` du dépôt. Les séances en cours sont coupées
par la recréation du conteneur : c'est accepté, les rooms vivent en mémoire.

### Retour en arrière

- **Automatique** : si la vérification échoue, l'image qui tournait avant la bascule est
  ré-étiquetée `movie-together-app:rollback` et le service `app` est recréé dessus, puis
  `/healthz` est revérifié. Le job reste rouge.
- **Manuel** : relancer **Deploy** (`workflow_dispatch`) avec le `sha` du dernier commit
  sain. Le déploiement manuel `bash deploy/deploy.sh` reste possible pour l'ensemble de
  la pile (applicatif et proxy).

Les 5 derniers tags `movie-together-app:main-*` sont conservés ; les précédents sont
supprimés en fin de job. `movie-together-app:latest`, produite par
`deploy/deploy.sh`, n'est jamais supprimée.

## Previews de pull request

Chaque PR ouverte (hors brouillon) est déployée sur :

```
https://pr-<numero>.movie-together.duckdns.org:8443
```

Un commentaire est posé sur la PR avec l'URL, le commit, l'image et le mot de passe de
connexion ; il est mis à jour à chaque push au lieu d'être dupliqué.

### Pourquoi le port 8443

Les ports 80 et 443 de la VM appartiennent au Caddy de production, et une preview ne
doit pas dépendre de sa configuration. Le proxy des previews écoute donc sur 8443, avec
un **seul certificat wildcard** `*.movie-together.duckdns.org` obtenu par challenge
DNS-01 DuckDNS (Caddy crée et supprime lui-même l'enregistrement TXT `_acme-challenge`).

Le HTTPS n'est pas un confort : les API de capture (webcam, micro) exigent un contexte
sécurisé, donc une preview en HTTP simple serait inutilisable pour tester la voix.

DuckDNS résout n'importe quel sous-domaine d'un domaine enregistré vers la VM : les URLs
de preview ne consomment donc aucun emplacement de domaine supplémentaire, et il n'y a
rien à nettoyer côté DNS à la fermeture d'une PR.

### Mise en place (une fois)

1. Créer le secret `DUCKDNS_TOKEN` (token du compte duckdns.org, page d'accueil) :
   `gh secret set DUCKDNS_TOKEN -R <proprietaire>/movie-together`.
2. Facultatif : `PREVIEW_ADMIN_PASSWORD` (16 caractères minimum) pour fixer le mot de
   passe de connexion des previews. Sans ce secret, un mot de passe aléatoire est généré
   par PR et publié dans le commentaire de la PR.
3. Autoriser le port TCP 8443 en entrée dans la liste de sécurité du VCN Oracle
   (source `0.0.0.0/0`, protocole TCP, port 8443), sinon les previews ne sont pas
   joignables depuis l'extérieur.
4. Installer la stack permanente du proxy :
   `sudo bash deploy/preview/bootstrap.sh`.

Le workflow de preview appelle `bootstrap.sh --ensure` à chaque exécution : la stack est
créée si elle manque et recréée si elle tourne sans token DuckDNS.

### Cycle de vie

- `opened`, `synchronize`, `reopened` : reconstruction de l'image de la PR et redéploiement.
- `closed` : suppression des conteneurs, démontage de l'overlay, suppression de l'état et
  des images de la PR.
- Chaque nuit : `deploy/preview/cleanup.sh` supprime les previews dont la PR n'est plus
  ouverte, et celles qui n'ont pas été redéployées depuis 14 jours.

### Données des previews

Une preview doit pouvoir lire les films pour être utile, mais ne doit jamais pouvoir
abîmer la production. Les films de production sont montés en **overlayfs** :

- la couche basse est le volume de production `movie-together_movie-data`, en lecture
  seule ;
- la couche haute est propre à la PR, dans `/home/ubuntu/previews/pr-<numero>/upper`.

La preview voit donc tous les films, mais tout ce qu'elle écrit (re-probe de
`movie.json`, nouvel encodage, télémétrie) atterrit dans sa couche jetable. Vérifié :
une écriture depuis une preview ne change ni la date de modification ni le contenu du
volume de production. `settings.json` est recopié une fois au premier démarrage pour que
la preview se comporte comme la production.

Chaque preview est limitée à 1 CPU et 2 Gio de mémoire, avec `ENCODE_THREADS=1`, pour ne
pas prendre les deux cœurs de la VM pendant une séance.

### Sans token DuckDNS

`bootstrap.sh --local` (ou un `bootstrap.sh` sans `DUCKDNS_TOKEN`) démarre le proxy avec
un certificat interne : la chaîne complète peut être vérifiée depuis la VM, mais le
navigateur refusera le certificat et les API de capture resteront bloquées. À réserver
aux vérifications locales.

## Diagnostics

```sh
gh run list --workflow deploy.yml --limit 5      # derniers déploiements
gh run list --workflow preview.yml --limit 5     # dernières previews
gh run view <id> --log                           # trace complète d'une exécution

docker inspect --format '{{.Config.Image}}' movie-together-app-1   # image en service
docker ps --filter name=movie-together                            # conteneurs
curl -fsS https://movie-together.duckdns.org/healthz              # santé publique

docker compose --project-name previews ps                         # proxy des previews
docker logs --tail=50 pr-<numero>-app-1                           # journaux d'une preview
sudo bash deploy/preview/down.sh <numero>                         # supprimer une preview
```

## Limites connues

- La recréation du conteneur `app` coupe les séances en cours.
- Le runner self-hosted est unique : les jobs s'exécutent en série, donc le job de
  preview d'une PR attend la fin de **Checks** avant de démarrer (compter le temps des
  tests e2e en plus du sien).
- Une preview ne peut pas tester une modification de la configuration Caddy de
  production ni du service `proxy` : elle n'exécute que le service `app`.
- Le port 8443 doit rester ouvert en entrée ; s'il est fermé, les previews sont
  inaccessibles depuis l'extérieur alors que la production continue de fonctionner.
- Les previews partagent les ressources de la VM de production : une PR lourde (encodage
  forcé depuis l'interface d'administration) ralentit la production.
