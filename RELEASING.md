# Releasing to PyPI

*(Version française : [RELEASING.fr.md](RELEASING.fr.md))*

CI publishes to PyPI automatically when a **version tag is pushed**.
Authentication uses PyPI **Trusted Publishing (OIDC)**: **no token is stored** in
the repository.

## One-time setup

### 1. Declare the trusted publisher on PyPI

On <https://pypi.org>, project `urban-http` → *Settings* → *Publishing* (or, before
the very first upload, <https://pypi.org/manage/account/publishing/> → *pending
publisher*), add a GitHub Actions publisher with:

| Field | Value |
|---|---|
| PyPI Project Name | `urban-http` |
| Owner | `gaelgael5` |
| Repository name | `urban-http` |
| Workflow name | `publish.yml` |
| Environment name | `pypi` |

(For TestPyPI, do the same on <https://test.pypi.org> with the `testpypi`
environment.)

### 2. Create the GitHub environments

In the repository → *Settings* → *Environments*, create `pypi` (and `testpypi` if
desired). You can add a protection rule there (required review before publishing).

## Publishing a version

1. Bump the version in `pyproject.toml` (`project.version`).
2. Commit and push to `main`.
3. Create and push the matching tag:

   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```

The `publish.yml` workflow checks that the tag (`v0.2.0`) matches
`project.version` (`0.2.0`), builds the sdist + wheel, runs `twine check`, then
publishes to PyPI.

### Test on TestPyPI first

Run the *Publier sur PyPI* workflow manually (Actions tab → *Run workflow*)
choosing the `testpypi` target.

## Fallback: API token

If you would rather not use Trusted Publishing, create a token on PyPI, add it as
the `PYPI_API_TOKEN` secret, and pass the password to the action in `publish.yml`:

```yaml
      - uses: pypa/gh-action-pypi-publish@release/v1
        with:
          password: ${{ secrets.PYPI_API_TOKEN }}
```
