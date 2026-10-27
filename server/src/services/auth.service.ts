import { Prisma } from '@prisma/client';
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

// Up to 5 attempts in the (rare) case a slug keeps colliding; each retry
// uses a freshly random suffix, so a run of actual collisions this long is
// astronomically unlikely and not worth a backoff delay.
const MAX_SLUG_ATTEMPTS = 5;

async function generateUniqueSlug(organizationName: string): Promise<string> {
  const base = slugify(organizationName) || 'org';
  const existing = await prisma.organization.findUnique({ where: { slug: base } });
  return existing ? withUniqueSuffix(base) : base;
}

async function createOrganization(input: SignupInput, passwordHash: string, slug: string) {
  return prisma.organization.create({
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
}

// True when a write failed on organization.slug's unique constraint
// specifically, as opposed to some other P2002 (which should still
// surface as-is rather than be retried as if it were this one).
function isSlugConflict(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === 'P2002' &&
    (err.meta?.target as string[] | undefined)?.includes('slug') === true
  );
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

  // generateUniqueSlug's read above and the create below race the same way
  // other uniqueness checks in this codebase do (see e.g. the partial index
  // in invoice.service.ts): two signups for the same organization name
  // arriving at the same instant can both see their slug free and then
  // collide on the write. The loser retries with a fresh suffix instead of
  // surfacing a raw 500 for what is, from the caller's side, a perfectly
  // ordinary signup.
  let organization: Awaited<ReturnType<typeof createOrganization>> | undefined;
  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
    const candidateSlug = attempt === 0 ? slug : withUniqueSuffix(slugify(input.organizationName) || 'org');
    try {
      // eslint-disable-next-line no-await-in-loop -- each attempt depends on whether the previous one lost the race
      organization = await createOrganization(input, passwordHash, candidateSlug);
      break;
    } catch (err) {
      if (!isSlugConflict(err) || attempt === MAX_SLUG_ATTEMPTS - 1) {
        throw err;
      }
    }
  }
  if (!organization) {
    throw new Error('Failed to create organization during signup');
  }

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
