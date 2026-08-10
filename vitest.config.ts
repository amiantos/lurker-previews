// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/*.{test,spec}.ts'],
    exclude: ['**/node_modules/**'],
    environment: 'node',
  },
});
