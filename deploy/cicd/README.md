# CI/CD (GitHub Actions + self-hosted runner on the app VM)

The slice VMs only have private IPs, so GitHub cannot reach them. Instead a **self-hosted runner**
on the app VM pulls deployment jobs from GitHub (outbound HTTPS only, no open ports).

```
push develop (backend) / master (frontend)
  └─ GitHub-hosted runner: typecheck + tests + build      (also on every PR)
       └─ if OK and it is a push: self-hosted runner on app VM
            backend repo  → deploy-backend.sh: build api + worker, restart api (migrations),
                            ship worker image to backend VM over the internal network, restart it
            frontend repo → rebuild + restart the frontend container
```

## Security (public repositories)
- Deploy jobs run only for `push`/`workflow_dispatch` on the main branch, never for pull requests.
- In each repo: *Settings → Actions → General → Fork pull request workflows*: **Require approval for all
  outside collaborators** (or make the repositories private — recommended).
- The runner runs as `ubuntu` (docker group, no sudo); secrets stay in the `.env` files on the VMs.

## One-time setup on the app VM
1. Internal SSH key app → backend/data: `~/.ssh/kronos_internal` (its public key in
   `~/.ssh/authorized_keys` of backend and data).
2. Stable checkouts: `~/kronos/SmartConcreteBackend` and `~/kronos/KronosFrontend`, with
   `deploy/vm-app-http/.env` (app) and `deploy/vm-worker/.env` (backend VM) already filled in.
3. One runner per repository (labels `self-hosted,kronos-app`). In GitHub:
   *Settings → Actions → Runners → New self-hosted runner → Linux x64*, copy the registration token, then:

```bash
mkdir -p ~/actions-runner-backend && cd ~/actions-runner-backend
curl -fsSLo runner.tar.gz https://github.com/actions/runner/releases/download/v<VERSION>/actions-runner-linux-x64-<VERSION>.tar.gz
tar xzf runner.tar.gz
./config.sh --unattended --url https://github.com/<owner>/SmartConcreteBackend --token <TOKEN> \
  --name kronos-app-backend --labels kronos-app --work _work
sudo ./svc.sh install ubuntu && sudo ./svc.sh start
```
   Repeat in `~/actions-runner-frontend` for `KronosFrontend` (`--name kronos-app-frontend`).
   Use the exact version/URL GitHub shows on the "New self-hosted runner" page.

## Manual deploy / rollback
- Re-run a workflow from the Actions tab, or *Run workflow* (workflow_dispatch).
- Roll back: re-run the deploy job of an older successful commit, or on the app VM
  `bash deploy/cicd/deploy-backend.sh <older-sha>`.
