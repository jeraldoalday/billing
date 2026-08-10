import { z } from 'zod';

// Emails are normalized (trimmed + lowercased) before validation so that
// "Foo@Example.com" and "foo@example.com" are treated as the same address
// for both the uniqueness check on signup and lookup on login.
const normalizedEmail = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim().toLowerCase() : value),
  z.string().email(),
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
