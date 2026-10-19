output "primary_endpoint" {
  value = aws_elasticache_replication_group.this.primary_endpoint_address
}

output "reader_endpoint" {
  value = aws_elasticache_replication_group.this.reader_endpoint_address
}

output "replication_group_id" {
  value = aws_elasticache_replication_group.this.id
}

output "security_group_id" {
  value = aws_security_group.this.id
}

output "secret_arn" {
  description = "Secret with keys auth_token, REDIS_URL, reader_url"
  value       = aws_secretsmanager_secret.this.arn
}
