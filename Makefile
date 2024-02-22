.PHONY: build-and-push-daemon
build-and-push-daemon:
	bash scripts/build-and-push-daemon.sh

.PHONY: build-daemon-dev-testnet
build-daemon-dev-testnet:
	bash scripts/build-daemon.sh dev-testnet

.PHONY: push-daemon-dev-testnet
push-daemon-dev-testnet:
	bash scripts/push-daemon.sh dev-testnet

.PHONY: deploy-lambdas-dev-testnet
deploy-lambdas-dev-testnet:
	yarn workspace wallet-service run serverless deploy --stage dev-testnet --region eu-central-1

.PHONY: deploy-lambdas-testnet
deploy-lambdas-testnet:
	yarn workspace wallet-service run serverless deploy --stage testnet --region eu-central-1

.PHONY: deploy-lambdas-mainnet-staging
deploy-lambdas-mainnet-staging:
	yarn workspace wallet-service run serverless deploy --stage mainnet-stg --region eu-central-1

.PHONY: deploy-lambdas-mainnet
deploy-lambdas-mainnet:
	yarn workspace wallet-service run serverless deploy --stage mainnet --region eu-central-1

.PHONY invoke-local:
invoke-local:
	AWS_SDK_LOAD_CONFIG=1 yarn workspace wallet-service run serverless invoke local --function $(FUNCTION) --stage dev-testnet --region eu-central-1

.PHONY: migrate
migrate:
	@echo "Migrating..."
	npx sequelize-cli db:migrate

.PHONY: new-migration
new-migration:
	npx sequelize migration:generate --name "$(NAME)"
