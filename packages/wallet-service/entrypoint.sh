#!/bin/sh

set -e

yarn serverless offline start --host 0.0.0.0 --httpPort 3000
