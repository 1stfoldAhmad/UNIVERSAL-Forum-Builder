#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { runCli, type CliIO } from './index';

const io: CliIO = {
  out: (s) => process.stdout.write(s + '\n'),
  err: (s) => process.stderr.write(s + '\n'),
  readFile: (p) => readFileSync(p, 'utf8'),
};

runCli(process.argv.slice(2), io).then((code) => { process.exitCode = code; });
