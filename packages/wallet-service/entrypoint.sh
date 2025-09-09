#!/bin/sh

set -e

# When MOCK_AWS is set to true, copy the mocked AWS credentials fixtures to .aws the working directory
if [ "$MOCK_AWS" = "true" ]; then
  cp -r tests/fixtures/aws ./.aws
fi

yarn serverless offline start --host 0.0.0.0 --httpPort 3000
