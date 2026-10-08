import { expect, mock, test } from 'claude-code/testing'

const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const PANE = {
  component: 'Pane',
  requestId: 'mouldcare',
  props: { title: 'MouldCare', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

test('the panel shows server, branch and changes, and Run tests records the result', async ($, on) => {
  const ran: string[] = []
  mock.clock(on)
  on('fs.read', () => ({ value: '{ "name": "mouldcare-mvp" }' }))
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: '{"ok":true}' } }))
  on('process.run', (_$, e) => {
    ran.push(e.argv.join(' '))
    if (e.argv[1] === 'rev-parse') return ok('main\n')
    if (e.argv[1] === 'status') return ok(' M README.md\n?? docs/new.md\n')
    if (e.argv.includes('--test')) return ok('# tests 109\n# pass 107\n# fail 2\n')
    return ok('')
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'mouldcare-panel', surface, ...PANE })
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ type: 'Text', text: /up on :3100/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^main$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /2 files uncommitted/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /DemoPass123!/ })).toBeDefined()

    await ui.press({ key: 'tests' })
    expect(await ui.find({ type: 'Text', text: /107 passed · 2 failed/ })).toBeDefined()
    await ui.unmount()
  }
  expect(ran).toContain('node --test backend/tests/*.test.js')
})

test('outside a MouldCare checkout the panel says so', async ($, on) => {
  mock.clock(on)
  on('fs.read', () => ({ value: '{ "name": "something-else" }' }))
  on('http.fetch', () => ({ value: { status: 503, ok: false, headers: {}, text: '' } }))
  on('process.run', () => ok(''))
  const ui = await $.ui.mount({ plugin: 'mouldcare-panel', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /Checking this folder/ })).toBeDefined()
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: /not a MouldCare checkout/ })).toBeDefined()
})
