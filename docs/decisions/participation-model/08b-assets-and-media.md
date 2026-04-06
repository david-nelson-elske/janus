# 124-08b: Assets & Media

**Status:** Draft
**Date:** 2026-04-02
**Depends on:** [01](01-core-records-and-define.md) (Core Records), [04](04-store-adapters-and-crud.md) (Store Adapters), [08](08-http-surface-and-bootstrap.md) (HTTP Surface)

## Scope

This sub-ADR specifies:
- `asset` framework entity — file metadata record
- Asset storage backends (filesystem, S3) and `asset_routing`
- Upload as an HTTP transport concern — multipart handling before pipeline
- Asset URL resolution on reads — enriching asset IDs to URLs
- Asset field validation on writes — confirming referenced assets exist
- Agent interaction with assets

This sub-ADR does NOT cover:
- Image processing/transformation (consumer concern)
- Video streaming (future)
- Asset CDN configuration (deployment concern)

## Problem

The vocabulary has an `Asset()` semantic type, but ADR-124 doesn't specify how binary files enter the system, where they're stored, or how asset references on entity records resolve to URLs. The dispatch pipeline is JSON-based — binary data needs special handling at the transport layer.

## Decision

### asset entity

Framework-provided entity for file metadata:

```ts
define('asset', {
  schema: {
    filename: Str({ required: true }),
    content_type: Str({ required: true }),
    size: Int({ required: true }),
    backend: Str({ required: true }),
    path: Str({ required: true }),
    checksum: Str(),
    alt: Str(),
  },
  storage: Persistent(),
  origin: 'framework',
  owned: true,
});
```

| Field | Purpose |
|-------|---------|
| `filename` | Original filename from upload |
| `content_type` | MIME type (image/jpeg, application/pdf, etc.) |
| `size` | File size in bytes |
| `backend` | Which storage backend ('local', 's3') |
| `path` | Backend-specific location |
| `checksum` | Content hash for integrity verification |
| `alt` | Alt text (agent-generated or user-provided) |

The `asset` entity participates in the standard pipeline — policy, audit, respond all apply. Ownership scoping from [01b](01b-record-metadata-ownership-scoping.md) means users see only their uploads.

### Asset storage backends

Binary file storage is separate from entity storage. Asset backends handle: write binary → path, resolve path → URL.

```ts
interface AssetBackend {
  write(stream: ReadableStream, meta: { filename: string; content_type: string }): Promise<{ path: string; size: number; checksum: string }>;
  url(path: string): string;
  delete(path: string): Promise<void>;
}
```

Backend routing follows the `persist_routing` pattern:

```ts
define('asset_routing', {
  schema: {
    backend: Str({ required: true }),
    config: Json({ required: true }),
  },
  storage: Derived(),
  origin: 'framework',
});
```

```
asset_routing:
  backend='local'    config={ basePath: '/data/assets', urlPrefix: '/assets' }
  backend='s3'       config={ bucket: 'my-app', region: 'us-east-1', urlPrefix: 'https://cdn.example.com' }
```

Configured at app bootstrap:

```ts
createApp({
  assets: {
    backend: 'local',
    basePath: '/data/assets',
    urlPrefix: '/assets',
  },
  // or
  assets: {
    backend: 's3',
    bucket: 'my-app',
    region: 'us-east-1',
    urlPrefix: 'https://cdn.example.com',
  },
});
```

### Upload as transport concern

Upload is handled by the HTTP receive execution (order 5) before the JSON-based pipeline:

```
Client sends:
  POST /assets  (multipart/form-data, file=photo.jpg)

HTTP receive (order 5):
  1. Detect Content-Type: multipart/form-data
  2. Extract file stream and metadata (filename, content_type)
  3. Resolve asset backend from config
  4. Stream file to backend → { path, size, checksum }
  5. Transform input to JSON:
     { filename: 'photo.jpg', content_type: 'image/jpeg',
       size: 48291, backend: 'local', path: '/2026/04/abc123.jpg',
       checksum: 'sha256:...' }
  6. Set ctx.entity = 'asset', ctx.operation = 'create'

Pipeline proceeds normally:
  policy(10) → parse(20) → validate(25) → store-create(35) →
  emit(40) → audit(50) → respond(70) → http-respond(80)
```

