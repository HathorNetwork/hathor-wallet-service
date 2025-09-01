set -e
set -o pipefail

# The image will be tagged as latest by default
FINAL_TAG="hathornetwork/hathor-wallet-service-migrator:latest";

# Fetching the versions of the critical dependencies from package.json
# to ensure consistency
SEQUELIZE_VERSION=$(cat ./package.json | jq -r '.devDependencies["sequelize"]');
echo "Using Sequelize version: $SEQUELIZE_VERSION";

SEQUELIZE_CLI_VERSION=$(cat ./package.json | jq -r '.devDependencies["sequelize-cli"]');
echo "Using Sequelize-Cli version: $SEQUELIZE_CLI_VERSION";

MYSQL2_VERSION=$(cat ./package.json | jq -r '.devDependencies["mysql2"]');
echo "Using MySql2 version: $MYSQL2_VERSION";

# Build the Docker image, passing the versions as build arguments
docker build \
  --build-arg SEQUELIZE_VERSION=$SEQUELIZE_VERSION \
  --build-arg SEQUELIZE_CLI_VERSION=$SEQUELIZE_CLI_VERSION \
  --build-arg MYSQL2_VERSION=$MYSQL2_VERSION \
  -t $FINAL_TAG \
  -f db/Dockerfile \
  .;
