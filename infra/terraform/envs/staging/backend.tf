# State lives in the bucket created by ../../bootstrap. Use `terraform init -backend=false` for
# offline validation and the placeholder plan.
terraform {
  backend "s3" {
    bucket       = "REPLACE-pos-tfstate-staging"
    key          = "staging/terraform.tfstate"
    region       = "ap-southeast-2"
    encrypt      = true
    use_lockfile = true
  }
}