The pipeline never sees binary data. It's a regular `create` on the `asset` entity. The HTTP receive execution handles the binary-to-metadata transformation.

**Route derivation:** The `asset` entity's routes are derived normally — `POST /assets` for create, `GET /assets/:id` for read. The HTTP receive execution detects multipart on the POST and handles it. No special route needed.

### Asset references on domain entities

When a schema has `image: Asset()`, the field value is an asset record ID:

```ts
define('note', {
  schema: {
    title: Str({ required: true }),
    body: Markdown(),
    image: Asset(),        // stores asset record ID
    author: Relation('user'),
  },
  storage: Persistent(),
  owned: true,
});
```

**On write (create/update):** The validate execution (order 25) confirms the referenced asset ID exists. If the asset doesn't exist, validation fails with `AssetNotFoundError`. This is automatic for any field with the `Asset()` type — no additional participation config needed.

**On read:** Asset IDs are enriched to asset metadata + URL. This happens in the respond execution (order 70):

```ts
// Raw record from store:
{ id: '456', title: 'My Note', image: 'abc123' }

// After respond enrichment:
{ id: '456', title: 'My Note', image: { id: 'abc123', url: '/assets/abc123/photo.jpg', filename: 'photo.jpg', content_type: 'image/jpeg', alt: 'Budget chart' } }
```

The respond execution reads the entity's schema, identifies Asset fields, batch-resolves the asset records, and enriches the response. This is internal to respond — no separate execution needed.

### Serving assets

Static file serving for the `local` backend is wired at HTTP surface bootstrap:

```
GET /assets/:id/:filename → resolve asset record → stream file from backend
```

For S3/CDN backends, the URL points directly to the CDN — no framework serving needed.

### Asset deletion

When an asset record is deleted (soft delete per [01b](01b-record-metadata-ownership-scoping.md)):
- The asset record gets `deletedAt` set
- The binary file is NOT immediately deleted (soft delete = recoverable)
- A retention cleanup job (cron subscription) deletes orphaned binary files whose asset records are past retention

When a domain entity record is deleted and it references an asset:
- The wiring effect determines behavior (cascade, nullify, restrict per [01d](01d-wiring-effects-cross-entity-lifecycle.md))
- Default for Asset fields: no cascade — the asset stays (it may be referenced by other records)
- Orphan detection: a scheduled job finds assets with no remaining references and marks them for cleanup

### Agent interaction

- **Read:** Agent sees asset metadata (filename, content_type, size, alt) plus URL via binding interaction levels
- **Write:** Agent can set `alt` text on asset records (generating descriptions)
- **Reference:** Agent can reference existing assets by ID when creating/updating domain entities
- **Upload:** Agent cannot upload binary files (agent protocol is JSON-based). Users upload through the HTTP surface.
- **Discovery:** Agent reads `query_field` for entities with Asset-typed fields to understand where files are referenced

### Updated infrastructure entity count

| Entity | Storage | New? |
|--------|---------|------|
| `asset` | Persistent | **Yes** |

Total infrastructure entities: **14** (was 13).

## Testing gate

When 124-08b is implemented:

- `asset` entity can be created with metadata fields
- Upload via multipart form data creates asset record + stores file
- Asset backend writes file and returns path + size + checksum
- Read of entity with Asset field enriches ID to { id, url, filename, content_type, alt }
- Validate on write rejects nonexistent asset IDs
- Asset entity respects ownership scoping (users see their uploads)
- Soft delete on asset record does not immediately delete binary
- Local backend serves files at configured URL prefix
- S3 backend returns CDN URLs without framework serving
- `asset_routing` correctly configures backend selection
