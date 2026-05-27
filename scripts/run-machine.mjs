#!/usr/bin/env node
// Single entrypoint that runs both the daemon and the dashboard inside one Fly machine.
//
// We deliberately co-locate: the dashboard reads the daemon's SQLite file directly, and
// Fly volumes attach to one machine at a time. Splitting the processes across machines
// would either need a second volume (which would diverge) or an RPC layer between them.
//
// If either child exits we tear the other down and exit non-zero; Fly's [[restart]]
// policy = "always" will bring the machine back up. We forward SIGTERM / SIGINT so the
// daemon's graceful shutdown (drain in-flight scans up to SHUTDOWN_DRAIN_MS) still runs.

import { spawn } from 'node:child_process'

const children = [
  { name: 'daemon', cmd: 'node', args: ['src/index.ts'] },
  { name: 'web', cmd: 'node', args: ['dashboard/.output/server/index.mjs'] },
]

let shuttingDown = false

const procs = children.map(({ name, cmd, args }) => {
  const child = spawn(cmd, args, { stdio: 'inherit', env: process.env })
  child.on('exit', (code, signal) => {
    if (shuttingDown) return
    console.error(`[run-machine] ${name} exited (code=${code} signal=${signal}); shutting down siblings`)
    shutdown(code ?? 1)
  })
  return { name, child }
})

function shutdown(exitCode) {
  if (shuttingDown) return
  shuttingDown = true
  for (const { child } of procs) {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGTERM') } catch { /* already dead */ }
    }
  }
  // Hard deadline so a stuck child can't keep the machine alive forever.
  setTimeout(() => process.exit(exitCode), 30_000).unref()
  Promise.all(procs.map(({ child }) => new Promise(r => child.on('exit', r))))
    .then(() => process.exit(exitCode))
}

process.on('SIGTERM', () => shutdown(0))
process.on('SIGINT', () => shutdown(0))
