# infra/github

The delivery pipelines live in [.github/workflows](../../.github/workflows). Reusable parts are prefixed with an underscore.

| Workflow                                               | Trigger                  | What it does                                                                                              |
| ------------------------------------------------------ | ------------------------ | --------------------------------------------------------------------------------------------------------- |
| [pr.yml](../../.github/workflows/pr.yml)               | pull request             | `_verify` + image build and scan                                                                          |
| [main.yml](../../.github/workflows/main.yml)           | push to `main`           | `_verify`, e2e, images, `_publish` → `_migrate` → `_deploy` to dev (when `DEPLOY_ENABLED`)                 |
| [release.yml](../../.github/workflows/release.yml)     | tag `v*`                 | staging, e2e + k6 + DAST, manual approval, prod expand-only migrate, blue/green deploy with canary         |
| [security.yml](../../.github/workflows/security.yml)   | PR, `main`, weekly       | dependency review, `pnpm audit`, Trivy (source, secrets, IaC), Gitleaks, CodeQL                           |
| [terraform.yml](../../.github/workflows/terraform.yml) | infra changes            | fmt, tflint, offline validate and plan for every environment                                              |
| [nightly.yml](../../.github/workflows/nightly.yml)     | 03:00 AEST               | k6 F10 profile against staging                                                                            |
| `_verify.yml`                                          | called                   | lint, typecheck, unit, golden, integration, cross-tenant, Storybook                                       |
| `_images.yml`                                          | called                   | build api, worker, payments and migrate from `infra/docker/Dockerfile`; Trivy gate; push to GHCR           |
| `_publish.yml`                                         | called                   | copy the built digest into an environment's ECR                                                           |
| `_migrate.yml`                                         | called                   | run `pnpm --filter @pos/db migrate` against an environment as a Fargate task; expand-only guard for prod   |
| `_deploy.yml`                                          | called                   | worker and payments rolling, api blue/green with canary, SLO watch, smoke                                 |

[renovate.json5](../../.github/renovate.json5) keeps dependencies, actions (pinned by digest), Terraform providers and the pinned container images current.
Scripts the workflows call are in [infra/scripts](../scripts); how to operate it all is in [docs/runbooks](../../docs/runbooks).
