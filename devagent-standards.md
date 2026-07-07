# Engineering standards — learned by DevAgent

Battle-tested rules, each repeatedly confirmed by merged work.
Humans may edit; the agent treats this file as authoritative.

- Verify every import in test files has a corresponding entry in devDependencies (or dependencies) before merging. _(confirmed 2x)_
- Verify every import in test files has a matching entry in devDependencies (or dependencies) before merging. _(confirmed 2x)_
- Every module imported in any test file MUST be listed in package.json devDependencies (or dependencies), and its @types/* package must also be listed if no bund _(confirmed 2x)_
- Every import or require of a third-party module must have a corresponding entry in package.json dependencies or devDependencies before merging. _(confirmed 2x)_
- Verify every module/service imported in changed files has its source file present in the PR diff or already exists in the repository at HEAD. _(confirmed 2x)_
- Verify every build context directory and volume mount path referenced in docker-compose files exists and is committed in the same branch before merging. _(confirmed 2x)_
- Verify that every file imported or referenced in the diff is either already in the repo or also included in the diff before merging. _(confirmed 2x)_
- Every build context referenced in docker-compose files must exist and be committed in the same branch before merging. _(confirmed 2x)_
- Reject any PR that adds duplicate top-level declarations (classes, interfaces, functions) within the same file. _(confirmed 2x)_
- Each module, class, and top-level declaration must appear exactly once per file — flag any diff hunk that introduces a duplicate import, export, or class defini _(confirmed 2x)_
