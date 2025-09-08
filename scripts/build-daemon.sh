set -e
set -o pipefail

# ACCOUNT_ID is a mandatory env var because the script was built to be used in AWS environments,
# however it's no longer mandatory to publish it there. So we're keeping this variable temporarily and
# implementing a specific behavior in case it's set to "NONE".

if [ -z "$ACCOUNT_ID" ]; then
    echo "Please export a ACCOUNT_ID env var before running this";
    echo "Set it to NONE if you don't want to publish to AWS ECR";
    exit 1;
fi

# DYNAMIC_FULLNODE_IDS is an optional env var that, if set to "true", will make the daemon fetch the fullnode
# identifiers dynamically from the fullnode before starting the daemon. This is needed inside containerized private
# networks where the fullnode IDs are not known in advance.
SHOULD_FETCH_IDS=false
if [ "$DYNAMIC_FULLNODE_IDS" = "true" ]; then
  SHOULD_FETCH_IDS=true
fi

# Fetch the image tag from the temp file, this should be filled if the stage
# is not `dev`
DOCKER_IMAGE_TAG=$(cat /tmp/docker_image_tag 2>/dev/null || echo "")

if [ -z "$DOCKER_IMAGE_TAG" ]; then
    commit=`git rev-parse HEAD`;
    timestamp=`date +%s`;
    # Default to the dev image tag
    DOCKER_IMAGE_TAG="dev-$commit-$timestamp";
fi;

echo $DOCKER_IMAGE_TAG;
# Store the updated image tag in the tmp file so the upload stage is able to use
# it
echo $DOCKER_IMAGE_TAG > /tmp/docker_image_tag;

# Handling th Account ID
if [ "$ACCOUNT_ID" = "NONE" ]; then
  echo "== Skipping AWS ECR login since ACCOUNT_ID is set to NONE";
  FINAL_TAG="hathornetwork/hathor-wallet-service-sync-daemon:latest";
  SHOULD_FETCH_IDS=true # Always fetch IDs when not using AWS ECR
else
  aws ecr get-login-password --region eu-central-1 | docker login --username AWS --password-stdin $ACCOUNT_ID.dkr.ecr.eu-central-1.amazonaws.com;
  FINAL_TAG="$ACCOUNT_ID.dkr.ecr.eu-central-1.amazonaws.com/hathor-wallet-service-sync-daemon:$DOCKER_IMAGE_TAG"
fi;

# Handling the dynamic fullnode IDs to decide the correct build target
if [ "$SHOULD_FETCH_IDS" = true ]; then
  echo "== Building the daemon to fetch fullnode IDs dynamically";
  BUILD_TARGET="dev";
else
  echo "== Building the daemon with statically defined fullnode IDs";
  BUILD_TARGET="prod";
fi;

# Copying the correct .dockerignore file
cp packages/daemon/.dockerignore .dockerignore;

# Fetching the daemon Dockerfile to build
docker build \
  -t $FINAL_TAG\
  -f packages/daemon/Dockerfile\
  --target $BUILD_TARGET \
  .;

# Removing the copied .dockerignore file to avoid confusion with other builds in this monorepo
rm .dockerignore
