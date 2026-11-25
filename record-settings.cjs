#!/usr/bin/env node
// Records the settings that decide how fast a payment can be confirmed, as they were in effect for one run, so that results of
// different runs can be compared knowing what each was run with.
//
//   node record-settings.cjs <results-dir> <config>-<run> <facilitator-dir>
//
// Writes <results-dir>/settings-<config>-<run>.json and prints one line (plus a warning where something looks wrong).
//
//   facilitator   read from the facilitator's own boot line (`settle confirmation=indexer … indexPoll=250ms …`), i.e. what the
//                 process really started with, not what a .env or this script's environment asked for
//   rindexer      block_poll_frequency from qday-payment-indexer/rindexer.yaml (absent = rindexer's default, `rapid`, about every
//                 50 ms), and whether the running rindexer process was started BEFORE that file or its .env last changed: if so it
//                 is still running the old settings and needs a restart
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const [, , dir, cfgRun, facDir] = process.argv;
if (!dir || !cfgRun || !facDir) { console.error('usage: node record-settings.cjs <results-dir> <config>-<run> <facilitator-dir>'); process.exit(1); }

const logFile = path.join(dir, `facilitator-${cfgRun}.log`);
const boot = fs.existsSync(logFile)
  ? (fs.readFileSync(logFile, 'utf8').replace(/\x1b\[[0-9;]*m/g, '').split('\n').find((l) => /settle confirmation=/.test(l)) ?? '')
  : '';
const num = (name) => { const m = boot.match(new RegExp(`${name}=(\\d+)ms`)); return m ? Number(m[1]) : null; };
const facilitator = {
  confirmation: /settle confirmation=indexer/.test(boot) ? 'indexer' : /settle confirmation=rpc/.test(boot) ? 'rpc' : 'unknown',
  indexPollMs: num('indexPoll') ?? num('poll'), // `poll=` is what older builds called it
  indexTimeoutMs: num('indexTimeout') ?? num('indexBudget'),
  indexQueryTimeoutMs: num('indexQueryTimeout'),
};

const indexerDir = path.resolve(facDir, '..', 'qday-payment-indexer');
const yamlFile = path.join(indexerDir, 'rindexer.yaml');
const envFile = path.join(indexerDir, '.env');
let rindexer = { found: false };
if (fs.existsSync(yamlFile)) {
  const yaml = fs.readFileSync(yamlFile, 'utf8');
  const m = yaml.match(/^\s*block_poll_frequency:\s*(\S+)/m);
  let startedAt = null;
  try {
    const pid = execSync("pgrep -f 'rindexer start' | head -1", { encoding: 'utf8' }).trim();
    if (pid) startedAt = new Date(execSync(`ps -o lstart= -p ${pid}`, { encoding: 'utf8' }).trim()).getTime() || null;
  } catch { /* not running */ }
  const changedAt = Math.max(fs.statSync(yamlFile).mtimeMs, fs.existsSync(envFile) ? fs.statSync(envFile).mtimeMs : 0);
  rindexer = {
    found: true,
    blockPollFrequency: m ? m[1].replace(/^["']|["']$/g, '') : 'default (rapid, about every 50 ms)',
    running: startedAt !== null,
    startedAt: startedAt ? new Date(startedAt).toISOString() : null,
    configChangedAt: new Date(changedAt).toISOString(),
    stale: startedAt !== null && changedAt > startedAt, // changed after it started: the running process has the old settings
  };
}

const out = { run: cfgRun, recordedAt: new Date().toISOString(), facilitator, rindexer };
fs.writeFileSync(path.join(dir, `settings-${cfgRun}.json`), JSON.stringify(out, null, 2));

const f = facilitator;
console.log(`settings: confirmation=${f.confirmation}` +
  (f.confirmation === 'indexer' ? `  facilitator polls the DB every ${f.indexPollMs ?? '?'}ms (index wait ${f.indexTimeoutMs ?? '?'}ms)` : '') +
  (rindexer.found ? `  |  rindexer block_poll_frequency: ${rindexer.blockPollFrequency}${rindexer.running ? '' : ' (rindexer is not running!)'}` : ''));
if (rindexer.stale) console.log(`⚠️ rindexer was started ${rindexer.startedAt} but its rindexer.yaml/.env changed ${rindexer.configChangedAt}: it is still running the OLD settings. Restart it for the change to apply.`);
if (f.confirmation === 'unknown') console.log('⚠️ no "settle confirmation=" line in the facilitator log: the facilitator settings could not be read.');
