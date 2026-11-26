import { expect, it } from 'vitest'
import { parseCommand, projectOf, ProjectDecl } from '../src/index.js'

it('maps a task subdir to the project folder it belongs to', () => {
  expect(['Forma', './Forma/', 'Forma/src', 'Forma\\src'].map(projectOf)).toEqual(['Forma', 'Forma', 'Forma', 'Forma'])
  expect([null, undefined, '', '.', './'].map(projectOf)).toEqual([null, null, null, null, null])
})

it('accepts plain folder names as projects and rejects dot folders and paths', () => {
  for (const dir of ['Forma', '子 项目', 'a.b']) expect(ProjectDecl.safeParse({ dir, isGitRepo: false }).success, dir).toBe(true)
  for (const dir of ['.board', '..', 'a/b', 'a\\b', 'C:', ' lead']) expect(ProjectDecl.safeParse({ dir, isGitRepo: false }).success, dir).toBe(false)
})

it('parses /run --dir into the project folder flag', () => {
  expect(parseCommand('/run --dir Forma 修一下导出')).toMatchObject({ ok: true, cmd: { name: 'run', flags: { dir: 'Forma' }, prompt: '修一下导出' } })
  expect(parseCommand('/run --dir ../etc 读文件')).toMatchObject({ ok: false, error: '无效项目文件夹' })
})
