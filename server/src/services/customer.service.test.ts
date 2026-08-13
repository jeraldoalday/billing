import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../lib/prisma';
import { createCustomer, deleteCustomer, getCustomer, listCustomers, updateCustomer } from './customer.service';

async function resetDb() {
  await prisma.subscriptionEvent.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.organization.deleteMany();
}

async function makeOrg(name: string) {
  return prisma.organization.create({ data: { name, slug: name.toLowerCase().replace(/\s+/g, '-') } });
}

beforeEach(resetDb);
afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

describe('createCustomer', () => {
  it('creates a customer', async () => {
    const org = await makeOrg('Acme');

    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });

    expect(customer.name).toBe('Jane Doe');
    expect(customer.email).toBe('jane@example.com');
    expect(customer.active).toBe(true);
  });

  it('throws a 409 when the email is already used within the organization', async () => {
    const org = await makeOrg('Acme');
    await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });

    await expect(createCustomer(org.id, { name: 'Jane Impostor', email: 'jane@example.com' })).rejects.toMatchObject(
      { status: 409 },
    );
  });

  it('allows the same email across different organizations', async () => {
    const orgA = await makeOrg('Org A');
    const orgB = await makeOrg('Org B');
    await createCustomer(orgA.id, { name: 'Jane Doe', email: 'jane@example.com' });

    await expect(createCustomer(orgB.id, { name: 'Jane Doe', email: 'jane@example.com' })).resolves.toMatchObject({
      email: 'jane@example.com',
    });
  });
});

describe('listCustomers', () => {
  it('only returns customers for the given organization', async () => {
    const orgA = await makeOrg('Org A');
    const orgB = await makeOrg('Org B');
    await createCustomer(orgA.id, { name: 'A Customer', email: 'a@example.com' });
    await createCustomer(orgB.id, { name: 'B Customer', email: 'b@example.com' });

    const customers = await listCustomers(orgA.id, {});

    expect(customers).toHaveLength(1);
    expect(customers[0]?.name).toBe('A Customer');
  });

  it('filters by email', async () => {
    const org = await makeOrg('Acme');
    await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });
    await createCustomer(org.id, { name: 'John Doe', email: 'john@example.com' });

    const customers = await listCustomers(org.id, { email: 'jane@example.com' });

    expect(customers.map((c) => c.name)).toEqual(['Jane Doe']);
  });
});

describe('getCustomer', () => {
  it('throws a 404 for a customer belonging to another organization', async () => {
    const orgA = await makeOrg('Org A');
    const orgB = await makeOrg('Org B');
    const customer = await createCustomer(orgB.id, { name: 'B Customer', email: 'b@example.com' });

    await expect(getCustomer(orgA.id, customer.id)).rejects.toMatchObject({ status: 404 });
  });
});

describe('updateCustomer', () => {
  it('updates fields', async () => {
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });

    const updated = await updateCustomer(org.id, customer.id, { name: 'Jane Smith', active: false });

    expect(updated.name).toBe('Jane Smith');
    expect(updated.active).toBe(false);
  });

  it('throws a 409 when updating to an email already used by another customer', async () => {
    const org = await makeOrg('Acme');
    await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });
    const john = await createCustomer(org.id, { name: 'John Doe', email: 'john@example.com' });

    await expect(updateCustomer(org.id, john.id, { email: 'jane@example.com' })).rejects.toMatchObject({
      status: 409,
    });
  });

  it('allows updating a customer to keep their own email', async () => {
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });

    await expect(
      updateCustomer(org.id, customer.id, { email: 'jane@example.com', name: 'Jane D.' }),
    ).resolves.toMatchObject({ name: 'Jane D.' });
  });

  it('refuses to update a customer belonging to another organization', async () => {
    const orgA = await makeOrg('Org A');
    const orgB = await makeOrg('Org B');
    const customer = await createCustomer(orgB.id, { name: 'B Customer', email: 'b@example.com' });

    await expect(updateCustomer(orgA.id, customer.id, { name: 'Hijacked' })).rejects.toMatchObject({ status: 404 });
  });
});

describe('deleteCustomer', () => {
  it('deletes a customer with no subscriptions', async () => {
    const org = await makeOrg('Acme');
    const customer = await createCustomer(org.id, { name: 'Jane Doe', email: 'jane@example.com' });

    await deleteCustomer(org.id, customer.id);

    await expect(getCustomer(org.id, customer.id)).rejects.toMatchObject({ status: 404 });
  });

  it('refuses to delete a customer belonging to another organization', async () => {
    const orgA = await makeOrg('Org A');
    const orgB = await makeOrg('Org B');
    const customer = await createCustomer(orgB.id, { name: 'B Customer', email: 'b@example.com' });

    await expect(deleteCustomer(orgA.id, customer.id)).rejects.toMatchObject({ status: 404 });
  });
});
