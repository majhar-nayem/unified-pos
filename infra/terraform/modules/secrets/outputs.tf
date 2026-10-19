output "arns" {
  description = "secret name → ARN"
  value       = { for k, v in aws_secretsmanager_secret.this : k => v.arn }
}
