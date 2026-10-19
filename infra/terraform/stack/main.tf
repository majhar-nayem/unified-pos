data "aws_region" "current" {}

locals {
  name   = "pos-${var.environment}"
  region = data.aws_region.current.name
  tags   = { Project = "pos-platform", Environment = var.environment, ManagedBy = "terraform" }

  alerts_doc = jsondecode(file("${path.module}/${var.alerts_file}"))

  api_port         = 3000
  otlp_endpoint    = "http://otel.${module.cluster.namespace_name}:4318"
  payments_url     = "http://payments.${module.cluster.namespace_name}:${var.payments_port}"
  image_repository = module.ecr.repository_urls

  # Service name → minimum running tasks, used by the alarms.
  alarm_services = {
    api            = var.sizing.api.min
    worker         = var.sizing.worker.min
    payments       = var.sizing.payments.min
    otel-collector = 2
  }

  common_env = {
    NODE_ENV                    = "production"
    AWS_REGION                  = local.region
    DEPLOYMENT_ENVIRONMENT      = var.environment
    OTEL_EXPORTER_OTLP_ENDPOINT = local.otlp_endpoint
    OTEL_EXPORTER_OTLP_PROTOCOL = "http/protobuf"
    # Preload: registers the ESM loader hook and starts OpenTelemetry before the app modules load.
    NODE_OPTIONS = "--import @pos/observability/register"
  }
}

# --- keys and secrets ------------------------------------------------------------------------------

module "kms" {
  source     = "../modules/kms"
  name       = local.name
  account_id = var.account_id
  keys = {
    data     = "${local.name}: Aurora, Redis, S3 and ECR encryption"
    secrets  = "${local.name}: shared application secrets (api, worker, collector)"
    payments = "${local.name}: payments-only secrets; api and worker roles cannot decrypt"
    logs     = "${local.name}: CloudWatch Logs and SNS"
  }
  deletion_window_in_days = var.protect ? 30 : 7
  tags                    = local.tags
}

# Values are set out of band (docs/runbooks/deploy.md); Terraform only creates the containers.
module "secrets" {
  source = "../modules/secrets"
  secrets = {
    "${local.name}/auth" = {
      description = "AUTH_JWT_KID, AUTH_JWT_PRIVATE_KEY, AUTH_JWT_PUBLIC_JWKS, AUTH_SECRETS_KEY (pnpm --filter @pos/api auth:keygen)"
      kms_key_arn = module.kms.key_arns["secrets"]
    }
    "${local.name}/operator" = {
      description = "AUTH_OPERATOR_TOKENS for tenant provisioning (until an operator IdP exists)"
      kms_key_arn = module.kms.key_arns["secrets"]
    }
    "${local.name}/api/database" = {
      description = "JSON keys DATABASE_URL and password for the api (application role app_rw, NOSUPERUSER NOBYPASSRLS)"
      kms_key_arn = module.kms.key_arns["secrets"]
    }
    "${local.name}/worker/database" = {
      description = "DATABASE_URL for the worker (application role)"
      kms_key_arn = module.kms.key_arns["secrets"]
    }
    "${local.name}/migrate/database" = {
      description = "DATABASE_URL for migrations (master or a BYPASSRLS migration role)"
      kms_key_arn = module.kms.key_arns["secrets"]
    }
    "${local.name}/observability/backend" = {
      description = "OTLP/HTTP backend: JSON keys endpoint, auth_header"
      kms_key_arn = module.kms.key_arns["secrets"]
    }
    "${local.name}/payments/database" = {
      description = "DATABASE_URL for payments (its own database role)"
      kms_key_arn = module.kms.key_arns["payments"]
    }
    "${local.name}/payments/provider" = {
      description = "Payment provider credentials and webhook signing secrets (JSON)"
      kms_key_arn = module.kms.key_arns["payments"]
    }
  }
  recovery_window_in_days = var.protect ? 30 : 7
  tags                    = local.tags
}

# --- network, data, storage ------------------------------------------------------------------------

module "network" {
  source             = "../modules/network"
  name               = local.name
  cidr               = var.vpc_cidr
  availability_zones = var.availability_zones
  single_nat_gateway = var.single_nat_gateway
  kms_key_arn        = module.kms.key_arns["logs"]
  tags               = local.tags
}

module "storage" {
  source                       = "../modules/storage"
  name                         = local.name
  account_id                   = var.account_id
  kms_key_arn                  = module.kms.key_arns["data"]
  audit_anchor_retention_years = var.protect ? 7 : 1
  force_destroy                = !var.protect
  tags                         = local.tags
}

