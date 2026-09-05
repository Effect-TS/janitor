# Effect workflow Cloudflare spike

## Retirement

The `Janitor/cluster-spike` deployment was destroyed on September 5, 2026 with `vp exec alchemy destroy --stage cluster-spike --yes`. Alchemy reported 10 successful resource deletions, including the cluster Worker, queues, payload bucket, Hyperdrive, Neon database, and Access applications. The results below are historical. See the [production deployment plan](../production-deployment-plan.md) for the next deployment.

## Pins

- Date: 2026-09-01
- Effect branch: `eff-988-alchemy-cloudflare-cluster`
- Effect commit: `f4143802256d135864f15314fc37385e919999b1`
- `@effect/platform-cloudflare`: vendored tarball built from that commit
- Effect packages: linked from the pinned Effect checkout
- Alchemy: `2.0.0-beta.75` with `patches/alchemy@2.0.0-beta.75.patch`
- Preview stage: `cluster-spike`
- Neon region and PostgreSQL version: `aws-us-east-1`, PostgreSQL 18

## Deployment

`vp run cloudflare:cluster-spike --yes` provisioned Neon, Hyperdrive, Queue, Cron, the
Website and webhook Workers, and the cluster Worker. The cluster Worker created the four
SQLite Durable Object classes owned by `AlchemyCloudflareCluster.make`:

- `ClusterEntity`
- `ClusterWorkflow`
- `ClusterDurableQueue`
- `ClusterSingleton`

The deployed cluster URL was
`https://janitor-clusterworker-cluster-spike-vxw4bnddqhw2f5bp.matechs.workers.dev`.

## Results

### Workflow and activities

The first `cluster-spike-first-payload-1` submission returned execution ID
`e8109134772b9cb304b12ae7a530ed7d`. A duplicate submission with
`captureDefect: true` returned the same ID and the original successful result. This confirms
first-payload-wins behavior.

The execution crossed both durable clocks and completed its GitHub-shaped activity. Neon
contained one `first` commit keyed by the execution key and one `second` commit keyed by the
activity idempotency key.

A captured defect returned HTTP 500 for `cluster-spike-defect-1`. A fresh remediation key,
`cluster-spike-remediation-1`, completed successfully. Failed execution keys remain terminal;
remediation requires a new key.

### Queue and Cron

Two Queue submissions for `cluster-spike-queue-1` produced one Neon `queue` row. The deployed
Cron Trigger woke `topology-probe-cron` and produced one Neon `cron` row.

### Neon interruption

The preview compute endpoint was disabled through the Neon API and reached the disabled,
idle state. `cluster-spike-neon-outage-1` then returned HTTP 503 with the expected database
recovery message.

After enabling and starting the same endpoint, `cluster-spike-neon-recovery-1` completed with
HTTP 200 without a Worker restart or redeployment. Recovery contact was a fresh
`POST /topology-probe/wait` request.

### Durable Object migration

The follow-up deployment added the retained `MigrationProbe` SQLite Durable Object class to
the existing cluster Worker. Alchemy recorded:

```json
{
  "deletedClasses": [],
  "renamedClasses": [],
  "transferredClasses": [],
  "newSqliteClasses": ["MigrationProbe"]
}
```

The four existing class mappings remained unchanged. `POST /migration-probe` returned
`writes: 1` and then `writes: 2` with a nonzero SQLite database size, proving persistence in
the migrated namespace. A normal topology workflow completed after the migration.

`MigrationProbe` must remain declared. Removing it would request a destructive class deletion
migration.

### In-flight redeployment and reactivation

`cluster-spike-inflight-redeploy-1` used a two-minute first durable clock and returned execution
ID `99bed1136092cf6abf6f62332f12f613`. Neon contained its single `first` commit before
`vp run cloudflare:cluster-redeploy --yes` forced a full preview redeployment.

Contacting the same execution after redeployment returned the same execution ID and successful
result. Neon contained exactly one `first` row and one activity-keyed `second` row. The forced
redeployment recorded no additional Durable Object migrations, with all five class mappings
stable.

Cloudflare does not expose a deterministic isolate-eviction control. The forced Worker
redeployment replaced the runtime while the workflow was suspended and proved that persisted
workflow, clock, and alarm state reactivated under the replacement. Earlier discarded
executions also completed through alarm wake before later result contact.

## Local runtime note

Restarting the local Docker PostgreSQL container leaves the current local Hyperdrive path
unusable until `alchemy dev` restarts. Direct PostgreSQL connections recover immediately. The
deployed Neon test did not reproduce this limitation: the Worker recovered after Neon restart
without redeployment.
