.PHONY: deploy-lambdas-dev-testnet
deploy-lambdas-dev-testnet:
	AWS_SDK_LOAD_CONFIG=1 npx serverless deploy --stage dev-testnet --region eu-central-1

.PHONY: deploy-lambdas-dev-testnet-ci
deploy-lambdas-dev-testnet-ci:
	npx serverless deploy --stage dev-testnet --region eu-central-1

.PHONY: deploy-lambdas-testnet
deploy-lambdas-testnet:
	AWS_SDK_LOAD_CONFIG=1 npx serverless deploy --stage testnet --region eu-central-1

.PHONY: deploy-lambdas-testnet-ci
deploy-lambdas-testnet-ci:
	npx serverless deploy --stage testnet --region eu-central-1

.PHONY: deploy-lambdas-mainnet-staging
deploy-lambdas-mainnet-staging:
	AWS_SDK_LOAD_CONFIG=1 npx serverless deploy --stage mainnet-stg --region eu-central-1

.PHONY: deploy-lambdas-mainnet-staging-ci
deploy-lambdas-mainnet-staging-ci:
	npx serverless deploy --stage mainnet-stg --region eu-central-1

.PHONY: deploy-lambdas-mainnet
deploy-lambdas-mainnet:
	AWS_SDK_LOAD_CONFIG=1 npx serverless deploy --stage mainnet --region eu-central-1

.PHONY: deploy-lambdas-mainnet-ci
deploy-lambdas-mainnet-ci:
	npx serverless deploy --stage mainnet --region eu-central-1

.PHONY: migrate
migrate:
	@echo "Migrating..."
	npx sequelize-cli db:migrate

.PHONY: new-migration
new-migration:
	npx sequelize migration:generate --name "$(NAME)"

.PHONY: seed_testnet
seed_testnet:
	npx sequelize-cli db:seed --seed testnet

.PHONY: seed_mainnet
seed_mainnet:
	npx sequelize-cli db:seed --seed mainnet

.PHONY: cleanup
cleanup:
	rm db.sqlite3
