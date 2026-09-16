#!/usr/bin/env node
/** Ego direct-tool adapter pinned to the canonical Steel Chromium target. */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { planNativeRound, validateAtomicSteps, sourceForAction, isDataAction, planningError } from './ego_round_validation.mjs';
import { inspectRegistrationTypeCapabilities, runTrustedCventProcedure } from './trusted_cvent_procedures.mjs';
const argv=process.argv.slice(2);const arg=n=>argv[argv.indexOf(n)+1];
const runtimePath=arg('--runtime');const operation=arg('--operation');const params=JSON.parse(arg('--params')||'{}');
function output(value,ok=true){return new Promise((resolve,reject)=>{const failed=typeof value==='object'&&value?value:{error:String(value)};process.stdout.write('BROWSER_TOOL_RESULT='+JSON.stringify(ok?{ok:true,tool:'ego',operation,...value}:{ok:false,tool:'ego',operation,...failed,error:String(failed.error??value)})+'\n',error=>error?reject(error):resolve())})}
// Keep the browser-only boundary: no host function, Promise, Error or object
// prototype enters model JavaScript. Node vm alone is NOT a security boundary.
function simpleScriptContext(run,logs,rr,desired,runtime,targetId){
  const context=vm.createContext(Object.create(null),{codeGeneration:{strings:false,wasm:false}});
  context.__bridge=async encoded=>{
    try{const {op,args}=JSON.parse(encoded);if(op==='console'){logs.push(args.values.map(v=>typeof v==='string'?v:JSON.stringify(v)).join(' '));return JSON.stringify({ok:true,value:null})}return JSON.stringify({ok:true,value:await run(op,args)})}
    catch(error){return JSON.stringify({ok:false,error:String(error?.message||error)})}
  };
  const seed={spaceId:runtime.browserRuntimeId,targetId,rr,desired};
  vm.runInContext(`((bridge,seed)=>{
    const run=async(op,args={})=>{const r=JSON.parse(await bridge(JSON.stringify({op,args})));if(!r.ok)throw new Error(r.error);return r.value};
    const sel=v=>typeof v==='string'?v.replace(/^loc=role:/,'role:').replace(/^loc=css:/,''):v;
    const point=v=>Array.isArray(v)?{x:v[0],y:v[1]}:{x:v.x,y:v.y};
    const blocked=()=>{throw new Error('Raw evaluate/CDP/network/process and other pages are unavailable. Use readTarget(\"@ref\") or locator read methods for compact field/link/editor state, page.snapshot() for semantic state, and page.screenshot() for visual state')};
    const capability=message=>{throw new Error('EGO_CAPABILITY_UNAVAILABLE: '+message)};
    const read=v=>run('readTarget',{target:sel(v)});
    let page;
    const locator=v=>Object.freeze({
      click:(o={})=>page.click(v,o),dblclick:(o={})=>page.dblclick(v,o),fill:text=>page.fill(v,text),focus:()=>page.focus(v),hover:()=>page.hover(v),press:key=>page.press(v,key),
      inputValue:async()=>(await read(v)).value,textContent:async()=>(await read(v)).text,innerText:async()=>(await read(v)).text,
      innerHTML:async()=>{const state=await read(v);if(state.html===null||state.html===undefined)capability('innerHTML is limited to editable rich-text controls');return state.html},
      getAttribute:async name=>{const state=await read(v);if(!Object.prototype.hasOwnProperty.call(state.attributes||{},String(name)))capability('attribute '+JSON.stringify(name)+' is outside the safe compact-read allowlist');return state.attributes[String(name)]},
      isChecked:async()=>Boolean((await read(v)).checked),isEnabled:async()=>Boolean((await read(v)).enabled),isVisible:async()=>Boolean((await read(v)).visible),
    });
    page={label:'p1',spaceId:seed.spaceId,targetId:seed.targetId,openedBy:'agent',
      info:async()=>(await run('pageInfo')).page,url:async()=>(await run('pageInfo')).page.url,title:async()=>(await run('pageInfo')).page.title,
      snapshot:async(options={})=>(await run('snapshotText',{options})).snapshot,
      screenshot:async(options={})=>(await run('screenshot',{fullPage:options.fullPage===true})).screenshotPath,
      goto:(url,o={})=>run('navigate',{url,waitUntil:o.waitUntil,timeoutSeconds:o.timeout?o.timeout/1000:undefined}),
      reload:async()=>page.goto(await page.url()),locator,readTarget:read,
      getByRole:(role,o={})=>locator('role:'+role+'[name='+JSON.stringify(String(o.name??''))+']'),
      click:(v,o={})=>typeof v==='object'?run('visualClick',{...point(v),label:o.label}):run('click',{target:sel(v),label:o.label}),
      dblclick:(v,o={})=>typeof v==='object'?run('visualDoubleClick',{...point(v),label:o.label}):run('dblclick',{target:sel(v),label:o.label}),
      fill:(v,text)=>run('fill',{target:sel(v),text}),focus:v=>run('focus',{target:sel(v)}),hover:v=>run('hover',{target:sel(v)}),
      press:(v,key)=>run('press',{target:sel(v),key}),
      selectOption:(v,optionSpec)=>run('selectOption',{target:sel(v),optionSpec}),
      setChecked:(v,checked)=>run('setChecked',{target:sel(v),checked}),
      dragAndDrop:(from,to)=>run('drag',{target:sel(from),destination:sel(to)}),
      setInputFiles:(v,filePath)=>run('uploadDiscountImport',{target:sel(v),filePath}),
      waitForTimeout:ms=>run('wait',{ms}),waitForLoadState:(loadState='load',o={})=>run('wait',{loadState,ms:o.timeout??30000}),
      waitForSelector:(v,o={})=>run('wait',{target:sel(v),ms:o.timeout??30000,state:o.state}),
      waitForURL:async(value,o={})=>{const end=Date.now()+(o.timeout??30000);while(Date.now()<end){const url=await page.url();if(typeof value==='string'?url===value:value.test(url))return url;await page.waitForTimeout(200)}throw new Error('Timed out waiting for URL')},
      waitForEvent:event=>capability(event==='popup'?'popup waits are not provided by the installed Linux helper; the observed Cvent Site Designer opens in assigned Page p1, so click it and inspect task.tabs()':'only the assigned Cvent Page and audited job uploads are available; '+JSON.stringify(event)+' events are not exposed'),
      acceptDialog:()=>capability('native-dialog acceptance is not exposed because it can commit an unverified action'),dismissDialog:()=>capability('native dialogs require user control through cvent_login_handoff'),
      evaluate:blocked,fetch:blocked,cdp:blocked,close:blocked,
    };
    page.mouse={click:(x,y,o={})=>run(o.clickCount===2?'visualDoubleClick':'visualClick',{x,y,label:o.label}),wheel:(dx,dy)=>run('scroll',{deltaX:dx,deltaY:dy}),move:(x,y)=>run('visualHover',{x,y}),down:()=>capability('free-form mouse down/up is unavailable; use dragAndDrop or dragMouse so both endpoints are checked'),up:()=>capability('free-form mouse down/up is unavailable; use dragAndDrop or dragMouse so both endpoints are checked')};
    page.keyboard={press:key=>run('press',{key}),type:text=>run('typeText',{text}),insertText:text=>run('typeText',{text}),paste:text=>typeof text==='string'?run('typeText',{text}):capability('rich HTML clipboard input is unavailable; use plain text keyboard input'),down:key=>run('keyDown',{key}),up:key=>run('keyUp',{key})};
    const task={spaceId:seed.spaceId,name:'assigned Cvent job',ownership:'agent',page:label=>{if(label!=='p1')throw new Error('Only assigned Page p1 is available');return page},userPage:()=>page,pages:async()=>[page],tabs:async()=>[{label:'p1',page,targetId:seed.targetId,title:await page.title(),url:await page.url(),active:true,openedBy:'agent'}],adopt:()=>page,newPage:blocked,release:blocked,cdp:blocked,waitForControl:async()=>true,handOff:()=>{throw new Error('Use cvent_login_handoff / Take Control')},finish:async()=>({keep:true})};
    const log=(...values)=>{void run('console',{values})};
    Object.assign(globalThis,{page,taskSpace:async()=>task,rr:seed.rr,desired:seed.desired,console:{log,warn:log,error:log},cliLog:log,
      pageInfo:page.info,snapshotText:page.snapshot,captureScreenshot:page.screenshot,readTarget:target=>run('readTarget',{target:sel(target)}),
      gotoAndWait:page.goto,openOrReuseTab:page.goto,click:page.click,doubleClick:page.dblclick,fillInput:page.fill,typeText:page.keyboard.type,pressKey:page.keyboard.press,selectOption:page.selectOption,setChecked:page.setChecked,hover:page.hover,
      scrollBy:dy=>run('scroll',{deltaY:dy}),scroll:({dy})=>run('scroll',{deltaY:dy}),wait:seconds=>run('wait',{ms:seconds*1000}),waitForElement:page.waitForSelector,
      dragMouse:points=>run('visualDrag',{...point(points[0]),toX:point(points[1]).x,toY:point(points[1]).y})});
  })(__bridge,JSON.parse(${JSON.stringify(JSON.stringify(seed))}));delete globalThis.__bridge;`,context,{timeout:10000});
  return context;
}
function roleRequest(target){
  const match=String(target||'').match(/^role:([a-z][a-z0-9_-]*)\[name=(?:"([^"]+)"|'([^']+)'|([^\]]+))\]$/i);
  return match?{role:match[1].toLowerCase(),name:(match[2]??match[3]??match[4]??'').trim()}:null;
}
const snapshotCachePath=runtimePath?path.join(path.dirname(path.resolve(runtimePath)),'browser-snapshot-cache.json'):null;
function readSnapshotCache(){
  try{const info=fs.lstatSync(snapshotCachePath);if(!info.isFile()||info.isSymbolicLink()||info.size>3*1024*1024)return null;return JSON.parse(fs.readFileSync(snapshotCachePath,'utf8'))}catch{return null}
}
function writeSnapshotCache(value){
  const temporary=`${snapshotCachePath}.${process.pid}.tmp`;fs.writeFileSync(temporary,JSON.stringify(value),{encoding:'utf8',mode:0o600,flag:'wx'});fs.renameSync(temporary,snapshotCachePath);fs.chmodSync(snapshotCachePath,0o600);
}
if(snapshotCachePath&&['script','actions','click','activate','visualClick','visualDoubleClick','fill','type','typeText','navigate','selectOption','setChecked','press','drag','visualDrag','uploadDiscountImport','recover','openAuthorizedEvent','inspectRegistrationTypeCapabilities','configureAdmissionItems','configureRegistrationTypes'].includes(operation)){try{fs.unlinkSync(snapshotCachePath)}catch(error){if(error?.code!=='ENOENT')throw error}}
if(!runtimePath||!operation){await output('Explicit --runtime and --operation are required',false);process.exit(2)}
const runtime=JSON.parse(fs.readFileSync(runtimePath,'utf8'));
const simple=runtime.executionMode==='simple';
const jobPath=path.dirname(runtimePath),pendingPath=path.join(jobPath,'browser-write-readback-required.json');
const rrSha256=simple&&fs.existsSync(path.join(jobPath,'input.xlsx'))?createHash('sha256').update(fs.readFileSync(path.join(jobPath,'input.xlsx'))).digest('hex'):null;
const unsafeActionURL=url=>/(?:^|[/?&=_-])(?:delete|archive|remove|publish|go[-_]?live|send|test[-_]?send|sendemail|sendmail|eventcreation|newevent|createevent|copyevent|cloneevent)(?:[/?&=_-]|$)/i.test(String(url));
const cdpOrigin=new URL(runtime.cdpHttpOrigin);process.env.EGO_BROWSER_CDP_HOST=cdpOrigin.hostname;process.env.EGO_BROWSER_CDP_PORT=cdpOrigin.port;
// Failure reporting lives outside try: startup, action, and postflight errors
// must retain their original cause and every successfully completed action.
const completedActions=[];
let writesAttempted=0,actionIndex=-1,dirty=false,saved=false,saves=0,readbacks=0;
try{
  const ego=await import('./vendor/ego-browser-linux/dist/src/helpers.js');
  const tabs=await ego.listTabs();
  const wanted=runtime.targetBrowserIdentity.targetId;
  const tab=tabs.find(t=>(t.targetId||t.id)===wanted);
  if(!tab)throw new Error('Canonical BrowserRuntime target is not available');
  await ego.switchTab(wanted);
  const marker=await ego.evaluate("window.__CVENT_BROWSER_RUNTIME_ID || (window.name.startsWith('cvent-runtime-') ? window.name : null)");
  if(marker!==runtime.browserRuntimeId)throw new Error('Ego marker mismatch — cross-browser routing blocked');
  const normalize=value=>String(value??'').replace(/\s+/g,' ').trim();
  async function dispatch(step,callback){
    if(step.intent!=='write')return callback();
    if(simple){
      assertSimpleMutationAllowed();
      const record={at:new Date().toISOString(),operation:step.operation,target:step.target,rrSource:'uploaded RR',rrSha256,eventKey:runtime.authorizedEventKey,url:(await ego.pageInfo()).url,request:{text:step.text,option:step.optionSpec??step.option,checked:step.checked,key:step.key},dataChange:!!step.dataChange,isSave:!!step.isSave,potentiallyPersisted:!!step.persistencePossible};
      if(step.dataChange||step.persistencePossible)writesAttempted++;
      if(step.persistencePossible){
        record.operation += '#'+Date.now()+'-'+actionIndex;
        const pending=privateJson(pendingPath)||{executionMode:'simple',browserRuntimeId:runtime.browserRuntimeId,attempts:[]};
        pending.attempts.push(record);writePrivateJson(pendingPath,pending);
        appendSimpleAudit({...record,result:'attempted'});
      }else appendSimpleAudit({...record,result:'ui_action_attempted'});
      try{const value=await callback();appendSimpleAudit({...record,result:'ui_action_completed'});return value}
      catch(error){
        if(step.persistencePossible||fs.existsSync(pendingPath))latchSimpleMutation(error);
        appendSimpleAudit({...record,result:'ui_action_error',error:String(error)});throw error;
      }
    }
    try{const value=await callback();writesAttempted++;return value}
    catch(error){writesAttempted++;throw error}
  }
  const eventKey=url=>{try{const parsed=new URL(url),keys=[...parsed.searchParams].filter(([name])=>['evtstub','eventid','event'].includes(name.toLowerCase())).map(([,value])=>value.trim().toLowerCase());if(keys.length)return keys[0]&&keys.every(key=>key===keys[0])?keys[0]:null;return parsed.pathname.match(/\/events\/([0-9a-f-]{20,})/i)?.[1]?.toLowerCase()??null}catch{return null}};
  const protectedPath=simple?/(?:^|\/)(?:attendees?|invitees?|contacts?|contact[-_]?types?|account(?:settings)?|organization|admin|global|library|profiles?)(?:\/|$)/i:/(?:^|\/)(?:attendees?|invitees?|contacts?|contact[-_]?types?|communications?|emails?|messages?|account(?:settings)?|organization|admin|global|library|profiles?)(?:\/|$)/i;
  const contextPath=path.join(path.dirname(runtimePath),'authorized-event-context.json'),transitionPath=path.join(path.dirname(runtimePath),'authorized-event-transition.json'),targetPath=path.join(path.dirname(runtimePath),'authorized-target.json');
  const privateJson=file=>{try{const stat=fs.lstatSync(file);return stat.isFile()&&!stat.isSymbolicLink()&&stat.size<1024*1024?JSON.parse(fs.readFileSync(file,'utf8')):null}catch{return null}};
  const writePrivateJson=(file,value)=>{const temporary=`${file}.${process.pid}.tmp`;fs.writeFileSync(temporary,JSON.stringify(value,null,2),{encoding:'utf8',mode:0o600,flag:'wx'});fs.renameSync(temporary,file);fs.chmodSync(file,0o600)};
  const uncertainPath=path.join(jobPath,'browser-mutation-uncertain.json');
  const present=file=>{try{fs.lstatSync(file);return true}catch(error){if(error.code==='ENOENT')return false;throw error}};
  function inheritedMutationHold(){
    // Same audit/resolution vocabulary as mutation_outcome.py. No new ledger.
    // Missing/corrupt markers must not hide an unmatched durable attempt.
    try{
      if(present(pendingPath)||present(uncertainPath))return 'inherited pending/uncertain mutation';
      const resolutionsPath=path.join(jobPath,'mutation-resolutions.json');
      const resolutions=present(resolutionsPath)?privateJson(resolutionsPath)?.resolutions:[];
      if(!Array.isArray(resolutions))throw Error('invalid resolutions');
      const resolved=new Set(),root=fs.realpathSync(jobPath)+path.sep;
      for(const resolution of resolutions){
        const evidence=fs.realpathSync(path.resolve(jobPath,resolution.evidencePath));
        if(resolution.actor!=='operator'||!['PERSISTED','NOT_PERSISTED'].includes(resolution.outcome)||
           !evidence.startsWith(root)||!fs.statSync(evidence).isFile()||
           createHash('sha256').update(fs.readFileSync(evidence)).digest('hex')!==resolution.evidenceSha256)throw Error('invalid operator evidence');
        resolved.add(JSON.stringify([resolution.attemptAt,resolution.operation,resolution.rrSource]));
      }
      const auditPath=path.join(jobPath,'scope-write-audit.jsonl'),counts=new Map();
      if(present(auditPath))for(const line of fs.readFileSync(auditPath,'utf8').split('\n').filter(line=>line.trim())){
        const item=JSON.parse(line),key=JSON.stringify([String(item.operation??''),String(item.rrSource||'')]);
        let delta=['attempted','failed','uncertain'].includes(item.result)?1:['succeeded','rejected_prewrite'].includes(item.result)?-1:0;
        if(item.result==='attempted'&&resolved.has(JSON.stringify([item.at,String(item.operation??''),String(item.rrSource||'')])))delta--;
        counts.set(key,(counts.get(key)||0)+delta);
      }
      if([...counts.values()].some(count=>count>0))return 'unresolved durable mutation audit';
      return null;
    }catch{return 'unreadable mutation evidence';}
  }
  const inheritedHold=simple?inheritedMutationHold():null;
  let mutationLatched=false;
  function latchSimpleMutation(error){
    mutationLatched=true; // Survives a caught JS exception even if disk I/O fails.
    if(!present(uncertainPath))writePrivateJson(uncertainPath,{executionMode:'simple',at:new Date().toISOString(),
      browserRuntimeId:runtime.browserRuntimeId,eventKey:runtime.authorizedEventKey,
      operation:'script',actionIndex,error:String(error).slice(-800)});
  }
  function assertSimpleMutationAllowed(){
    if(inheritedHold||mutationLatched||present(uncertainPath))throw Error('MUTATION_RECONCILIATION_REQUIRED: '+(inheritedHold||'ambiguous post-dispatch failure')+'; only read-only reconciliation is permitted');
    const holdsPath=path.join(jobPath,'replay-holds.json');
    if(present(holdsPath)){
      const document=privateJson(holdsPath);
      // Dynamic scripts do not supply trustworthy object attribution. Fail
      // closed for event holds rather than matching identities in source text.
      if(!document||document.eventKey!==runtime.authorizedEventKey||!Array.isArray(document.holds)||document.holds.length)
        throw Error('MATCH_UNCERTAIN_HUMAN_REVIEW: event replay holds block Simple Mode mutations; read-only inspection remains available');
    }
  }
  const jobEvidence=name=>{const file=path.join(jobPath,name);try{const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.size>25*1024*1024)throw Error('Unsafe RR evidence artifact');return JSON.parse(fs.readFileSync(file,'utf8'))}catch(error){if(error.code==='ENOENT')return null;throw error}};
  const appendSimpleAudit=record=>fs.appendFileSync(path.join(jobPath,'scope-write-audit.jsonl'),JSON.stringify(record)+'\n',{mode:0o600});
  const targetBound=()=>{const lock=privateJson(targetPath),expected=String(runtime.authorizedEventKey||'').toLowerCase();return lock?.browser_runtime_id===runtime.browserRuntimeId&&String(lock.event_key||'').toLowerCase()===expected&&lock.name===runtime.authorizedEventName};
  const sameRoute=(left,right)=>{try{const a=new URL(left),b=new URL(right);return a.origin===b.origin&&a.pathname.replace(/\/$/,'')===b.pathname.replace(/\/$/,'')&&a.search===b.search}catch{return false}};
  async function eventIdentityEvidence(){
    const info=await ego.pageInfo(),url=new URL(info.url),expected=String(runtime.authorizedEventKey||'').toLowerCase();
    const visibleResult=await ego.evaluate(`(() => {const expected=${JSON.stringify(String(runtime.authorizedEventName||''))},key=${JSON.stringify(String(runtime.authorizedEventKey||'').toLowerCase())},keys=[],push=value=>{try{const u=new URL(value,location.href);for(const [name,item] of u.searchParams)if(['evtstub','eventid','event'].includes(name.toLowerCase())&&item)keys.push(item.toLowerCase());const match=u.pathname.match(/\\/events\\/([0-9a-f-]{20,})/i);if(match)keys.push(match[1].toLowerCase())}catch{}};for(const element of document.querySelectorAll('a[href],form[action]'))push(element.href||element.action);for(const input of document.querySelectorAll('input[type=hidden]'))if(/^(?:evtstub|eventid|event)$/i.test(input.name||input.id||''))keys.push(String(input.value||'').toLowerCase());const body=(document.body?.innerText||'').slice(0,100000),headings=[document.title,...document.querySelectorAll('h1,h2,[role=heading]')].map(value=>typeof value==='string'?value:value.innerText||value.textContent||'');return {ready:document.readyState,hasSelectedName:Boolean(expected)&&body.includes(expected),hasSelectedHeading:Boolean(expected)&&headings.some(value=>String(value).includes(expected)),hasLogin:/(?:sign in|log in|enter your password|verify your identity|authenticator)/i.test(body),keys:[...new Set(keys)].slice(0,200),hasExpectedKey:keys.includes(key)}})()`);
    const visible={keys:[],hasLogin:false,hasExpectedKey:false,...(visibleResult??{})};
    const currentKey=eventKey(info.url),direct=currentKey===expected,isInventory=/\/events2\/eventselection/i.test(url.pathname),protectedCurrent=protectedPath.test(url.pathname),conflictingKey=Boolean(currentKey&&currentKey!==expected);
    const context=privateJson(contextPath),transition=privateJson(transitionPath),now=Date.now();
    const contextBound=context?.schemaVersion===1&&context.browserRuntimeId===runtime.browserRuntimeId&&String(context.eventKey||'').toLowerCase()===expected&&now-Date.parse(context.provenAt||0)<=30*60*1000;
    const safeTransitionDestination=sameRoute(info.url,transition?.toUrl)||((url.hostname==='cvent.com'||url.hostname.endsWith('.cvent.com'))&&!protectedCurrent);
    const transitionBound=transition?.schemaVersion===1&&transition.browserRuntimeId===runtime.browserRuntimeId&&String(transition.eventKey||'').toLowerCase()===expected&&now-Date.parse(transition.createdAt||0)<=5*60*1000&&contextBound&&context.url===transition.fromUrl&&safeTransitionDestination;
    const persistedCurrent=contextBound&&context.url===info.url;
    const proven=Boolean(expected)&&!isInventory&&!protectedCurrent&&!visible.hasLogin&&!conflictingKey&&(direct||persistedCurrent||transitionBound);
    return {proven,page:info,direct,isInventory,protectedCurrent,visible,conflictingKey,persistedCurrent,transitionBound};
  }
  async function rememberAuthorizedPage(evidence){
    if(!evidence?.proven)return;
    const temporary=`${contextPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary,JSON.stringify({schemaVersion:1,browserRuntimeId:runtime.browserRuntimeId,eventKey:String(runtime.authorizedEventKey).toLowerCase(),eventName:runtime.authorizedEventName,url:evidence.page.url,title:evidence.page.title,provenAt:new Date().toISOString(),evidence:{direct:evidence.direct,hasExpectedKey:evidence.visible?.hasExpectedKey,hasSelectedName:evidence.visible?.hasSelectedName,hasSelectedHeading:evidence.visible?.hasSelectedHeading,persistedCurrent:evidence.persistedCurrent,transitionBound:evidence.transitionBound,bootstrap:evidence.bootstrap??null}}),{encoding:'utf8',mode:0o600,flag:'wx'});fs.renameSync(temporary,contextPath);fs.chmodSync(contextPath,0o600);try{fs.unlinkSync(transitionPath)}catch(error){if(error?.code!=='ENOENT')throw error}
  }
  async function stageAuthorizedTransition(destination){
    const before=await eventIdentityEvidence();if(!before.proven)throw Error('Navigation blocked: source page does not prove the exact selected event');
    const to=new URL(destination,before.page.url),host=to.hostname.toLowerCase(),expected=String(runtime.authorizedEventKey||'').toLowerCase(),key=eventKey(to.href);
    if(to.protocol!=='https:'||!(host==='cvent.com'||host.endsWith('.cvent.com'))||protectedPath.test(to.pathname)||key&&key!==expected)throw Error('Navigation outside exact selected event blocked');
    let observed=Boolean(key===expected);
    if(!observed)observed=await ego.evaluate(`(() => {const wanted=${JSON.stringify(to.href)},same=(value)=>{try{const a=new URL(value,location.href),b=new URL(wanted);return a.origin===b.origin&&a.pathname.replace(/\/$/,'')===b.pathname.replace(/\/$/,'')&&a.search===b.search}catch{return false}};return [...document.querySelectorAll('a[href],form[action]')].some(element=>same(element.href||element.action))})()`);
    if(!observed){const routes=privateJson(path.join(path.dirname(runtimePath),'cvent-route-cache.json'));observed=Object.values(routes?.routes||{}).some(route=>route?.browserRuntimeId===runtime.browserRuntimeId&&sameRoute(route.url,to.href))}
    if(!observed)throw Error('Navigation blocked: keyless Cvent route has no verified event-local relationship');
    const temporary=`${transitionPath}.${process.pid}.tmp`;fs.writeFileSync(temporary,JSON.stringify({schemaVersion:1,browserRuntimeId:runtime.browserRuntimeId,eventKey:expected,fromUrl:before.page.url,toUrl:to.href,createdAt:new Date().toISOString()}),{encoding:'utf8',mode:0o600,flag:'wx'});fs.renameSync(temporary,transitionPath);fs.chmodSync(transitionPath,0o600);return to.href;
  }
  async function assertLease(){
    const endpoint=process.env.CVENT_LEASE_VALIDATE_URL,jobId=process.env.CVENT_JOB_ID,token=process.env.CVENT_LEASE_TOKEN,eventId=runtime.authorizedEventId;
    if(!jobId&&process.env.CVENT_ENV!=='production')return;
    if(!endpoint||!jobId||!token||!eventId)throw new Error('Write blocked: action round lease context is absent');
    const url=new URL(endpoint);if(!['127.0.0.1','localhost','::1'].includes(url.hostname)||!['http:','https:'].includes(url.protocol))throw new Error('Write blocked: lease validator is not loopback');
    url.searchParams.set('job_id',jobId);url.searchParams.set('event_id',eventId);
    const response=await fetch(url,{headers:{'X-CVENT-Lease-Token':token},signal:AbortSignal.timeout(5000)});
    if(response.status!==204)throw new Error('Write blocked: canonical event lease is no longer active');
  }
  async function assertAuthenticatedReadContext(){
    const info=await ego.pageInfo(),url=new URL(info.url),host=url.hostname.toLowerCase();
    if(url.protocol!=='https:'||!(host==='cvent.com'||host.endsWith('.cvent.com'))||url.username||url.password||url.port&&url.port!=='443')throw new Error('Read blocked: authenticated Cvent context is required');
    const login=await ego.evaluate(`(() => {const text=(document.body?.innerText||'').slice(0,50000);return /(?:sign in|log in|enter your password|verify your identity|authenticator)/i.test(text)||/(?:login|signin|authenticate|sso)/i.test(location.href)})()`);
    if(login===true)throw new Error('AUTH_REQUIRED: current Cvent authentication is unavailable');
    return {page:info,state:'AUTHENTICATED_UNBOUND'};
  }
  async function assertAuthorizedPage(){
    const evidence=await eventIdentityEvidence(),url=new URL(evidence.page.url),host=url.hostname.toLowerCase();
    if(url.protocol!=='https:'||!(host==='cvent.com'||host.endsWith('.cvent.com'))||!evidence.proven)throw new Error('Write blocked: current Cvent page does not prove the exact selected event');
    if(protectedPath.test(url.pathname))throw new Error('Write blocked: protected Cvent area');
    await rememberAuthorizedPage(evidence);return evidence;
  }
  async function resolveTarget(request){
    let target=request.target,descriptor,fallbackUsed=false;
    try{descriptor=await ego.evaluateLocator(target,(element)=>{const id=element.id,label=id?document.querySelector('label[for="'+CSS.escape(id)+'"]'):element.closest('label');return {tag:element.tagName,role:element.getAttribute('role'),text:(element.innerText||element.textContent||'').trim().slice(0,500),label:(label?.innerText||label?.textContent||'').trim().slice(0,500),aria:element.getAttribute('aria-label'),title:element.getAttribute('title'),name:element.getAttribute('name'),documentUrl:element.ownerDocument.location.href,type:element.getAttribute('type'),editable:element.isContentEditable,controlValue:element.tagName==='INPUT'&&/^(?:submit|button|reset)$/i.test(element.type)?element.value:null,href:element instanceof HTMLAnchorElement?element.href:null,disabled:'disabled' in element?Boolean(element.disabled):false,connected:element.isConnected}})}
    catch(originalError){
      const requested=roleRequest(target);if(!requested)throw originalError;const token=`cvent-round-target-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const found=await ego.evaluate(`(() => {const requested=${JSON.stringify(requested)},token=${JSON.stringify(token)},context=${JSON.stringify(String(request.targetContext||''))},index=${JSON.stringify(Number.isInteger(request.targetIndex)?request.targetIndex:null)},norm=v=>String(v||'').toLowerCase().replace(/[\\s:*]+/g,' ').trim(),role=e=>e.getAttribute('role')||(e.tagName==='BUTTON'?'button':e.tagName==='A'&&e.href?'link':e.tagName==='SELECT'?'combobox':e.matches('input,textarea')?'textbox':''),all=[...document.querySelectorAll('*')].filter(e=>role(e).toLowerCase()===requested.role&&e.isConnected),matches=all.filter(e=>{const id=e.id,label=id?document.querySelector('label[for="'+CSS.escape(id)+'"]'):null,names=[e.getAttribute('aria-label'),e.getAttribute('title'),e.getAttribute('name'),label?.innerText,e.closest('label')?.innerText,e.innerText].filter(Boolean).map(norm),box=e.getBoundingClientRect(),style=getComputedStyle(e);if(!names.includes(norm(requested.name))||box.width<=0||box.height<=0||style.display==='none'||style.visibility==='hidden'||e.disabled)return false;if(!context)return true;let p=e.parentElement;for(let d=0;p&&d<10;d++,p=p.parentElement)if(norm(p.innerText||p.textContent).includes(norm(context)))return true;return false}),chosen=index!==null?matches[index]:matches.length===1?matches[0]:null;if(!chosen)return {count:matches.length};chosen.setAttribute('data-cvent-round-target',token);const id=chosen.id,label=id?document.querySelector('label[for="'+CSS.escape(id)+'"]'):chosen.closest('label');return {count:1,descriptor:{tag:chosen.tagName,role:role(chosen),text:(chosen.innerText||chosen.textContent||'').trim().slice(0,500),label:(label?.innerText||label?.textContent||'').trim().slice(0,500),aria:chosen.getAttribute('aria-label'),title:chosen.getAttribute('title'),name:chosen.getAttribute('name'),documentUrl:chosen.ownerDocument.location.href,type:chosen.getAttribute('type'),editable:chosen.isContentEditable,controlValue:chosen.tagName==='INPUT'&&/^(?:submit|button|reset)$/i.test(chosen.type)?chosen.value:null,href:chosen instanceof HTMLAnchorElement?chosen.href:null,disabled:Boolean(chosen.disabled),connected:chosen.isConnected}}})()`);
      if(found.count!==1)throw new Error(`Target resolution found ${found.count} exact accessible-name matches`);target=`[data-cvent-round-target="${token}"]`;descriptor=found.descriptor;fallbackUsed=true;
    }
    return {target,descriptor,fallbackUsed};
  }
  async function pointDescriptor(x,y){return ego.evaluate(`(() => {let e=document.elementFromPoint(${JSON.stringify(x)},${JSON.stringify(y)});if(!e)return null;e=e.closest('button,a,input,select,textarea,[role],[contenteditable=true]')||e;return {tag:e.tagName,role:e.getAttribute('role'),text:(e.innerText||e.textContent||'').trim().slice(0,500),label:e.getAttribute('aria-label')||e.getAttribute('title')||'',aria:e.getAttribute('aria-label'),title:e.getAttribute('title'),name:e.getAttribute('name'),type:e.getAttribute('type'),editable:e.isContentEditable,controlValue:e.tagName==='INPUT'&&/^(?:submit|button|reset)$/i.test(e.type)?e.value:null,href:e instanceof HTMLAnchorElement?e.href:null,disabled:Boolean(e.disabled),connected:e.isConnected}})()`)}
  async function compactControlInventory(){return ego.evaluate(`(() => {const norm=value=>String(value||'').replace(/\\s+/g,' ').trim(),selectorFor=element=>element.id?'#'+CSS.escape(element.id):(element.getAttribute('name')?'[name="'+CSS.escape(element.getAttribute('name'))+'"]':element.getAttribute('data-cvent-id')?'[data-cvent-id="'+CSS.escape(element.getAttribute('data-cvent-id'))+'"]':element.getAttribute('data-testid')?'[data-testid="'+CSS.escape(element.getAttribute('data-testid'))+'"]':null),controls=[],seen=new Set();for(const element of document.querySelectorAll('input,select,textarea,button,[role=combobox],[contenteditable=true]')){if(seen.has(element))continue;seen.add(element);const type=(element.getAttribute('type')||'').toLowerCase(),style=getComputedStyle(element),box=element.getBoundingClientRect();if(type==='hidden'||!element.isConnected||box.width<=0||box.height<=0||style.display==='none'||style.visibility==='hidden')continue;const id=element.id,label=id?document.querySelector('label[for="'+CSS.escape(id)+'"]'):element.closest('label'),selector=selectorFor(element),name=norm(element.getAttribute('aria-label')||label?.innerText||element.getAttribute('title')||element.getAttribute('name')||element.innerText);if(!selector&&!name)continue;controls.push({tag:element.tagName,role:element.getAttribute('role'),label:name.slice(0,300),selector,type:type||null,value:type==='password'?null:('value' in element?String(element.value).slice(0,500):null),checked:'checked' in element?Boolean(element.checked):null,disabled:'disabled' in element?Boolean(element.disabled):null,options:element.tagName==='SELECT'?[...element.options].map(option=>({label:norm(option.textContent).slice(0,200),value:option.value,selected:option.selected,disabled:option.disabled})).slice(0,250):undefined});if(controls.length>=400)break}return {url:location.href,title:document.title,controls}})()`)}
  async function compactTargetState(target){return ego.evaluateLocator(target,(element)=>{const rect=element.getBoundingClientRect(),style=getComputedStyle(element),type=(element.getAttribute('type')||'').toLowerCase(),editable=element.isContentEditable||element.getAttribute('contenteditable')==='true',attributeNames=['href','target','rel','title','name','placeholder','aria-label','aria-expanded','aria-checked','aria-selected','role','contenteditable','type'],attributes=Object.fromEntries(attributeNames.map(name=>[name,element.getAttribute(name)])),selection=element.ownerDocument.getSelection(),selectedText=selection?.rangeCount&&[...Array(selection.rangeCount)].some((_,index)=>{try{return selection.getRangeAt(index).intersectsNode(element)}catch{return false}})?selection.toString():'';const anchors=(element.matches?.('a[href]')?[element]:[]).concat([...element.querySelectorAll?.('a[href]')||[]]).slice(0,100),sourceHtml=editable?String(element.innerHTML||''):'';return {tag:element.tagName,role:element.getAttribute('role'),text:String(element.innerText||element.textContent||'').trim().slice(0,20000),value:type==='password'?null:('value' in element?String(element.value).slice(0,20000):null),checked:'checked' in element?Boolean(element.checked):null,enabled:!(('disabled' in element&&element.disabled)||element.getAttribute('aria-disabled')==='true'),visible:element.isConnected&&rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden',editable,attributes,href:element instanceof HTMLAnchorElement?element.href:null,selectedText,html:editable?sourceHtml.slice(0,20000):null,htmlTruncated:editable&&sourceHtml.length>20000,links:anchors.map(anchor=>({text:String(anchor.innerText||anchor.textContent||'').replace(/\s+/g,' ').trim().slice(0,1000),href:anchor.href,rawHref:anchor.getAttribute('href'),target:anchor.getAttribute('target'),rel:anchor.getAttribute('rel')}))}})}
  async function authorizeInteractive(step,descriptor){
    if(!descriptor||!descriptor.connected||descriptor.disabled)throw new Error('Action target is missing, disconnected, or disabled');
    if(simple&&step.intent==='read'&&['press','hover','focus','selectText'].includes(step.operation))return;
    const labels=['text','label','aria','title','name','controlValue'].map(key=>normalize(descriptor[key])).filter(Boolean),target=normalize(step.target);
    const identity=/(?:event[-_ ]?(?:name|title|code)|evtstub|eventid|contact[-_ ]?type[-_ ]?(?:name|code))/i;
    const protectedControl=/^(?:publish(?:\s|$)|go live(?:\s|$)|send(?:\s|$)|test[-\s]*(?:send|email)(?:\s|$)|schedule(?:\s|$)|delete(?:\s|$)|remove(?:\s|$)|archive(?:\s|$)|(?:create|new|copy|duplicate|clone)\s+(?:an?\s+)?(?:new\s+)?event(?:\s|$)|create\s+contact\s+type(?:\s|$)|attendees?$|invitees?$|contacts?$)/i;
    const mutating=/^(?:save(?:\s|$)|save\s*(?:&|and)\s*close(?:\s|$)|create(?:\s|$)|add(?:\s|$)|update(?:\s|$)|apply(?:\s|$)|confirm(?:\s|$)|submit(?:\s|$))/i;
    if((!simple||step.dataChange||step.persistencePossible)&&(identity.test(target)||labels.some(label=>identity.test(label))))throw new Error('Write blocked: selected event identity is immutable');
    if(simple&&(step.dataChange||step.persistencePossible)&&labels.some(label=>/^(?:name|title|code)$/i.test(label.replace(/[*:]/g,'').trim()))&&/\/(?:EventDetails|EventInformation)(?:\/|$)/i.test(new URL((await ego.pageInfo()).url).pathname))throw Error('Write blocked: selected event identity is immutable');
    if(labels.some(label=>protectedControl.test(label)&&!(simple&&/^(?:attendees?|invitees?|contacts?)$/i.test(label)))||descriptor.href&&protectedPath.test(new URL(descriptor.href).pathname))throw new Error('Action blocked: protected Cvent control');
    if(simple&&descriptor.href&&unsafeActionURL(descriptor.href))throw Error('Permanent action URL blocked');
    if(simple&&descriptor.documentUrl){const d=new URL(descriptor.documentUrl),key=eventKey(d.href);if(!(d.hostname==='cvent.com'||d.hostname.endsWith('.cvent.com'))||key&&key!==String(runtime.authorizedEventKey).toLowerCase())throw Error('Write blocked: target frame belongs to another event/context');}
    if(descriptor.href){const url=new URL(descriptor.href),key=eventKey(url.href);if(url.protocol!=='https:'||!(url.hostname==='cvent.com'||url.hostname.endsWith('.cvent.com'))||key&&key!==String(runtime.authorizedEventKey).toLowerCase())throw Error('Navigation outside exact authorized event blocked');if(['click','dblclick','activate'].includes(step.operation))await stageAuthorizedTransition(url.href);}
    if(!simple&&step.intent!=='write'&&(labels.some(label=>mutating.test(label))||['checkbox','radio','switch'].includes(String(descriptor.role).toLowerCase())||descriptor.tag==='INPUT'&&['click','activate'].includes(step.operation)))throw new Error('Mutating control requires write intent and RR evidence');
    if(step.intent==='write'){if(simple&&!targetBound())throw Error('Write blocked: exact selected target is not bound');await assertLease();await assertAuthorizedPage();}
  }
  async function runAdaptive(step){
    const op=step.operation;let resolved;
    if(!simple&&step.intent!=='write')await assertAuthenticatedReadContext();
    if(step.target&&['readTarget','click','dblclick','activate','fill','type','focus','hover','selectOption','setChecked','press','search','selectText','drag','uploadDiscountImport'].includes(op)){resolved=await resolveTarget(step);step={...step,target:resolved.target};if(!['readTarget','focus'].includes(op))await authorizeInteractive(step,resolved.descriptor)}
    if(['visualClick','visualDoubleClick','visualDrag'].includes(op))await authorizeInteractive(step,await pointDescriptor(step.x,step.y));
    if(['typeText','press'].includes(op)&&!step.target&&step.intent==='write'){
      const focused=await ego.evaluate(`(() => {const e=document.activeElement;if(!e)return null;const label=e.id?document.querySelector('label[for="'+CSS.escape(e.id)+'"]'):e.closest('label');return {tag:e.tagName,role:e.getAttribute('role'),name:e.getAttribute('name'),aria:e.getAttribute('aria-label'),label:label?.innerText||'',title:e.getAttribute('title'),connected:e.isConnected,disabled:Boolean(e.disabled)}})()`);
      await authorizeInteractive(step,focused);
    }
    if(step.intent==='write'&&!['click','dblclick','activate','fill','type','focus','hover','selectOption','setChecked','press','search','selectText','drag','uploadDiscountImport','visualClick','visualDoubleClick','visualDrag'].includes(op)){await assertLease();await assertAuthorizedPage();}
    switch(op){
      case 'pageInfo':return {page:await ego.pageInfo()};
      case 'snapshotText':return {snapshot:await ego.snapshot(step.options)};
      case 'screenshot':return {screenshotPath:await ego.screenshot({path:step.filePath,fullPage:step.fullPage===true})};
      case 'readTarget':return {target:step.target,...await compactTargetState(step.target)};
      case 'controlInventory':return {snapshotKind:'controlInventory',snapshot:JSON.stringify(await compactControlInventory(),null,2)};
      case 'sectionState':return await ego.evaluate(`(() => {const norm=v=>String(v||'').replace(/\\s+/g,' ').trim();return {url:location.href,title:document.title,rows:[...document.querySelectorAll('table tr,[role=row]')].slice(0,2000).map(r=>({text:norm(r.innerText||r.textContent).slice(0,5000),cells:[...r.querySelectorAll('th,td,[role=cell],[role=columnheader]')].map(c=>norm(c.innerText||c.textContent).slice(0,2000)),links:[...r.querySelectorAll('a[href]')].map(a=>({text:norm(a.innerText||a.textContent),href:a.href})).slice(0,20)})).filter(r=>r.text),headings:[...document.querySelectorAll('h1,h2,h3,[role=heading]')].map(e=>norm(e.innerText||e.textContent)).filter(Boolean),buttons:[...document.querySelectorAll('button,[role=button],input[type=submit]')].map(e=>norm(e.innerText||e.value||e.getAttribute('aria-label'))).filter(Boolean)}})()`);
      case 'visualHover':await ego.hover([step.x,step.y]);return {hovered:[step.x,step.y]};
      case 'scroll':await ego.wheel(Number(step.deltaX??0),Number(step.deltaY??700));await ego.waitForTimeout(step.settleMs??500);return {scrolledBy:step.deltaY??700};
      case 'click':await dispatch(step,()=>ego.click(step.target,{label:step.label}));return {clicked:true};
      case 'dblclick':await dispatch(step,()=>ego.dblclick(step.target,{label:step.label}));return {doubleClicked:true};
      case 'activate':return {activated:await dispatch(step,()=>ego.evaluateLocator(step.target,(element)=>{element.click();return true}))};
      case 'visualClick':await dispatch(step,()=>ego.click([step.x,step.y],{label:step.label}));return {clicked:[step.x,step.y]};
      case 'visualDoubleClick':await dispatch(step,()=>ego.dblclick([step.x,step.y],{label:step.label}));return {doubleClicked:[step.x,step.y]};
      case 'fill':await dispatch(step,()=>ego.fill(step.target,step.text??''));return {filled:true};
      case 'type':await dispatch(step,async()=>{await ego.focus(step.target);await ego.insertText(step.text??'')});return {typed:true};
      case 'typeText':await dispatch(step,()=>ego.insertText(step.text??''));return {typed:true};
      case 'focus':await ego.focus(step.target);return {focused:true};
      case 'hover':await dispatch(step,()=>ego.hover(step.target));return {hovered:true};
      case 'selectOption':{if(simple){await dispatch(step,()=>ego.selectOption(step.target,step.optionSpec));return {selected:step.optionSpec}}const d=await ego.evaluateLocator(step.target,e=>({tag:e.tagName,options:e.tagName==='SELECT'?[...e.options].map(o=>({label:String(o.textContent||'').replace(/\s+/g,' ').trim(),value:o.value,disabled:o.disabled})):[]}));if(d.tag==='SELECT'){const key=step.optionBy==='value'?'value':'label',matches=d.options.filter(option=>option[key]===String(step.option)&&!option.disabled);if(matches.length!==1)throw new Error(`Native Cvent combobox found ${matches.length} exact ${key} matches`);await dispatch(step,()=>ego.selectOption(step.target,{[key]:step.option}));return {selected:step.option}}if(step.optionBy==='value')throw new Error('Custom combobox requires exact option label');await ego.click(step.target);await ego.waitForTimeout(250);const option=await resolveTarget({target:`role:option[name="${String(step.option).replaceAll('"','\\"')}"]`});await dispatch(step,()=>ego.click(option.target));return {selected:step.option}}
      case 'setChecked':await dispatch(step,()=>ego.setChecked(step.target,Boolean(step.checked)));return {checked:Boolean(step.checked)};
      case 'press':await dispatch(step,async()=>{if(step.target)await ego.focus(step.target);await ego.press(step.key)});return {pressed:step.key};
      case 'keyDown':if(!/^(?:Shift|Control|Meta)$/i.test(step.key))throw Error('EGO_CAPABILITY_UNAVAILABLE: keyboard.down is limited to selection modifiers Shift, Control, and Meta');await ego.down(step.key);return {keyDown:step.key};
      case 'keyUp':if(!/^(?:Shift|Control|Meta)$/i.test(step.key))throw Error('EGO_CAPABILITY_UNAVAILABLE: keyboard.up is limited to selection modifiers Shift, Control, and Meta');await ego.up(step.key);return {keyUp:step.key};
      case 'search':await dispatch(step,async()=>{await ego.fill(step.target,step.text??'');if(step.submit!==false)await ego.press('Enter')});return {query:step.text??''};
      case 'selectText':return {selected:await ego.evaluateLocator(step.target,(element)=>{const range=document.createRange(),selection=getSelection();range.selectNodeContents(element);selection.removeAllRanges();selection.addRange(range);element.closest('[contenteditable=true]')?.focus();return selection.toString()})};
      case 'drag':await dispatch(step,()=>ego.drag([step.target,step.destination],{delay:75}));return {dragged:true};
      case 'visualDrag':await dispatch(step,()=>ego.drag([[step.x,step.y],[step.toX,step.toY]],{delay:75,label:step.label}));return {dragged:[[step.x,step.y],[step.toX,step.toY]]};
      case 'uploadDiscountImport':await dispatch(step,()=>ego.setInputFiles(step.target,step.filePath));return {uploadedArtifact:'discount-import.xlsx'};
      case 'navigate':{const url=new URL(step.url),key=eventKey(url.href),expected=String(runtime.authorizedEventKey||'').toLowerCase(),bound=targetBound();if(simple){if(unsafeActionURL(url.href))throw Error('Permanent action URL blocked');if(url.protocol!=='https:'||!(url.hostname==='cvent.com'||url.hostname.endsWith('.cvent.com'))||url.username||url.password)throw Error('Navigation outside Cvent blocked');if(bound&&(await eventIdentityEvidence()).proven&&!protectedPath.test(url.pathname)&&(!key||key===expected))try{await stageAuthorizedTransition(url.href)}catch{/* Reads are not write authorization; a later mutation must prove its target. */}await ego.goto(url.href,{waitUntil:step.waitUntil||'domcontentloaded',timeout:step.timeoutSeconds?step.timeoutSeconds*1000:30000});return {navigated:url.href}}if(url.protocol!=='https:'||!(url.hostname==='cvent.com'||url.hostname.endsWith('.cvent.com'))||key&&key!==expected||protectedPath.test(url.pathname))throw new Error('Navigation outside exact selected event blocked');if(bound)await stageAuthorizedTransition(url.href);else if(!/\/events2\/eventselection/i.test(url.pathname))throw new Error('Read bootstrap navigation is limited to authenticated Cvent event inventory');await ego.goto(url.href,{waitUntil:step.waitUntil||'domcontentloaded',timeout:Math.max(1000,Math.min(Number(step.timeoutSeconds??30),180)*1000)});if(bound)await assertAuthorizedPage();else await assertAuthenticatedReadContext();return {navigated:url.href}}
      case 'wait':if(step.target)await ego.waitForSelector(step.target,{timeout:step.ms??30000,state:step.state});else if(step.loadState)await ego.waitForLoadState(step.loadState,{timeout:step.ms??30000});else await ego.waitForTimeout(step.ms??1000);return {waitedMs:step.ms??1000};
      default:throw new Error(`Unsupported coherent Ego action: ${op}`);
    }
  }
  async function preflightAtomic(planned){
    if(!planned?.mutations.length)return undefined;
    if(!targetBound())throw planningError('Exact selected target is not bound to the current BrowserRuntime');
    await assertLease();await assertAuthorizedPage();
    await ego.snapshot();
    let saveTarget;
    for(let index=0;index<planned.steps.length;index++){
      const step=planned.steps[index];
      if(!step.target&&step.x===undefined)continue;
      if(step.target)step.target=step.target.replace(/^loc=role:/,'role:').replace(/^loc=css:/,'');
      const d=step.target?(await resolveTarget(step)).descriptor:await pointDescriptor(step.x,step.y);
      if(step.destination)await resolveTarget({target:step.destination});
      const save=['text','label','aria','title'].some(k=>/^save(?:\s|$)/i.test(normalize(d?.[k])));
      if(save&&planned.commitCandidates.includes(index)){
        // Cvent can enable Save after an edit, but the commit control must exist now.
        if(!d.connected)throw planningError('Save control is disconnected');
        await authorizeInteractive({...step,intent:'write'},{...d,disabled:false});saveTarget=step.target??`${step.x},${step.y}`;
      }else await authorizeInteractive({...step,intent:step.data?'write':'read'},d);
    }
    if(!saveTarget)throw planningError('No exact, current Save control exists for the planned mutations');
    return saveTarget;
  }
  async function collectEventRows(maxScrolls=60){
    const seen=new Map(),passes=[],limit=Math.max(1,Math.min(Number(maxScrolls),100));let pageNumber=1;
    await ego.evaluate(`(() => {window.scrollTo(0,0);for(const e of document.querySelectorAll('*'))if(e.scrollHeight>e.clientHeight+10&&[...e.querySelectorAll('table')].length)e.scrollTop=0})()`);await ego.waitForTimeout(350);
    for(let i=0;i<limit;i++){
      const view=await ego.evaluate(`(() => {const clean=v=>String(v||'').replace(/\\s+/g,' ').trim().toLowerCase(),scrollables=[document.scrollingElement,...document.querySelectorAll('*')].filter(e=>e&&e.scrollHeight>e.clientHeight+10&&([...e.querySelectorAll?.('table')||[]].length||e===document.scrollingElement)),scroller=scrollables.sort((a,b)=>(b.scrollHeight-b.clientHeight)-(a.scrollHeight-a.clientHeight))[0]||document.scrollingElement,rows=[];for(const table of document.querySelectorAll('table')){const headers=[...table.querySelectorAll('thead th')],effective=headers.length?headers:[...(table.querySelector('tr')?.querySelectorAll('th')||[])],names=effective.map(cell=>clean(cell.innerText||cell.textContent).replace(/[\\uE000-\\uF8FF]/g,'')),codeIndex=names.findIndex(name=>name==='code'||name==='event code'),statusIndex=names.findIndex(name=>name==='status'||name==='event status');for(const row of table.querySelectorAll('tr')){const box=row.getBoundingClientRect();if(box.bottom<0||box.top>innerHeight)continue;const cells=[...row.querySelectorAll('td')].map(cell=>(cell.innerText||cell.textContent||'').trim()),link=row.querySelector('td a[href]');if(!link||!cells.length)continue;const rect=link.getBoundingClientRect(),x=Math.max(0,Math.min(innerWidth-1,rect.left+rect.width/2)),y=Math.max(0,Math.min(innerHeight-1,rect.top+rect.height/2)),cover=document.elementFromPoint(x,y);rows.push({name:(link.innerText||link.textContent||'').trim(),code:codeIndex>=0?cells[codeIndex]||'':'',status:statusIndex>=0?cells[statusIndex]||'':'',inventoryColumnsTrusted:codeIndex>=0&&statusIndex>=0,href:link.href||'',connected:link.isConnected,visible:rect.width>0&&rect.height>0&&rect.bottom>=0&&rect.top<=innerHeight,pointerEvents:getComputedStyle(link).pointerEvents,linkContainsCover:Boolean(cover&&(cover===link||link.contains(cover)))})}}return {y:scroller.scrollTop,height:scroller.clientHeight,scrollHeight:scroller.scrollHeight,documentScroller:scroller===document.scrollingElement,rows}})()`);
      for(const row of view.rows){const key=eventKey(row.href);if(key)seen.set(`${key}\u0000${row.name}\u0000${row.code}`,{...row,eventKey:key})}
      passes.push({page:pageNumber,y:view.y,visibleRows:view.rows.length});
      if(view.y+view.height<view.scrollHeight-2){await ego.evaluate(`(() => {const all=[document.scrollingElement,...document.querySelectorAll('*')].filter(e=>e&&e.scrollHeight>e.clientHeight+10&&([...e.querySelectorAll?.('table')||[]].length||e===document.scrollingElement)),s=all.sort((a,b)=>(b.scrollHeight-b.clientHeight)-(a.scrollHeight-a.clientHeight))[0]||document.scrollingElement;s.scrollTop+=Math.max(500,Math.round(s.clientHeight*.8))})()`);await ego.waitForTimeout(500);continue}
      const next=await ego.evaluate(`(() => {const norm=v=>String(v||'').replace(/\\s+/g,' ').trim(),items=[...document.querySelectorAll('button,a,[role=button]')].filter(e=>/^(?:next|next page)$/i.test(norm(e.getAttribute('aria-label')||e.innerText||e.textContent))&&e.isConnected&&!e.disabled&&e.getAttribute('aria-disabled')!=='true'),e=items.length===1?items[0]:null;if(!e)return false;e.setAttribute('data-cvent-inventory-next','true');return true})()`);
      if(!next)break;
      await ego.click('[data-cvent-inventory-next="true"]');pageNumber++;await ego.waitForTimeout(750);await ego.evaluate(`(() => {window.scrollTo(0,0);document.querySelector('[data-cvent-inventory-next]')?.removeAttribute('data-cvent-inventory-next');for(const e of document.querySelectorAll('*'))if(e.scrollHeight>e.clientHeight+10&&[...e.querySelectorAll('table')].length)e.scrollTop=0})()`);
    }
    return {rows:[...seen.values()],passes,pages:pageNumber,finalY:await ego.evaluate('scrollY'),scrollHeight:await ego.evaluate('document.documentElement.scrollHeight')};
  }
  if(params.intent==='read'&&!['script','actions','openAuthorizedEvent','pageInfo','navigate','wait'].includes(operation))await assertAuthenticatedReadContext();
  let result;
  switch(operation){
    case '__preflightTarget': {const resolved=await resolveTarget({target:params.target,targetContext:params.context,targetIndex:params.index});result={resolved:resolved.descriptor,resolvedTarget:resolved.target,fallbackUsed:resolved.fallbackUsed};break;}
    case 'probe': {const info=await ego.pageInfo();result={marker,targetId:wanted,url:info.url,title:info.title};break}
    case 'snapshotText': {
      const identity=await ego.evaluate(`(() => {if(!window.__CVENT_SNAPSHOT_DOCUMENT_ID){Object.defineProperty(window,'__CVENT_SNAPSHOT_DOCUMENT_ID',{value:crypto.randomUUID(),configurable:false});window.__CVENT_SNAPSHOT_GENERATION=0;new MutationObserver(()=>window.__CVENT_SNAPSHOT_GENERATION++).observe(document.documentElement,{subtree:true,childList:true,attributes:true,characterData:true})}return {documentId:window.__CVENT_SNAPSHOT_DOCUMENT_ID,generation:window.__CVENT_SNAPSHOT_GENERATION,url:location.href}})()`);
      const cached=readSnapshotCache();
      if(cached&&cached.browserRuntimeId===runtime.browserRuntimeId&&cached.targetId===wanted&&cached.documentId===identity.documentId&&cached.generation===identity.generation&&cached.url===identity.url&&Date.now()-cached.savedAt<60000){
        result={snapshot:cached.snapshot,snapshotCacheHit:true};
      }else{
        const snapshot=await ego.snapshot();const after=await ego.evaluate(`({documentId:window.__CVENT_SNAPSHOT_DOCUMENT_ID,generation:window.__CVENT_SNAPSHOT_GENERATION,url:location.href})`);
        if(identity.documentId===after.documentId&&identity.generation===after.generation&&identity.url===after.url)writeSnapshotCache({browserRuntimeId:runtime.browserRuntimeId,targetId:wanted,...after,savedAt:Date.now(),snapshot});
        result={snapshot,snapshotCacheHit:false};
      }
      break;
    }
    case 'readTarget': {
      result={target:params.target,...await compactTargetState(params.target)};
      break;
    }
    case 'sectionState': {
      if(params.domain==='pricing'){
        // The planner SPA navigates before its fee tables render. Never turn a
        // loading shell into a complete-but-empty RR reconciliation result.
        let ready=false;
        for(let attempt=0;attempt<60;attempt++){
          ready=await ego.evaluate(`Boolean([...document.querySelectorAll('h1,h2,h3,[role=heading]')].some(element=>String(element.innerText||element.textContent||'').trim()==='Pricing')&&document.querySelector('table tr,[role=row]'))`);
          if(ready)break;
          await ego.waitForTimeout(500);
        }
        if(!ready)throw new Error('Pricing fee tables did not render; section state is unavailable, not empty');
      }
      result=await ego.evaluate(`(() => {const norm=v=>String(v||'').replace(/\\s+/g,' ').trim(),labelFor=element=>{const id=element.id,label=id?document.querySelector('label[for="'+CSS.escape(id)+'"]'):null;return norm(element.getAttribute('aria-label')||label?.innerText||element.closest('label')?.innerText||element.getAttribute('name')||element.getAttribute('placeholder'))},selectorFor=element=>element.id?'#'+CSS.escape(element.id):(element.getAttribute('name')?'[name="'+CSS.escape(element.getAttribute('name'))+'"]':null),rows=[...document.querySelectorAll('table tr,[role=row]')].slice(0,2000).map(row=>({text:norm(row.innerText||row.textContent).slice(0,5000),cells:[...row.querySelectorAll('th,td,[role=cell],[role=columnheader]')].map(cell=>norm(cell.innerText||cell.textContent).slice(0,2000)),links:[...row.querySelectorAll('a[href]')].map(link=>({text:norm(link.innerText||link.textContent).slice(0,1000),href:link.href})).slice(0,20)})).filter(row=>row.text),controls=[...document.querySelectorAll('input,select,textarea,[role=combobox]')].slice(0,500).map(element=>{const type=(element.getAttribute('type')||'').toLowerCase();return {selector:selectorFor(element),label:labelFor(element),type:type||element.tagName.toLowerCase(),value:type==='password'?null:('value' in element?String(element.value).slice(0,5000):null),checked:'checked' in element?Boolean(element.checked):null,disabled:'disabled' in element?Boolean(element.disabled):null,options:element.tagName==='SELECT'?[...element.options].map(option=>({label:norm(option.textContent),value:option.value,selected:option.selected})).slice(0,500):undefined}}),headings=[...document.querySelectorAll('h1,h2,h3,[role=heading]')].map(element=>norm(element.innerText||element.textContent)).filter(Boolean).slice(0,100),buttons=[...document.querySelectorAll('button,[role=button],input[type=submit]')].map(element=>({text:norm(element.innerText||element.value||element.getAttribute('aria-label')),disabled:Boolean(element.disabled)})).filter(item=>item.text).slice(0,200);return {url:location.href,title:document.title,rows,controls,headings,buttons}})()`);break;
    }
    case 'controlInventory': {
      result={snapshotKind:'controlInventory',snapshot:JSON.stringify(await compactControlInventory(),null,2)};break;
    }
    case 'pageInfo': result={page:await ego.pageInfo()};break;
    case 'scroll': {
      const delta=Number(params.deltaY??params.y??Math.max(500,Math.round((await ego.evaluate('window.innerHeight'))*.8)));
      result={scroll:await ego.evaluate(`(() => { window.scrollBy(0,${JSON.stringify(delta)}); return {beforeY:scrollY,height:innerHeight,scrollHeight:document.documentElement.scrollHeight} })()`)};
      await ego.waitForTimeout(params.settleMs??500);
      result.scroll.afterY=await ego.evaluate('scrollY');break;
    }
    case 'eventInventory': {
      const inventory=await collectEventRows(params.maxScrolls??100);
      result={events:inventory.rows.map(({name,code,status,href,eventKey})=>({name,code,status,href,eventKey})),passes:inventory.passes,finalY:inventory.finalY,scrollHeight:inventory.scrollHeight};break;
    }
    case 'scanEventList': {
      const exactName=String(params.exactName||'').trim();if(!exactName)throw new Error('scanEventList requires exactName');
      const inventory=await collectEventRows(params.maxScrolls??60),exactMatches=inventory.rows.filter(row=>row.name===exactName);
      result={exactName,exactMatches,observedRows:inventory.rows,...inventory};break;
    }
    case 'openAuthorizedEvent': {
      const exactName=String(params.eventName||'').trim(),expectedKey=String(params.eventKey||'').trim().toLowerCase(),expectedCode=String(params.eventCode||'').trim().toLowerCase();
      if(!exactName||!expectedKey||expectedKey!==String(runtime.authorizedEventKey||'').toLowerCase()||exactName!==runtime.authorizedEventName)throw new Error('Server-selected exact event identity is required');
      const authenticated=await assertAuthenticatedReadContext(),before=authenticated.page,beforeUrl=new URL(before.url);
      const currentEvidence=await eventIdentityEvidence();
      if(currentEvidence.proven&&!params.refreshInventory){
        await rememberAuthorizedPage(currentEvidence);
        result={openedEventKey:expectedKey,activation:'already-inside-exact-event',inventoryUrl:null,navigationTarget:{name:exactName,eventKey:expectedKey,code:params.eventCode||'',status:'',href:before.url},landing:{ready:currentEvidence.visible.ready,title:before.title},identityEvidence:currentEvidence,targetState:'AUTHORIZED_EVENT_BOUND'};break;
      }
      const inventoryUrl='https://app.cvent.com/Subscribers/Events2/EventSelection';
      if(!/\/events2\/eventselection/i.test(beforeUrl.pathname))await ego.goto(inventoryUrl,{waitUntil:'domcontentloaded',timeout:Math.max(1000,Math.min(Number(params.timeoutSeconds??60),180)*1000)});
      await assertAuthenticatedReadContext();
      const inventoryPage=await ego.pageInfo(),inventoryParsed=new URL(inventoryPage.url);
      if(inventoryParsed.protocol!=='https:'||!inventoryParsed.hostname.endsWith('cvent.com')||!/\/events2\/eventselection/i.test(inventoryParsed.pathname))throw new Error('AUTH_REQUIRED: authenticated Cvent event inventory is unavailable');
      const inventory=await collectEventRows(params.maxScrolls??60);
      const authorized=inventory.rows.filter(item=>item.name===exactName&&item.eventKey===expectedKey&&item.inventoryColumnsTrusted&&(!expectedCode||String(item.code||'').trim().toLowerCase()===expectedCode)&&item.connected&&item.visible);
      if(authorized.length===0)throw new Error('EVENT_NOT_FOUND: exact selected event key/code/name is absent from authenticated Cvent inventory');
      if(authorized.length>1)throw new Error('EVENT_AMBIGUOUS: multiple authenticated inventory rows match the selected event');
      const chosen=authorized[0],observedAt=new Date().toISOString(),timeout=Math.max(1000,Math.min(Number(params.timeoutSeconds??60),180)*1000);
      writePrivateJson(path.join(path.dirname(runtimePath),'selected-event-inventory.json'),{name:chosen.name,event_key:chosen.eventKey,event_id:runtime.authorizedEventId,code:chosen.code,status:chosen.status,href:chosen.href,browser_runtime_id:runtime.browserRuntimeId,observed_at:observedAt,proof:'exact-authenticated-inventory-row'});
      await ego.goto(chosen.href,{waitUntil:'domcontentloaded',timeout});await ego.waitForTimeout(1000);
      const opened=await eventIdentityEvidence(),openedUrl=new URL(opened.page.url),safeLanding=openedUrl.protocol==='https:'&&(openedUrl.hostname==='cvent.com'||openedUrl.hostname.endsWith('.cvent.com'))&&!opened.isInventory&&!opened.protectedCurrent&&!opened.visible.hasLogin&&!opened.conflictingKey;
      if(!safeLanding)throw new Error('EVENT_IDENTITY_UNVERIFIED: exact inventory candidate did not open a safe Cvent event page');
      const identityEvidence={...opened,proven:true,bootstrap:{source:'exact-authenticated-inventory-row',name:chosen.name,eventKey:chosen.eventKey,code:chosen.code,href:chosen.href,finalUrl:opened.page.url,browserRuntimeId:runtime.browserRuntimeId}};
      await rememberAuthorizedPage(identityEvidence);
      const landing=await ego.evaluate(`(() => ({ready:document.readyState,title:document.title,headings:[...document.querySelectorAll('h1,h2,h3,[role=heading]')].map(element=>String(element.innerText||element.textContent||'').replace(/\\s+/g,' ').trim()).filter(Boolean).slice(0,20)}))()`);
      result={openedEventKey:expectedKey,activation:'exact-authenticated-inventory',inventoryUrl:inventoryPage.url,navigationTarget:chosen,authenticatedInventory:inventory.rows.map(({name,code,status,href,eventKey})=>({name,code,status,href,eventKey})),inventoryPasses:inventory.passes,inventoryRefreshed:true,inventoryCount:inventory.rows.length,landing,identityEvidence,targetState:'AUTHORIZED_EVENT_BOUND'};break;
    }
    case 'script': {
      // The same Ego executor and target/lease checks, now with coherent native
      // helper scripts. No shell, network, process, filesystem or raw CDP API is exposed.
      const logs=[];
      let postSaveSnapshot;
      const validation=simple?{items:[]}:JSON.parse(fs.readFileSync(path.join(path.dirname(runtimePath),'rr-validation.json'),'utf8'));
      const verified=new Set(validation.items.filter(item=>item.domain===params.domain&&item.status==='VERIFIED').map(item=>`${item.sourceEvidence.sheet}!${item.sourceEvidence.range}`));
      const domainItems=validation.items.filter(item=>item.domain===params.domain);
      const target=value=>typeof value==='string'?value.replace(/^loc=role:/,'role:').replace(/^loc=css:/,''):value;
      const planned=simple?null:planNativeRound(params.script,params,domainItems);
      const plannedSave=simple?null:await preflightAtomic(planned);
      const readOps=new Set(['pageInfo','snapshotText','screenshot','readTarget','scroll','wait','navigate','hover','visualHover','focus','keyDown','keyUp']);
      async function runSimple(op,args){
        actionIndex=completedActions.length;
        // The router already owns this authenticated profile/target. Reads must
        // remain available on login/error pages so Pi can diagnose and recover.
        // Only mutations below need current-page event/authentication proof.
        if((await ego.evaluate("window.__CVENT_BROWSER_RUNTIME_ID || window.name"))!==runtime.browserRuntimeId)throw Error('Runtime identity lost');
        const step={operation:op,...args,intent:'read'};
        if(op==='screenshot')step.filePath=path.join(jobPath,`browser-visual-${Date.now()}-${actionIndex}.png`);
        const passive=readOps.has(op)||['controlInventory','sectionState','selectText'].includes(op);
        if(!passive){
          const d=args.target?(await resolveTarget({target:args.target})).descriptor:args.x!==undefined?await pointDescriptor(args.x,args.y):await ego.evaluate(`(() => {const e=document.activeElement;if(!e)return null;const label=e.id?document.querySelector('label[for="'+CSS.escape(e.id)+'"]'):e.closest('label');return {tag:e.tagName,role:e.getAttribute('role'),type:e.getAttribute('type'),editable:e.isContentEditable,name:e.getAttribute('name'),text:(e.innerText||'').slice(0,500),label:label?.innerText||'',aria:e.getAttribute('aria-label'),title:e.getAttribute('title'),connected:e.isConnected,disabled:Boolean(e.disabled)}})()`);
          const labels=['text','label','aria','title','name','controlValue'].map(k=>normalize(d?.[k]));
          const safeKey=['keyDown','keyUp'].includes(op)||op==='press'&&/^(?:Escape|(?:(?:Shift|ControlOrMeta|Control|Meta)\+)?(?:Tab|Arrow(?:Up|Down|Left|Right)|Home|End|PageUp|PageDown)|(?:ControlOrMeta|Control|Meta)\+[ac])$/i.test(args.key);
          if(op==='press'&&/^(?:Backspace|Delete)$/i.test(args.key)&&!(['INPUT','TEXTAREA'].includes(d?.tag)||d?.editable))throw Error('Destructive keyboard operation outside an editable control blocked');
          step.dataChange=!safeKey&&(isDataAction(op,args)||['drag','visualDrag'].includes(op)||(['click','visualClick','visualDoubleClick'].includes(op)&&(['checkbox','radio','switch'].includes(String(d?.role).toLowerCase())||['checkbox','radio'].includes(String(d?.type).toLowerCase()))));
          step.isSave=!safeKey&&(labels.some(s=>/^save(?:\s|$)/i.test(s))||op==='press'&&/^(?:ControlOrMeta|Control|Meta)\+s$/i.test(args.key));
          const controls=step.dataChange||step.isSave?(await compactControlInventory()).controls??[]:[];
          const editorHasSave=controls.some(c=>/^save(?:\s|$)/i.test(c.label||''));
          step.persistencePossible=step.isSave||step.dataChange&&!editorHasSave||!safeKey&&labels.some(s=>/^(?:create|add|update|apply|confirm|submit)(?:\s|$)/i.test(s));
          step.intent=safeKey||d?.href?'read':'write';
          if(step.isSave){
            for(const c of controls){const field=String(c.label||'')+' '+String(c.selector||'');const expected=/(?:event[-_ ]?(?:name|title))/i.test(field)?runtime.authorizedEventName:/event[-_ ]?code/i.test(field)?(runtime.authorizedEventCode||process.env.CVENT_AUTHORIZED_EVENT_CODE):null;if(expected&&c.value!==null&&c.value!==undefined&&normalize(c.value)!==normalize(expected))throw Error('Save blocked: event identity field differs from the human-selected identity');}
            saves++;
          }
          await authorizeInteractive(step,d);
          if(op==='drag')await authorizeInteractive(step,(await resolveTarget({target:args.destination})).descriptor);
          if(op==='visualDrag')await authorizeInteractive(step,await pointDescriptor(args.toX,args.toY));
        }
        if(op==='uploadDiscountImport'){
          const root=fs.realpathSync(path.join(jobPath,'uploads')),files=Array.isArray(args.filePath)?args.filePath:[args.filePath];
          if(!files.length)throw Error('No upload files supplied');
          step.filePath=files.map(value=>{const file=fs.realpathSync(path.resolve(jobPath,value));if(!file.startsWith(root+path.sep)||!fs.statSync(file).isFile())throw Error('Upload must be an existing job-owned uploads file');return file});
        }
        const started=performance.now();
        const value=await runAdaptive(step);
        if(['snapshotText','screenshot','readTarget'].includes(op)&&privateJson(pendingPath)&&(await eventIdentityEvidence()).proven){
          readbacks++;
          writePrivateJson(path.join(jobPath,'browser-last-atomic-readback.json'),{executionMode:'simple',observedAt:new Date().toISOString(),browserRuntimeId:runtime.browserRuntimeId,eventKey:runtime.authorizedEventKey,operation:op,evidence:value});
        }
        completedActions.push({index:actionIndex,operation:op,intent:step.intent,dataChange:!!step.dataChange,isSave:!!step.isSave,durationMs:Math.round(performance.now()-started),result:op==='snapshotText'?{snapshotCaptured:true,bytes:Buffer.byteLength(value.snapshot)}:value});
        return value;
      }
      let simpleQueue=Promise.resolve();
      const run=async(op,args={},options={})=>{
        if(simple){
          const task=simpleQueue.then(()=>runSimple(op,args)).catch(error=>{
            // Includes failed observations after a possible commit. A script's
            // catch must not make its subsequent queued writes safe again.
            if(present(pendingPath))latchSimpleMutation(error);
            throw error;
          });
          simpleQueue=task.catch(()=>{});return task;
        }
        if(completedActions.length>=200)throw Error('Ego round exceeded 200 actions; continue in another coherent round');
        actionIndex=completedActions.length;
        let intent=readOps.has(op)?'read':params.intent;
        if(options.intent==='read')intent='read';
        let source=options.rrSource;
        const data=isDataAction(op,args)||(['click','visualClick','visualDoubleClick'].includes(op)&&Boolean(source));
        if(op==='press'&&!data)intent='read';
        if(data&&params.intent==='write'){
          source=sourceForAction({operation:op,...args,rrSource:source},params.rrSources,domainItems);
          const match=planned?.steps.some(s=>s.data&&s.operation===op&&s.target===args.target&&s.text===args.text&&s.option===args.option&&s.checked===args.checked&&s.key===args.key&&s.x===args.x&&s.y===args.y&&s.destination===args.destination&&s.toX===args.toX&&s.toY===args.toY&&s.rrSource===source);
          if(!match)throw planningError('Action differs from the validated atomic plan');
        }
        if(intent==='read'&&isDataAction(op,args))throw Error('Read-only Ego action cannot edit/commit controls');
        if(op==='navigate'&&dirty)throw Error('Save and verify current changes before navigation');
        if(intent==='write'){await assertLease();await assertAuthorizedPage();}
        else await assertAuthenticatedReadContext();
        if((await ego.evaluate("window.__CVENT_BROWSER_RUNTIME_ID || window.name"))!==runtime.browserRuntimeId)throw Error('Runtime identity lost during Ego round');
        let isSave=false;
        if(['click','dblclick','visualClick','visualDoubleClick'].includes(op)){
          const d=['click','dblclick'].includes(op)?(await resolveTarget({target:args.target})).descriptor:await pointDescriptor(args.x,args.y);
          isSave=['text','label','aria','title'].some(key=>/^save(?:\s|$)/i.test(normalize(d?.[key])));
          if(!isSave&&!data)intent='read';
          if(isSave&&(!plannedSave||(args.target??`${args.x},${args.y}`)!==plannedSave))throw planningError('Save was not validated as part of this atomic mutation set');
        }
        if(data&&intent==='write'&&(!source||!verified.has(source)||!params.rrSources.includes(source)))throw planningError('Data action needs an exact VERIFIED rrSource from the round header');
        // Save and keyboard navigation carry round context, not invented cell provenance.
        if(!data)source=undefined;
        if(op==='screenshot')args.filePath=path.join(path.dirname(runtimePath),`browser-visual-${Date.now()}-${actionIndex}.png`);
        const step={operation:op,...args,intent,rrSource:source};
        const started=performance.now(),before=writesAttempted;
        let value;
        try{value=await runAdaptive(step);}catch(error){if(writesAttempted>before)dirty=true;throw error;}
        if(writesAttempted>before){dirty=true;saved=isSave||params.commitMode==='autosave';}
        if(isSave){saves++;saved=true;}
        if(dirty&&saved&&op==='snapshotText'){
          if(params.domain==='event_settings'&&/button "Save(?:\s|"|$)/i.test(value.snapshot))throw Error('Save did not leave the Event Information editor; persistence remains unproven. Inspect validation errors without replay.');
          postSaveSnapshot=value.snapshot;
          writePrivateJson(path.join(path.dirname(runtimePath),'browser-last-atomic-readback.json'),{observedAt:new Date().toISOString(),browserRuntimeId:runtime.browserRuntimeId,eventKey:runtime.authorizedEventKey,domain:params.domain,snapshot:postSaveSnapshot,verificationPlan:planned.steps.filter(s=>s.data)});
          readbacks++;dirty=false;saved=false;
        }
        completedActions.push({index:actionIndex,operation:op,intent,rrSource:source,durationMs:Math.round(performance.now()-started),result:op==='snapshotText'?{snapshotCaptured:true,bytes:Buffer.byteLength(value.snapshot)}:value});
        return value;
      };
      const point=(value)=>Array.isArray(value)?{x:value[0],y:value[1]}:{x:value.x,y:value.y};
      const selector=value=>target(typeof value==='object'&&value!==null&&'target' in value?value.target:value);
      const upstreamPage={
        label:'p1',spaceId:runtime.browserRuntimeId,openedBy:'agent',targetId:wanted,
        url:async()=>(await run('pageInfo')).page.url,title:async()=>(await run('pageInfo')).page.title,
        info:async()=>(await run('pageInfo')).page,snapshot:async()=>(await run('snapshotText')).snapshot,
        screenshot:async options=>(await run('screenshot',{fullPage:options?.fullPage===true})).screenshotPath,
        goto:(url,options={})=>run('navigate',{url,waitUntil:options.waitUntil,timeoutSeconds:options.timeout?Math.ceil(options.timeout/1000):undefined}),
        reload:async()=>{const info=(await run('pageInfo')).page;return run('navigate',{url:info.url})},
        click:(value,options={})=>typeof value==='object'&&value!==null&&'x' in value?run('visualClick',point(value),options):run('click',{target:selector(value)},options),
        dblclick:(value,options={})=>typeof value==='object'&&value!==null&&'x' in value?run('visualDoubleClick',point(value),options):run('dblclick',{target:selector(value)},options),
        fill:(value,text,options={})=>run('fill',{target:selector(value),text},options),
        hover:value=>run('hover',{target:selector(value)}),
        focus:value=>run('focus',{target:selector(value)}),
        press:(value,key,options={})=>run('press',{target:selector(value),key},options),
        selectOption:(value,option,options={})=>run('selectOption',{target:selector(value),option:typeof option==='string'?option:option.label??option.value,optionBy:typeof option==='object'&&option.value!==undefined?'value':'label'},options),
        dragAndDrop:(from,to,options={})=>run('drag',{target:selector(from),destination:selector(to)},options),
        setInputFiles:()=>{throw Error('Arbitrary upload is blocked; use the audited event-local RR artifact operation')},
        waitForTimeout:ms=>run('wait',{ms}),waitForLoadState:(loadState='load',options={})=>run('wait',{loadState,ms:options.timeout??30000}),
        waitForSelector:async value=>{await run('readTarget',{target:selector(value)});return true},
        waitForURL:async value=>{const info=(await run('pageInfo')).page;if(typeof value==='string'&&info.url!==value)throw Error('Current URL does not match');return info.url},
        evaluate:()=>{throw Error('Unrestricted page.evaluate is blocked by event write policy; use snapshot and audited Page actions')},
        cdp:()=>{throw Error('Raw CDP is blocked by the canonical job runtime')},
        close:()=>{throw Error('The canonical job Page cannot be closed')},
      };
      upstreamPage.mouse={click:(x,y,options={})=>run(options.clickCount===2?'visualDoubleClick':'visualClick',{x,y,label:options.label},options),move:()=>true,down:()=>true,up:()=>true,wheel:(dx,dy)=>run('scroll',{deltaY:dy})};
      upstreamPage.keyboard={press:(key,options={})=>run('press',{key},options),type:(text,options={})=>run('typeText',{text},options),insertText:(text,options={})=>run('typeText',{text},options),paste:(text,options={})=>run('typeText',{text},options),down:key=>run('press',{key}),up:()=>true};
      const upstreamTask={spaceId:runtime.browserRuntimeId,name:process.env.CVENT_JOB_ID||'cvent-job',ownership:'agent',page:label=>{if(label!=='p1')throw Error('Only canonical Page p1 is available');return upstreamPage},userPage:()=>upstreamPage,pages:async()=>[upstreamPage],tabs:async()=>[{label:'p1',page:upstreamPage,targetId:wanted,title:await upstreamPage.title(),url:await upstreamPage.url(),active:true,openedBy:'agent'}],newPage:()=>{throw Error('The isolated job owns one canonical Page')},adopt:()=>upstreamPage,release:()=>{throw Error('The canonical Page cannot be released')},waitForControl:async()=>true,handOff:()=>{throw Error('Use cvent_login_handoff for authenticated user control')},finish:async()=>({keep:true}),cdp:()=>{throw Error('Raw CDP is blocked')}};
      const upstreamTaskSpace=async()=>upstreamTask;
      const context=simple?simpleScriptContext(run,logs,jobEvidence('input.inspection.json'),jobEvidence('expected-domains.json'),runtime,wanted):vm.createContext({
        cliLog:value=>logs.push(value),console:{log:(...values)=>logs.push(values.map(value=>typeof value==='string'?value:JSON.stringify(value)).join(' ')),warn:(...values)=>logs.push(values.join(' ')),error:(...values)=>logs.push(values.join(' '))},taskSpace:upstreamTaskSpace,page:upstreamPage,
        useOrCreateTaskSpace:async()=>({id:runtime.browserRuntimeId}),
        pageInfo:async()=> (await run('pageInfo')).page,
        snapshotText:async()=> (await run('snapshotText')).snapshot,
        captureScreenshot:async()=> (await run('screenshot')).screenshotPath,
        readTarget:async value=>run('readTarget',{target:target(value)}),
        gotoAndWait:async url=>run('navigate',{url}),
        openOrReuseTab:async url=>run('navigate',{url}),
        click:async(value,options={})=>typeof value==='string'?run('click',{target:target(value)},options):run('visualClick',point(value),options),
        doubleClick:async(value,options={})=>run('visualDoubleClick',point(value),options),
        fillInput:async(value,text,options={})=>run('fill',{target:target(value),text},options),
        typeText:async(text,options={})=>run('typeText',{text},options),
        pressKey:async(key,options={})=>run('press',{key,target:options.target?target(options.target):undefined},options),
        selectOption:async(value,option,options={})=>run('selectOption',{target:target(value),option,optionBy:options.optionBy},options),
        setChecked:async(value,checked,options={})=>run('setChecked',{target:target(value),checked},options),
        hover:async value=>run('hover',{target:target(value)}),
        scrollBy:async dy=>run('scroll',{deltaY:dy}),
        scroll:async({dy})=>run('scroll',{deltaY:dy}),
        wait:async seconds=>run('wait',{ms:Math.max(50,Math.min(seconds*1000,30000))}),
        waitForElement:async value=>run('wait',{target:target(value),ms:30000}),
        dragMouse:async(points,options={})=>run('visualDrag',{...point(points[0]),toX:point(points[1]).x,toY:point(points[1]).y},options),
      },{codeGeneration:{strings:false,wasm:false}});
      await new vm.Script(`(async()=>{${params.script}\n})()`).runInContext(context,{timeout:10000});
      if(simple)await simpleQueue;
      if(!simple&&dirty)throw Error('Ego round ended with changes lacking Save and fresh readback');
      result={postSaveSnapshot,verificationPlan:planned?.steps.filter(s=>s.data),actions:completedActions,actionCount:completedActions.length,writesAttempted,saves,readbacks,logs:logs.filter(value=>value!==postSaveSnapshot),unresolvedWrites:simple?Boolean(inheritedHold||mutationLatched||present(pendingPath)||present(uncertainPath)):false};break;
    }
    case 'actions': {
      let saveTarget;
      if(params.steps.some(s=>s.intent==='write')){
        const items=JSON.parse(fs.readFileSync(path.join(path.dirname(runtimePath),'rr-validation.json'),'utf8')).items.filter(i=>i.domain===params.domain);
        const sources=[...new Set(params.steps.filter(s=>s.rrSource).map(s=>s.rrSource))];
        for(const step of params.steps){
          step.data=isDataAction(step.operation,step)||(step.operation==='click'&&Boolean(step.rrSource)&&!/save/i.test(step.target??''));
          if(step.data)step.rrSource=sourceForAction(step,sources,items);
        }
        const planned=validateAtomicSteps(params.steps,params.commitMode);
        if(!planned.mutations.length)throw planningError('A write round must contain an RR-backed data mutation and commit/readback path');
        saveTarget=await preflightAtomic(planned);
      }
      const actions=completedActions;let pendingSavedWrite=false;
      for(let index=0;index<params.steps.length;index++){
        actionIndex=index;
        const step=params.steps[index],started=performance.now(),before=writesAttempted;
        const actionResult=await runAdaptive(step);
        const saveStep=step.intent==='write'&&step.operation==='click'&&step.target===saveTarget;
        if(saveStep){saves++;pendingSavedWrite=true}
        if(writesAttempted>before&&params.commitMode==='autosave')pendingSavedWrite=true;
        if(pendingSavedWrite&&step.intent==='read'&&['readTarget','sectionState','controlInventory','snapshotText','screenshot'].includes(step.operation)){readbacks++;pendingSavedWrite=false}
        actions.push({index,operation:step.operation,intent:step.intent,durationMs:Math.round((performance.now()-started)*10)/10,result:actionResult});
      }
      if(pendingSavedWrite)throw Error('Ego action round ended with saved changes lacking fresh readback');
      result={objective:params.objective,commitMode:params.commitMode,actions,writesAttempted,saves,readbacks,actionCount:actions.length};break;
    }
    case 'screenshot': result={screenshotPath:await ego.screenshot({path:params.filePath,fullPage:params.fullPage===true})};break;
    case 'visualClick': await authorizeInteractive(params,await pointDescriptor(params.x,params.y));result={result:await ego.click([params.x,params.y],{label:params.label})};break;
    case 'visualDoubleClick': await authorizeInteractive(params,await pointDescriptor(params.x,params.y));result={result:await ego.dblclick([params.x,params.y],{label:params.label})};break;
    case 'click': {const resolved=await resolveTarget(params);await authorizeInteractive(params,resolved.descriptor);result={result:await dispatch(params,()=>ego.click(resolved.target))};break;}
    case 'activate': {const resolved=await resolveTarget(params);await authorizeInteractive(params,resolved.descriptor);result={result:await dispatch(params,()=>ego.evaluateLocator(resolved.target,(element)=>{if(!(element instanceof HTMLElement))throw new Error('activate target must be an HTML element');element.click();return true}))};break;}
    case 'fill': result={result:await ego.fill(params.target,params.text??'')};break;
    case 'type': await ego.focus(params.target);result={result:await ego.insertText(params.text??'')};break;
    case 'typeText': if(params.intent==='write'){await assertLease();await assertAuthorizedPage();writesAttempted++}result={result:await ego.insertText(params.text??'')};break;
    case 'hover': result={result:await ego.hover(params.target)};break;
    case 'selectOption': {
      const descriptor=await ego.evaluateLocator(params.target,(element)=>({tag:element.tagName,role:element.getAttribute('role')||''}));
      if(descriptor.tag==='SELECT')result={selected:await ego.selectOption(params.target,{[params.optionBy==='value'?'value':'label']:params.option}),controlKind:'native'};
      else{
        if(params.optionBy==='value')throw new Error('Custom Cvent combobox options must be selected by exact label');
        await ego.click(params.target);await ego.waitForTimeout(250);
        const selected=await ego.evaluate(`(() => {const wanted=${JSON.stringify(String(params.option??''))},normalize=value=>String(value||'').replace(/\\s+/g,' ').trim(),roots=[document],matches=[];for(let i=0;i<roots.length;i++){for(const element of roots[i].querySelectorAll('*')){if(element.shadowRoot)roots.push(element.shadowRoot);if(!element.matches('[role="option"],li,[data-cvent-id*="option"],[data-testid*="option"]'))continue;const rect=element.getBoundingClientRect(),style=getComputedStyle(element);if(normalize(element.innerText||element.textContent)===normalize(wanted)&&element.isConnected&&rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden')matches.push(element)}}if(matches.length!==1)return {count:matches.length};matches[0].click();return {count:1,text:normalize(matches[0].innerText||matches[0].textContent)}})()`);
        if(selected.count!==1)throw new Error(`Custom Cvent combobox found ${selected.count} exact option-label matches`);
        result={selected:selected.text,controlKind:'custom'};
      }
      break;
    }
    case 'inspectRegistrationTypeCapabilities': result=await inspectRegistrationTypeCapabilities(ego,runtime,params);break;
    case 'configureAdmissionItems':
    case 'configureRegistrationTypes': result=await runTrustedCventProcedure(ego,runtime,operation,params);break;
    case 'setChecked': result={result:await ego.setChecked(params.target,Boolean(params.checked)),checked:Boolean(params.checked)};break;
    case 'press': await ego.focus(params.target);await ego.press(params.key);result={pressed:params.key};break;
    case 'search': {
      const descriptor=await ego.evaluateLocator(params.target,(element)=>({
        tag:element.tagName,type:element.getAttribute('type')||'',role:element.getAttribute('role')||'',
        name:element.getAttribute('name')||'',placeholder:element.getAttribute('placeholder')||'',
        aria:element.getAttribute('aria-label')||'',
      }));
      const searchable=descriptor.tag==='INPUT'&&(/search/i.test(`${descriptor.type} ${descriptor.role} ${descriptor.name} ${descriptor.placeholder} ${descriptor.aria}`));
      if(!searchable)throw new Error('search target is not an identified search/filter input');
      await ego.fill(params.target,params.text??'');if(params.submit!==false)await ego.press('Enter');
      result={query:params.text??'',submitted:params.submit!==false};break;
    }
    case 'selectText': result={selected:await ego.evaluateLocator(params.target,(element)=>{const range=document.createRange();range.selectNodeContents(element);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);element.closest('[contenteditable=true]')?.focus();return selection.toString()})};break;
    case 'drag': result={result:await ego.drag([params.target,params.destination],{delay:75})};break;
    case 'visualDrag': await authorizeInteractive(params,await pointDescriptor(params.x,params.y));result={result:await ego.drag([[params.x,params.y],[params.toX,params.toY]],{delay:75,label:params.label})};break;
    case 'uploadDiscountImport': await ego.setInputFiles(params.target,params.filePath);result={uploadedArtifact:'discount-import.xlsx'};break;
    case 'navigate': {
      if(simple){result=await runAdaptive({operation:'navigate',...params});break;}
      const lockPath=path.join(path.dirname(runtimePath),'authorized-target.json');let hasTargetLock=false;try{const lock=JSON.parse(fs.readFileSync(lockPath,'utf8'));hasTargetLock=lock.browser_runtime_id===runtime.browserRuntimeId&&String(lock.event_key||'').toLowerCase()===String(runtime.authorizedEventKey||'').toLowerCase()}catch{}
      if(runtime.accessMode!=='read_only_inventory'&&hasTargetLock)await stageAuthorizedTransition(params.url);
      const navigation=await ego.goto(params.url,{waitUntil:params.waitUntil||'domcontentloaded',timeout:Math.max(1000,Math.min(Number(params.timeoutSeconds??30),180)*1000)});
      if(runtime.accessMode!=='read_only_inventory'&&hasTargetLock)await assertAuthorizedPage();
      result={result:navigation};break;
    }
    case 'wait': {
      let ready=true;
      if(params.target)ready=await ego.waitForSelector(params.target,{timeout:params.ms??30000});
      else if(params.loadState)ready=await ego.waitForLoadState(params.loadState,{timeout:params.ms??30000});
      else await ego.waitForTimeout(params.ms??params.timeout??1000);
      result={waitedMs:params.ms??params.timeout??1000,ready};break;
    }
    default:throw new Error('Unsupported Ego operation: '+operation);
  }
  const after=await ego.evaluate("window.__CVENT_BROWSER_RUNTIME_ID || (window.name.startsWith('cvent-runtime-') ? window.name : null)");
  if(after!==runtime.browserRuntimeId)throw new Error('Runtime marker changed after Ego action');
  const page=await ego.pageInfo();
  await output({marker:after,targetId:wanted,observedAt:new Date().toISOString(),page,...result});process.exit(0);
}catch(e){await output({error:e?.stack||e?.message||String(e),actionIndex,writesAttempted,completedActions,...(operation==='script'?{saves,readbacks,unresolvedWrites:simple?fs.existsSync(pendingPath):dirty||writesAttempted>0}: {})},false);process.exit(1)}
