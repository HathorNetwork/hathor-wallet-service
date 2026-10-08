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

From #515 on, the daemon keeps such a wallet's totals current again. On short totals, the first large debit underflows and **halts sync for every wallet**. So the wallet-service must heal these wallets before the daemon deploys:

1. **Deploy the wallet-service** (the Lambdas).
2. **Wait at least 10 minutes.** A load that was already running the old code (`loadWalletAsync` times out after 600 s) can still record a failure without rebuilding.
3. **Re-run the load of each such wallet.**
   - List them:
     ```sql
     SELECT id, xpubkey, max_gap FROM wallet WHERE status = 'ready' AND ct_status = 'error';
     ```
   - Invoke the load Lambda directly for each wallet. The load API can't be used, because it needs the client's signatures.
     ```sh
     aws lambda invoke --function-name hathor-wallet-service-<stage>-loadWalletAsync \
       --invocation-type Event --cli-binary-format raw-in-base64-out \
       --payload '{"xpubkey": "<xpubkey>", "maxGap": <max_gap>}' /dev/null
     ```
   - The load first moves the wallet to `ct_status = 'creating'`, which the daemon skips, so every outcome is safe:
     - **Success:** the totals are rebuilt and the wallet goes `ready`.
     - **A failure:** the totals are rebuilt and the wallet goes back to `error`, now safe.
     - **A timeout:** it goes through the DLQ, which rebuilds the totals the same way.
     - **Anything else:** the wallet is left `creating`.
   - Re-invoke any wallet that is left `creating`, and any whose run raised the "Failed shielded upgrade not recorded" alert.
4. **Re-run the list query just before deploying the daemon.** Every wallet still on it must have been re-invoked after step 2.
5. **Deploy the daemon.**

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
