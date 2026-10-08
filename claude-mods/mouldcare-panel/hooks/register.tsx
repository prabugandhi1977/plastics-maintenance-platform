import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Health, Repo, TestRun } from '../types'

const PANE = 'mouldcare'
const PORT = 3100
const HEALTH_URL = `http://127.0.0.1:${PORT}/api/health`

const health = atom({ plugin: 'mouldcare-panel', key: 'health' } as const, {
  isChecked: false,
  isMouldCare: false,
  isServerUp: false,
  isDemoStarting: false,
  checkedAt: 0,
} as Health)
const tests = atom({ plugin: 'mouldcare-panel', key: 'tests' } as const, {
  status: 'never',
  passed: 0,
  failed: 0,
  finishedAt: 0,
  message: '',
} as TestRun)
const repo = atom({ plugin: 'mouldcare-panel', key: 'repo' } as const, { branch: '', changes: 0 } as Repo)

type Api = Parameters<Parameters<Register>[0]>[2] extends (...a: infer A) => unknown ? A[0] : never

async function isMouldCareRepo($: Api): Promise<boolean> {
  try {
    return /"name":\s*"mouldcare/.test(await $.fs.read('package.json'))
  } catch {
    return false
  }
}

async function isServerUp($: Api): Promise<boolean> {
  try {
    return (await $.http.fetch(HEALTH_URL)).ok
  } catch {
    return false
  }
}

async function refresh($: Api): Promise<void> {
  const [isMouldCare, isUp, branch, status] = await Promise.all([
    isMouldCareRepo($),
    isServerUp($),
    $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD']).catch(() => null),
    $.process.run(['git', 'status', '--porcelain']).catch(() => null),
  ])
  const checkedAt = await $.clock.now()
  await update($, health, prev => ({ ...prev, isChecked: true, isMouldCare, isServerUp: isUp, checkedAt, isDemoStarting: isUp ? false : prev.isDemoStarting }))
  await update($, repo, () => ({
    branch: branch?.exitCode === 0 ? branch.stdout.trim() : '',
    changes: status?.exitCode === 0 ? status.stdout.split('\n').filter(Boolean).length : 0,
  }))
}

async function runTests($: Api): Promise<void> {
  if ((await read($, tests)).status === 'running') return
  await update($, tests, (t): TestRun => ({ ...t, status: 'running', message: '' }))
  try {
    const { stdout, stderr } = await $.process.run(['node', '--test', 'backend/tests/*.test.js'], { timeoutMs: 600_000 })
    const count = (name: string) => Number(stdout.match(new RegExp(`^# ${name} (\\d+)`, 'm'))?.[1] ?? NaN)
    const passed = count('pass')
    const failed = count('fail')
    const finishedAt = await $.clock.now()
    if (Number.isNaN(passed) || Number.isNaN(failed)) {
      const message = (stderr || stdout).trim().split('\n').slice(-1)[0] ?? 'no test summary'
      await update($, tests, (): TestRun => ({ status: 'error', passed: 0, failed: 0, finishedAt, message }))
      $.ui.toast('MouldCare tests did not report a result')
      return
    }
    await update($, tests, (): TestRun => ({ status: failed ? 'failed' : 'passed', passed, failed, finishedAt, message: '' }))
    $.ui.toast(failed ? `MouldCare tests: ${failed} failed` : `MouldCare tests: all ${passed} passed`)
  } catch (err) {
    const finishedAt = await $.clock.now()
    await update($, tests, (): TestRun => ({ status: 'error', passed: 0, failed: 0, finishedAt, message: String(err).slice(0, 200) }))
  }
}

// Commands call node directly (no npm, no shell) so they also start on Windows.
// The server lives as long as this session (or until the mod reloads); a server you started yourself is left alone.
async function startDemo($: Api): Promise<void> {
  const hs = await read($, health)
  if (hs.isDemoStarting) return
  if (await isServerUp($)) {
    $.ui.toast(`MouldCare is already running on port ${PORT}`)
    return refresh($)
  }
  await update($, health, x => ({ ...x, isDemoStarting: true }))
  const seed = await $.process.run(['node', 'backend/scripts/seed.js'], { timeoutMs: 120_000 }).catch(() => null)
  if (!seed || seed.exitCode !== 0) {
    await update($, health, x => ({ ...x, isDemoStarting: false }))
    $.ui.toast('Seeding the demo data failed; run npm run seed to see why')
    return
  }
  void (async () => {
    for await (const piece of $.process.spawn({ argv: ['node', 'backend/server.js'], env: { PORT: String(PORT) } })) {
      if ('text' in piece) $.ui.log(piece.text, { to: 'debug' })
    }
    await update($, health, x => ({ ...x, isDemoStarting: false }))
    await refresh($)
  })()
  $.clock.after(2500, () => void refresh($))
}

