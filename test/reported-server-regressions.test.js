"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const vm = require('node:vm');
const { mungeCwd } = require('../lib/telemetry');
const { createGitStatus } = require('../lib/gitstatus');
const { resolveCodexRollout } = require('../lib/codex-telemetry');

function terminalWith(t, result) {
  const name = require.resolve('../lib/terminal');
  const cached = require.cache[name];
  const exec = cp.execFile;
  cp.execFile = (_bin,args,_opts,cb) => queueMicrotask(() => {
    const r = result(args.filter(x => x !== '-u'));
    cb(r.ok ? null : Object.assign(new Error('tmux failed'),{code:r.code || 1}),r.stdout || '',r.stderr || '');
  });
  delete require.cache[name]; const terminal = require(name); cp.execFile = exec;
  t.after(() => { delete require.cache[name]; if(cached) require.cache[name]=cached; });
  return terminal;
}
test('a transient tmux listing failure rejects instead of erasing the fleet', async t => {
  const T=terminalWith(t,()=>({ok:false,code:'ETIMEDOUT',stderr:''}));
  await assert.rejects(T.listSessions());
});
test('a confirmed empty tmux server remains an authoritative empty fleet', async t => {
  const T=terminalWith(t,()=>({ok:false,stderr:'no server running on /tmp/fixture'}));
  assert.deepEqual(await T.listSessions(),[]);
});
test('an inconclusive kill probe keeps the saved tab', async t => {
  const registry=require('../lib/registry'); let removals=0;
  t.mock.method(registry,'remove',()=>{removals++;return true;});
  const T=terminalWith(t,()=>({ok:false,code:'ETIMEDOUT',stderr:''}));
  assert.equal((await T.killSession('cdtimeout')).ok,false);
  assert.equal(removals,0);
});
test('kill reports failed persistence even after tmux confirms the session is gone', async t => {
  const registry=require('../lib/registry');
  t.mock.method(registry,'remove',()=>false);
  const T=terminalWith(t,()=>({ok:true}));
  const r=await T.killSession('cdclosed');
  assert.equal(r.ok,false); assert.match(r.error,/sav|registr|persist|forget/i);
});
test('Claude project folders encode punctuation and non-ASCII characters', () => {
  assert.equal(mungeCwd('/tmp/a b@c+d/雪'),'-tmp-a-b-c-d--');
  assert.equal(mungeCwd('C:\\'),'C--');
});
test('background git probes disable optional index locking without dropping environment', async () => {
  let options;
  const g=createGitStatus({execFileFn:(_file,_args,opts,cb)=>{options=opts;queueMicrotask(()=>cb(null,''));}});
  g.get('/fixture'); await g.flush();
  assert.equal(options.env?.GIT_OPTIONAL_LOCKS,'0');
  assert.equal(options.env.PATH,process.env.PATH);
});
test('repeated missing Codex rollout reads do not rewalk the tree until a bounded retry', t => {
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'scheme-rollout-miss-'));
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const uuid='11111111-2222-3333-4444-555555555555';
  let now=1000, scans=0;
  t.mock.method(Date,'now',()=>now);
  const read=fs.readdirSync;
  t.mock.method(fs,'readdirSync',(...args)=>{scans++;return read(...args);});
  assert.equal(resolveCodexRollout(uuid,base),null); const first=scans;
  assert.equal(resolveCodexRollout(uuid,base),null); assert.equal(scans,first);
  fs.writeFileSync(path.join(base,`rollout-fixture-${uuid}.jsonl`),'{}\n');
  now+=60000;
  assert.ok(resolveCodexRollout(uuid,base)?.path);
});
test('deferred retirement never schedules an overflowing native timer', () => {
  const durations=[];
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../lib/closetab'),'utf8'),{
    module,require: name => name==='./terminal' ? {killSession:()=>{throw Error('early kill');}} : {appendEntry(){}},
    setTimeout:(_fn,ms)=>durations.push(ms),process,
  });
  module.exports.main(['--id','cdwait','--after','2147484']);
  assert.ok(durations.every(ms=>ms<=2147483647));
});
test('launcher explains a missing --port value', () => {
  const r=cp.spawnSync('bash',[path.join(__dirname,'../bin/scheme'),'--port'],{encoding:'utf8'});
  assert.equal(r.status,2); assert.match(r.stderr,/port.*(value|number|required)/i);
  assert.doesNotMatch(r.stderr,/unbound variable/);
});


test('launch prompt quoting survives backslashes and quotes in fish and POSIX shells', t => {
  const T=require('../lib/terminal');
  const fish=process.env.SCHEME_TEST_FISH;
  for (const shell of ['sh','bash',...(fish ? [fish] : [])]) {
    for(const value of ['tail\\', "slash\\'quote", 'double\\\\slash', '$HOME $(printf bad)', '`printf bad`', 'snow 雪']) {
      const args=[...(shell===fish ? ['--no-config'] : []),'-c',`printf '%s' ${T.shquote(value)}`];
      const r=cp.spawnSync(shell,args,{encoding:'utf8'});
      assert.equal(r.status,0,r.stderr);
      assert.equal(r.stdout,value,`${path.basename(shell)} roundtrip`);
    }
  }
});

test('rename and reorder report registry failures instead of claiming a saved change', async t => {
  const registry=require('../lib/registry');
  t.mock.method(registry,'reorder',()=>false); t.mock.method(registry,'setLabel',()=>false);
  const T=terminalWith(t,()=>({ok:true}));
  assert.equal(T.reorder(['cdone']).ok,false);
  assert.equal((await T.renameSession('cdone','new name')).ok,false);
});
