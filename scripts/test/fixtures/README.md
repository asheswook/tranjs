# Published core baseline

`tranjs-core-1.1.0.tgz` is the original, unchanged npm tarball for
`@tranjs/core@1.1.0` (9,494 bytes), downloaded with `npm pack`.

- Source: https://registry.npmjs.org/@tranjs/core/-/core-1.1.0.tgz
- License: `LGPL-2.1-only`, as declared in the archived `package/package.json`.
- Registry SHA-512 integrity (also verified against the archive):
  `sha512-b7zLSA0QFgcud7hlUDTxvw9PL2uyNQ+9opSFlSNa2vTrPjw3YhNihX01hzLkH2YEQDdTbMZPOeW7UKmmi7URuQ==`

The differential test pins this published release to preserve the original
no-session behavior independently of branch history. Vendoring the small archive
keeps repeated runs offline and avoids npm cache or registry availability issues.
The test verifies the checksum, package name, and version before running it.
