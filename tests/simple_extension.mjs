import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { pathToFileURL } from 'node:url';
const root=process.cwd(), directory=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'simple-offline-'));
try {
  const helperRoot=path.join(directory,'helper');fs.mkdirSync(helperRoot);
  Object.assign(process.env,{CVENT_EXECUTION_MODE:'simple',CVENT_USAGE_GUARD_ENABLED:'1',CVENT_JOB_DIR:directory,CVENT_REPO_ROOT:helperRoot,
    CVENT_AUTHORIZED_EVENT_ID:'event',CVENT_AUTHORIZED_EVENT_KEY:'event',CVENT_AUTHORIZED_EVENT_NAME:'Event',
    CVENT_LEASE_VALIDATE_URL:'http://unused.invalid',CVENT_LEASE_TOKEN:'offline',CVENT_WORKER_SLOT:'1'});
  const save=(name,value)=>fs.writeFileSync(path.join(directory,name),JSON.stringify(value));
  const load=name=>JSON.parse(fs.readFileSync(path.join(directory,name),'utf8'));
  save('browser-runtime.json',{browserRuntimeId:'runtime',executionMode:'simple'});
  save('state.json',{completed:['first'],pending:['second'],current_stage:'second'});
  save('rr-validation.json',{items:[
    {domain:'event_settings',itemId:'one',status:'VERIFIED'},
    {domain:'site_designer',itemId:'two',status:'VERIFIED'},
  ]});
  save('browser-snapshot-pending.json',{complete:false,nextChunk:99}); // legacy gates must be irrelevant
  save('domain-results.json',{domains:{event_settings:{checkpoint:'COMPLETE'}}});
  const helper=path.join(helperRoot,'browser_tool.py');
  fs.writeFileSync(helper,'print(\'BROWSER_ROUTER_RESULT={"ok":true,"actionCount":10,"writesAttempted":3,"saves":1,"readbacks":1,"logs":["native result"]}\')');
  const require=createRequire(import.meta.url);
  let source=stripTypeScriptTypes(fs.readFileSync(path.join(root,'extensions/cvent-job-tools.ts'),'utf8'));
  source=source.replace('"typebox"',JSON.stringify(pathToFileURL(require.resolve('typebox')).href))
    .replace('"./prewrite-orchestration.mjs"',JSON.stringify(pathToFileURL(path.join(root,'extensions/prewrite-orchestration.mjs')).href))
    .replace('"../ego_round_validation.mjs"',JSON.stringify(pathToFileURL(path.join(root,'ego_round_validation.mjs')).href));
  const extension=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
  // Budget arithmetic includes cache hits but never treats subscription
  // equivalents as API charges. Invalid operator settings fail closed.
  const budget=new extension.UsageBudget({},{});
  budget.record({provider:'anthropic',usage:{input:1,output:10,cacheRead:999,totalTokens:1010,cost:{total:15}}});
  assert.match(budget.reason(),/API spend/);
  const codexBudget=new extension.UsageBudget({},{});
  codexBudget.record({provider:'openai-codex',usage:{cost:{total:300}}});
  assert.equal(codexBudget.reason(),null);
  assert.equal(codexBudget.totals.estimatedSubscriptionEquivalentUsd,300);
  assert.match(new extension.UsageBudget({calls:250},{}).reason(),/Model-call/);
  assert.match(new extension.UsageBudget({totalTokens:20000000},{}).reason(),/token checkpoint/);
  assert.throws(()=>new extension.UsageBudget({},{CVENT_MAX_MODEL_CALLS:'NaN'}),/positive finite/);
  for(let i=0;i<3;i++)codexBudget.toolResult('login',{content:[{text:'not agent-owned'}]},true);
  assert.match(codexBudget.reason(),/identical/);
  codexBudget.toolResult('read',{content:[]},false);assert.equal(codexBudget.reason(),null);
  const tools=new Map(),hooks=new Map();let active=[];
  extension.default({on:(name,fn)=>hooks.set(name,fn),registerTool:tool=>tools.set(tool.name,tool),setActiveTools:names=>active=names,getActiveTools:()=>active});
  await hooks.get('session_start')();
  assert.deepEqual(active,['read','bash','cvent_open_event','cvent_login_handoff','cvent_job_update','cvent_finish']);
  assert.equal(await hooks.get('context')({messages:[]}),undefined);
  const native={command:"ego-browser nodejs <<'JS'\nconst x='RR intent'; await page.fill('@1',x);\nJS"};
  const printed=await tools.get('bash').execute('normal-no-compiler-no-metadata',native);
  assert(printed.content[0].text.startsWith('native result\n[Ego:'));
  const output=fs.readdirSync(directory).find(n=>/^ego-output-.*\.txt$/.test(n));
  assert.equal(fs.readFileSync(path.join(directory,output),'utf8'),'native result');
  const reread=await tools.get('read').execute('read-normal-output',{path:path.join(directory,output),offset:1,limit:20});
  assert(reread.content[0].text.includes('native result'));
  assert.equal(load('browser-last-script-result.json').actionCount,10);
  fs.writeFileSync(helper,'import json\nprint(\'BROWSER_ROUTER_RESULT=\'+json.dumps({"ok":True,"logs":["x"*50000]}))');
  const large=await tools.get('bash').execute('bounded-preview',native);
  assert(large.content[0].text.length < 13000);
  assert(large.content[0].text.includes('Preview truncated at 12KB'));
  const fullPath=large.content[0].text.match(/Full output: ([^;]+);/)[1];
  assert.equal(fs.readFileSync(fullPath,'utf8').length,50000);
  let retrieved='';
  for(let chunk=1;chunk<=5;chunk++){
    const page=await tools.get('read').execute('long-line-retrieval',{path:fullPath,offset:1,limit:1,chunk});
    retrieved+=page.content[0].text.split('\n[Chunk ')[0];
  }
  assert.equal(retrieved,fs.readFileSync(fullPath,'utf8'),'Every byte of a long single-line artifact remains retrievable');
  assert.equal(load('browser-last-script-result.json').logs[0].length,50000);
  const firstEvidence=printed.content[0].text.match(/structured evidence: ([^;]+);/)[1];
  const savedEvidence=await tools.get('read').execute('earlier-structured-evidence',{path:firstEvidence});
  assert.equal(JSON.parse(savedEvidence.content[0].text).actionCount,10,'Later batches must not overwrite earlier readback evidence');
  assert.equal(await hooks.get('tool_call')({toolName:'bash',input:native}),undefined);
  await tools.get('cvent_job_update').execute('own-checklist',{stage:'A Pi chosen custom section',completed:['second'],pending:['third'],action:'Continuing'});
  assert.deepEqual(load('state.json').completed,['first','second']);
  assert.equal(load('state.json').current_stage,'A Pi chosen custom section');
  const highVolume=Array.from({length:125},(_,i)=>`Workbook item ${i+1}: exact source and next action`);
  assert(tools.get('cvent_job_update').parameters.properties.pending.maxItems >= highVolume.length);
  await tools.get('cvent_job_update').execute('large-dynamic-checklist',{pending:highVolume});
  assert.deepEqual(load('state.json').pending,highVolume);
  const at='2026-01-01T00:00:00.000Z';
  const attempt={at,operation:'click#one',rrSource:'uploaded RR',eventKey:'event',result:'attempted'};
  fs.writeFileSync(path.join(directory,'scope-write-audit.jsonl'),JSON.stringify(attempt)+'\n');
  save('browser-write-readback-required.json',{executionMode:'simple',browserRuntimeId:'runtime',attempts:[attempt]});
  const auditBefore=fs.readFileSync(path.join(directory,'scope-write-audit.jsonl'),'utf8');
  const pendingBefore=fs.readFileSync(path.join(directory,'browser-write-readback-required.json'),'utf8');
  await assert.rejects(tools.get('cvent_job_update').execute('not-observed',{verification:'Saved'}),/PERSISTENCE_RECONCILIATION_REQUIRED/);
  save('browser-last-atomic-readback.json',{executionMode:'simple',browserRuntimeId:'runtime',eventKey:'event',observedAt:'2026-01-01T00:00:01.000Z',evidence:{snapshot:'unrelated footer; requested value did not persist'}});
  await assert.rejects(tools.get('cvent_job_update').execute('false-pi-verification',{verification:'All requested values match.'}),/PERSISTENCE_RECONCILIATION_REQUIRED/);
  await assert.rejects(tools.get('cvent_finish').execute('false-final-verification',{status:'DRAFT_COMPLETE',realReads:['All values persisted']}),/PERSISTENCE_RECONCILIATION_REQUIRED/);
  assert.equal(fs.readFileSync(path.join(directory,'scope-write-audit.jsonl'),'utf8'),auditBefore);
  assert.equal(fs.readFileSync(path.join(directory,'browser-write-readback-required.json'),'utf8'),pendingBefore);
  fs.writeFileSync(path.join(directory,'browser-write-readback-required.json'),'malformed');
  await assert.rejects(tools.get('cvent_job_update').execute('corrupt-marker',{verification:'Saved'}),/PERSISTENCE_RECONCILIATION_REQUIRED/);
  fs.writeFileSync(path.join(directory,'browser-write-readback-required.json'),pendingBefore);
  save('browser-mutation-uncertain.json',{reason:'response lost'});
  fs.unlinkSync(path.join(directory,'browser-write-readback-required.json'));
  await assert.rejects(tools.get('cvent_job_update').execute('uncertain-only',{verification:'Saved'}),/PERSISTENCE_RECONCILIATION_REQUIRED/);
  // Simulate independent operator reconciliation, NOT a Pi tool capability.
  save('operator-readback.json',{outcome:'NOT_PERSISTED',observed:'old value'});
  save('mutation-resolutions.json',{resolutions:[{attemptAt:at,operation:attempt.operation,rrSource:attempt.rrSource,
    actor:'operator',outcome:'NOT_PERSISTED',evidencePath:'operator-readback.json',
    evidenceSha256:createHash('sha256').update(fs.readFileSync(path.join(directory,'operator-readback.json'))).digest('hex')}]});
  fs.unlinkSync(path.join(directory,'browser-mutation-uncertain.json'));
  assert.equal(fs.readFileSync(path.join(directory,'scope-write-audit.jsonl'),'utf8'),auditBefore);
  // Upstream capability instructions are no longer readable in Simple Mode.
  for(const path of ['skills/ego-browser/SKILL.md','skills/ego-browser/references/api.md'])
    await assert.rejects(tools.get('read').execute('not-the-runtime-contract',{path:root+'/'+path}),/Read is limited/);
  // Many ordinary browser failures remain tool errors, never a controller terminal.
  fs.writeFileSync(helper,'import sys\nprint(\'BROWSER_ROUTER_RESULT={"ok":false,"error":"stale ref: page changed"}\')\nsys.exit(1)');
  for(let i=0;i<4;i++){
    await assert.rejects(tools.get('bash').execute('recoverable',native),/stale ref/);
    assert.equal(await hooks.get('tool_call')({toolName:'bash',input:native}),undefined);
  }
  assert(!fs.readdirSync(directory).some(n=>n.startsWith('controller-failure')));
  // A Cvent route error with a still-bound authenticated profile should recover
  // through the login entry point, not hand the browser to the human again.
  fs.writeFileSync(helper,`import sys,json,pathlib
op=sys.argv[sys.argv.index('--operation')+1]
flag=pathlib.Path(${JSON.stringify(path.join(directory,'normalized'))})
out={'ok':True}
if op=='pageInfo': out['page']={'url':'https://app.cvent.com/error'}
if op=='navigate': flag.write_text('1')
if op=='authStatus': out.update(authenticated=flag.exists(),workerSlot=1,profileMatch=True,accountContextMatch=True,persistedProfile=True)
print('BROWSER_ROUTER_RESULT='+json.dumps(out))
`);
  const login=await tools.get('cvent_login_handoff').execute('recover-bad-route',{reason:'Inspecting a Cvent route error'});
  assert(login.content[0].text.includes('persistedProfileReused'));
  assert(!fs.existsSync(path.join(directory,'browser-gate.json')));
  assert.deepEqual(load('state.json').completed,['first','second']);
  const final={status:'REVIEW_REQUIRED',unresolvedItems:['One RR item ambiguous; independent work completed'],domainAssessments:[
    {domain:'event_settings',outcome:'verified',allSafeWorkAttempted:true,evidence:['Persisted Event Settings readback']},
  ],realReads:['Persisted verification'],realWrites:['Changed value'],guardrails:{published:0,emailsSent:0,deletes:0,globalMutations:0}};
  await assert.rejects(tools.get('cvent_finish').execute('pending-checklist',final),/pending safe work/);
  await tools.get('cvent_job_update').execute('checklist-done',{pending:[],action:'All independent work attempted'});
  await assert.rejects(tools.get('cvent_finish').execute('finish-too-early',final),/site_designer/);
  final.domainAssessments.push({domain:'site_designer',outcome:'review_required',allSafeWorkAttempted:false,evidence:['Some work remains']});
  await assert.rejects(tools.get('cvent_finish').execute('unfinished-is-not-review',final),/Unfinished safe work/);
  // Completion checks state, not phrase matching. An honest exact exception can
  // contain 'not verified'; it must not become an endless finish/rephrase loop.
  final.domainAssessments[1].allSafeWorkAttempted=true;
  final.domainAssessments[1].evidence=['Widget not verified: exact identity was attempted three ways; Cvent exposed no event-local editable control'];
  await assert.rejects(tools.get('cvent_finish').execute('review-is-not-complete',{...final,status:'DRAFT_COMPLETE',unresolvedItems:[]}),/every populated RR domain/);
  assert.equal((await tools.get('cvent_finish').execute('finish',final)).terminate,true);
  assert.equal(load('final-report.json').status,'REVIEW_REQUIRED');
  assert.equal(load('final-report.json').reported_by,'pi');
  assert.deepEqual(load('final-report.json').domain_assessments.map(item=>item.rr_item_count),[1,1]);
  assert.deepEqual(load('state.json').completed,['first','second']);
  assert(load('final-report.json').domain_assessments.every(item=>item.all_safe_work_attempted));
  const extra={domain:'workbook_specific_requirement',outcome:'verified',allSafeWorkAttempted:true,evidence:['Reopened exact requested custom configuration; values match original sheet cells']};
  final.domainAssessments.push(extra);
  assert.equal((await tools.get('cvent_finish').execute('compiler-is-not-an-allowlist',final)).terminate,true);
  assert.equal(load('final-report.json').domain_assessments[2].rr_item_count,null);
  await assert.rejects(tools.get('cvent_finish').execute('duplicate-domain',{...final,domainAssessments:[...final.domainAssessments,extra]}),/unique non-empty/);
  await assert.rejects(tools.get('cvent_finish').execute('blank-evidence',{...final,domainAssessments:[{...extra,evidence:[' ']}]}),/non-empty Cvent evidence/);
  fs.unlinkSync(path.join(directory,'rr-validation.json'));
  const complete={...final,status:'DRAFT_COMPLETE',unresolvedItems:[],domainAssessments:[extra]};
  await assert.rejects(tools.get('cvent_finish').execute('no-compiler-empty-is-not-done',{...complete,domainAssessments:[]}),/Assess the original workbook/);
  await assert.rejects(tools.get('cvent_finish').execute('no-attempt-attestation',{...complete,domainAssessments:[{...extra,allSafeWorkAttempted:undefined}]}),/Unfinished safe work/);
  assert.equal((await tools.get('cvent_finish').execute('dynamic-without-compiler',complete)).terminate,true);
  await tools.get('cvent_job_update').execute('unfinished-after-runtime-loss',{pending:['Still safe work to do']});
  assert.equal((await tools.get('cvent_finish').execute('genuine-job-wide-blocker',{...final,status:'INCOMPLETE',jobWideBlocker:'lease_lost',blockerEvidence:'Exact worker lease validation failed before dispatch',domainAssessments:[]})).terminate,true);
  assert.deepEqual(load('state.json').pending,['Still safe work to do']);
  // A timed-out handoff must terminate the run, not invite another hour of
  // pageInfo errors while USER ownership keeps the worker lease occupied.
  const callsFile=path.join(directory,'handoff-browser-calls');
  fs.writeFileSync(helper,`import sys,json,pathlib
op=sys.argv[sys.argv.index('--operation')+1]
with pathlib.Path(${JSON.stringify(callsFile)}).open('a') as f: f.write(op+'\\n')
out={'ok':True}
if op=='pageInfo': out['page']={'url':'https://app.cvent.com/login'}
if op=='authStatus': out.update(authenticated=False,workerSlot=1,profileMatch=False)
print('BROWSER_ROUTER_RESULT='+json.dumps(out))
`);
  save('browser-gate.json',{ownership:'AGENT',desiredOwnership:'AGENT',activeActor:'NONE'});
  save('state.json',{status:'running',current_stage:'my-section',completed:['first','second'],pending:['third']});
  const originalNow=Date.now,originalTimer=globalThis.setTimeout;
  let clock=originalNow();
  Date.now=()=>clock;
  globalThis.setTimeout=(fn,ms,...args)=>{
    if(ms===1000){clock+=60*60*1000+1;return originalTimer(fn,0,...args)}
    return originalTimer(fn,ms,...args);
  };
  try {
    const expired=await tools.get('cvent_login_handoff').execute('login-timeout',{},new AbortController().signal);
    assert.equal(expired.terminate,true);
    assert(expired.content[0].text.includes('timed out'));
  } finally {Date.now=originalNow;globalThis.setTimeout=originalTimer}
  assert.equal(load('state.json').status,'login_required');
  assert.deepEqual(load('state.json').pending,['third']);
  assert.deepEqual(load('state.json').completed,['first','second']);
  assert.equal(load('browser-gate.json').ownership,'USER');
  assert.deepEqual(fs.readFileSync(callsFile,'utf8').trim().split('\n'),['pageInfo','authStatus']);
  // A second attempt while still USER-owned makes ZERO browser requests and
  // does not clear pending mutation evidence or steal browser control.
  save('browser-write-readback-required.json',{uncertain:'preserve-me'});
  const priorCalls=fs.readFileSync(callsFile,'utf8');
  const userOwned=await tools.get('cvent_login_handoff').execute('still-user-owned',{},new AbortController().signal);
  assert.equal(userOwned.terminate,true);
  assert.equal(fs.readFileSync(callsFile,'utf8'),priorCalls);
  assert.equal(load('browser-write-readback-required.json').uncertain,'preserve-me');
  assert.equal(load('browser-gate.json').ownership,'USER');
  fs.unlinkSync(path.join(directory,'browser-write-readback-required.json'));
  // A real Return-to-Agent before the deadline remains a normal continuation.
  save('browser-gate.json',{ownership:'AGENT',desiredOwnership:'AGENT',activeActor:'NONE'});
  save('state.json',{status:'running',current_stage:'my-section',completed:['first'],pending:['third']});
  globalThis.setTimeout=(fn,ms,...args)=>{
    if(ms===1000){save('browser-gate.json',{ownership:'AGENT',desiredOwnership:'AGENT',activeActor:'NONE'});return originalTimer(fn,0,...args)}
    return originalTimer(fn,ms,...args);
  };
  try {
    const resumed=await tools.get('cvent_login_handoff').execute('normal-return',{},new AbortController().signal);
    assert.notEqual(resumed.terminate,true);
    assert.equal(load('state.json').status,'running');
    assert.equal(load('state.json').current_stage,'my-section');
  } finally {globalThis.setTimeout=originalTimer}
  // Usage checkpoint blocks every sibling tool, including a false finish,
  // preserves pending mutation evidence, and survives a session restart.
  save('browser-write-readback-required.json',{uncertain:'must-not-clear'});
  await hooks.get('message_end')({message:{role:'assistant',provider:'anthropic',model:'test',content:[],usage:{input:5,cacheRead:1000,totalTokens:1005,cost:{total:16}}}});
  assert.equal(load('token-usage.json').totals.cacheRead,1000);
  for(const name of ['bash','cvent_finish','cvent_login_handoff']){
    const stopped=await hooks.get('tool_call')({toolName:name,input:{}});
    assert.equal(stopped.block,true);assert.equal(stopped.terminate,true);
  }
  assert.equal(load('browser-write-readback-required.json').uncertain,'must-not-clear');
  assert.match(load(`usage-budget-stop-${process.pid}.json`).reason,/API spend/);
  await hooks.get('session_start')();
  assert.equal((await hooks.get('tool_call')({toolName:'bash',input:native})).terminate,true);
  console.log('Simple extension: persistence holds, dynamic coverage, handoff, bounded previews and usage checkpoints PASS');
} finally {fs.rmSync(directory,{recursive:true,force:true})}
