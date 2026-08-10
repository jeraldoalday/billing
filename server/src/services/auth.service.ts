import { ApiError } from '../middleware/errorHandler';
import { hashPassword, verifyPassword } from '../lib/password';
import { signAccessToken } from '../lib/jwt';
import { prisma } from '../lib/prisma';
import { slugify, withUniqueSuffix } from '../utils/slug';
import type { LoginInput, SignupInput, UpdateProfileInput } from '../validators/auth';

export interface AuthResult {
  token: string;
  user: { id: string; email: string; name: string | null };
  organization: { id: string; name: string; slug: string };
}

async function generateUniqueSlug(organizationName: string): Promise<string> {
  const base = slugify(organizationName) || 'org';
  const existing = await prisma.organization.findUnique({ where: { slug: base } });
  return existing ? withUniqueSuffix(base) : base;
}

export async function signup(input: SignupInput): Promise<AuthResult> {
  const existingUser = await prisma.user.findUnique({ where: { email: input.email } });
  if (existingUser) {
    throw ApiError.conflict('An account with this email already exists');
  }

  const [slug, passwordHash] = await Promise.all([
    generateUniqueSlug(input.organizationName),
    hashPassword(input.password),
  ]);

  const organization = await prisma.organization.create({
    data: {
      name: input.organizationName,
      slug,
      users: {
        create: {
          email: input.email,
          passwordHash,
          name: input.name,
        },
      },
    },
    include: { users: true },
  });

  const user = organization.users[0];
  if (!user) {
    throw new Error('Failed to create user during signup');
  }

  const token = signAccessToken({ sub: user.id, orgId: organization.id, email: user.email });

  return {
    token,
    user: { id: user.id, email: user.email, name: user.name },
    organization: { id: organization.id, name: organization.name, slug: organization.slug },
  };
}

// A precomputed bcrypt hash of a value nobody will ever type as a real
// password. When the email isn't registered, we still run a full bcrypt
// compare against this instead of short-circuiting, so response time for
// "unknown email" and "known email, wrong password" is the same and an
// attacker can't use login timing to enumerate registered emails.
const UNKNOWN_USER_PASSWORD_HASH = '$2a$10$E1/zrzgMWPwVs4vtXO4AU.6ccu.3juC5mu3FNfmWycgNFwY0Uw.E2';

export async function login(input: LoginInput): Promise<AuthResult> {
  const user = await prisma.user.findUnique({
    where: { email: input.email },
    select: {
      id: true,
      email: true,
      name: true,
      passwordHash: true,
      organization: { select: { id: true, name: true, slug: true } },
    },
  });

  const passwordIsValid = await verifyPassword(input.password, user?.passwordHash ?? UNKNOWN_USER_PASSWORD_HASH);
  if (!user || !passwordIsValid) {
    throw ApiError.unauthorized('Invalid email or password');
  }

  const token = signAccessToken({ sub: user.id, orgId: user.organization.id, email: user.email });

  return {
    token,
    user: { id: user.id, email: user.email, name: user.name },
    organization: user.organization,
  };
}

export interface ProfileResult {
  id: string;
  email: string;
  name: string | null;
}

export async function updateProfile(
  userId: string,
  input: UpdateProfileInput,
): Promise<ProfileResult> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, passwordHash: true } });
  if (!user) {
    throw ApiError.unauthorized('Account no longer exists');
  }

  let passwordHash: string | undefined;
  if (input.newPassword) {
    const currentPasswordValid = await verifyPassword(input.currentPassword ?? '', user.passwordHash);
    if (!currentPasswordValid) {
      throw ApiError.unauthorized('Current password is incorrect');
    }
    passwordHash = await hashPassword(input.newPassword);
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data: {
      name: input.name ?? undefined,
      passwordHash,
    },
    select: { id: true, email: true, name: true },
  });

  return updated;
}
