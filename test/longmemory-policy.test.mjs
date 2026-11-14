// The policy for the long-term memory recall server: its one tool is a read,
// allowed with and without writes; any other name under it is refused.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideTool } from '../bridge/policy.mjs'

const name = (t) => `mcp__venom_recall__${t}`

test('policy: memory_recall is a read, with or without writes', () => {
  assert.equal(decideTool(name('memory_recall')), true)
  assert.equal(decideTool(name('memory_recall'), true), true)
})

test('policy: anything else under venom_recall is refused, even with writes', () => {
  for (const t of ['memory_save', 'memory_forget', 'memory_search', 'read_file', 'get_recall', 'memory_recall_all']) {
    assert.equal(decideTool(name(t)), false, `${t} must be refused`)
    assert.equal(decideTool(name(t), true), false, `${t} must be refused with writes`)
  }
})

test('policy: the same tool name on another server gets no special treatment', () => {
  assert.equal(decideTool('mcp__someserver__memory_recall'), false)
})
