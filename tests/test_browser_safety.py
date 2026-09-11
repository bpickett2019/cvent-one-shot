import json,os,subprocess,tempfile,unittest
from contextlib import nullcontext
from pathlib import Path
from unittest.mock import patch
import browser_gate,browser_tool

ROOT=Path(__file__).resolve().parents[1]
HTML=(ROOT/'templates/index.html').read_text()
APP=(ROOT/'app.py').read_text()
PROMPT=(ROOT/'PI_PROMPT.md').read_text()
SKILL=(ROOT/'skills/ego-browser/SKILL.md').read_text()
ROUTER=(ROOT/'browser_tool.py').read_text()
EGO_DIRECT=(ROOT/'ego_direct.mjs').read_text()

class ViewerSafetyTests(unittest.TestCase):
    def test_viewer_is_shielded_by_default(self):
        self.assertIn('viewer-stage agent-owned',HTML)
        self.assertIn('.viewer-stage.agent-owned .browser-frame',HTML)
        self.assertIn('pointer-events:none',HTML)
        self.assertIn('interaction-shield',HTML)
        self.assertIn('TAKE CONTROL',HTML)
        self.assertIn('RETURN TO AGENT',HTML)
        self.assertLess(HTML.index('id="ownership-label"'),HTML.index('id="take-control"'))
        self.assertLess(HTML.index('id="take-control"'),HTML.index('id="browser-reload"'))
        self.assertIn('class="browser-controls"',HTML)
        self.assertNotIn('class="shield-card"',HTML)
        self.assertIn('background:transparent;pointer-events:auto',HTML)
        self.assertIn('tabindex="-1"',HTML)
    def test_hover_never_changes_ownership(self):
        lowered=HTML.lower()
        for event in ('mouseenter','mouseover','pointerenter','mousemove'):
            self.assertNotIn(event,lowered)
    def test_raw_viewer_tab_hidden_until_user_control(self):
        self.assertIn('id="browser-tab" class="secondary" type="button" hidden',HTML)
        self.assertIn("if(state.browser_gate?.ownership==='USER'&&state.browser?.viewer_url)",HTML)
    def test_viewer_document_blocks_all_input_while_agent_owned(self):
        self.assertIn("'pointermove'",APP);self.assertIn("'mousemove'",APP)
        self.assertIn("'wheel'",APP);self.assertIn("'focusin'",APP)
        self.assertIn("document.body.style.pointerEvents=user?'auto':'none'",APP)
        self.assertIn("d.ownership==='USER'&&d.desiredOwnership==='USER'",APP)
        self.assertIn("if not user_owned:",APP)
        self.assertIn('ownership.get("ownership") == "USER"',APP)
    def test_product_explains_the_direct_pi_ego_workflow(self):
        self.assertIn('<title>Forge · CVENT Agent</title>',HTML)
        self.assertIn('PI AGENT · EGO BROWSER · STEEL.DEV',HTML)
        self.assertIn('Upload the RR. Pi builds the event.',HTML)
        self.assertIn('Pi reads the workbook directly',HTML)
        self.assertIn('PI + EGO SKILL · STEEL.DEV',HTML)
        self.assertIn('FastAPI(title="CVENT Agent"',APP)
        self.assertIn('state["agent_session_saved"]',APP)
        self.assertNotIn('state["agent_session"]',APP)
    def test_forge_brand_palette(self):
        for color in ('#152c44','#5994f6','#255ab2','#4581e5','#99bfff','#cae5ff','#6ff0dd','#eefffc'):
            self.assertIn(color,HTML)
    def test_three_user_operation_switcher_maps_only_active_worker_slots(self):
        for slot in ('1','2','3'):
            self.assertIn(f'data-worker="{slot}"',HTML)
            self.assertIn(f'USER {slot}',HTML)
        self.assertIn('selectedWorker=Number(slot)',HTML)
        self.assertIn('f.append(\'worker_slot\',String(workerAtStart))',HTML)
        self.assertIn('`/api/status?worker_slot=${workerAtStart}`',HTML)
        self.assertIn('id="active-worker-label"',HTML)
        self.assertIn('id="intake-worker-context"',HTML)
        self.assertIn('id="browser-worker-context"',HTML)
        self.assertIn("url.searchParams.set('worker',String(selectedWorker))",HTML)
        self.assertIn('No runs yet for User ${selectedWorker}',HTML)
        self.assertIn('id="event-target-input"',HTML)
        self.assertIn('id="event-options"',HTML)
        self.assertIn('Type an exact server-authorized event name, code, or ID.',HTML)
        self.assertIn('workspaceEpoch',HTML)
        self.assertIn("$('rr').value=''",HTML)
        self.assertIn('id="workbook-file-name"',HTML)
        self.assertIn('id="workbook-file-meta"',HTML)
        self.assertIn('renderWorkbookIdentity(state.rr_file',HTML)
        self.assertIn("['draft','cancelled'].includes(jobState)",HTML)
        self.assertIn("jobState==='cancelled'?'RUN PI AGAIN':'RUN PI AGENT'",HTML)
        self.assertIn("d.detail==='CSRF validation failed'",HTML)
        self.assertIn("fetch('/api/me',{cache:'no-store'})",HTML)

    def test_sidebar_navigation_is_clickable(self):
        for target in ('workspace-top','intake-panel','browser-panel'):
            self.assertIn(f'data-target="{target}"',HTML)
            self.assertIn(f'id="{target}"',HTML)
        self.assertNotIn('data-target="scope-panel"',HTML)
        self.assertNotIn('data-target="workbook-panel"',HTML)
        self.assertIn('window.scrollTo({top,behavior})',HTML)
        self.assertIn("target.classList.add('nav-focus')",HTML)
        self.assertIn('<strong>Steel.dev browser</strong><small>Watch Pi use Ego</small>',HTML)
        self.assertIn("x.setAttribute('aria-current','page')",HTML)
    def test_completed_work_is_visibly_reported(self):
        self.assertIn('id="completion-summary"',HTML)
        self.assertIn('id="completion-chips"',HTML)
        self.assertIn('id="completion-toast"',HTML)
        self.assertIn("`${prettyStage(last)} complete`",HTML)
        self.assertIn("completed.length>knownCompleted",HTML)
        self.assertIn("classList.toggle('is-complete',done)",HTML)
    def test_login_is_one_continuous_return_to_agent_workflow(self):
        self.assertNotIn('id="save-auth"', HTML)
        self.assertNotIn('SAVE LOGIN INFO', HTML)
        self.assertIn('id="reset-login"', HTML)
        self.assertIn('RESET CVENT LOGIN', HTML)
        self.assertIn('Forge verifies before persisting', HTML)
        self.assertIn("'/api/browser/reset-login'", HTML)
        self.assertIn('profilePersisted: true', (ROOT/'extensions/cvent-job-tools.ts').read_text())

    def test_operator_errors_are_actionable_and_do_not_lead_with_stack_traces(self):
        for text in (
            'Anthropic is unavailable',
            'Cvent login is required',
            'Your Cvent session expired',
            'USER 1 is busy',
            'All 3 workers are busy',
            'This event is already being modified',
            'Your security token expired',
            'The event was not uniquely found',
            'Stopped safely before any Cvent write',
            'A Cvent write may have started',
            'Build completed and final Cvent readback passed',
        ):
            self.assertIn(text, HTML)
        self.assertIn("lower.includes('traceback')", HTML)
        self.assertIn("'RESTRICTED STAGING ACCESS':'ENTRA AUTHENTICATED'", HTML)

    def test_live_data_is_never_cached(self):
        self.assertIn("opts.cache='no-store'",HTML)
        self.assertIn('state.rr_version!==loadedRRVersion',HTML)
        self.assertIn('"Cache-Control": "no-store, no-cache, must-revalidate"',APP)
        self.assertIn('JSONResponse(product_facing(state), headers={"Cache-Control": "no-store"})',APP)

class BrowserTargetSafetyTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.base=Path(self.tmp.name)
        self.old=(browser_tool.CURRENT,browser_tool.local_probe)
        browser_tool.CURRENT=self.base
        self.runtime={'browserRuntimeId':'runtime-current','authorizedEventName':'(C+D) Medtrade Testing Clone 2','authorizedEventKey':'locked','targetBrowserIdentity':{'url':'https://app.cvent.com/event?evtstub=locked'}}
    def tearDown(self):
        browser_tool.CURRENT,browser_tool.local_probe=self.old;self.tmp.cleanup()
    def write_lock(self, status='Draft'):
        (self.base/'authorized-target.json').write_text(json.dumps({'name':'(C+D) Medtrade Testing Clone 2','url':'https://app.cvent.com/event?evtstub=locked','event_key':'locked','event_status':status,'browser_runtime_id':'runtime-current'}))
    def test_write_requires_lock_matching_live_page(self):
        browser_tool.local_probe=lambda runtime:{'url':'https://app.cvent.com/event?evtStub=locked'}
        self.assertEqual(browser_tool.event_key('https://app.cvent.com/event?evtStub=locked'),'locked')
        with self.assertRaisesRegex(RuntimeError,'Write blocked'):
            browser_tool.guard(self.runtime,'click',{'intent':'write'})
        self.write_lock()
        browser_tool.guard(self.runtime,'click',{'intent':'write'})
        stale=dict(self.runtime,browserRuntimeId='runtime-restarted')
        with self.assertRaisesRegex(RuntimeError,'Write blocked'):
            browser_tool.guard(stale,'click',{'intent':'write'})
        browser_tool.local_probe=lambda runtime:{'url':'https://app.cvent.com/event?evtstub=other'}
        with self.assertRaisesRegex(RuntimeError,'Write blocked'):
            browser_tool.guard(self.runtime,'click',{'intent':'write'})

    def test_lifecycle_policy_allows_configurable_statuses_and_blocks_locked_or_unknown(self):
        browser_tool.local_probe=lambda runtime:{'url':'https://app.cvent.com/event?evtstub=locked'}
        for status in ('Draft','Active','Open','Completed'):
            self.write_lock(status)
            browser_tool.guard(self.runtime,'configureAdmissionItems',{'intent':'write'})
        for status in ('Cancelled','Canceled','Archived','Lifecycle Surprise'):
            self.write_lock(status)
            with self.assertRaisesRegex(RuntimeError,'not writable under approved product policy'):
                browser_tool.guard(self.runtime,'configureAdmissionItems',{'intent':'write'})
        self.write_lock('Completed')
        with patch.dict(os.environ,{'CVENT_WRITABLE_EVENT_STATUSES':'draft'}):
            with self.assertRaisesRegex(RuntimeError,'completed.*not writable'):
                browser_tool.guard(self.runtime,'configureAdmissionItems',{'intent':'write'})
    def test_uncertain_mutation_blocks_automatic_replay(self):
        browser_tool.local_probe=lambda runtime:{'url':'https://app.cvent.com/event?evtstub=locked'}
        self.write_lock()
        (self.base/'browser-mutation-uncertain.json').write_text('{}')
        with self.assertRaisesRegex(RuntimeError,'uncertain outcome'):
            browser_tool.guard(self.runtime,'click',{'intent':'write'})
    def test_write_timeout_is_audited_and_cannot_replay(self):
        current={'url':'https://app.cvent.com/event?evtstub=locked'}
        params={'intent':'write','rrSource':'Event Details!B10','target':'#Save','timeoutSeconds':1}
        resolved=subprocess.CompletedProcess(['node'],0,'BROWSER_TOOL_RESULT={"ok":true,"resolved":{"tag":"BUTTON","connected":true,"disabled":false}}\n','')
        with patch.object(browser_tool,'action',side_effect=lambda *_:nullcontext()), \
             patch.object(browser_tool,'guard',return_value=current), \
             patch.object(browser_tool.subprocess,'run',side_effect=[resolved,subprocess.TimeoutExpired(['node'],1)]):
            with self.assertRaisesRegex(RuntimeError,'automatic replay is blocked'):
                browser_tool.run_direct(self.base/'runtime.json',self.runtime,'ego','click',params)
        records=[json.loads(line) for line in (self.base/'scope-write-audit.jsonl').read_text().splitlines()]
        self.assertEqual([record['result'] for record in records],['attempted','uncertain_timeout'])
        self.assertTrue((self.base/'browser-mutation-uncertain.json').exists())
    def test_write_helper_error_is_uncertain_and_cannot_replay(self):
        current={'url':'https://app.cvent.com/event?evtstub=locked'}
        params={'intent':'write','rrSource':'Event Details!B10','target':'#Save','timeoutSeconds':1}
        resolved=subprocess.CompletedProcess(['node'],0,'BROWSER_TOOL_RESULT={"ok":true,"resolved":{"tag":"BUTTON","connected":true,"disabled":false}}\n','')
        failed=subprocess.CompletedProcess(['node'],1,'BROWSER_TOOL_RESULT={"ok":false,"error":"post-action marker failed"}\n','')
        with patch.object(browser_tool,'action',side_effect=lambda *_:nullcontext()), \
             patch.object(browser_tool,'guard',return_value=current), \
             patch.object(browser_tool.subprocess,'run',side_effect=[resolved,failed]):
            with self.assertRaisesRegex(RuntimeError,'post-action marker failed'):
                browser_tool.run_direct(self.base/'runtime.json',self.runtime,'ego','click',params)
        records=[json.loads(line) for line in (self.base/'scope-write-audit.jsonl').read_text().splitlines()]
        self.assertEqual([record['result'] for record in records],['attempted','uncertain_error'])
        self.assertTrue((self.base/'browser-mutation-uncertain.json').exists())
    def test_invalid_selector_is_rejected_before_write_audit(self):
        browser_tool.local_probe=lambda runtime:{'url':'https://app.cvent.com/event?evtstub=locked'}
        self.write_lock()
        with self.assertRaisesRegex(RuntimeError,'Unsupported selector syntax'):
            browser_tool.guard(self.runtime,'click',{
                'intent':'write','target':'button:has-text("Edit")',
            })
        self.assertFalse((self.base/'scope-write-audit.jsonl').exists())
        self.assertFalse((self.base/'browser-mutation-uncertain.json').exists())
    def test_unresolved_write_target_is_rejected_before_dispatch(self):
        current={'url':'https://app.cvent.com/event?evtstub=locked'}
        params={'intent':'write','target':'role:button[name="Missing"]'}
        failed=subprocess.CompletedProcess(['node'],1,'BROWSER_TOOL_RESULT={"ok":false,"error":"could not locate target"}\n','')
        with patch.object(browser_tool,'action',side_effect=lambda *_:nullcontext()), \
             patch.object(browser_tool,'guard',return_value=current), \
             patch.object(browser_tool.subprocess,'run',return_value=failed):
            with self.assertRaisesRegex(RuntimeError,'before browser dispatch'):
                browser_tool.run_direct(self.base/'runtime.json',self.runtime,'ego','click',params)
        self.assertFalse((self.base/'scope-write-audit.jsonl').exists())
        self.assertFalse((self.base/'browser-mutation-uncertain.json').exists())

    def test_trusted_procedure_accepts_only_typed_rr_values(self):
        admission={'intent':'write','rrSource':'VERIFIED RR domain: admission_items','timeoutSeconds':600,'records':[
            {'code':'FULL','name':'Full Access','source':'Sheet!D5','registrationTypes':[{'code':'ATT','name':'Attendee'}],'knownRegistrationTypes':[{'code':'ATT','name':'Attendee'}]},
        ]}
        browser_tool.validate_trusted_procedure('configureAdmissionItems',admission)
        with self.assertRaisesRegex(RuntimeError,'only typed RR'):
            browser_tool.validate_trusted_procedure('configureAdmissionItems',{**admission,'target':'#arbitrary'})
        registration={'intent':'write','rrSource':'VERIFIED RR domain: registration_types','timeoutSeconds':600,'records':[
            {'code':'ATT','name':'Attendee','source':'Sheet!A5','activationDirective':'ACTIVATE','groupRegistration':False,'reprintFee':125},
        ]}
        browser_tool.validate_trusted_procedure('configureRegistrationTypes',registration)
        with self.assertRaisesRegex(RuntimeError,'directives are invalid'):
            browser_tool.validate_trusted_procedure('configureRegistrationTypes',{**registration,'records':[{**registration['records'][0],'activationDirective':'OPEN'}]})

    def test_only_fixed_rr_discount_artifact_can_be_uploaded(self):
        artifact=self.base/'discount-import.xlsx';artifact.write_bytes(b'xlsx')
        self.assertEqual(browser_tool.fixed_upload_artifact({'artifact':'discount-import.xlsx'}),artifact.resolve())
        with self.assertRaisesRegex(RuntimeError,'Only the compiled RR'):
            browser_tool.fixed_upload_artifact({'artifact':'other.xlsx'})
        artifact.unlink();artifact.symlink_to(self.base/'outside.xlsx')
        (self.base/'outside.xlsx').write_bytes(b'outside')
        with self.assertRaisesRegex(RuntimeError,'escaped|invalid'):
            browser_tool.fixed_upload_artifact({'artifact':'discount-import.xlsx'})

    def test_preflight_can_replace_role_locator_before_write_dispatch(self):
        resolved=subprocess.CompletedProcess(['node'],0,
            'BROWSER_TOOL_RESULT={"ok":true,"resolved":{"tag":"SELECT","connected":true,"disabled":false},"resolvedTarget":"[data-cvent-agent-target=\\"one\\"]","fallbackUsed":true}\n','')
        with patch.object(browser_tool.subprocess,'run',return_value=resolved):
            params=browser_tool.preflight_write_target(self.base/'runtime.json','selectOption',{
                'intent':'write','rrSource':'Event Details!B11','target':'role:combobox[name="Time Zone:"]',
            })
        self.assertEqual(params['target'],'[data-cvent-agent-target="one"]')
    def test_open_authorized_event_requires_live_lease_inventory_and_runtime_identity(self):
        browser_tool.local_probe=lambda runtime:{'url':'https://app.cvent.com/Subscribers/Events2/EventSelection'}
        with patch.object(browser_tool, 'assert_event_lease') as lease:
            browser_tool.guard(self.runtime,'openAuthorizedEvent',{
                'intent':'read','eventName':self.runtime['authorizedEventName'],'eventKey':'locked',
            })
            lease.assert_called_once_with(self.runtime)
        with patch.object(browser_tool, 'assert_event_lease'):
            with self.assertRaisesRegex(RuntimeError,'does not match BrowserRuntime'):
                browser_tool.guard(self.runtime,'openAuthorizedEvent',{
                    'intent':'read','eventName':self.runtime['authorizedEventName'],'eventKey':'other',
                })
        browser_tool.local_probe=lambda runtime:{'url':'https://app.cvent.com/subscribers/events2/Details/EventDetails/Index/Edit?evtstub=locked'}
        with patch.object(browser_tool, 'assert_event_lease'):
            with self.assertRaisesRegex(RuntimeError,'event inventory'):
                browser_tool.guard(self.runtime,'openAuthorizedEvent',{
                    'intent':'read','eventName':self.runtime['authorizedEventName'],'eventKey':'locked',
                })

    def test_auth_status_verifies_slot_profile_without_exposing_cookie_values(self):
        profile=self.base/'browser-profiles'/'slot-1'/'chromium-profile';profile.mkdir(parents=True)
        metadata=profile.parent/'auth-profile.json'
        metadata.write_text(json.dumps({'authenticated':True,'workerSlot':1,'organizationId':'org-private'}))
        runtime={**self.runtime,'workerSlot':1,'profilePath':str(profile),'cdpHttpOrigin':'http://127.0.0.1:9334','targetBrowserIdentity':{'targetId':'target'}}
        page={'id':'target','webSocketDebuggerUrl':'ws://127.0.0.1/devtools/page/target'}
        cookies={'cookies':[{'name':'org-id','value':'org-private','domain':'.cvent.com'}]}
        ui={'result':{'value':{'ready':'complete','hasUi':True,'hasLogin':False}}}
        with patch.dict(os.environ,{'CVENT_WORKSPACE_ID':'workspace-one'}), \
             patch.object(browser_tool,'browser_profile_dir',return_value=profile), \
             patch.object(browser_tool,'browser_auth_metadata_path',return_value=metadata), \
             patch.object(browser_tool,'local_probe',return_value={'url':'https://app.cvent.com/Subscribers/Events2/EventSelection','title':'Events'}), \
             patch.object(browser_tool,'browser_pages',return_value=[page]), \
             patch.object(browser_tool,'select_page',return_value=page), \
             patch.object(browser_tool,'browser_command',side_effect=[cookies,ui]):
            result=browser_tool.authenticated_profile_status(runtime)
        self.assertTrue(result['authenticated'])
        self.assertTrue(result['accountContextMatch'])
        self.assertNotIn('org-private',json.dumps(result))

    def test_navigation_fails_closed(self):
        browser_tool.local_probe=lambda runtime:{'url':'https://app.cvent.com/subscribers/events2/EventSelection'}
        with self.assertRaisesRegex(RuntimeError,'non-authorized'):
            browser_tool.guard(self.runtime,'navigate',{'url':'https://app.cvent.com/event?evtstub=other','intent':'read'})
        self.write_lock('Completed')
        with self.assertRaisesRegex(RuntimeError,'outside the exact authorized event context'):
            browser_tool.guard(self.runtime,'navigate',{'url':'https://events.app.cvent.com/events/home','intent':'read'})
        browser_tool.guard(self.runtime,'navigate',{'url':'https://events.app.cvent.com/events/details?evtstub=locked','intent':'read'})
        with self.assertRaisesRegex(RuntimeError,'account-global'):
            browser_tool.guard(self.runtime,'navigate',{'url':'https://app.cvent.com/account/settings','intent':'read'})
        with self.assertRaisesRegex(RuntimeError,'attendee/contact'):
            browser_tool.guard(self.runtime,'navigate',{'url':'https://app.cvent.com/attendees?evtstub=locked','intent':'read'})
        with self.assertRaisesRegex(RuntimeError,'attendee/contact'):
            browser_tool.guard(self.runtime,'navigate',{'url':'https://app.cvent.com/Subscribers/ContactTypes?evtstub=locked','intent':'read'})

    def test_protected_mutation_controls_are_rejected_before_dispatch(self):
        for label in ('Publish', 'Go Live', 'Send Email', 'Delete', 'Archive', 'Create Contact Type', 'Attendees', 'Contacts'):
            with self.subTest(label=label), patch.object(browser_tool.subprocess,'run',return_value=subprocess.CompletedProcess(
                ['node'],0,'BROWSER_TOOL_RESULT='+json.dumps({'ok':True,'resolved':{'tag':'BUTTON','text':label,'connected':True,'disabled':False}})+'\n','')):
                with self.assertRaisesRegex(RuntimeError,'protected|immutable'):
                    browser_tool.preflight_write_target(self.base/'runtime.json','click',{'intent':'write','target':f'role:button[name="{label}"]'})
    def test_read_intent_cannot_disguise_a_save_mutation(self):
        resolved=subprocess.CompletedProcess(['node'],0,
            'BROWSER_TOOL_RESULT='+json.dumps({'ok':True,'resolved':{'tag':'BUTTON','text':'Save','connected':True,'disabled':False}})+'\n','')
        with patch.object(browser_tool.subprocess,'run',return_value=resolved):
            with self.assertRaisesRegex(RuntimeError,'requires write intent'):
                browser_tool.preflight_action_target(self.base/'runtime.json','click',{'intent':'read','target':'role:button[name="Save"]'})

    def test_pi_reads_rr_and_uses_the_ego_skill_in_steel(self):
        runner=(ROOT/'job_runner.py').read_text()
        shim=(ROOT/'bin/ego-browser').read_text()
        self.assertIn('Read the workbook directly',PROMPT)
        self.assertIn('Interpret the workbook yourself',PROMPT)
        self.assertIn('Do not run `rr_compiler.py`',PROMPT)
        self.assertIn('Use the ego-browser skill',PROMPT)
        self.assertIn('--skill',runner)
        self.assertIn('skills/ego-browser/SKILL.md',runner)
        self.assertIn('tools = "read,bash,cvent_job_update,cvent_login_handoff,cvent_finish"',runner)
        self.assertNotIn('def prepare_rr(',runner)
        self.assertIn('EGO_BROWSER_CDP_HOST',runner)
        self.assertIn('CVENT_BROWSER_TARGET_ID',runner)
        self.assertIn('page.snapshot()',SKILL)
        self.assertIn('page.getByRole',SKILL)
        self.assertIn('CVENT_BROWSER_RUNTIME_ID',SKILL)
        self.assertIn('CVENT_LEASE_VALIDATE_URL',shim)
        self.assertIn('x-cvent-lease-token',shim)
        self.assertIn('vendor/ego-browser-linux/dist/src/index.js',shim)
        self.assertIn('Never create, rename, clone, delete, archive, publish',PROMPT)
        self.assertIn('call `cvent_login_handoff`',PROMPT)


class BrowserGateTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();base=Path(self.tmp.name)
        self.old=(browser_gate.GATE,browser_gate.LOCK)
        browser_gate.GATE=base/'gate.json';browser_gate.LOCK=base/'gate.lock'
        browser_gate.initialize()
    def tearDown(self):
        browser_gate.GATE,browser_gate.LOCK=self.old;self.tmp.cleanup()
    def test_agent_action_and_user_transition(self):
        self.assertEqual(browser_gate.read()['automationOwner'],'PI_EGO')
        with browser_gate.action('runtime-x','PI_EGO'):
            self.assertEqual(browser_gate.read()['activeActor'],'PI_EGO')
            self.assertEqual(browser_gate.read()['automationOwner'],'PI_EGO')
        self.assertEqual(browser_gate.read()['activeActor'],'NONE')
        self.assertEqual(browser_gate.read()['automationOwner'],'PI_EGO')
        browser_gate.request_user()
        with self.assertRaisesRegex(RuntimeError,'not agent-owned'):
            with browser_gate.action('runtime-x','PI_EGO'):pass
    def test_only_explicit_request_changes_desired_ownership(self):
        self.assertEqual(browser_gate.read()['desiredOwnership'],'AGENT')
        browser_gate.request_user()
        self.assertEqual(browser_gate.read()['desiredOwnership'],'USER')

if __name__=='__main__':unittest.main()
