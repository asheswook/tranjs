expect.extend(require('@tranjs/core/testing/jest').matchers);
require('./matcher-cases.cjs').register({ test, expect });
