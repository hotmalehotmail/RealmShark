import { resolve } from 'path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Mirrors electron.vite.config.ts's renderer alias / tsconfig.web.json's
// "@renderer" path so test files can import renderer modules the same way
// production code eventually will, without a separate mapping to maintain.
// The react plugin is needed even for non-rendering tests (e.g. the
// allowlist tripwire) since importing a .tsx provider module like
// EntityRegistry.tsx requires its JSX to be transformed.
export default defineConfig({
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src')
    }
  },
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts']
  }
})