function ago(ms: number): string {
  const min = Math.round(ms / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  return `${Math.round(min / 60)} h ago`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'mouldcare', description: 'Open the MouldCare dev panel' })
    await refresh($)
    $.clock.every(15_000, () => void refresh($))
    if ((await read($, health)).isMouldCare) void $.ui.open({ id: PANE, title: 'MouldCare' })
    return started
  })

  on('command.run', { command: 'mouldcare' }, async $ => {
    await $.ui.open({ id: PANE, title: 'MouldCare' })
    await refresh($)
    return { text: 'MouldCare panel opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const hs = await read($, health)
    const t = await read($, tests)
    const r = await read($, repo)
    const now = await $.clock.now()

    if (!hs.isMouldCare) {
      return (
        <Box flexDirection="column">
          {!hs.isChecked ? (
            <Text dimColor>Checking this folder…</Text>
          ) : (
            <Box flexDirection="column">
              <Text dimColor>This folder is not a MouldCare checkout.</Text>
              <Text dimColor>Open Claude Code in the plastics-maintenance-platform repository.</Text>
            </Box>
          )}
          <Text> </Text>
          <Button key="refresh" hotkey="r" dimColor label="Refresh" onPress={() => refresh($)} />
        </Box>
      )
    }

    const server = hs.isServerUp ? (
      <Text color="success">● up on :{PORT}</Text>
    ) : hs.isDemoStarting ? (
      <Text color="warning">◐ starting…</Text>
    ) : (
      <Text dimColor>○ not running</Text>
    )
    const testLine =
      t.status === 'running' ? (
        <Text color="warning">running…</Text>
      ) : t.status === 'never' ? (
        <Text dimColor>not run this session</Text>
      ) : t.status === 'error' ? (
        <Text color="error">no result · {t.message || 'see npm test'}</Text>
      ) : (
        <Text color={t.failed ? 'error' : 'success'}>
          {t.passed} passed · {t.failed} failed
        </Text>
      )

    return (
      <Box flexDirection="column">
        <Box>
          <Text dimColor>{'Server   '}</Text>
          {server}
        </Box>
        <Box>
          <Text dimColor>{'Tests    '}</Text>
          {testLine}
        </Box>
        {t.finishedAt > 0 && t.status !== 'running' && <Text dimColor>{'         ran ' + ago(now - t.finishedAt)}</Text>}
        <Box>
          <Text dimColor>{'Branch   '}</Text>
          <Text>{r.branch || '—'}</Text>
        </Box>
        <Box>
          <Text dimColor>{'Changes  '}</Text>
          <Text color={r.changes ? 'warning' : undefined}>
            {r.changes ? `${r.changes} file${r.changes === 1 ? '' : 's'} uncommitted` : 'clean'}
          </Text>
        </Box>
        <Text> </Text>
        <Box>
          <Button
            key="tests"
            variant="primary"
            hotkey="t"
            label={t.status === 'running' ? 'Tests running…' : 'Run tests'}
            onPress={() => runTests($)}
          />
          <Text> </Text>
          <Button
            key="demo"
            hotkey="d"
            label={hs.isServerUp ? 'Demo running' : hs.isDemoStarting ? 'Starting…' : 'Start demo'}
            onPress={() => startDemo($)}
          />
          <Text> </Text>
          <Button key="refresh" hotkey="r" dimColor label="Refresh" onPress={() => refresh($)} />
        </Box>
        {hs.isServerUp && (
          <Box flexDirection="column">
            <Text> </Text>
            <Text dimColor>Web http://localhost:{PORT} · field app /mobile/</Text>
            <Text dimColor>acme@demo.test · dispatch@demo.test · engineer@demo.test</Text>
            <Text dimColor>Password DemoPass123!</Text>
          </Box>
        )}
      </Box>
    )
  })
}
