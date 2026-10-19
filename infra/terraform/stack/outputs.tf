output "deploy_role_arn" {
  description = "Set as the AWS_DEPLOY_ROLE_ARN variable of the GitHub Environment"
  value       = module.github_oidc.deploy_role_arn
}

output "plan_role_arn" {
  value = module.github_oidc.plan_role_arn
}

output "cluster_name" {
  value = module.cluster.cluster_name
}

output "ecr_repository_urls" {
  value = module.ecr.repository_urls
}

output "services" {
  description = "Names CI deploys to"
  value = {
    api      = module.api.service_name
    worker   = module.worker.service_name
    payments = module.payments.service_name
  }
}

output "task_definition_families" {
  value = {
    api      = module.api.task_definition_family
    worker   = module.worker.task_definition_family
    payments = module.payments.task_definition_family
    migrate  = module.migrate.task_definition_family
  }
}

output "api_codedeploy" {
  value = {
    application      = module.api.codedeploy_app_name
    deployment_group = module.api.codedeploy_deployment_group_name
  }
}

output "migrate_network" {
  description = "awsvpc configuration for `ecs run-task` of the migration task"
  value = {
    subnets         = module.network.private_subnet_ids
    security_groups = [module.migrate.security_group_id]
  }
}

output "cloudfront_domain_name" {
  value = module.edge.cloudfront_domain_name
}

output "alb_dns_name" {
  value = module.edge.alb_dns_name
}

output "aurora_writer_endpoint" {
  value = module.aurora.writer_endpoint
}

output "aurora_reader_endpoint" {
  value = module.aurora.reader_endpoint
}

output "aurora_master_secret_arn" {
  value = module.aurora.master_user_secret_arn
}

output "secret_arns" {
  value = module.secrets.arns
}

output "audit_anchors_bucket" {
  value = module.storage.audit_anchors_bucket
}

output "alarm_topics" {
  value = {
    page   = module.alarms.page_topic_arn
    ticket = module.alarms.ticket_topic_arn
  }
}
