# Publier une version sur PyPI

La CI publie automatiquement sur PyPI quand on **pousse un tag de version**.
L'authentification utilise le **Trusted Publishing (OIDC)** de PyPI : **aucun
token n'est stocké** dans le dépôt.

## Configuration (une seule fois)

### 1. Déclarer le « trusted publisher » sur PyPI

Sur <https://pypi.org>, projet `urban-http` → *Settings* → *Publishing* (ou, avant
le tout premier envoi, <https://pypi.org/manage/account/publishing/> → *pending
publisher*), ajouter un éditeur GitHub Actions avec :

| Champ | Valeur |
|---|---|
| PyPI Project Name | `urban-http` |
| Owner | `gaelgael5` |
| Repository name | `urban-http` |
| Workflow name | `publish.yml` |
| Environment name | `pypi` |

(Pour TestPyPI, répéter la même chose sur <https://test.pypi.org> avec
l'environment `testpypi`.)

### 2. Créer les environnements GitHub

Dans le dépôt → *Settings* → *Environments*, créer `pypi` (et `testpypi` si
souhaité). On peut y ajouter une règle de protection (révision obligatoire avant
publication).

## Publier une version

1. Mettre à jour la version dans `pyproject.toml` (`project.version`).
2. Commiter et pousser sur `main`.
3. Créer et pousser le tag correspondant :

   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```

Le workflow `publish.yml` vérifie que le tag (`v0.2.0`) correspond bien à
`project.version` (`0.2.0`), construit le sdist + wheel, les passe à
`twine check`, puis publie sur PyPI.

### Tester d'abord sur TestPyPI

Lancer manuellement le workflow *Publier sur PyPI* (onglet Actions →
*Run workflow*) en choisissant la cible `testpypi`.

## Repli : token d'API

Si le Trusted Publishing n'est pas souhaité, créer un token sur PyPI, l'ajouter
en secret `PYPI_API_TOKEN`, et passer le mot de passe à l'action dans
`publish.yml` :

```yaml
      - uses: pypa/gh-action-pypi-publish@release/v1
        with:
          password: ${{ secrets.PYPI_API_TOKEN }}
```
