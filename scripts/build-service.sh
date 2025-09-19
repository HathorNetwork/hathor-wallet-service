set -e
set -o pipefail


FINAL_TAG="hathornetwork/hathor-wallet-service-lambdas:dev";

# Copying the correct .dockerignore file
cp packages/wallet-service/.dockerignore .dockerignore;

# Fetching the daemon Dockerfile to build
docker build \
  -t $FINAL_TAG\
  -f packages/wallet-service/Dockerfile.dev\
  .;

# Removing the copied .dockerignore file to avoid confusion with other builds in this monorepo
rm .dockerignore
