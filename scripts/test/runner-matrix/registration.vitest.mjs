import '@tranjs/testing/vitest';
import { test, expect } from 'vitest';
import cases from './registration-cases.cjs';
cases.register({ test, expect, entry: () => import('@tranjs/testing/vitest') });
