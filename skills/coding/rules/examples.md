---
description: Coding Agent few-shot implementation examples
alwaysApply: true
---

# Examples

## Example 1: CRUD comments endpoint

**Architecture spec:** REST API for comments — create, read, update, delete. Validation on content (1–2000 chars), postId (UUID). Errors: 400 invalid, 404 not found.

**Implementation:**

```typescript
// src/api/comments/types.ts
export interface Comment {
  id: string;
  postId: string;
  content: string;
  authorId: string;
  createdAt: string;
}

export interface CreateCommentInput {
  content: string;
  postId: string;
}

export interface UpdateCommentInput {
  content: string;
}

// src/api/comments/validation.ts
import { z } from 'zod';

export const createCommentSchema = z.object({
  content: z.string().min(1, 'Content required').max(2000, 'Content too long'),
  postId: z.string().uuid('Invalid post ID'),
});

export const updateCommentSchema = z.object({
  content: z.string().min(1).max(2000),
});

// src/api/comments/errors.ts
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class ValidationError extends ApiError {
  constructor(message: string) {
    super(message, 400);
  }
}

export class NotFoundError extends ApiError {
  constructor(resource: string) {
    super(`${resource} not found`, 404);
  }
}

// src/api/comments/handlers.ts
import type { Comment, CreateCommentInput } from './types';
import { createCommentSchema, updateCommentSchema } from './validation';
import { ValidationError, NotFoundError } from './errors';

export async function createComment(
  body: unknown,
  repo: { create: (input: CreateCommentInput) => Promise<Comment>; postExists: (id: string) => Promise<boolean> }
): Promise<Comment> {
  const parsed = createCommentSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.errors.map(e => e.message).join('; '));
  }
  const { content, postId } = parsed.data;
  const exists = await repo.postExists(postId);
  if (!exists) {
    throw new NotFoundError('Post');
  }
  return repo.create({ content, postId });
}

export async function updateComment(
  id: string,
  body: unknown,
  repo: { findById: (id: string) => Promise<Comment | null>; update: (id: string, content: string) => Promise<Comment> }
): Promise<Comment> {
  const parsed = updateCommentSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.message);
  }
  const existing = await repo.findById(id);
  if (!existing) {
    throw new NotFoundError('Comment');
  }
  return repo.update(id, parsed.data.content);
}

// src/api/comments/router.ts
import { createComment, updateComment } from './handlers';
import { ApiError } from './errors';

export function registerCommentRoutes(router: Router, repo: CommentRepository): void {
  router.post('/comments', async (req, res) => {
    try {
      const comment = await createComment(req.body, repo);
      res.status(201).json(comment);
    } catch (err) {
      if (err instanceof ApiError) {
        res.status(err.statusCode).json({ error: err.message });
      } else {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  router.patch('/comments/:id', async (req, res) => {
    try {
      const comment = await updateComment(req.params.id, req.body, repo);
      res.json(comment);
    } catch (err) {
      if (err instanceof ApiError) {
        res.status(err.statusCode).json({ error: err.message });
      } else {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });
}
```

---

## Example 2: Search input with debounce and loading state

**UX spec:** Search input — debounce 300ms, loading spinner while fetching, aria-live for results, keyboard navigation.

**Implementation:**

```typescript
// src/components/SearchInput.tsx
import React, { useState, useCallback, useMemo } from 'react';

export interface SearchResult {
  id: string;
  title: string;
  subtitle?: string;
}

interface SearchInputProps {
  onSearch: (query: string) => Promise<SearchResult[]>;
  onSelect?: (result: SearchResult) => void;
  placeholder?: string;
  debounceMs?: number;
}

export function SearchInput({
  onSearch,
  onSelect,
  placeholder = 'Search...',
  debounceMs = 300,
}: SearchInputProps): React.ReactElement {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const performSearch = useCallback(
    async (value: string) => {
      if (!value.trim()) {
        setResults([]);
        return;
      }
      setIsLoading(true);
      setError(null);
      try {
        const data = await onSearch(value.trim());
        setResults(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Search failed');
        setResults([]);
      } finally {
        setIsLoading(false);
      }
    },
    [onSearch]
  );

  const debouncedSearch = useMemo(
    () => debounce(performSearch, debounceMs),
    [performSearch, debounceMs]
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      setQuery(value);
      debouncedSearch(value);
    },
    [debouncedSearch]
  );

  return (
    <div role="search" aria-label="Search">
      <label htmlFor="search-input" className="sr-only">
        Search
      </label>
      <input
        id="search-input"
        type="search"
        value={query}
        onChange={handleChange}
        placeholder={placeholder}
        aria-expanded={results.length > 0}
        aria-controls="search-results"
        aria-autocomplete="list"
        aria-busy={isLoading}
        aria-invalid={!!error}
        aria-describedby={error ? 'search-error' : undefined}
      />
      {isLoading && (
        <span className="spinner" role="status" aria-live="polite">
          Searching...
        </span>
      )}
      {error && (
        <p id="search-error" role="alert" className="error">
          {error}
        </p>
      )}
      <ul id="search-results" role="listbox" aria-live="polite">
        {results.map((r) => (
          <li
            key={r.id}
            role="option"
            tabIndex={0}
            onClick={() => onSelect?.(r)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') onSelect?.(r);
            }}
          >
            {r.title}
            {r.subtitle && <span className="subtitle">{r.subtitle}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function debounce<T extends (...args: unknown[]) => unknown>(
  fn: T,
  ms: number
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout>;
  return (...args: Parameters<T>) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), ms);
  };
}
```
