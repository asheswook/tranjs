require('@tranjs/testing/jest');
const { test, expect } = require('@jest/globals');
require('./registration-cases.cjs').register({
    test, expect, entry: () => require('@tranjs/testing/jest'),
});
