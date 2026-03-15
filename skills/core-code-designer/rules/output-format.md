---
description: Expected structure for Core Code Designer architecture specifications
alwaysApply: true
---

# Output Format

Architecture specifications MUST follow this structure. Use concrete TypeScript types and JSON schemas.

## 1. Architecture overview

- System diagram as text (ASCII or Mermaid)
- Module boundaries and responsibilities
- Data flow between components

## 2. Data models

- Entity definitions with fields, types, relationships
- Constraints (unique, required, foreign keys)
- Indexes for query performance

## 3. API contracts

- Endpoint path, HTTP method
- Request schema (body, query, params)
- Response schema with status codes
- Example request/response JSON

## 4. File/directory structure

- Recommended layout with rationale
- Module boundaries mapped to directories

## 5. Dependency recommendations

- Required dependencies with rationale
- Version constraints if relevant

---

## Example: Notification system architecture spec

```markdown
# Notification System Architecture

## 1. Architecture overview

```
[Client] <--HTTP/WS--> [API Gateway] <--> [Notification Service]
                              |
                              v
                       [Event Bus] <--> [Delivery Workers]
                              |
                              v
                       [Storage: PostgreSQL + Redis]
```

- **Notification Service**: Receives events, persists, dispatches
- **Event Bus**: Decouples producers from delivery workers
- **Delivery Workers**: Email, push, in-app (WebSocket)

## 2. Data models

```typescript
interface Notification {
  id: string;
  userId: string;
  type: 'email' | 'push' | 'in_app';
  channel: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'sent' | 'failed';
  createdAt: Date;
  sentAt?: Date;
}

interface NotificationPreference {
  userId: string;
  channel: string;
  enabled: boolean;
}
```

## 3. API contracts

### POST /api/v1/notifications

**Request:**
```json
{
  "userId": "usr_123",
  "type": "in_app",
  "channel": "comments",
  "payload": { "message": "New reply", "postId": "p_456" }
}
```

**Response 201:**
```json
{
  "id": "notif_789",
  "status": "pending",
  "createdAt": "2025-03-15T10:00:00Z"
}
```

## 4. File structure

```
src/
  notifications/
    service.ts      # Core orchestration
    models.ts      # Types/entities
    api/
      routes.ts    # HTTP handlers
    delivery/      # Channel-specific workers
```

## 5. Dependencies

- `ioredis` — pub/sub for event bus, caching
- `pg` — PostgreSQL client for persistence
```
