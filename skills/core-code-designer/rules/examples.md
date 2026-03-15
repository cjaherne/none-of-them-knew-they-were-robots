---
description: Few-shot architecture examples for Core Code Designer
alwaysApply: true
---

# Architecture Examples

## Example 1: Comments feature for a blog

### Overview

```
[Client] --> [Comments API] --> [Comments Service]
                                    |
                                    v
                              [PostgreSQL]
                                    |
                    [User] ----< [Comment] >---- [Post]
```

### Data models

```typescript
interface Comment {
  id: string;
  postId: string;
  userId: string;
  parentId: string | null;  // For nested replies
  content: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;   // Soft delete
}

// Relations: Comment belongs to User, Comment belongs to Post
// Comment can have parent Comment (self-reference)
```

**Constraints:**
- `postId` FK → Post, ON DELETE CASCADE
- `userId` FK → User, ON DELETE SET NULL (preserve orphaned comments with "deleted user")
- `parentId` FK → Comment, ON DELETE CASCADE
- Indexes: `(postId, createdAt)`, `(userId)`, `(parentId)`

### API contracts

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/posts/:postId/comments` | List comments (paginated) |
| POST | `/api/v1/posts/:postId/comments` | Create comment |
| PATCH | `/api/v1/comments/:id` | Update own comment |
| DELETE | `/api/v1/comments/:id` | Soft-delete own comment |

**POST /api/v1/posts/:postId/comments**

Request:
```json
{
  "content": "Great post!",
  "parentId": null
}
```

Response 201:
```json
{
  "id": "cmt_abc123",
  "postId": "p_456",
  "userId": "usr_789",
  "parentId": null,
  "content": "Great post!",
  "createdAt": "2025-03-15T10:00:00Z"
}
```

**Error response shape (4xx/5xx):**
```json
{
  "error": { "code": "VALIDATION_ERROR", "message": "Content is required" },
  "statusCode": 400
}
```

### File structure

```
src/
  comments/
    comments.service.ts    # Business logic
    comments.repository.ts # Data access
    comments.types.ts      # Comment, CreateCommentInput, etc.
  api/
    routes/
      comments.routes.ts   # Mount at /posts/:postId/comments, /comments/:id
```

### Error handling strategy

- Validation errors → 400 with field-level details
- Not found (post/comment) → 404
- Unauthorised (edit/delete other's comment) → 403
- Rate limit (create) → 429
- Use consistent `{ error: { code, message } }` shape

---

## Example 2: Real-time notifications via WebSocket

### Overview

```
[Client WS] <---> [WebSocket Gateway] <---> [Notification Service]
                        |                            |
                        v                            v
                  [Redis Pub/Sub]              [PostgreSQL]
                        |
                        v
                  [Event Publishers] (comment created, like, etc.)
```

### Event schema

```typescript
interface NotificationEvent {
  type: 'comment_created' | 'like_received' | 'mention';
  payload: {
    id: string;
    actorId: string;
    targetId: string;
    targetType: 'post' | 'comment';
    metadata?: Record<string, unknown>;
  };
  timestamp: string;  // ISO 8601
}
```

**JSON schema for event payload:**
```json
{
  "type": "object",
  "required": ["type", "payload", "timestamp"],
  "properties": {
    "type": { "enum": ["comment_created", "like_received", "mention"] },
    "payload": {
      "type": "object",
      "required": ["id", "actorId", "targetId", "targetType"],
      "properties": {
        "id": { "type": "string" },
        "actorId": { "type": "string" },
        "targetId": { "type": "string" },
        "targetType": { "enum": ["post", "comment"] }
      }
    },
    "timestamp": { "type": "string", "format": "date-time" }
  }
}
```

### Connection management

- **Auth**: JWT in query param or first message; reject unauthenticated
- **Channels**: Subscribe to `user:{userId}` Redis channel
- **Heartbeat**: Client sends `ping` every 30s; server responds `pong`; disconnect after 90s silence
- **Reconnect**: Client includes `lastEventId` to request missed events (optional catch-up)

### Data flow

1. Event occurs (e.g. comment created) → Publisher pushes to Redis `user:{targetUserId}`
2. WebSocket gateway subscribes to user channels for connected clients
3. Gateway forwards events to relevant WebSocket connections
4. Persist to PostgreSQL for offline users; on connect, optionally fetch recent unread

### Storage approach

- **PostgreSQL**: `notifications` table for persistence, read-on-connect, mark-as-read
- **Redis**: Pub/sub only (no persistence); ephemeral delivery
- **In-memory**: Map of `userId` → `Set<WebSocket>` in gateway (or use Redis adapter for multi-instance)

### File structure

```
src/
  notifications/
    gateway/
      ws-handler.ts       # Connection lifecycle
      channels.ts         # Redis subscribe logic
    events/
      schema.ts           # NotificationEvent type
      publishers.ts       # Publish to Redis
    storage/
      notification.repository.ts
```
