# Run once per AWS account with an administrator profile, then migrate each environment to the bucket.
# One bucket holds the state of every environment in the account (keys: <env>/terraform.tfstate).

provider "aws" {
  region = "ap-southeast-2"
}

variable "account_id" {
  description = "AWS account id (bucket names are globally unique)"
  type        = string
}

variable "environments" {
  description = "Environment names that live in this account (used in bucket naming only)"
  type        = list(string)
  default     = ["dev"]
}

resource "aws_s3_bucket" "state" {
  bucket = "pos-tfstate-${var.account_id}"
  tags   = { Project = "pos-platform", ManagedBy = "terraform", Environments = join(",", var.environments) }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

data "aws_iam_policy_document" "tls_only" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]
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

resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id
  policy = data.aws_iam_policy_document.tls_only.json
}

output "state_bucket" {
  value = aws_s3_bucket.state.id
}

output "state_bucket_arn" {
  value = aws_s3_bucket.state.arn
}
