---
name: ego-browser
description: Operate the job's isolated Steel.dev Chromium browser with Ego. Use for all Cvent navigation, inspection, form entry, uploads, saves, and readback verification.
---

# Ego browser in the isolated Steel session

Use the `ego-browser` command from `bash`. It is already connected to this job's Steel.dev Chromium instance. Do not launch another browser.

Each call is a Node.js script supplied on stdin:

```bash
ego-browser <<'EOF'
const tabs = await browser.listTabs()
const targetId = process.env.CVENT_BROWSER_TARGET_ID
if (!tabs.some(tab => (tab.targetId || tab.id) === targetId)) throw new Error('Job browser tab is unavailable')
await browser.switchTab(targetId)
const marker = await page.evaluate(() => window.name)
if (marker !== process.env.CVENT_BROWSER_RUNTIME_ID) throw new Error('Job browser runtime marker mismatch')
console.log(await page.info())
console.log(await page.snapshot())
EOF
```

The main helpers are:

- `page.info()`, `page.snapshot()`, `page.screenshot({path})`
- `page.goto(url, {waitUntil, timeout})`, `page.reload()`
- `page.getByRole(role, {name})`, `page.getByText(text)`, `page.getByLabel(text)`, `page.locator(css)`
- locator methods such as `click()`, `fill(value)`, `press(key)`, `check()`, `selectOption(value)`, `innerText()`, and `isVisible()`
- `page.waitForLoadState()`, `page.waitForTimeout(ms)`, and `page.keyboard`
- `browser.listTabs()` and `browser.switchTab(targetId)`

## Workflow

1. At the start of every script, select `CVENT_BROWSER_TARGET_ID` and verify its runtime marker as shown above.
2. Observe with `page.snapshot()` before acting. Use exact accessible names or stable selectors found in that observation.
3. Perform all predictable actions for the current form in one script rather than one command per click.
4. After each Cvent Save, wait for readiness and read the saved values back with a fresh snapshot or targeted locator reads.
5. Use a screenshot for visual or virtualized editors when the semantic snapshot is insufficient. Store screenshots inside `$CVENT_JOB_DIR` so Pi can read them.
6. For file uploads, use `page.locator('input[type=file]').setInputFiles('/absolute/path')`.
7. If Cvent or Microsoft asks for authentication, do not automate credentials or MFA. Call `cvent_login_handoff`, then continue in the same browser after control returns.

Stay in the exact server-selected event. Never rename the event, create another event, publish/go live, send communications, delete/archive anything, or access attendee/contact records. Do not guess between similar objects: use exact workbook codes, names, and parent context.
