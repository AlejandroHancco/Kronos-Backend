# CI/CD (GitHub Actions + GHCR + self-hosted runner on the app VM)

The slice VMs only have private IPs, so GitHub cannot reach them. A **self-hosted runner**
on the app VM pulls deployment jobs from GitHub (outbound HTTPS only, no open ports).
Images are **built on GitHub**, never on the VMs; the VMs only download the layers that changed.

```
push develop (backend) / master (frontend)
  ├─ GitHub-hosted: typecheck + tests + build                  (also on every PR)
  └─ GitHub-hosted: build images (layer cache) → GHCR, tagged with the commit SHA
       └─ both OK → self-hosted runner on app VM:
            backend repo  → deploy-backend.sh: pull api + worker from GHCR, restart api (migrations),
                            push worker to the app's registry (127.0.0.1:5000), backend VM pulls it
                            through an SSH reverse tunnel (it has no internet), restart worker
            frontend repo → pull frontend from GHCR, restart it (VITE_* applied at container start)
```

- Deploys on the app VM take a host lock (`/tmp/kronos-deploy.lock`): one at a time, across both repos.
- GHCR credentials are the job's temporary `GITHUB_TOKEN`, kept in a per-job `DOCKER_CONFIG` that is
  deleted afterwards: no registry secret is stored anywhere.
- The internal registry (`kronos-registry` container, volume `kronos-registry`) listens only on the
  app VM's loopback; the backend VM reaches it only during the pull, via `ssh -R`.
- The frontend image is environment-agnostic: it is built with `__VITE_*__` placeholders that the
  container replaces at start with the `VITE_*` values of `deploy/vm-app-http/.env`.
- Each deploy keeps only the current commit's images on the VMs; any older one can be pulled from GHCR.

## Security
- Deploy jobs run only for `push`/`workflow_dispatch` on the main branch, never for pull requests.
- Repositories are private; GHCR packages published by a repo's workflow are private and readable
  by that repo's workflows only.
- The runner runs as `ubuntu` (docker group, no sudo); secrets stay in the `.env` files on the VMs.

## One-time setup on the app VM
1. Internal SSH key app → backend/data: `~/.ssh/kronos_internal` (its public key in
   `~/.ssh/authorized_keys` of backend and data).
2. Configuration: `~/kronos/SmartConcreteBackend/deploy/vm-app-http/.env` (app) and, on the backend
   VM, `~/kronos/SmartConcreteBackend/deploy/vm-worker/.env`. Each deploy installs the matching
   `docker-compose.yml` next to them.
3. Docker with the compose and buildx plugins (`sudo apt-get install -y docker-compose-v2 docker-buildx`).
4. One runner per repository. In GitHub: *Settings → Actions → Runners → New self-hosted runner →
   Linux x64*, copy the registration token, then:

```bash
mkdir -p ~/actions-runner-backend && cd ~/actions-runner-backend
curl -fsSLo runner.tar.gz https://github.com/actions/runner/releases/download/v<VERSION>/actions-runner-linux-x64-<VERSION>.tar.gz
tar xzf runner.tar.gz
./config.sh --unattended --url https://github.com/<owner>/<backend-repo> --token <TOKEN> --name app --work _work
sudo ./svc.sh install ubuntu && sudo ./svc.sh start
```
   Repeat in `~/actions-runner-frontend` for the frontend repository.
   Use the exact version/URL GitHub shows on the "New self-hosted runner" page.

## Manual deploy / rollback
- Re-run a workflow from the Actions tab, or *Run workflow* (workflow_dispatch).
- Roll back: re-run the deploy job of an older successful run; its image is still in GHCR, so it
  only downloads and restarts (no rebuild).
