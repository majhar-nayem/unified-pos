# Environment: prod-au (docs/03-implementation-plan.md §10). Composition lives in ../../stack.

provider "aws" {
  region = "ap-southeast-2"

  # Placeholder plans run without credentials (see placeholder.tfvars).
  access_key                  = var.offline_plan ? "placeholder" : null
  secret_key                  = var.offline_plan ? "placeholder" : null
  skip_credentials_validation = var.offline_plan
  skip_requesting_account_id  = var.offline_plan
  skip_metadata_api_check     = var.offline_plan
  skip_region_validation      = var.offline_plan
}

provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  access_key                  = var.offline_plan ? "placeholder" : null
  secret_key                  = var.offline_plan ? "placeholder" : null
  skip_credentials_validation = var.offline_plan
  skip_requesting_account_id  = var.offline_plan
  skip_metadata_api_check     = var.offline_plan
  skip_region_validation      = var.offline_plan
}

module "stack" {
  source = "../../stack"
  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  environment        = "prod-au"
  account_id         = var.account_id
  availability_zones = ["ap-southeast-2a", "ap-southeast-2b", "ap-southeast-2c"]
  vpc_cidr           = "10.30.0.0/16"
  single_nat_gateway = false
  protect            = true

  aurora = {
    instance_class        = "db.r6g.xlarge"
    reader_count          = 2
    backup_retention_days = 35
  }
  redis = {
    node_type          = "cache.r7g.large"
    num_cache_clusters = 3
  }
  sizing = {
    api      = { cpu = 1024, memory = 2048, desired = 4, min = 4, max = 40 }
    worker   = { cpu = 1024, memory = 2048, desired = 2, min = 2, max = 10 }
    payments = { cpu = 512, memory = 1024, desired = 3, min = 3, max = 10 }
  }

  canary_interval_minutes           = 30
  image_tag                         = var.image_tag
  github_repository                 = var.github_repository
  github_create_oidc_provider       = var.github_create_oidc_provider
  github_existing_oidc_provider_arn = var.github_existing_oidc_provider_arn
  alb_certificate_arn               = var.alb_certificate_arn
  cloudfront_prefix_list_id         = var.cloudfront_prefix_list_id
  origin_domain_name                = var.origin_domain_name
  domain_names                      = var.domain_names
  cloudfront_certificate_arn        = var.cloudfront_certificate_arn
  page_endpoints                    = var.page_endpoints
  ticket_endpoints                  = var.ticket_endpoints
  state_bucket_arn                  = var.state_bucket_arn
}

output "deploy_role_arn" {
  value = module.stack.deploy_role_arn
}

output "plan_role_arn" {
  value = module.stack.plan_role_arn
}

output "cluster_name" {
  value = module.stack.cluster_name
}

output "ecr_repository_urls" {
  value = module.stack.ecr_repository_urls
}

output "services" {
  value = module.stack.services
}

output "task_definition_families" {
  value = module.stack.task_definition_families
}

output "api_codedeploy" {
  value = module.stack.api_codedeploy
}

output "migrate_network" {
  value = module.stack.migrate_network
}

output "cloudfront_domain_name" {
  value = module.stack.cloudfront_domain_name
}

output "secret_arns" {
  value = module.stack.secret_arns
}

output "aurora_writer_endpoint" {
  value = module.stack.aurora_writer_endpoint
}

output "alarm_topics" {
  value = module.stack.alarm_topics
}
