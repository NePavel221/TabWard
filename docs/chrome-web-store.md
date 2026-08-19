# Chrome Web Store release checklist

- Register and verify a dedicated Chrome Web Store publisher account.
- Review `debugger`, `downloads`, `scripting`, `tabs`, `tabGroups`, `storage`,
  alarms, and `<all_urls>` against minimum-permission requirements.
- Publish the privacy policy on a stable HTTPS URL.
- Prepare listing copy, icons, screenshots, and a short demonstration.
- Explain the single purpose: controlled local browser access for user-approved
  AI agent sessions.
- Declare that browser data is processed locally and no remote executable code
  is used.
- Provide reviewer instructions for installing Node.js, starting the MCP,
  pairing, opening an agent-owned tab, and checking managed isolation.
- Upload `dist/tabward-extension-<version>.zip`.
- Use deferred publishing for the first review.
