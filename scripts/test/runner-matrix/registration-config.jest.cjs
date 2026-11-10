const { test, expect } = typeof globalThis.expect === 'function' ? globalThis : require('@jest/globals');
require('./config-registration-cases.cjs').register({ test, expect });
