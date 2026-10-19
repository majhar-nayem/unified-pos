locals {
  buckets = {
    receipts = { expiration_days = var.receipts_expiration_days }
    exports  = { expiration_days = var.exports_expiration_days }
  }
}

# --- receipts / exports: versioned, SSE-KMS, private, TLS-only ------------------------------------

resource "aws_s3_bucket" "data" {
  for_each      = local.buckets
  bucket        = "${var.name}-${each.key}-${var.account_id}"
  force_destroy = var.force_destroy
  tags          = merge(var.tags, { Purpose = each.key })
}

resource "aws_s3_bucket_versioning" "data" {
  for_each = aws_s3_bucket.data
  bucket   = each.value.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "data" {
  for_each = aws_s3_bucket.data
  bucket   = each.value.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "data" {
  for_each                = aws_s3_bucket.data
  bucket                  = each.value.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "data" {
  for_each = aws_s3_bucket.data
  bucket   = each.value.id

  rule {
    id     = "tiering"
    status = "Enabled"
    filter {}
    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  dynamic "rule" {
    for_each = local.buckets[each.key].expiration_days > 0 ? [1] : []
    content {
      id     = "expire"
      status = "Enabled"
      filter {}
      expiration {
        days = local.buckets[each.key].expiration_days
      }
    }
  }
}

data "aws_iam_policy_document" "tls_only" {
  for_each = aws_s3_bucket.data
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [each.value.arn, "${each.value.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "data" {
  for_each = aws_s3_bucket.data
  bucket   = each.value.id
  policy   = data.aws_iam_policy_document.tls_only[each.key].json
}

# --- audit anchors: Object Lock COMPLIANCE (docs/01 §11, §13) --------------------------------------

resource "aws_s3_bucket" "audit_anchors" {
  bucket              = "${var.name}-audit-anchors-${var.account_id}"
  object_lock_enabled = true
  tags                = merge(var.tags, { Purpose = "audit-anchors" })
}

resource "aws_s3_bucket_versioning" "audit_anchors" {
  bucket = aws_s3_bucket.audit_anchors.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_object_lock_configuration" "audit_anchors" {
  bucket = aws_s3_bucket.audit_anchors.id
  rule {
    default_retention {
      mode  = "COMPLIANCE"
      years = var.audit_anchor_retention_years
    }
  }
  depends_on = [aws_s3_bucket_versioning.audit_anchors]
}

resource "aws_s3_bucket_server_side_encryption_configuration" "audit_anchors" {
  bucket = aws_s3_bucket.audit_anchors.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "audit_anchors" {
  bucket                  = aws_s3_bucket.audit_anchors.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

data "aws_iam_policy_document" "audit_anchors" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.audit_anchors.arn, "${aws_s3_bucket.audit_anchors.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
  # Nobody shortens a retention period or deletes a locked version, not even root.
  statement {
    sid       = "DenyRetentionTampering"
    effect    = "Deny"
    actions   = ["s3:BypassGovernanceRetention", "s3:PutBucketObjectLockConfiguration", "s3:DeleteBucket"]
    resources = [aws_s3_bucket.audit_anchors.arn, "${aws_s3_bucket.audit_anchors.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
  }
}

resource "aws_s3_bucket_policy" "audit_anchors" {
  bucket = aws_s3_bucket.audit_anchors.id
  policy = data.aws_iam_policy_document.audit_anchors.json
}

# --- ALB access logs (SSE-S3: ELB log delivery does not support SSE-KMS) ----------------------------

resource "aws_s3_bucket" "alb_logs" {
  bucket        = "${var.name}-alb-logs-${var.account_id}"
  force_destroy = var.force_destroy
  tags          = merge(var.tags, { Purpose = "alb-logs" })
}

resource "aws_s3_bucket_server_side_encryption_configuration" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "alb_logs" {
  bucket                  = aws_s3_bucket.alb_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id
  rule {
    id     = "expire"
    status = "Enabled"
    filter {}
    expiration {
      days = 90
    }
  }
}

data "aws_iam_policy_document" "alb_logs" {
  statement {
    sid       = "ElbLogDelivery"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.alb_logs.arn}/*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.elb_account_id}:root"]
    }
  }
}

resource "aws_s3_bucket_policy" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id
  policy = data.aws_iam_policy_document.alb_logs.json
}
