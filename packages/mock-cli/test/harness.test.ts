import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, readFileSync, existsSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const hx = '1234567890123456789012'
const end = '</task id="' + hx + '">'
const bin = fileURLToPath(new URL('../src/index.ts',import.meta.url))
const run = (input: string, cwd?: string) => spawnSync(process.execPath,[bin],{cwd,input,encoding:'utf8',shell:false,windowsHide:true,timeout:5000})
function prompt(scenario: string, mode='fresh') {
  return ['#scenario:'+scenario+' hx='+hx,'<agent_hub_harness version="1" mode="'+mode+'" id="'+hx+'">','rules',
    '</agent_hub_harness id="'+hx+'">','<task id="'+hx+'">','测试',end,''].join('\n')
}
it('hashes precisely the consumed UTF-8 bytes', () => {
  const text = prompt('echo-harness')
  const result = run(text)
  expect(result.status).toBe(0)
  const messages = result.stdout.trim().split('\n').map(s=>JSON.parse(s))
  expect(messages[0].type).toBe('session')
  expect(JSON.parse(messages[1].text)).toMatchObject({hx:true,mode:'fresh',task:'测试',bytes:Buffer.byteLength(text),
    sha256:createHash('sha256').update(text).digest('hex')})
})
it('waits for the matching close line and leaves the answer unread', () => {
  const text = prompt('need-input')
  expect(run(text.replace(end,'</task id="wrong">')).stderr.trim()).toBe('harness block not terminated')
  expect(run(text.replace(end,'</task id="wrong">')).status).toBe(1)
  expect(run(text+'real answer\n').stdout).toContain('"text":"real answer"')
  expect(run('#scenario:need-input hx=bad\nfirst answer\n').stdout).toContain('"text":"first answer"')
})
it('executes relative operations in order and chooses fixOps for autofix', () => {
  const cwd=mkdtempSync(join(tmpdir(),'mock-fs-'))
  const encode=(ops:unknown)=>Buffer.from(JSON.stringify(ops)).toString('base64url')
  try {
    const ops=encode([{op:'mkdir',path:'notes'},{op:'write',path:'notes/x',content:'one'},{op:'symlink',target:'notes',path:'alias'}])
    const fixOps=encode([{op:'delete',path:'notes/x'},{op:'write',path:'notes/new',content:'two'}])
    const scenario='fs ops='+ops+' fixOps='+fixOps
    expect(run(prompt(scenario),cwd).status).toBe(0)
    expect(lstatSync(join(cwd,'alias')).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(cwd,'notes/x'),'utf8')).toBe('one')
    expect(run(prompt(scenario,'autofix'),cwd).status).toBe(0)
    expect(existsSync(join(cwd,'notes/x'))).toBe(false)
    expect(readFileSync(join(cwd,'notes/new'),'utf8')).toBe('two')
    for (const path of ['../escape','/absolute','C:\\escape','alias/new']) {
      expect(run(prompt('fs ops='+encode([{op:'write',path,content:'bad'}])),cwd).status).toBe(1)
    }
  } finally { rmSync(cwd,{recursive:true,force:true}) }
})
