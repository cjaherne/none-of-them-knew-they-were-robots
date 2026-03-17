---
description: Testing Agent few-shot test examples
alwaysApply: true
---

# Examples

## Example 1: User authentication service — unit tests

**Context:** AuthService with login, register, and token validation. Uses database for users and JWT for tokens.

**Implementation:**

```typescript
// __tests__/auth.service.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AuthService } from '../services/auth.service';

// Mock bcrypt for password hashing
vi.mock('bcrypt', () => ({
  hash: vi.fn((password: string) => Promise.resolve(`hashed_${password}`)),
  compare: vi.fn((plain: string, hashed: string) =>
    Promise.resolve(hashed === `hashed_${plain}`)
  ),
}));

describe('AuthService', () => {
  let authService: AuthService;
  let mockUserRepo: {
    findByEmail: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
  };
  let mockJwtService: {
    sign: ReturnType<typeof vi.fn>;
    verify: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockUserRepo = {
      findByEmail: vi.fn(),
      create: vi.fn(),
      findById: vi.fn(),
    };
    mockJwtService = {
      sign: vi.fn().mockReturnValue('mock-jwt-token'),
      verify: vi.fn().mockReturnValue({ userId: 'user-123', email: 'test@example.com' }),
    };
    authService = new AuthService(mockUserRepo, mockJwtService);
  });

  describe('login', () => {
    it('returns token and user when credentials are valid', async () => {
      const user = {
        id: 'user-123',
        email: 'test@example.com',
        passwordHash: 'hashed_password123',
      };
      mockUserRepo.findByEmail.mockResolvedValue(user);

      const result = await authService.login('test@example.com', 'password123');

      expect(result).toEqual({
        token: 'mock-jwt-token',
        user: { id: user.id, email: user.email },
      });
      expect(mockUserRepo.findByEmail).toHaveBeenCalledWith('test@example.com');
      expect(mockJwtService.sign).toHaveBeenCalledWith(
        { userId: user.id, email: user.email },
        expect.any(Object)
      );
    });

    it('throws InvalidCredentialsError when user not found', async () => {
      mockUserRepo.findByEmail.mockResolvedValue(null);

      await expect(authService.login('unknown@example.com', 'password'))
        .rejects.toThrow('Invalid credentials');
      expect(mockJwtService.sign).not.toHaveBeenCalled();
    });

    it('throws InvalidCredentialsError when password is wrong', async () => {
      mockUserRepo.findByEmail.mockResolvedValue({
        id: 'user-123',
        email: 'test@example.com',
        passwordHash: 'hashed_wrongpassword',
      });

      await expect(authService.login('test@example.com', 'password123'))
        .rejects.toThrow('Invalid credentials');
    });

    it('throws when email is empty', async () => {
      await expect(authService.login('', 'password'))
        .rejects.toThrow('Email is required');
    });

    it('throws when password is empty', async () => {
      await expect(authService.login('test@example.com', ''))
        .rejects.toThrow('Password is required');
    });
  });

  describe('register', () => {
    it('creates user and returns token when email is unique', async () => {
      mockUserRepo.findByEmail.mockResolvedValue(null);
      mockUserRepo.create.mockResolvedValue({
        id: 'new-user-456',
        email: 'new@example.com',
        passwordHash: 'hashed_securepass',
      });

      const result = await authService.register('new@example.com', 'securepass');

      expect(result.token).toBe('mock-jwt-token');
      expect(mockUserRepo.create).toHaveBeenCalledWith(
        'new@example.com',
        expect.stringContaining('hashed_')
      );
    });

    it('throws when email already exists', async () => {
      mockUserRepo.findByEmail.mockResolvedValue({ id: 'existing', email: 'taken@example.com' });

      await expect(authService.register('taken@example.com', 'password'))
        .rejects.toThrow('Email already registered');
      expect(mockUserRepo.create).not.toHaveBeenCalled();
    });

    it('throws when password is too short', async () => {
      await expect(authService.register('valid@example.com', '123'))
        .rejects.toThrow('Password must be at least 8 characters');
    });
  });

  describe('validateToken', () => {
    it('returns user when token is valid', async () => {
      mockUserRepo.findById.mockResolvedValue({
        id: 'user-123',
        email: 'test@example.com',
      });

      const result = await authService.validateToken('valid-jwt-token');

      expect(result).toEqual({ id: 'user-123', email: 'test@example.com' });
      expect(mockJwtService.verify).toHaveBeenCalledWith('valid-jwt-token');
      expect(mockUserRepo.findById).toHaveBeenCalledWith('user-123');
    });

    it('throws when token is invalid', async () => {
      mockJwtService.verify.mockImplementation(() => {
        throw new Error('Invalid token');
      });

      await expect(authService.validateToken('bad-token'))
        .rejects.toThrow('Invalid token');
      expect(mockUserRepo.findById).not.toHaveBeenCalled();
    });

    it('throws when user no longer exists', async () => {
      mockUserRepo.findById.mockResolvedValue(null);

      await expect(authService.validateToken('valid-jwt-token'))
        .rejects.toThrow('User not found');
    });

    it('throws when token is null or undefined', async () => {
      await expect(authService.validateToken(null as unknown as string))
        .rejects.toThrow('Token required');
    });
  });
});
```

