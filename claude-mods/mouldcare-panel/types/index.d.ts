export type Health = { isChecked: boolean; isMouldCare: boolean; isServerUp: boolean; isDemoStarting: boolean; checkedAt: number }
export type TestRun = {
  status: 'never' | 'running' | 'passed' | 'failed' | 'error'
  passed: number
  failed: number
  finishedAt: number
  message: string
}
export type Repo = { branch: string; changes: number }

declare module 'claude-code' {
  interface PluginState {
    'mouldcare-panel': { health: Health; tests: TestRun; repo: Repo }
  }
}
