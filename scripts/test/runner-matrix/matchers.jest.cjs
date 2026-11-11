expect.extend(require('@tranjs/testing/jest').matchers);
require('./matcher-cases.cjs').register({ test, expect });
