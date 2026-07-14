export {}

declare global {
  interface Window {
    /** Set true by fixtureSource once every fixture envelope has been delivered - see `e2e/shots.spec.ts`. */
    __harnessFixtureReady?: boolean
  }

  interface ImportMetaEnv {
    /** Set (via `.env.harness`, `--mode harness`) only for the browser harness build - see `docs/overlay-harness.md`. */
    readonly VITE_HARNESS?: string
  }
}
