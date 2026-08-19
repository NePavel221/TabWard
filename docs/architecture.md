# Architecture

```text
MCP client -> TabWard stdio MCP -> paired WebSocket on 127.0.0.1
           -> TabWard MV3 extension -> Chrome APIs and CDP
           -> agent-owned tabs in the real Chrome profile
```

The MCP process owns session policy and exposes typed tools. The extension owns
browser operations. A versioned protocol and explicit local pairing connect the
two components. Persistent popup settings form an extension-enforced policy
ceiling for existing-tab access and workspace placement, so an MCP client cannot
silently override the user's choice. No TabWard cloud service receives browser
content.
