---
description: Quality checklist for Core Code Designer architecture specs
alwaysApply: true
---

# Architecture Quality Checklist

Before finalising any architecture specification, verify each section below.

## API design

- [ ] **Naming**: Consistent resource naming (plural nouns: `/comments`, `/posts`), kebab-case for multi-word
- [ ] **HTTP verbs**: GET (read), POST (create), PATCH (partial update), PUT (replace), DELETE (remove)
- [ ] **Error response shape**: Unified structure, e.g. `{ error: { code: string, message: string } }`
- [ ] **Pagination**: Cursor or offset; include `nextCursor`/`hasMore` in response
- [ ] **Versioning**: URL prefix `/api/v1/` or header `Accept: application/vnd.api+json;version=1`

**Example error response:**
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid input",
    "details": [{ "field": "email", "reason": "Invalid format" }]
  },
  "statusCode": 400
}
```

## Data model

- [ ] **Normalisation**: No redundant data; FK references for relationships
- [ ] **Indexes**: On foreign keys, frequently filtered/sorted columns
- [ ] **Constraints**: NOT NULL, UNIQUE, CHECK where appropriate
- [ ] **Cascade rules**: ON DELETE CASCADE vs SET NULL vs RESTRICT documented
- [ ] **Migration path**: How to add/remove columns without downtime (e.g. additive first, backfill, drop old)

**Example TypeScript + constraints:**
```typescript
interface Comment {
  id: string;
  postId: string;      // FK, indexed
  userId: string;      // FK, indexed
  content: string;     // NOT NULL, max length
  createdAt: Date;     // indexed for sort
}
// Index: (postId, createdAt DESC)
// Cascade: postId ON DELETE CASCADE
```

## Security

- [ ] **Auth**: How is identity established? (JWT, session, API key)
- [ ] **Authorisation**: Per-resource checks (e.g. user can only edit own comments)
- [ ] **Input validation**: Schema for request bodies; max lengths, allowed characters
- [ ] **Rate limiting**: Per-user/per-IP limits for write operations
- [ ] **CORS**: Allowed origins documented; credentials handling

## Scalability

- [ ] **Caching strategy**: What is cached (e.g. GET by ID), TTL, invalidation on write
- [ ] **Query performance**: N+1 avoidance; indexes for common queries
- [ ] **Connection pooling**: DB pool size guidance; connection limits for external services

## Testability

- [ ] **Interface boundaries**: Services depend on abstractions (e.g. `ICommentRepository`), not concrete DB
- [ ] **Dependency injection**: Constructor-injected dependencies for easy mocking
- [ ] **Mock-friendly**: No hidden globals; time/ID generation injectable

**Example injectable interface:**
```typescript
interface CommentRepository {
  findById(id: string): Promise<Comment | null>;
  findByPostId(postId: string, opts: PaginationOpts): Promise<Comment[]>;
  create(input: CreateCommentInput): Promise<Comment>;
}
// Implementation can be swapped for in-memory mock in tests
```
