import { test, expect } from 'vitest';
import { matchers } from '@tranjs/core/testing/vitest';
import cases from './matcher-cases.cjs';
expect.extend(matchers);
cases.register({ test, expect });
