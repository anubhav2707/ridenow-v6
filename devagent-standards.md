# Engineering standards — learned by DevAgent

Battle-tested rules, each repeatedly confirmed by merged work.
Humans may edit; the agent treats this file as authoritative.

- Every module imported in any test file must have a matching entry in package.json devDependencies (or dependencies) before merging, and its @types/* package must also be listed if the module ships no bundled types. _(confirmed 2x)_
- Every import or require of a third-party module must have a corresponding entry in package.json dependencies or devDependencies before merging. _(confirmed 2x)_
- Verify every module, service, or file imported or referenced in changed files has its source present in the PR diff or already exists in the repository at HEAD before merging. _(confirmed 2x)_
- Verify every build context directory and volume mount path referenced in docker-compose files exists and is committed in the same branch before merging. _(confirmed 2x)_
- Reject any diff that introduces a duplicate top-level declaration (import, export, class, interface, or function) within the same file — each must appear exactly once per file. _(confirmed 2x)_
