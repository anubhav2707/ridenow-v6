# Engineering standards — learned by DevAgent

Battle-tested rules, each repeatedly confirmed by merged work.
Humans may edit; the agent treats this file as authoritative.

- Every module imported in any test file must have a matching entry in package.json devDependencies (or dependencies) before merging, and its @types/* package must also be listed if the module ships no bundled types. _(confirmed 2x)_
- Every import or require of a third-party module must have a corresponding entry in package.json dependencies or devDependencies before merging. _(confirmed 2x)_
- Verify every module, service, or file imported or referenced in changed files has its source present in the PR diff or already exists in the repository at HEAD before merging. _(confirmed 2x)_
- Verify every build context directory and volume mount path referenced in docker-compose files exists and is committed in the same branch before merging. _(confirmed 2x)_
- Reject any diff that introduces a duplicate top-level declaration (import, export, class, interface, or function) within the same file — each must appear exactly once per file. _(confirmed 2x)_
- Block merge if any manifest entry marked (create) contributes zero diff hunks to the unified diff. _(confirmed 9x)_
- Never merge a PR that deletes or stubs out security-critical test suites — verify that all pre-existing test functions in auth, identity, session, and access-co _(confirmed 3x)_
- Reject well-known default credential values explicitly, not just empty strings, for every secret/token field validated at startup. _(confirmed 3x)_
- Every public API endpoint that accepts a resource ID must have an HTTP-level test asserting a 404 response for an unknown/non-existent ID, and the handler must  _(confirmed 3x)_
- When storing a value then performing a fallible async operation that may roll back the store, use a generation counter or compare-and-delete to ensure the rollb _(confirmed 3x)_
- Every I/O call reachable from an HTTP handler must accept and forward a context.Context — use QueryContext/ExecContext/QueryRowContext (not Query/Exec/QueryRow) _(confirmed 3x)_
- For every error path marked as unverified or ❔ in a PR, add an integration test that injects a failing dependency and asserts both the observable HTTP response  _(confirmed 3x)_
- Every safety-critical validation function must have test coverage for all conditional branches, including partial-config, fully-missing, and fully-present cases _(confirmed 3x)_
- Never rely on CREATE TABLE IF NOT EXISTS to add new columns to an existing table — use idempotent ALTER TABLE ADD COLUMN migrations instead. _(confirmed 3x)_