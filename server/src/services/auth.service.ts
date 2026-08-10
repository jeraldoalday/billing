import { ApiError } from '../middleware/errorHandler';
import { hashPassword, verifyPassword } from '../lib/password';
import { signAccessToken } from '../lib/jwt';
import { prisma } from '../lib/prisma';
import { slugify, withUniqueSuffix } from '../utils/slug';
import type { LoginInput, SignupInput } from '../validators/auth';

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

export async function login(input: LoginInput): Promise<AuthResult> {
  const user = await prisma.user.findUnique({
    where: { email: input.email },
    include: { organization: true },
  });

  if (!user || !(await verifyPassword(input.password, user.passwordHash))) {
    throw ApiError.unauthorized('Invalid email or password');
  }

  const token = signAccessToken({ sub: user.id, orgId: user.organizationId, email: user.email });

  return {
    token,
    user: { id: user.id, email: user.email, name: user.name },
    organization: {
      id: user.organization.id,
      name: user.organization.name,
      slug: user.organization.slug,
    },
  };
}
