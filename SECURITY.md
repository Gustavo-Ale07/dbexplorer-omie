# Security policy

## Supported versions

Security fixes are made on the `main` branch and included in the next release. Older versions are
not maintained.

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report them privately through GitHub:
[Security → Report a vulnerability](https://github.com/Gustavo-Ale07/dbexplorer-omie/security/advisories/new).

Include, if you can:

- the affected version or commit;
- the steps to reproduce, or a proof of concept that works in **mock mode** (`OMIE_MODE=mock`);
- the impact you expect (for example credential exposure, privilege escalation or a write
  without confirmation).

Never test against an Omie account you do not own, and never include real credentials, customer
data or Omie responses from a real company in a report.

You should get an acknowledgement within a few days. Once the issue is confirmed, a fix is
prepared and published together with an advisory that credits you, unless you prefer otherwise.

## Scope

In scope: this repository's code, the Docker image built from it and the default configuration in
`.env.example` and `compose.yaml`.

Out of scope: the Omie API itself, third-party AI providers, and deployments that ignore the
production checklist in [docs/deployment.md](docs/deployment.md) (for example, exposing the app
over plain HTTP).

The threat model and the controls in place are described in [docs/security.md](docs/security.md).
