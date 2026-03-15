---
description: Testing Agent output format and test structure
alwaysApply: true
---

# Output Format

## Test file placement

- **Unit/integration:** Adjacent to source (`Component.test.tsx`) or in `__tests__/` directory
- **E2E:** In `e2e/` or `tests/e2e/` directory
- Follow project convention if one exists

## Test structure

- Use `describe` for grouping (feature, module, or component)
- Use `it` / `test` with descriptive names that explain the scenario
- Order: happy paths first, then edge cases, then error scenarios

## Mocking

- Mock external services: APIs, databases, file system, third-party SDKs
- Use dependency injection or module mocks (e.g. `vi.mock`, `jest.mock`)
- Ensure mocks are reset between tests to avoid leakage

## Example test file structure

```typescript
// __tests__/auth.service.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AuthService } from '../auth.service';

describe('AuthService', () => {
  let authService: AuthService;
  let mockDb: { findUser: ReturnType<typeof vi.fn>; createUser: ReturnType<typeof vi.fn> };
  let mockJwt: { sign: ReturnType<typeof vi.fn>; verify: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockDb = { findUser: vi.fn(), createUser: vi.fn() };
    mockJwt = { sign: vi.fn(), verify: vi.fn() };
    authService = new AuthService(mockDb, mockJwt);
  });

  describe('login', () => {
    it('returns token when credentials are valid', async () => {
      // Arrange
      mockDb.findUser.mockResolvedValue({ id: '1', passwordHash: '...' });
      mockJwt.sign.mockReturnValue('jwt-token');

      // Act
      const result = await authService.login('user@example.com', 'password');

      // Assert
      expect(result.token).toBe('jwt-token');
      expect(mockDb.findUser).toHaveBeenCalledWith('user@example.com');
    });

    it('throws when user not found', async () => {
      mockDb.findUser.mockResolvedValue(null);

      await expect(authService.login('unknown@example.com', 'pass'))
        .rejects.toThrow('Invalid credentials');
    });
  });
});
```
