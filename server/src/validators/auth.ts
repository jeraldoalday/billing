import { z } from 'zod';

export const signupSchema = z.object({
  organizationName: z.string().min(2).max(100),
  email: z.string().email(),
  password: z.string().min(8).max(72),
  name: z.string().min(1).max(100).optional(),
});
export type SignupInput = z.infer<typeof signupSchema>;

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const updateProfileSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    currentPassword: z.string().min(1).optional(),
    newPassword: z.string().min(8).max(72).optional(),
  })
  .refine((data) => !data.newPassword || !!data.currentPassword, {
    message: 'currentPassword is required to set a newPassword',
    path: ['currentPassword'],
  });
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
