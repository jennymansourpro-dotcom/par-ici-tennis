# Déclenchement externe fiable (cron-job.org)

Le cron de GitHub Actions est « best-effort » : il peut partir avec plusieurs
heures de retard. Pour garantir que la réservation parte à 08:00 pile, un
scheduler externe appelle l'API GitHub chaque matin pour lancer le workflow
`Tennis booking` via `workflow_dispatch`. Le workflow attend ensuite lui-même
08:00 (Europe/Paris) avant de lancer la recherche — le déclencheur n'a donc pas
besoin d'être précis à la seconde, juste d'arriver avant 08:00.

Les trois crons GitHub restent en place comme filet de secours ; le groupe de
concurrence (sans annulation) rend les doublons inoffensifs.

## 1. Créer un token GitHub (fine-grained PAT)

1. GitHub → Settings → Developer settings → [Fine-grained tokens](https://github.com/settings/personal-access-tokens)
   → **Generate new token**.
2. **Repository access** : *Only select repositories* → `par-ici-tennis`.
3. **Permissions → Repository permissions → Actions : Read and write.**
   Rien d'autre.
4. Expiration : 1 an (mettre un rappel pour le renouveler).
5. Copier le token (`github_pat_…`) — il ne sera montré qu'une fois.

## 2. Créer le job sur cron-job.org

Créer un compte gratuit sur [cron-job.org](https://cron-job.org), puis **Create cronjob** :

- **URL** :
  `https://api.github.com/repos/jennymansourpro-dotcom/par-ici-tennis/actions/workflows/book-tennis.yml/dispatches`
- **Schedule** : tous les jours à **07:52**, fuseau **Europe/Paris**.
- **Advanced → Request method** : `POST`
- **Advanced → Headers** :

  | Header | Valeur |
  |---|---|
  | `Authorization` | `Bearer github_pat_…` (le token de l'étape 1) |
  | `Accept` | `application/vnd.github+json` |
  | `X-GitHub-Api-Version` | `2022-11-28` |
  | `Content-Type` | `application/json` |

- **Advanced → Request body** : `{"ref":"master"}`
- **Advanced → Treat as success** : réponse HTTP `204` (GitHub répond
  `204 No Content` quand le dispatch est accepté).

## 3. Vérifier

Attendre le prochain matin (ou lancer le job manuellement depuis cron-job.org)
et vérifier dans l'onglet **Actions** du repo qu'un run `Tennis booking` avec
l'événement `workflow_dispatch` démarre, attend 08:00, puis lance la recherche.

⚠️ Le token ne doit vivre **que** dans cron-job.org — jamais dans ce repo.
