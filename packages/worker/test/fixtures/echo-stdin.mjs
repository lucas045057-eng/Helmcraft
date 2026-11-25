import { appendFileSync } from 'node:fs'
import { stdin, stdout } from 'node:process'

/**
 * WIN-7 夹具：把 stdin 原样回显为 JSON，并报告 argv / cwd。
 * 用于断言 prompt 只经 stdin 传递、不出现在命令行、不被 shell 解释。
 */
const chunks = []
for await (const chunk of stdin) chunks.push(Buffer.from(chunk))
const stdinText = Buffer.concat(chunks).toString('utf8')

if (process.env.ECHO_STDIN_SENTINEL) {
  appendFileSync(process.env.ECHO_STDIN_SENTINEL, 'child-started\n')
}

stdout.write(JSON.stringify({
  argv: process.argv.slice(1),
  allArgv: process.argv,
  cwd: process.cwd(),
  stdin: stdinText,
  stdinBytes: Buffer.byteLength(stdinText, 'utf8'),
}) + '\n')
