# Runbook: DR restore drill (PITR)

Related: [deploy](deploy.md), [on-call](on-call.md). Targets from [architecture §12.1](../01-system-architecture.md): Phase 1 **RPO 5 min, RTO 4 h** (restore); Phase 3 RPO 5 min / RTO 1 h (warm
standby in a second region). Plan F10 requires a drill that restores from PITR. Run it in **staging**, quarterly and before the pilot, with a stopwatch.

## What is and is not covered today

| Failure                               | Recovery                                                            | Status                                                                                                                                                                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Instance or AZ loss                   | Aurora failover to the reader (about 30 s); devices queue and retry | Provisioned: writer plus reader in different AZs                                                                                                                                                                                       |
| Bad deploy, corrupted or deleted data | Point-in-time restore to a new cluster in the same region           | Provisioned: automated backups with PITR (7 days dev, 14 staging, 35 prod); this drill                                                                                                                                                 |
| Region loss                           | Restore from a cross-region snapshot copy                           | **Not provisioned.** No cross-region backup exists yet. Snapshot copies give an RPO of the copy interval, not 5 minutes; the 5 minute target for region loss needs the Phase 3 warm standby (Aurora Global Database). Decide before GA |
| Audit tampering                       | Compare the chain head with the Object Lock anchors in S3           | Anchor bucket provisioned (COMPLIANCE lock); the anchoring job is not built yet (F1 open item)                                                                                                                                         |

## Preconditions

- Staging is healthy and has realistic data (nightly k6 leaves synthetic tenants).
- AWS profile with `rds:*`, `ec2:Describe*`, `secretsmanager:GetSecretValue` on staging; someone to scribe times.
- Note the cluster identifier (`pos-staging`), subnet group, security group and KMS key from `terraform output` or the console.

## Steps

Record the clock time at the start of every step in the drill log below.

1. **Pick the restore point.** Choose a time inside the PITR window, for example 15 minutes ago, and write down the newest row you expect to see
   (`SELECT max(seq) FROM audit.audit_log` per tenant, or the last order number on a known test tenant).

   ```bash
   export AWS_REGION=ap-southeast-2 SRC=pos-staging DRILL=pos-staging-drill-$(date +%Y%m%d)
   aws rds describe-db-clusters --db-cluster-identifier $SRC \
     --query 'DBClusters[0].[LatestRestorableTime,EarliestRestorableTime,DBSubnetGroup,VpcSecurityGroups[0].VpcSecurityGroupId,KmsKeyId]'
   ```

2. **Restore to a new cluster** (never over the original):

   ```bash
   aws rds restore-db-cluster-to-point-in-time \
     --source-db-cluster-identifier $SRC --db-cluster-identifier $DRILL \
     --restore-type full-copy --restore-to-time "$(date -u -v-15M +%Y-%m-%dT%H:%M:%SZ)" \
     --db-subnet-group-name <subnet-group> --vpc-security-group-ids <aurora-sg> \
     --kms-key-id <data-key-arn> --enable-cloudwatch-logs-exports postgresql \
     --db-cluster-parameter-group-name pos-staging-aurora-pg16
   aws rds create-db-instance --db-instance-identifier $DRILL-writer --db-cluster-identifier $DRILL \
     --engine aurora-postgresql --db-instance-class db.r6g.large --db-subnet-group-name <subnet-group>
   aws rds wait db-instance-available --db-instance-identifier $DRILL-writer
   ```

   Use `--use-latest-restorable-time` instead of `--restore-to-time` to measure the best-case RPO.

3. **Reach it from inside the VPC.** The drill cluster shares the aurora security group, so run checks as a one-off ECS task with the migrate image and
   a `DATABASE_URL` for the drill endpoint (the master user's password is the source cluster's, restored with the data).
4. **Verify integrity** (all must pass; copy the output into the log):

   ```sql
   SELECT id FROM public.schema_migrations ORDER BY id;           -- same migrations as the source
   SELECT count(*) FROM platform.tenants;                          -- matches the source at the restore time
   SELECT tenant_id, max(seq) FROM audit.audit_log GROUP BY 1;     -- newest rows are the ones expected in step 1
   SELECT count(*) FROM audit.outbox_events WHERE published_at IS NULL;  -- unpublished events are replayed by the relay (at-least-once)
   ```

   Run the audit chain verification for each synthetic tenant (the API endpoint `POST /v1/audit/verify`, or `verifyAuditChain` from `@pos/db`
   in a one-off task) and compare chain heads with the S3 anchors once anchoring exists. A broken chain is a Sev 1.

5. **Application check.** Start a copy of the api task definition pointing at the drill cluster (override `DATABASE_URL`, `REDIS_URL` of a scratch Redis),
   run `infra/scripts/smoke.sh`, log in as a synthetic tenant admin and read recent orders.
6. **Record RPO and RTO.**
   - RPO = time of the last committed write in the source minus the newest write present after restore.
   - RTO (drill) = from "decision to restore" (step 2 start) to "application check passed" (step 5 end). Add the time to repoint production: update the
     `*/database` secrets, then redeploy api, worker and payments (about 10 minutes with `ecs-deploy.sh`).
7. **Tear down:**

   ```bash
   aws rds delete-db-instance --db-instance-identifier $DRILL-writer --skip-final-snapshot
   aws rds delete-db-cluster --db-cluster-identifier $DRILL --skip-final-snapshot
   ```

## Doing it for real

Declare the incident, freeze deploys, restore as above to a new cluster, verify, then cut over: write the new endpoint into `<env>/api/database`,
`<env>/worker/database`, `<env>/payments/database` and `<env>/migrate/database`, redeploy the three services, run smoke. Keep the damaged cluster (rename nothing,
change nothing) until the post-incident review is done. Re-run `grants` if the application role's password changed. Devices keep queued commands and retry, so no
sale is lost while the API is unavailable; Hub and offline modes continue.

## Drill log

| Date | Environment | Restore point | RPO observed | Restore duration | RTO (drill) | Integrity checks | Findings | Who |
| ---- | ----------- | ------------- | ------------ | ---------------- | ----------- | ---------------- | -------- | --- |
|      |             |               |              |                  |             |                  |          |     |
