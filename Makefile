.PHONY: build-and-push-daemon
build-and-push-daemon:
	bash scripts/build-and-push-daemon.sh

.PHONY: build-daemon
build-daemon:
	bash scripts/build-daemon.sh

.PHONY: push-daemon
push-daemon:
	bash scripts/push-daemon.sh

.PHONY: deploy-lambdas-nano
deploy-lambdas-nano:
# TODO: We should make sure to use the right profile here (I had to set it as default to not lose time)
# AWS_SDK_LOAD_CONFIG=1 yarn workspace wallet-service run serverless deploy --stage nano --region eu-central-1 --aws-profile nano-testnet
	AWS_SDK_LOAD_CONFIG=1 yarn workspace wallet-service run serverless deploy --stage nano --region eu-central-1

.PHONY: deploy-lambdas-dev-testnet
deploy-lambdas-dev-testnet:
	AWS_SDK_LOAD_CONFIG=1 yarn workspace wallet-service run serverless deploy --stage dev-testnet --region eu-central-1

.PHONY: deploy-lambdas-testnet
deploy-lambdas-testnet:
	AWS_SDK_LOAD_CONFIG=1 yarn workspace wallet-service run serverless deploy --stage testnet --region eu-central-1

.PHONY: deploy-lambdas-mainnet-staging
deploy-lambdas-mainnet-staging:
	AWS_SDK_LOAD_CONFIG=1 yarn workspace wallet-service run serverless deploy --stage mainnet-stg --region eu-central-1

.PHONY: deploy-lambdas-mainnet
deploy-lambdas-mainnet:
	AWS_SDK_LOAD_CONFIG=1 yarn workspace wallet-service run serverless deploy --stage mainnet --region eu-central-1

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
