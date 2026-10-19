# Placeholder values for an offline plan. No real credentials, account ids or certificates.
#   terraform init -backend=false && terraform plan -var-file=placeholder.tfvars -out=tfplan
offline_plan              = true
account_id                = "111111111111"
github_repository         = "example-org/unified-pos"
alb_certificate_arn       = "arn:aws:acm:ap-southeast-2:111111111111:certificate/00000000-0000-0000-0000-000000000000"
cloudfront_prefix_list_id = "pl-00000000"
domain_names              = []
page_endpoints            = []
ticket_endpoints          = []
