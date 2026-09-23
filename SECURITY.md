# Security

TabWard is public-source beta software. Do not file public issues containing cookies,
tokens, authenticated page content, pairing state, traces, downloads, or local
filesystem paths.

## Reporting a vulnerability

Report vulnerabilities privately through GitHub Security Advisories:

https://github.com/NePavel221/TabWard/security/advisories/new

Do not include live credentials or browser exports. Use synthetic reproduction
data whenever possible.

## Supported versions

| Version | Security support |
| --- | --- |
| 0.4.0 | Supported source beta version |
| 0.3.x and earlier | Unsupported |

TabWard binds local transports to `127.0.0.1`, but its local state and broker
credential are protected from remote network users, not from malicious code
already running as the same OS user. Same-user processes may read local files,
interfere with loopback traffic, or inject into Chrome and are outside the
primary trust boundary.
