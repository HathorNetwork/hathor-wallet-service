.PHONY: build-and-push-daemon
build-and-push-daemon:
	bash scripts/build-and-push-daemon.sh

# dev-testnet
.PHONY: build-daemon-dev-testnet
build-daemon-dev-testnet:
	bash scripts/build-daemon.sh dev-testnet

.PHONY: push-daemon-dev-testnet
push-daemon-dev-testnet:
	bash scripts/push-daemon.sh

.PHONY: deploy-lambdas-dev-testnet
deploy-lambdas-dev-testnet:
	yarn workspace wallet-service run serverless deploy --stage dev-testnet --region eu-central-1

# testnet
.PHONY: build-daemon-testnet
build-daemon-testnet:
	bash scripts/build-daemon.sh testnet

.PHONY: push-daemon-testnet
push-daemon-testnet:
	bash scripts/push-daemon.sh testnet

.PHONY: deploy-lambdas-testnet
deploy-lambdas-testnet:
	yarn workspace wallet-service run serverless deploy --stage testnet --region eu-central-1

# mainnet-staging

.PHONY: build-daemon-mainnet-staging
build-daemon-mainnet-staging:
	bash scripts/build-daemon.sh mainnet_staging

.PHONY: push-daemon-mainnet-staging
push-daemon-mainnet-staging:
	bash scripts/push-daemon.sh mainnet_staging

.PHONY: deploy-lambdas-mainnet-staging
deploy-lambdas-mainnet-staging:
	yarn workspace wallet-service run serverless deploy --stage mainnet-stg --region eu-central-1

# mainnet

.PHONY: deploy-lambdas-mainnet
deploy-lambdas-mainnet:
	yarn workspace wallet-service run serverless deploy --stage mainnet --region eu-central-1

.PHONY: push-daemon-mainnet
push-daemon-mainnet:
	bash scripts/push-daemon.sh mainnet

.PHONY: deploy-lambdas-mainnet
deploy-lambdas-mainnet:
	yarn workspace wallet-service run serverless deploy --stage mainnet --region eu-central-1

# other

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