module "ecr" {
  source      = "../modules/ecr"
  name        = local.name
  kms_key_arn = module.kms.key_arns["data"]
  tags        = local.tags
}

module "aurora" {
  source                     = "../modules/aurora"
  name                       = local.name
  vpc_id                     = module.network.vpc_id
  subnet_ids                 = module.network.isolated_subnet_ids
  allowed_security_group_ids = [module.api.security_group_id, module.worker.security_group_id, module.payments.security_group_id, module.migrate.security_group_id]
  instance_class             = var.aurora.instance_class
  reader_count               = var.aurora.reader_count
  backup_retention_days      = var.aurora.backup_retention_days
  deletion_protection        = var.protect
  skip_final_snapshot        = !var.protect
  kms_key_arn                = module.kms.key_arns["data"]
  tags                       = local.tags
}

module "redis" {
  source                     = "../modules/redis"
  name                       = local.name
  vpc_id                     = module.network.vpc_id
  subnet_ids                 = module.network.isolated_subnet_ids
  allowed_security_group_ids = [module.api.security_group_id, module.worker.security_group_id]
  node_type                  = var.redis.node_type
  num_cache_clusters         = var.redis.num_cache_clusters
  kms_key_arn                = module.kms.key_arns["data"]
  secret_kms_key_arn         = module.kms.key_arns["secrets"]
  tags                       = local.tags
}

# --- edge ------------------------------------------------------------------------------------------

module "edge" {
  source = "../modules/edge"
  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  name                       = local.name
  vpc_id                     = module.network.vpc_id
  vpc_cidr                   = module.network.vpc_cidr
  public_subnet_ids          = module.network.public_subnet_ids
  alb_logs_bucket            = module.storage.alb_logs_bucket
  certificate_arn            = var.alb_certificate_arn
  cloudfront_prefix_list_id  = var.cloudfront_prefix_list_id
  origin_domain_name         = var.origin_domain_name
  domain_names               = var.domain_names
  cloudfront_certificate_arn = var.cloudfront_certificate_arn
  api_port                   = local.api_port
  payments_port              = var.payments_port
  deletion_protection        = var.protect
  tags                       = local.tags
}

# --- compute ---------------------------------------------------------------------------------------

module "cluster" {
  source      = "../modules/ecs-cluster"
  name        = local.name
  vpc_id      = module.network.vpc_id
  kms_key_arn = module.kms.key_arns["logs"]
  tags        = local.tags
}

