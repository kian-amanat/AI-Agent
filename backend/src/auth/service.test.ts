import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as authService from './service.js';
import * as dbClient from '../db/client.js';
import * as authUtils from './utils.js';
import { eq } from 'drizzle-orm';
import { users } from '../db/schema.js';

describe('auth/service', () => {
  const mockUser = {
    id: 1,
    email: 'test@example.com',
    passwordHash: 'hashedpassword',
    createdAt: new Date(),
    name: 'Test User'
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('register', () => {
    it('should hash password and insert user', async () => {
      const hashSpy = vi.spyOn(authUtils, 'hashPassword').mockResolvedValue('hashedpassword');
      const insertSpy = vi.spyOn(dbClient.db, 'insert').mockReturnValue({
        values: [mockUser],
        run: vi.fn(),
      } as any);

      const result = await authService.register({ email: 'test@example.com', password: 'plainpassword', name: 'Test User' });
      expect(hashSpy).toHaveBeenCalledWith('plainpassword');
      expect(insertSpy).toHaveBeenCalled();
      expect(result.user.email).toBe('test@example.com');
      expect(result.user.passwordHash).toBe('hashedpassword');
    });

    it('should throw if user already exists', async () => {
      vi.spyOn(dbClient.db, 'select').mockReturnValue({
        from: () => ({
          where: () => ({
            get: () => mockUser,
          }),
        }),
      } as any);

      await expect(authService.register({ email: 'test@example.com', password: 'plainpassword', name: 'Test User' })).rejects.toThrow();
    });
  });

  describe('login', () => {
    it('should return user if password matches', async () => {
      vi.spyOn(dbClient.db, 'select').mockReturnValue({
        from: () => ({
          where: () => ({
            get: () => mockUser,
          }),
        }),
      } as any);
      vi.spyOn(authUtils, 'comparePassword').mockResolvedValue(true);

      const result = await authService.login({ email: 'test@example.com', password: 'plainpassword' });
      expect(result.user.email).toBe('test@example.com');
    });

    it('should throw if user not found', async () => {
      vi.spyOn(dbClient.db, 'select').mockReturnValue({
        from: () => ({
          where: () => ({
            get: () => undefined,
          }),
        }),
      } as any);

      await expect(authService.login({ email: 'notfound@example.com', password: 'plainpassword' })).rejects.toThrow();
    });

    it('should throw if password does not match', async () => {
      vi.spyOn(dbClient.db, 'select').mockReturnValue({
        from: () => ({
          where: () => ({
            get: () => mockUser,
          }),
        }),
      } as any);
      vi.spyOn(authUtils, 'comparePassword').mockResolvedValue(false);

      await expect(authService.login({ email: 'test@example.com', password: 'wrongpassword' })).rejects.toThrow();
    });
  });

  describe('findUserByEmail', () => {
    it('should return user if found', async () => {
      vi.spyOn(dbClient.db, 'select').mockReturnValue({
        from: () => ({
          where: () => ({
            get: () => mockUser,
          }),
        }),
      } as any);

      const result = await authService.findUserByEmail('test@example.com');
      expect(result).toEqual(mockUser);
    });

    it('should return undefined if not found', async () => {
      vi.spyOn(dbClient.db, 'select').mockReturnValue({
        from: () => ({
          where: () => ({
            get: () => undefined,
          }),
        }),
      } as any);

      const result = await authService.findUserByEmail('notfound@example.com');
      expect(result).toBeUndefined();
    });
  });
});
