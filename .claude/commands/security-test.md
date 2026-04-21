# Security Test

Run a focused security audit of this Slack FAQ chatbot codebase. Work through each category below, reading the relevant source files as you go, then produce a prioritised findings report.

## Files to audit

| Area | Files |
|------|-------|
| Auth / access control | `src/handlers/dmMessage.js`, `src/handlers/hrAdminHandler.js` |
| LLM & prompt safety | `src/services/llm.js`, `src/handlers/employeeHandler.js` |
| File ingestion | `src/services/ingestion.js`, `src/utils/slack/index.js` |
| Database | `src/services/supabase.js`, `supabase/schema.sql` |
| Notifications | `src/handlers/notifyHandler.js` |
| App bootstrap | `src/app.js`, `src/index.js`, `api/slack.js` |
| Secrets & config | `.env.example`, `package.json` |

## Check each category

### 1. Secrets & credential hygiene
- Scan all source files for hardcoded tokens, keys, passwords, or connection strings (not just `.env.example`).
- Verify no secret is committed to git: `git log --all -p -- "**/*.js" | grep -E "(sk-|xoxb-|xapp-|eyJ)"` (summarise findings).
- Check that every required secret is read from `process.env` and that the app fails fast if one is missing.

### 2. Authentication & authorisation
- Trace how HR admin identity is verified: where is `HR_USER_IDS` parsed, and where is it checked?
- Assess whether a Slack user could impersonate an admin or bypass the check.
- Check whether actions triggered by confirmation buttons verify that the *same* user who initiated the action is the one clicking the button (`src/handlers/hrAdminHandler.js`).

### 3. Prompt injection & LLM safety
- In `src/services/llm.js`, identify every place where external input (user questions, document content, extracted names) is interpolated into a prompt string.
- Assess whether an attacker could craft a policy document or question to override system instructions or leak the system prompt.
- Check whether the `SENSITIVE_TOPICS_SIGNAL` and `NOT_FOUND_SIGNAL` sentinel strings can be spoofed by user input.

### 4. Input validation & sanitisation
- Identify every user-supplied value that reaches a database call (`supabase.js`).
- Check whether document names extracted by `extractDocName()` are sanitised before use in queries.
- Look for missing length limits on user messages or uploaded file names.

### 5. File upload security
- In `src/services/ingestion.js`, check: maximum file size enforcement, allowed MIME types / extensions, whether filenames are sanitised, and whether parsing errors are caught safely.
- Verify the Slack file download in `src/utils/slack/index.js` uses the bot token safely (no token leakage in logs or errors).

### 6. Database & RLS
- In `supabase/schema.sql`, identify tables, their RLS status, and any defined policies.
- In `src/services/supabase.js`, check whether the service-role key (which bypasses RLS) is the only credential used and whether that's appropriate for all operations.
- Flag any queries that concatenate user input into query strings rather than using parameterised calls.

### 7. Notification & rate-limiting abuse
- In `src/handlers/notifyHandler.js`, determine whether the cooldown is *enforced* or only advisory, and whether there is any server-side rate limit on broadcast messages.
- Check batch-sending logic for missing delays that could trigger Slack API rate limits.

### 8. Sensitive data exposure & logging
- Identify what user data (Slack IDs, names, email, questions, answers) is logged to Supabase or any other sink.
- Check `src/services/analytics.js` for any PII cached in memory or sent to Mixpanel without consent controls.
- Verify that error messages surfaced to Slack users do not leak internal stack traces, DB errors, or API responses.

### 9. Dependency vulnerabilities
Run: `npm audit --json | node -e "const a=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); const vulns=a.vulnerabilities||{}; Object.entries(vulns).forEach(([k,v])=>{ if(v.severity==='critical'||v.severity==='high') console.log(v.severity.toUpperCase(), k, v.fixAvailable?'(fix available)':'(no fix)'); })"`

Report any critical or high severity findings.

---

## Output format

Produce a report with this structure:

```
## Security Test Report — Policy Pony Slack Bot

### Critical (must fix before production)
[numbered list — each item: file:line, description, why it matters, recommended fix]

### High (fix soon)
[same format]

### Medium (address in next sprint)
[same format]

### Low / Informational
[same format]

### Passed checks
[bullet list of categories that look clean]
```

Be concrete: include file paths, line numbers, and specific code snippets where relevant. Do not pad the report — only include real findings.
