#!/usr/bin/env bash
set -euo pipefail

# Before a core release, set BOTH @tranjs/testing's @tranjs/core peerDependency
# (with its caret range) and devDependency to the selected release version.
# Lerna updates only the first matching dependency collection; do not rely on it
# to update the peer range as well. Make both edits before publishing the release.
npm run build
npm test
npm run test:packed
npm run test:runners
lerna publish "$@"
