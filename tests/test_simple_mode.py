"""Execute the actual Simple Mode wrapper with fake browser I/O, never Cvent."""
import json
import os
import subprocess
import unittest
from unittest.mock import patch
from contextlib import nullcontext

import browser_tool
from mutation_outcome import mutation_outcome
import test_runtime_failure_regressions as regressions


class SimpleModeTests(unittest.TestCase):
    def setUp(self):
        regressions.AdapterFailureTests.setUp(self)
        self.runtime.update(executionMode='simple', authorizedEventName='Selected Event', authorizedEventId='test-event')
        (self.folder/'browser-runtime.json').write_text(json.dumps(self.runtime))
        (self.folder/'authorized-target.json').write_text(json.dumps({'browser_runtime_id':'cvent-runtime-test','event_key':'test-event','name':'Selected Event'}))
        (self.folder/'input.inspection.json').write_text(json.dumps({'sheets':[{'name':'Original RR','populated_rows':[[{'cell':'B1','value':'Verified intent'}]]}]}))
        self.state = self.folder/'fake-page.json'
        self.state.write_text(json.dumps({'url':'https://app.cvent.com/edit?evtstub=test-event','editor':True,'value':'old','persisted':'old'}))
        (self.folder/'vendor/ego-browser-linux/dist/src/helpers.js').write_text(r'''
import fs from 'node:fs';
let state=JSON.parse(fs.readFileSync('fake-page.json','utf8'));
const store=()=>fs.writeFileSync('fake-page.json',JSON.stringify(state));
const labels={'@save':'Save','@edit':'Edit','@delete':'Delete','@archive':'Archive','@remove':'Remove','@publish':'Publish','@send':'Send','@schedule':'Schedule','@test-send':'Test Send','@new':'Create Event','@identity':'Event Name','@bare-title':'* Title:','@code':'Event Code','@field':'Venue','@check':'Enabled','@select':'Choice','@file':'Upload','@link':'Show Hours','@editor':'Editor'};
function descriptor(target){if(!labels[target])throw Error('Stale ref / control not found');return {tag:['@field','@identity','@code','@file','@check'].includes(target)?'INPUT':target==='@select'?'SELECT':target==='@link'?'A':target==='@editor'?'DIV':'BUTTON',label:labels[target],role:target==='@check'?'checkbox':target==='@editor'?'textbox':null,connected:true,disabled:false,value:state.value,documentUrl:process.env.FRAME_URL||state.url,options:[{label:'Choice',value:'choice',disabled:false}]}}
export async function listTabs(){return [{id:'target'}]}
export async function switchTab(){}
export async function pageInfo(){return {url:state.url,title:'Selected Event'}}
export async function evaluate(expression){
 if(expression.includes('__CVENT_BROWSER_RUNTIME_ID'))return 'cvent-runtime-test';
 if(expression.includes('document.activeElement'))return descriptor(state.focused||'@field');
 if(expression.includes('controls=[],seen'))return {controls:state.editor?[{label:'Save'}]:[]};
 if(expression.includes('hasSelectedName'))return {ready:'complete',hasSelectedName:true,hasSelectedHeading:true,hasLogin:state.url.includes('/login'),keys:['test-event'],hasExpectedKey:true};
 if(expression.includes('sign in|log in'))return !!process.env.READ_AUTH_TEXT;
 if(expression.includes('const wanted='))return true;
 return false;
}
export async function evaluateLocator(target,fn){const d=descriptor(target);if(String(fn).includes('attributeNames=')){const link={text:'Show Hours',href:'https://bdny.com/about-bdny/',rawHref:'https://bdny.com/about-bdny/',target:'_blank',rel:null};return {...d,text:d.label,value:target==='@field'?state.value:null,checked:target==='@check'?Boolean(state.value):null,enabled:true,visible:true,editable:target==='@editor',attributes:{href:target==='@link'?link.href:null,target:target==='@link'?'_blank':null,rel:null,title:null,name:null,placeholder:null,'aria-label':null,'aria-expanded':null,'aria-checked':null,'aria-selected':null,role:d.role,contenteditable:target==='@editor'?'true':null,type:null},href:target==='@link'?link.href:null,selectedText:target==='@editor'?'Show Hours':'',html:target==='@editor'?'<p><a href="https://bdny.com/about-bdny/">Show Hours</a></p>':null,htmlTruncated:false,links:target==='@editor'?[link]:target==='@link'?[link]:[]}}return d}
export async function fill(target,text){state.value=text;if(!state.editor)state.persisted=text;store();if(text==='hiccup')throw Error('Recoverable field dispatch hiccup')}
export async function focus(target){state.focused=target;store()}
export async function insertText(text){return fill(state.focused||'@field',text)}
export async function click(target){descriptor(target);if(target==='@save'){state.persisted=state.value;if(state.recordKey)state.records[state.recordKey]=state.value;state.editor=false;store();if(process.env.SAVE_THROW)throw Error('Save response lost')}if(target==='@edit'){state.editor=true;store()}}
export async function press(){}
export async function down(){}
export async function up(){}
export async function snapshot(){return JSON.stringify(state)}
export async function screenshot(){return 'browser-visual-test.png'}
export async function waitForTimeout(){}
export async function waitForLoadState(){}
export async function waitForSelector(target){descriptor(target)}
export async function goto(url){state.url=url;const key=new URL(url).searchParams.get('recordId');if(key){state.recordKey=key;state.value=state.records[key]??'';state.persisted=state.value;state.editor=true}store()}
export async function hover(){}
export async function wheel(){}
export async function selectOption(target,option){state.value=option;store()}
export async function setChecked(target,checked){state.value=checked;store()}
export async function setInputFiles(target,files){state.files=files;store()}
''')

    tearDown = regressions.AdapterFailureTests.tearDown

    def run_simple(self, script, **extra):
        env={k:v for k,v in os.environ.items() if not k.startswith('CVENT_')}
        env.update(CVENT_ENV='development', **extra)
        p=subprocess.run(['node','ego_direct.mjs','--runtime',str(self.folder/'browser-runtime.json'),'--operation','script','--params',json.dumps({'intent':'read','script':script})],cwd=self.folder,env=env,capture_output=True,text=True,timeout=15)
        return p, browser_tool.child_result(p)

    def test_normal_variable_loop_and_split_save_need_no_metadata_or_plan(self):
        _, first=self.run_simple("const task=await taskSpace('mission'); const p=task.page('p1'); for(const value of ['one','two']) await p.fill('@field',value); await p.keyboard.press('Tab'); console.log(await p.snapshot());")
        self.assertTrue(first['ok'],first)
        self.assertEqual(first['writesAttempted'],2)
        self.assertFalse(mutation_outcome(self.folder)['unresolved'])
        _, second=self.run_simple("await page.click('@save'); console.log(await page.snapshot());")
        self.assertTrue(second['ok'],second)
        self.assertEqual(second['saves'],1)
        self.assertEqual(second['readbacks'],1)
        self.assertEqual(json.loads(self.state.read_text())['persisted'],'two')
        self.assertFalse((self.folder/'browser-mutation-uncertain.json').exists())
        self.assertTrue((self.folder/'browser-last-atomic-readback.json').exists())

    def test_pre_save_hiccup_and_stale_ref_do_not_create_holds_or_prevent_recovery(self):
        _, failed=self.run_simple("await page.fill('@field','hiccup');")
        self.assertFalse(failed['ok'])
        self.assertFalse(failed['unresolvedWrites'])
        self.assertFalse(mutation_outcome(self.folder)['unresolved'])
        _, failed=self.run_simple("await page.click('@missing');")
        self.assertFalse(failed['unresolvedWrites'])
        _, recovered=self.run_simple("console.log(await page.snapshot()); await page.fill('@field','recovered'); await page.click('@save'); console.log(await page.snapshot());")
        self.assertTrue(recovered['ok'],recovered)

    def test_persisted_save_response_loss_retains_evidence_but_allows_inspection(self):
        self.run_simple("await page.fill('@field','new');")
        _, failed=self.run_simple("await page.click('@save');", SAVE_THROW='1')
        self.assertTrue(failed['unresolvedWrites'])
        self.assertTrue(mutation_outcome(self.folder)['unresolved'])
        self.assertFalse((self.folder/'browser-mutation-uncertain.json').exists())
        _, observed=self.run_simple("console.log(await page.snapshot());")
        self.assertTrue(observed['ok'],observed)
        self.assertEqual(observed['readbacks'],1)
        self.assertEqual(json.loads(self.state.read_text())['persisted'],'new')

    def test_compact_locator_reads_link_editor_and_selection_state(self):
        _, r=self.run_simple("const link=page.locator('@link'); console.log(await link.getAttribute('href')); const editor=await page.readTarget('@editor'); console.log(JSON.stringify({selectedText:editor.selectedText,html:editor.html,links:editor.links}));")
        self.assertTrue(r['ok'],r)
        self.assertEqual(r['logs'][0],'https://bdny.com/about-bdny/')
        rich=json.loads(r['logs'][1]);self.assertEqual(rich['selectedText'],'Show Hours')
        self.assertEqual(rich['links'][0]['href'],'https://bdny.com/about-bdny/')
        self.assertIn('<a href=',rich['html'])

    def test_selection_keyboard_is_native_but_not_a_data_write(self):
        _, r=self.run_simple("await page.focus('@editor'); await page.keyboard.press('Shift+End'); await page.keyboard.down('Shift'); await page.keyboard.press('ArrowLeft'); await page.keyboard.up('Shift');")
        self.assertTrue(r['ok'],r)
        self.assertEqual(r['writesAttempted'],0)
        self.assertFalse(mutation_outcome(self.folder)['unresolved'])

    def test_missing_popup_wait_is_an_actionable_zero_dispatch_capability_error(self):
        _, r=self.run_simple("const popup=page.waitForEvent('popup'); await page.click('@edit'); await popup;")
        self.assertFalse(r['ok'],r)
        self.assertIn('EGO_CAPABILITY_UNAVAILABLE',r['error'])
        self.assertIn('opens in assigned Page p1',r['error'])
        self.assertEqual(r['writesAttempted'],0)
        self.assertEqual(r['completedActions'],[])

    def test_real_excel_drives_125_dynamic_edits_save_reopen_and_idempotent_recheck(self):
        # Generic mocked forms, not a pricing/question executor or a model run.
        # Script chooses work from literal Excel data and observed navigation.
        from openpyxl import Workbook
        wb = Workbook()
        ws = wb.active
        ws.title = 'Unrecognized customer layout'
        ws.append(['Object', 'Requested value'])
        desired = {f'Object {i}': f'Value {i}' for i in range(125)}
        for name, value in desired.items():
            ws.append([name, value])
        workbook = self.folder/'input.xlsx'
        wb.save(workbook)
        wb.close()
        inspection = subprocess.run(['python3',str(regressions.ROOT/'inspect_rr.py'),str(workbook),str(self.folder/'input.inspection.json')],capture_output=True,text=True,timeout=30)
        self.assertEqual(inspection.returncode,0,inspection.stderr)
        for name in ('expected-domains.json','rr-validation.json','configuration-plan.json'):
            (self.folder/name).unlink(missing_ok=True)
        state = json.loads(self.state.read_text())
        state.update(records={},links=[{'text':name,'href':f'https://app.cvent.com/edit?evtstub=test-event&recordId={i}'} for i,name in enumerate(desired)])
        self.state.write_text(json.dumps(state))
        script = r'''
const links=JSON.parse(await page.snapshot()).links;
let changed=0,verified=0;
for(const row of rr.sheets[0].populated_rows.slice(1)) {
  const [name,value]=row.map(cell=>cell.value);
  const link=links.find(link=>link.text===name);
  if(!link) throw Error('Missing observed object: '+name);
  await page.goto(link.href);
  if(await page.locator('@field').inputValue()!==value) {
    await page.fill('@field',value);
    await page.click('@save');
    await page.goto(link.href);
    changed++;
  }
  if(await page.locator('@field').inputValue()!==value) throw Error('Persisted mismatch: '+name);
  verified++;
}
console.log(JSON.stringify({changed,verified}));
'''
        _, first = self.run_simple(script)
        self.assertTrue(first['ok'],first)
        self.assertEqual(json.loads(first['logs'][-1]),{'changed':125,'verified':125})
        self.assertEqual(first['saves'],125)
        self.assertGreaterEqual(first['readbacks'],125)
        self.assertEqual(list(json.loads(self.state.read_text())['records'].values()),list(desired.values()))
        _, recheck = self.run_simple(script)
        self.assertTrue(recheck['ok'],recheck)
        self.assertEqual(json.loads(recheck['logs'][-1]),{'changed':0,'verified':125})
        self.assertEqual(recheck['saves'],0)
        self.assertEqual(recheck['writesAttempted'],0)

    def test_original_rr_available_without_any_compiler_artifact(self):
        _, r=self.run_simple("console.log(rr.sheets[0].populated_rows[0][0]); console.log(desired);")
        self.assertTrue(r['ok'],r)
        self.assertIn('Verified intent',r['logs'][0])

    def test_reads_and_navigation_work_without_target_write_authority(self):
        (self.folder/'authorized-target.json').unlink()
        _, r=self.run_simple("console.log(await page.snapshot()); await page.goto('https://app.cvent.com/events2/eventselection'); console.log(await page.info());")
        self.assertTrue(r['ok'],r)
        _, r=self.run_simple("await page.fill('@field','no');")
        self.assertFalse(r['ok'])
        self.assertEqual(r['writesAttempted'],0)

    def test_owned_reads_can_inspect_login_or_error_pages_and_recover_navigation(self):
        s=json.loads(self.state.read_text());s['url']='https://app.cvent.com/login?evtstub=test-event';self.state.write_text(json.dumps(s))
        _, r=self.run_simple("console.log(await page.url()); console.log(await page.snapshot());", READ_AUTH_TEXT='1')
        self.assertTrue(r['ok'],r)
        _, r=self.run_simple("await page.fill('@field','no');", READ_AUTH_TEXT='1')
        self.assertFalse(r['ok'],r);self.assertEqual(r['writesAttempted'],0)
        _, r=self.run_simple("await page.goto('https://app.cvent.com/view?evtstub=test-event'); console.log(await page.snapshot());", READ_AUTH_TEXT='1')
        self.assertTrue(r['ok'],r)

    def test_actual_cvent_title_label_is_immutable_but_tab_is_allowed(self):
        s=json.loads(self.state.read_text());s['url']='https://app.cvent.com/Details/EventDetails/Index/Edit?evtstub=test-event';self.state.write_text(json.dumps(s))
        _, r=self.run_simple("await page.fill('@bare-title','wrong');")
        self.assertFalse(r['ok'],r);self.assertEqual(r['writesAttempted'],0)
        _, r=self.run_simple("await page.focus('@bare-title'); await page.keyboard.press('Tab');")
        self.assertTrue(r['ok'],r)

    def test_same_event_route_and_origin_changes_work(self):
        _, r=self.run_simple("await page.goto('https://events.app.cvent.com/details?evtstub=test-event'); await page.fill('@field','same event');")
        self.assertTrue(r['ok'],r)
        _, r=self.run_simple("await page.goto('https://events.app.cvent.com/keyless-config'); await page.fill('@field','same keyless event');")
        self.assertTrue(r['ok'],r)

    def test_cross_event_page_and_frame_writes_are_blocked(self):
        _, r=self.run_simple("await page.goto('https://app.cvent.com/view?evtstub=another'); await page.fill('@field','no');")
        self.assertFalse(r['ok'])
        self.assertEqual(r['writesAttempted'],0)
        self.state.write_text(json.dumps({'url':'https://app.cvent.com/view?evtstub=test-event','editor':True,'value':'old'}))
        _, r=self.run_simple("await page.fill('@field','no');", FRAME_URL='https://app.cvent.com/view?evtstub=another')
        self.assertFalse(r['ok'])
        self.assertEqual(r['writesAttempted'],0)

    def test_permanent_control_blocks(self):
        for ref in ['delete','archive','remove','publish','send','schedule','test-send','new']:
            with self.subTest(ref=ref):
                _, r=self.run_simple(f"await page.click('@{ref}');")
                self.assertFalse(r['ok'],r)
                self.assertEqual(r['writesAttempted'],0)
        for ref in ['identity','code']:
            _, r=self.run_simple(f"await page.fill('@{ref}','no');")
            self.assertFalse(r['ok'],r)
            self.assertEqual(r['writesAttempted'],0)

    def test_attendee_contact_account_and_shared_writes_blocked(self):
        for area in ['attendees','contacts','account','global','library']:
            _, r=self.run_simple(f"await page.goto('https://app.cvent.com/{area}/edit?evtstub=test-event'); await page.fill('@field','no');")
            self.assertFalse(r['ok'],r)
            self.assertEqual(r['writesAttempted'],0)

    def test_destructive_url_navigation_blocked(self):
        for op in ['Delete','Archive','Publish','CreateEvent','SendEmail']:
            _, r=self.run_simple(f"await page.goto('https://app.cvent.com/config/{op}?evtstub=test-event');")
            self.assertFalse(r['ok'],r)
            self.assertEqual(r['writesAttempted'],0)

    def test_no_general_node_host_escape_or_raw_protocol(self):
        attacks=["page.info.constructor('return process')()", "(await page.info()).constructor.constructor('return process')()", "try { await page.click('@missing') } catch(e) { e.constructor.constructor('return process')() }", "await import('node:fs')", "await page.evaluate('fetch(\"/Delete\")')", "await page.cdp('Runtime.evaluate',{})", "process.exit(0)"]
        for script in attacks:
            with self.subTest(script=script):
                _, r=self.run_simple(script)
                self.assertFalse(r['ok'],r)
                self.assertEqual(r['writesAttempted'],0)

    def test_uploads_only_job_owned_regular_files_including_array_api(self):
        (self.folder/'uploads').mkdir()
        file=self.folder/'uploads'/'asset.txt';file.write_text('RR asset')
        _, r=self.run_simple(f"await page.setInputFiles('@file',[{json.dumps(str(file))}]);")
        self.assertTrue(r['ok'],r)
        link=self.folder/'uploads'/'escape';link.symlink_to(self.state)
        _, r=self.run_simple(f"await page.setInputFiles('@file',{json.dumps(str(link))});")
        self.assertFalse(r['ok'],r)
        self.assertEqual(r['writesAttempted'],0)

    def test_lease_loss_blocks_before_dispatch(self):
        _, r=self.run_simple("await page.fill('@field','no');",CVENT_JOB_ID='test-job')
        self.assertFalse(r['ok'])
        self.assertIn('lease context',r['error'])
        self.assertEqual(r['writesAttempted'],0)

    def test_real_extension_bypasses_controller_and_records_pi_verification(self):
        p=subprocess.run(['node','tests/simple_extension.mjs'],cwd=regressions.ROOT,text=True,capture_output=True,timeout=30)
        self.assertEqual(p.returncode,0,(p.stdout+p.stderr)[-9000:])

    def test_router_does_not_require_rr_sources_or_atomic_shape(self):
        proc,r=self.run_simple("await page.fill('@field','split edit');")
        with patch.object(browser_tool,'CURRENT',self.folder),patch.object(browser_tool,'action',side_effect=lambda *_:nullcontext()),patch.object(browser_tool,'guard',return_value={'url':'https://app.cvent.com/view?evtstub=test-event'}),patch.object(browser_tool.subprocess,'run',return_value=proc):
            routed=browser_tool.run_direct(self.folder/'browser-runtime.json',self.runtime,'ego','script',{'intent':'read','script':"await page.fill('@field','split edit');"})
        self.assertTrue(routed['ok'],routed)
        self.assertFalse(mutation_outcome(self.folder)['unresolved'])
