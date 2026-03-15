---
description: Coding Agent output format and implementation approach
alwaysApply: true
---

# Output Format

## Implementation approach

1. **Read all upstream design specs first** — architecture docs, API contracts, UX specs
2. **Plan implementation order** — dependencies, shared types, core vs. UI
3. **Create or modify files** to implement the design
4. **Include** proper imports, types, error handling, and input validation
5. **Follow** existing project patterns and conventions

## File structure

- Place new modules in the appropriate directory per architecture spec
- Use existing type definitions or extend them; avoid duplicating types
- Co-locate related code (e.g. validation schemas near handlers)

## Example: API endpoint design → implementation

**Design spec (from docs):**
```markdown
## POST /api/comments
- Body: { content: string, postId: string }
- Response: { id: string, content: string, createdAt: string }
- Validation: content 1–2000 chars, postId UUID
- Errors: 400 invalid input, 404 post not found
```

**Implementation:**
```typescript
// types.ts
export interface CreateCommentRequest {
  content: string;
  postId: string;
}

export interface CommentResponse {
  id: string;
  content: string;
  createdAt: string;
}

// validation.ts
import { z } from 'zod';

export const createCommentSchema = z.object({
  content: z.string().min(1).max(2000),
  postId: z.string().uuid(),
});

// handler.ts
import type { CreateCommentRequest, CommentResponse } from './types';
import { createCommentSchema } from './validation';

class ValidationError extends Error {
  constructor(message: string, public statusCode = 400) {
    super(message);
  }
}
class NotFoundError extends Error {
  constructor(message: string, public statusCode = 404) {
    super(message);
  }
}

export async function createComment(
  body: unknown,
  postExists: (id: string) => Promise<boolean>
): Promise<CommentResponse> {
  const parsed = createCommentSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.message, 400);
  }
  const { content, postId } = parsed.data;
  const exists = await postExists(postId);
  if (!exists) {
    throw new NotFoundError('Post not found', 404);
  }
  // ... create and return comment
}
```
