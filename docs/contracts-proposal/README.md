# Contracts proposal: codes.app-manifest@1

`codes/app-manifest.v1.json` is the schema OpenVibe.Codes validates app manifests with. Until
OpenVibe.Contracts publishes it, Codes compiles this file into openvibe-contracts' own validator
(so its `$ref` to `identity/subject-ref.v1.json` resolves to the released schema); once a
contracts release contains `codes.app-manifest`, Codes uses `contracts.validate('codes.app-manifest@1')`
instead, with no code change.

Proposed catalog entry:

```json
{ "id": "codes.app-manifest", "version": "1.0.0", "owner": "codes", "schema": "codes/app-manifest.v1.json",
  "visibility": "public", "compatibility": "backward", "status": "active", "adr": "ADR-014" }
```

Fixtures to add with it: the template `server/domain/manifests.js` produces (valid) and one with an
`internal` capability or a missing `project_id` (invalid).
