output "receipts_bucket" {
  value = aws_s3_bucket.data["receipts"].id
}

output "exports_bucket" {
  value = aws_s3_bucket.data["exports"].id
}

output "audit_anchors_bucket" {
  value = aws_s3_bucket.audit_anchors.id
}

output "alb_logs_bucket" {
  value = aws_s3_bucket.alb_logs.id
}

output "bucket_arns" {
  value = {
    receipts      = aws_s3_bucket.data["receipts"].arn
    exports       = aws_s3_bucket.data["exports"].arn
    audit_anchors = aws_s3_bucket.audit_anchors.arn
  }
}
