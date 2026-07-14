import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

// Reuses tsconfig.web's @renderer alias (see electron.vite.config.ts's renderer
// block) so test files can import the same way source files do, without
// spinning up electron-vite's full main/preload/renderer build.
export default defineConfig({
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src')
    }
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts']
  }
})
