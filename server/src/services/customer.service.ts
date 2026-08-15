import { ApiError } from '../middleware/errorHandler';
import { prisma } from '../lib/prisma';
import type { CreateCustomerInput, ListCustomersQuery, UpdateCustomerInput } from '../validators/customer';

async function assertEmailAvailable(organizationId: string, email: string, excludeCustomerId?: string) {
  const existing = await prisma.customer.findUnique({
    where: { organizationId_email: { organizationId, email } },
  });
  if (existing && existing.id !== excludeCustomerId) {
    throw ApiError.conflict('A customer with this email already exists');
  }
}

export async function createCustomer(organizationId: string, input: CreateCustomerInput) {
  await assertEmailAvailable(organizationId, input.email);

  return prisma.customer.create({
    data: {
      organizationId,
      name: input.name,
      email: input.email,
      active: input.active ?? true,
      country: input.country,
    },
  });
}

export async function listCustomers(organizationId: string, query: ListCustomersQuery) {
  return prisma.customer.findMany({
    where: {
      organizationId,
      active: query.active,
      email: query.email,
    },
    orderBy: { createdAt: 'desc' },
  });
}

// Scoping the lookup to organizationId means a customer belonging to another
// org 404s exactly like one that doesn't exist, rather than leaking a 403
// that would confirm the id is real.
export async function getCustomer(organizationId: string, customerId: string) {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, organizationId },
  });

  if (!customer) {
    throw ApiError.notFound('Customer not found');
  }

  return customer;
}

export async function updateCustomer(organizationId: string, customerId: string, input: UpdateCustomerInput) {
  await getCustomer(organizationId, customerId);

  if (input.email) {
    await assertEmailAvailable(organizationId, input.email, customerId);
  }

  return prisma.customer.update({
    where: { id: customerId },
    data: {
      name: input.name,
      email: input.email,
      active: input.active,
      country: input.country,
    },
  });
}

// Refuses to delete a customer with a subscription that isn't CANCELED yet,
// mirroring how real billing systems require ending active billing
// relationships before removing the party they bill — deleting out from
// under a live subscription would silently orphan it.
export async function deleteCustomer(organizationId: string, customerId: string): Promise<void> {
  await getCustomer(organizationId, customerId);

  const activeSubscriptionCount = await prisma.subscription.count({
    where: { customerId, status: { not: 'CANCELED' } },
  });
  if (activeSubscriptionCount > 0) {
    throw ApiError.conflict('Cannot delete a customer with a non-canceled subscription');
  }

  await prisma.customer.delete({ where: { id: customerId } });
}