---

## Example 2: Checkout flow — E2E with Playwright

**Context:** E-commerce checkout — add to cart, fill shipping/billing, submit, verify success and error states.

**Implementation:**

```typescript
// e2e/checkout.spec.ts
import { test, expect } from '@playwright/test';

test.describe('Checkout flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Add a product to cart
    await page.getByRole('link', { name: 'Products' }).click();
    await page.getByRole('button', { name: 'Add to cart' }).first().click();
    await page.getByRole('link', { name: 'Cart (1)' }).click();
    await page.getByRole('button', { name: 'Proceed to checkout' }).click();
  });

  test('completes checkout successfully with valid data', async ({ page }) => {
    // Fill shipping form
    await page.getByLabel('Full name').fill('Jane Doe');
    await page.getByLabel('Email').fill('jane@example.com');
    await page.getByLabel('Address').fill('123 Main St');
    await page.getByLabel('City').fill('New York');
    await page.getByLabel('ZIP code').fill('10001');
    await page.getByLabel('Country').selectOption('US');

    // Fill payment (mock in test env)
    await page.getByLabel('Card number').fill('4242424242424242');
    await page.getByLabel('Expiry').fill('12/28');
    await page.getByLabel('CVC').fill('123');

    // Submit
    await page.getByRole('button', { name: 'Place order' }).click();

    // Verify success
    await expect(page.getByRole('heading', { name: 'Order confirmed' })).toBeVisible();
    await expect(page.getByText('Thank you for your order')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Continue shopping' })).toBeVisible();
  });

  test('shows validation errors for empty required fields', async ({ page }) => {
    // Submit without filling
    await page.getByRole('button', { name: 'Place order' }).click();

    await expect(page.getByText('Full name is required')).toBeVisible();
    await expect(page.getByText('Email is required')).toBeVisible();
    await expect(page.getByText('Address is required')).toBeVisible();
  });

  test('shows error for invalid email', async ({ page }) => {
    await page.getByLabel('Full name').fill('Jane Doe');
    await page.getByLabel('Email').fill('invalid-email');
    await page.getByLabel('Address').fill('123 Main St');
    await page.getByLabel('City').fill('New York');
    await page.getByLabel('ZIP code').fill('10001');
    await page.getByLabel('Country').selectOption('US');

    await page.getByRole('button', { name: 'Place order' }).click();

    await expect(page.getByText('Please enter a valid email')).toBeVisible();
  });

  test('shows error when payment fails', async ({ page }) => {
    // Use test card that triggers decline
    await page.getByLabel('Full name').fill('Jane Doe');
    await page.getByLabel('Email').fill('jane@example.com');
    await page.getByLabel('Address').fill('123 Main St');
    await page.getByLabel('City').fill('New York');
    await page.getByLabel('ZIP code').fill('10001');
    await page.getByLabel('Country').selectOption('US');
    await page.getByLabel('Card number').fill('4000000000000002'); // Decline card
    await page.getByLabel('Expiry').fill('12/28');
    await page.getByLabel('CVC').fill('123');

    await page.getByRole('button', { name: 'Place order' }).click();

    await expect(page.getByText('Your card was declined')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Place order' })).toBeEnabled();
  });

  test('persists cart when navigating back from checkout', async ({ page }) => {
    await page.getByRole('link', { name: 'Back to cart' }).click();

    await expect(page.getByText('1 item in cart')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Proceed to checkout' })).toBeVisible();
  });
});
```

---

## Example 3: Lua game logic — unit tests with busted

**Context:** LÖVE game with a pure Lua utility module for score and level progression. No LÖVE runtime in tests.

**Implementation:**

```lua
-- spec/score_utils_spec.lua
local busted = require("busted")
local describe, it, assert = busted.describe, busted.it, busted.assert
local score_utils = require("src.data.score_utils")

describe("score_utils", function()
  describe("levelForScore", function()
    it("returns 1 for score 0", function()
      assert.are.equal(1, score_utils.levelForScore(0))
    end)

    it("returns 2 when score reaches first threshold", function()
      assert.are.equal(2, score_utils.levelForScore(1000))
    end)

    it("returns same level for score just below threshold", function()
      assert.are.equal(1, score_utils.levelForScore(999))
    end)

    it("throws for negative score", function()
      assert.has_error(function()
        score_utils.levelForScore(-1)
      end, "score must be non-negative")
    end)
  end)

  describe("livesRemaining", function()
    it("returns 3 when no deaths", function()
      assert.are.equal(3, score_utils.livesRemaining(3, 0))
    end)

    it("returns 0 when deaths >= initial", function()
      assert.are.equal(0, score_utils.livesRemaining(3, 3))
    end)
  end)
end)
```

Run with: `busted` (or `luarocks test` if configured). Document in README: "Run tests: `busted`"