data "aws_iam_policy_document" "s3_app" {
  statement {
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${module.storage.bucket_arns["receipts"]}/*", "${module.storage.bucket_arns["exports"]}/*"]
  }
  statement {
    actions   = ["s3:ListBucket"]
    resources = [module.storage.bucket_arns["receipts"], module.storage.bucket_arns["exports"]]
  }
  statement {
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [module.kms.key_arns["data"]]
  }
}

# The worker additionally writes audit-chain anchors (write and read, never delete).
data "aws_iam_policy_document" "worker_task" {
  source_policy_documents = [data.aws_iam_policy_document.s3_app.json]
  statement {
    actions   = ["s3:PutObject", "s3:GetObject", "s3:GetObjectRetention"]
    resources = ["${module.storage.bucket_arns["audit_anchors"]}/*"]
  }
  statement {
    actions   = ["s3:ListBucket"]
    resources = [module.storage.bucket_arns["audit_anchors"]]
  }
}

module "api" {
  source = "../modules/ecs-service"

  name                  = local.name
  service_name          = "api"
  cluster_arn           = module.cluster.cluster_arn
  cluster_name          = module.cluster.cluster_name
  vpc_id                = module.network.vpc_id
  subnet_ids            = module.network.private_subnet_ids
  image                 = "${local.image_repository["api"]}:${var.image_tag}"
  cpu                   = var.sizing.api.cpu
  memory                = var.sizing.api.memory
  desired_count         = var.sizing.api.desired
  min_count             = var.sizing.api.min
  max_count             = var.sizing.api.max
  container_port        = local.api_port
  enable_load_balancer  = true
  target_group_arn      = module.edge.api_target_group_arns["blue"]
  alb_security_group_id = module.edge.alb_security_group_id
  health_check_command  = ["CMD-SHELL", "wget -qO- http://localhost:${local.api_port}/v1/health >/dev/null || exit 1"]
  kms_key_arn           = module.kms.key_arns["logs"]
  secret_kms_key_arns   = [module.kms.key_arns["secrets"]]
  attach_task_policy    = true
  task_policy_json      = data.aws_iam_policy_document.s3_app.json

  environment = merge(local.common_env, {
    PORT               = tostring(local.api_port)
    OTEL_SERVICE_NAME  = "api"
    PAYMENTS_BASE_URL  = local.payments_url
    S3_RECEIPTS_BUCKET = module.storage.receipts_bucket
    S3_EXPORTS_BUCKET  = module.storage.exports_bucket
    RATE_LIMIT_ENABLED = "true"
    }, length(var.domain_names) > 0 ? {
    AUTH_WEBAUTHN_RP_ID   = var.domain_names[0]
    AUTH_WEBAUTHN_ORIGINS = "https://${var.domain_names[0]}"
  } : {})
  secrets = {
    DATABASE_URL         = "${module.secrets.arns["${local.name}/api/database"]}:DATABASE_URL::"
    REDIS_URL            = "${module.redis.secret_arn}:REDIS_URL::"
    AUTH_JWT_KID         = "${module.secrets.arns["${local.name}/auth"]}:AUTH_JWT_KID::"
    AUTH_JWT_PRIVATE_KEY = "${module.secrets.arns["${local.name}/auth"]}:AUTH_JWT_PRIVATE_KEY::"
    AUTH_JWT_PUBLIC_JWKS = "${module.secrets.arns["${local.name}/auth"]}:AUTH_JWT_PUBLIC_JWKS::"
    AUTH_SECRETS_KEY     = "${module.secrets.arns["${local.name}/auth"]}:AUTH_SECRETS_KEY::"
    AUTH_OPERATOR_TOKENS = "${module.secrets.arns["${local.name}/operator"]}:AUTH_OPERATOR_TOKENS::"
  }

  # Blue/green through CodeDeploy: 10 % canary, 30 minute SLO watch, then 100 % (plan §10).
  blue_green              = true
  blue_target_group_name  = module.edge.api_target_group_names["blue"]
  green_target_group_name = module.edge.api_target_group_names["green"]
  listener_arn            = module.edge.listener_arn
  canary_percentage       = 10
  canary_interval_minutes = var.canary_interval_minutes
  rollback_alarm_names    = module.alarms.rollback_alarm_names
  tags                    = local.tags
}

module "worker" {
  source = "../modules/ecs-service"

  name                = local.name
  service_name        = "worker"
  cluster_arn         = module.cluster.cluster_arn
  cluster_name        = module.cluster.cluster_name
  vpc_id              = module.network.vpc_id
  subnet_ids          = module.network.private_subnet_ids
  image               = "${local.image_repository["worker"]}:${var.image_tag}"
  cpu                 = var.sizing.worker.cpu
  memory              = var.sizing.worker.memory
  desired_count       = var.sizing.worker.desired
  min_count           = var.sizing.worker.min
  max_count           = var.sizing.worker.max
  kms_key_arn         = module.kms.key_arns["logs"]
  secret_kms_key_arns = [module.kms.key_arns["secrets"]]
  attach_task_policy  = true
  task_policy_json    = data.aws_iam_policy_document.worker_task.json

  environment = merge(local.common_env, {
    OTEL_SERVICE_NAME   = "worker"
    S3_RECEIPTS_BUCKET  = module.storage.receipts_bucket
    S3_EXPORTS_BUCKET   = module.storage.exports_bucket
    AUDIT_ANCHOR_BUCKET = module.storage.audit_anchors_bucket
  })
  secrets = {
    DATABASE_URL = "${module.secrets.arns["${local.name}/worker/database"]}:DATABASE_URL::"
    REDIS_URL    = "${module.redis.secret_arn}:REDIS_URL::"
  }
  tags = local.tags
}

# Payments: its own task role (no S3, no shared secrets), its own KMS key, its own database role.
module "payments" {
  source = "../modules/ecs-service"

  name                           = local.name
  service_name                   = "payments"
  cluster_arn                    = module.cluster.cluster_arn
  cluster_name                   = module.cluster.cluster_name
  vpc_id                         = module.network.vpc_id
  subnet_ids                     = module.network.private_subnet_ids
  image                          = "${local.image_repository["payments"]}:${var.image_tag}"
  cpu                            = var.sizing.payments.cpu
  memory                         = var.sizing.payments.memory
  desired_count                  = var.sizing.payments.desired
  min_count                      = var.sizing.payments.min
  max_count                      = var.sizing.payments.max
  container_port                 = var.payments_port
  enable_load_balancer           = true
  target_group_arn               = module.edge.payments_target_group_arn
  alb_security_group_id          = module.edge.alb_security_group_id
  ingress_security_group_ids     = [module.api.security_group_id]
  health_check_command           = ["CMD-SHELL", "wget -qO- http://localhost:${var.payments_port}/v1/health >/dev/null || exit 1"]
  service_discovery_namespace_id = module.cluster.namespace_id
  service_discovery_name         = "payments"
  kms_key_arn                    = module.kms.key_arns["logs"]
  secret_kms_key_arns            = [module.kms.key_arns["payments"]]

  environment = merge(local.common_env, {
    PORT              = tostring(var.payments_port)
    OTEL_SERVICE_NAME = "payments"
  })
  secrets = {
    DATABASE_URL         = "${module.secrets.arns["${local.name}/payments/database"]}:DATABASE_URL::"
    PAYMENT_PROVIDER_CFG = "${module.secrets.arns["${local.name}/payments/provider"]}:config::"
    WEBHOOK_SIGNING_KEYS = "${module.secrets.arns["${local.name}/payments/provider"]}:webhook_signing_keys::"
  }
  tags = local.tags
}

# One-off task definition for `pnpm --filter @pos/db migrate`; run from CI with ecs run-task.
module "migrate" {
  source = "../modules/ecs-service"

  name                = local.name
  service_name        = "migrate"
  create_service      = false
  cluster_arn         = module.cluster.cluster_arn
  cluster_name        = module.cluster.cluster_name
  vpc_id              = module.network.vpc_id
  subnet_ids          = module.network.private_subnet_ids
  image               = "${local.image_repository["migrate"]}:${var.image_tag}"
  cpu                 = 512
  memory              = 1024
  kms_key_arn         = module.kms.key_arns["logs"]
  secret_kms_key_arns = [module.kms.key_arns["secrets"]]
  # Also runs `pnpm --filter @pos/db grants` (command override) to create or refresh the application role;
  # the role password comes from the api database secret, never from the run-task call (CloudTrail records it).
  environment = { NODE_ENV = "production", APP_DB_ROLE = "app_rw" }
  secrets = {
    DATABASE_URL    = "${module.secrets.arns["${local.name}/migrate/database"]}:DATABASE_URL::"
    APP_DB_PASSWORD = "${module.secrets.arns["${local.name}/api/database"]}:password::"
  }
  tags = local.tags
}

module "otel_collector" {
  source = "../modules/otel-collector"

  name                      = local.name
  environment               = var.environment
  cluster_arn               = module.cluster.cluster_arn
  cluster_name              = module.cluster.cluster_name
  vpc_id                    = module.network.vpc_id
  subnet_ids                = module.network.private_subnet_ids
  namespace_id              = module.cluster.namespace_id
  kms_key_arn               = module.kms.key_arns["logs"]
  secret_kms_key_arns       = [module.kms.key_arns["secrets"]]
  backend_secret_arn        = module.secrets.arns["${local.name}/observability/backend"]
  client_security_group_ids = [module.api.security_group_id, module.worker.security_group_id, module.payments.security_group_id]
  tags                      = local.tags
}

# --- alarms ----------------------------------------------------------------------------------------

module "alarms" {
  source = "../modules/alarms"

  name                          = local.name
  kms_key_arn                   = module.kms.key_arns["logs"]
  page_endpoints                = var.page_endpoints
  ticket_endpoints              = var.ticket_endpoints
  alb_arn_suffix                = module.edge.alb_arn_suffix
  api_target_group_arn_suffixes = module.edge.api_target_group_arn_suffixes
  cluster_name                  = module.cluster.cluster_name
  services                      = local.alarm_services
  aurora_cluster_identifier     = module.aurora.cluster_identifier
  redis_node_ids                = [for i in range(var.redis.num_cache_clusters) : format("%s-%03d", local.name, i + 1)]
  app_alerts                    = local.alerts_doc.alerts
  app_composites                = local.alerts_doc.composites
  tags                          = local.tags
}

# --- GitHub OIDC deploy role -----------------------------------------------------------------------

module "github_oidc" {
  source = "../modules/github-oidc"

  name                  = local.name
  account_id            = var.account_id
  region                = local.region
  github_repository     = var.github_repository
  github_environment    = var.environment
  create_provider       = var.github_create_oidc_provider
  existing_provider_arn = var.github_existing_oidc_provider_arn
  ecr_repository_arns   = values(module.ecr.repository_arns)
  cluster_name          = module.cluster.cluster_name
  pass_role_arns = [
    module.api.task_role_arn, module.api.execution_role_arn,
    module.worker.task_role_arn, module.worker.execution_role_arn,
    module.payments.task_role_arn, module.payments.execution_role_arn,
    module.migrate.task_role_arn, module.migrate.execution_role_arn,
    module.otel_collector.task_role_arn,
  ]
  state_bucket_arn = var.state_bucket_arn
  tags             = local.tags
}
