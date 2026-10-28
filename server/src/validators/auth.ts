import { z } from 'zod';

// Emails are normalized (trimmed + lowercased) before validation so that
// "Foo@Example.com" and "foo@example.com" are treated as the same address
// for both the uniqueness check on signup and lookup on login. Capped at
// 254 (RFC 5321's own limit on a full address), the same discipline every
// other string field in this codebase follows — unlike those, an
// unbounded email had nothing stopping a signup from storing one long
// enough to make the uniqueness lookup and every later login do more work
// than any real address ever needs.
const normalizedEmail = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim().toLowerCase() : value),
  z.string().email().max(254),
);

export const signupSchema = z.object({
  organizationName: z.string().trim().min(2).max(100),
  email: normalizedEmail,
  password: z.string().min(8).max(72),
  name: z.string().trim().min(1).max(100).optional(),
});
export type SignupInput = z.infer<typeof signupSchema>;

export const loginSchema = z.object({
  email: normalizedEmail,
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const updateProfileSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    currentPassword: z.string().min(1).optional(),
    newPassword: z.string().min(8).max(72).optional(),
  })
  .refine((data) => !data.newPassword || !!data.currentPassword, {
    message: 'currentPassword is required to set a newPassword',
    path: ['currentPassword'],
  });
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
