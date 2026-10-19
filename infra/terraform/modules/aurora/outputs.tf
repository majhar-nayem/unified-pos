output "cluster_identifier" {
  value = aws_rds_cluster.this.cluster_identifier
}

output "cluster_arn" {
  value = aws_rds_cluster.this.arn
}

output "writer_endpoint" {
  value = aws_rds_cluster.this.endpoint
}

output "reader_endpoint" {
  value = aws_rds_cluster.this.reader_endpoint
}

output "port" {
  value = aws_rds_cluster.this.port
}

output "database_name" {
  value = aws_rds_cluster.this.database_name
}

output "master_user_secret_arn" {
  description = "Secrets Manager secret managed by RDS ({username,password})"
  value       = one(aws_rds_cluster.this.master_user_secret).secret_arn
}

output "security_group_id" {
  value = aws_security_group.this.id
}

output "instance_identifiers" {
  value = aws_rds_cluster_instance.this[*].identifier
}
