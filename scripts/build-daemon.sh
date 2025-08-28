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

if [ "$ACCOUNT_ID" = "NONE" ]; then
  echo "== Skipping AWS ECR login since ACCOUNT_ID is set to NONE";
  FINAL_TAG="hathornetwork/hathor-wallet-service-sync-daemon:latest";
else
  aws ecr get-login-password --region eu-central-1 | docker login --username AWS --password-stdin $ACCOUNT_ID.dkr.ecr.eu-central-1.amazonaws.com;
  FINAL_TAG="$ACCOUNT_ID.dkr.ecr.eu-central-1.amazonaws.com/hathor-wallet-service-sync-daemon:$DOCKER_IMAGE_TAG"
fi;

# Copying the correct .dockerignore file
cp packages/daemon/.dockerignore .dockerignore;

# Fetching the daemon Dockerfile to build
docker build \
  -t $FINAL_TAG\
  -f packages/daemon/Dockerfile\
  .;

# Removing the copied .dockerignore file to avoid confusion with other builds in this monorepo
rm .dockerignore
