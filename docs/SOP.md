# Standard Operating Procedures

## Deploying

The deployment is partially automated with CodeBuild and CodePipeline in AWS.

Please refer to the wallet-service's release guide for a more in-depth expalanation of which branches/tags trigger builds:
https://github.com/HathorNetwork/ops-tools/blob/1092092ba840c7492436ee092ef2d0a274006c5b/docs/release-guides/wallet-service.md

If you need to know the exact steps that take place during deployment, check [this document](2021-07-29-infrastructure-design.md#how-the-process-works)

### Avoiding downtime
We always want to make sure the migrations do not generate downtimes while running.

Check [this document](2021-07-29-infrastructure-design.md#avoiding-downtimes-during-schema-migrations) for more info on how to build safe migrations.

In case it's not possible to build a downtime-safe migration (this can happen), we have a maintenance mode in place that should be enabled before deploying, or before approving the deployment request in CodePipeline. Check below how to enable it.

### First deploy of the failed-upgrade rebuild (#515)

This is a one-time procedure for the first deploy to each environment that includes #515. It covers wallets that were already in `status = 'ready' AND ct_status = 'error'` before that deploy, meaning their shielded upgrade failed. While the upgrade ran, the daemon skipped their `wallet_balance` and `wallet_tx_history` updates, and nothing rebuilt them afterwards, so their totals are short.

From #515 on, the daemon keeps such a wallet's totals current again. On short totals, the first large debit underflows and **halts sync for every wallet**.

These wallets are healed by rebuilding their totals, and that rebuild has to run **under the new daemon**. The old daemon skips a `ready/error` wallet, so anything it receives after a rebuild under the old daemon is missing from its totals again. While a wallet is `creating`, both daemons skip it, so the procedure parks the wallets there until the new daemon is live.

**Holding the daemon:**
- **The image goes to every environment.** A release's CodeBuild run deploys each environment's Lambdas and pushes one daemon image tag, and Flux image automation bumps every environment whose image policy matches within about a minute. So a daemon can roll out before its own environment's Lambdas are deployed.
- **Suspend before tagging.** Before pushing the git tag, suspend the Flux Kustomization of every environment whose daemon follows that tag:

  | Tag | Environments |
  |---|---|
  | release | `mainnet`, `ekvilibro-mainnet`, `testnet-india`, `testnet-shielded-outputs`, `testnet-playground` |
  | rc | `mainnet-staging`, `ekvilibro-testnet` |

  These lists are from ops-tools; confirm them against the cluster's image policies first.
- **Resuming is not optional.** While an environment's Kustomization is suspended, nothing in its path applies, including config and blue/green changes.

**Names:** Flux environments and Lambda stages are named differently.

| Flux environment (`hathor-wallet-service-<environment>`) | Lambda stage |
|---|---|
| `mainnet` | `mainnet` |
| `mainnet-staging` | `mainnet-stg` |
| `testnet-india` | `india` |
| `testnet-shielded-outputs` | `shielded` (its own AWS account) |
| `ekvilibro-mainnet` | `ekvi-main` (its own AWS account) |
| `dev` | `dev-testnet` |

**Steps:**

1. **Hold the daemons.** For each environment from the table above:
   ```sh
   flux suspend kustomization -n flux-system hathor-wallet-service-<environment>
   ```
2. **Release.** Push the tag. Each environment's migrations and Lambdas deploy; the running daemons stay the old ones. A v1.14.0 daemon or Lambda can claim a legacy address without setting `bip32_account` after the migration's one-time backfill. Once the new Lambdas are live, their address API serves those addresses; step 6 repairs their account column once the old writers are gone.

Then, for each environment in turn:

3. **Wait at least 10 minutes after this environment's new Lambdas finish deploying.** A load that was already running the old code (`loadWalletAsync` times out after 600 s) can still record a failure without rebuilding. Confirm no alias still routes to the old code.
4. **Save the list of wallets, then park them in `creating`:**
   ```sql
   SELECT id, xpubkey, max_gap FROM wallet WHERE status = 'ready' AND ct_status = 'error';
   UPDATE wallet SET ct_status = 'creating' WHERE status = 'ready' AND ct_status = 'error';
   ```
   **What clients see:** from here until a wallet's load finishes, its status reads `creating`. It still serves its balances and history, which won't move while it's parked. A client can't retry the load meanwhile.
5. **Release the daemon:**
   ```sh
   flux resume kustomization -n flux-system hathor-wallet-service-<environment>
   ```
   Wait for Flux to reconcile the release, and confirm the StatefulSet template **and every Ready daemon pod** use the expected new image tag or digest, with no old pods left. `kubectl rollout status` alone can succeed on the old ready StatefulSet before Flux applies the new image.
6. **Repair legacy addresses claimed by old writers after the migration.** Only after step 5 and the old Lambda executions have drained, inspect the rows in this environment:
   ```sql
   SELECT COUNT(*) AS claimed_null_accounts FROM `address`
    WHERE `wallet_id` IS NOT NULL AND `bip32_account` IS NULL;
   SELECT `wallet_id`, `index`, COUNT(*) AS rows_at_index FROM `address`
    WHERE `wallet_id` IS NOT NULL AND (`bip32_account` IS NULL OR `bip32_account` = 0)
    GROUP BY `wallet_id`, `index` HAVING COUNT(*) > 1 LIMIT 20;
   SELECT `address`, `wallet_id`, `index` FROM `address`
    WHERE `wallet_id` IS NOT NULL AND `bip32_account` IS NULL
      AND (`index` IS NULL OR `scan_privkey` IS NOT NULL
           OR `catchup_state` IS NOT NULL OR `ct_address` IS NOT NULL) LIMIT 20;
   ```
   Stop and investigate if either of the last two queries returns rows: a duplicate legacy index would conflict with the account-0 unique key, and shielded metadata must not be relabeled as legacy. Otherwise repeat the migration's backfill, leaving unclaimed observation rows at NULL:
   ```sql
   UPDATE `address` SET `bip32_account` = 0
    WHERE `wallet_id` IS NOT NULL AND `bip32_account` IS NULL;
   SELECT COUNT(*) AS claimed_null_accounts FROM `address`
    WHERE `wallet_id` IS NOT NULL AND `bip32_account` IS NULL;
   ```
   The final count must be zero. Check `/wallet/addresses/new` for an affected wallet known to have unused addresses; an empty list is legitimate for a wallet that has exhausted its gap.
7. **Repeat step 4 once.** This catches a wallet whose upgrade failed between step 4 and the new daemon, and was rebuilt under the old one. Add those wallets to the saved list.
8. **Re-run the load of every saved wallet.** This step is required: a parked wallet stays frozen until its load runs. Invoke the load Lambda directly; the load API can't be used, because it needs the client's signatures.
   ```sh
   aws lambda invoke --function-name hathor-wallet-service-<stage>-loadWalletAsync \
     --invocation-type Event --cli-binary-format raw-in-base64-out \
     --payload '{"xpubkey": "<xpubkey>", "maxGap": <max_gap>}' /dev/null
   ```
   Every outcome is now safe:
   - **Success:** the totals are rebuilt and the wallet goes `ready`.
   - **A failure:** the totals are rebuilt and the wallet goes back to `error`, now with the new daemon keeping them current.
   - **A timeout:** after two automatic retries, about 35 minutes, it reaches the DLQ, which rebuilds the totals the same way. A wallet that ends there is pinned at the retry cap, so only a direct invoke can load it again.
   - **Anything else:** the wallet is left `creating`.
9. **Done when no saved wallet is still `creating`.** Give a timing-out load its 35 minutes. Then re-invoke any saved wallet still `creating`, and any whose run raised the "Failed shielded upgrade not recorded" alert.

**Rollback:** roll the Lambdas and the daemon back together. With pre-#515 Lambdas under the new daemon, a failed load records `error` without rebuilding, and the new daemon then counts the wallet on short totals. A rollback to old writers on the migrated schema can create claimed NULL-account addresses again; repeat step 6 on the next forward rollout. Also audit an environment that already ran this migration with old writers, even if it is past the one-time #515 rebuild.

**dev** deploys its Lambdas and daemon together, nightly, and is already past #515. There, run step 8 for any `ready/error` wallet: under the new daemon, a direct load moves the wallet to `creating` and rebuilds it.

## Adding new environment variables

If you need to add new environment variables, there are some steps that should be taken.

Let's say we want to add the `ENV_VAR_1` env var.

First step would be to add it to the [serverless.yml](https://github.com/HathorNetwork/hathor-wallet-service/blob/master/serverless.yml) file, under `provider.environment`.

Then, you need to add it in [.codebuild/buildspec.yml](https://github.com/HathorNetwork/hathor-wallet-service/blob/master/.codebuild/buildspec.yml). If it's not a secret, just add it under `env.variables`.

If it's a secret, you'll need to add it to `env.secrets-manager`, and one for each environment we have (`dev`, `testnet` and `mainnet`). You should use the same name for it as you did in the `serverless.yml` file, but adding a prefix indicating the name of the environment. The value should be the path to a key in AWS Secrets Manager. Ask some account admin for help on adding the secrets there and providing you with the key path.

## Creating a new DB migration

To create a new DB migration, run:

```bash
make new-migration NAME=migration_name
```

It will create an empty migration file for you. You should include your migration logic there.

To run your migration:

```bash
make migrate
```

The migrations will run in the database specified in your local environment configuration. If you need to configure it for a local database, check [this](https://github.com/HathorNetwork/hathor-wallet-service/blob/dev/README.md#local-database).

## Enabling debug logs

The logger is set on the INFO level by default.

To enable more verbose debug logs, we need to change the `LOG_LEVEL` environment variable. This can be done by either changing the default deploy variable on `$PROJECT_DIR/.codebuild/buildspec.yml` and triggering a new deploy by following the steps on the **Deploying** section or by manually setting it on the AWS Lambda configuration tab for the Lamdba you desire to change the log level, valid severity values are `error`, `warn`, `info`, `verbose`, `debug` and `silly`

Changing the environment will cause the lambda to be restarted, so the next request will already be logged

## Enabling Maintenance Mode
TODO - This is not implemented yet
