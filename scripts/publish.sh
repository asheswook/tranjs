#!/usr/bin/env bash
set -euo pipefail

# Release @tranjs/testing when its code changes or it needs a newer core than
# its peer range allows. For a core range update, set BOTH its @tranjs/core
# peerDependency (caret range) and devDependency to the selected version before
# publishing. Lerna updates only the first matching dependency collection.
npm run build
npm test
npm run test:packed
npm run test:runners
lerna publish "$@"
