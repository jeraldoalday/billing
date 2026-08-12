import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../lib/prisma';
import {
  createProduct,
  deleteProduct,
  getProduct,
  listProducts,
  updateProduct,
} from './product.service';

async function resetDb() {
  await prisma.product.deleteMany();
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

describe('createProduct', () => {
  it('creates a product scoped to the organization, defaulting active to true', async () => {
    const org = await makeOrg('Acme');

    const product = await createProduct(org.id, { name: 'API Access' });

    expect(product.organizationId).toBe(org.id);
    expect(product.name).toBe('API Access');
    expect(product.active).toBe(true);
  });

  it('respects an explicit active: false', async () => {
    const org = await makeOrg('Acme');

    const product = await createProduct(org.id, { name: 'Legacy Plan', active: false });

    expect(product.active).toBe(false);
  });
});

describe('listProducts', () => {
  it('only returns products for the given organization', async () => {
    const orgA = await makeOrg('Org A');
    const orgB = await makeOrg('Org B');
    await createProduct(orgA.id, { name: 'A Product' });
    await createProduct(orgB.id, { name: 'B Product' });

    const products = await listProducts(orgA.id, {});

    expect(products).toHaveLength(1);
    expect(products[0]?.name).toBe('A Product');
  });

  it('filters by active status when requested', async () => {
    const org = await makeOrg('Acme');
    await createProduct(org.id, { name: 'Active', active: true });
    await createProduct(org.id, { name: 'Archived', active: false });

    const active = await listProducts(org.id, { active: true });
    const inactive = await listProducts(org.id, { active: false });

    expect(active.map((p) => p.name)).toEqual(['Active']);
    expect(inactive.map((p) => p.name)).toEqual(['Archived']);
  });
});

describe('getProduct', () => {
  it('returns the product when it belongs to the organization', async () => {
    const org = await makeOrg('Acme');
    const created = await createProduct(org.id, { name: 'API Access' });

    const found = await getProduct(org.id, created.id);

    expect(found.id).toBe(created.id);
  });

  it('throws a 404 for a product belonging to another organization', async () => {
    const orgA = await makeOrg('Org A');
    const orgB = await makeOrg('Org B');
    const product = await createProduct(orgB.id, { name: 'B Product' });

    await expect(getProduct(orgA.id, product.id)).rejects.toMatchObject({ status: 404 });
  });

  it('throws a 404 for a nonexistent product', async () => {
    const org = await makeOrg('Acme');

    await expect(getProduct(org.id, 'does-not-exist')).rejects.toMatchObject({ status: 404 });
  });
});

describe('updateProduct', () => {
  it('updates fields for a product in the organization', async () => {
    const org = await makeOrg('Acme');
    const created = await createProduct(org.id, { name: 'API Access' });

    const updated = await updateProduct(org.id, created.id, { name: 'API Access Pro', active: false });

    expect(updated.name).toBe('API Access Pro');
    expect(updated.active).toBe(false);
  });

  it('refuses to update a product belonging to another organization', async () => {
    const orgA = await makeOrg('Org A');
    const orgB = await makeOrg('Org B');
    const product = await createProduct(orgB.id, { name: 'B Product' });

    await expect(updateProduct(orgA.id, product.id, { name: 'Hijacked' })).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('deleteProduct', () => {
  it('deletes a product in the organization', async () => {
    const org = await makeOrg('Acme');
    const created = await createProduct(org.id, { name: 'API Access' });

    await deleteProduct(org.id, created.id);

    await expect(getProduct(org.id, created.id)).rejects.toMatchObject({ status: 404 });
  });

  it('refuses to delete a product belonging to another organization', async () => {
    const orgA = await makeOrg('Org A');
    const orgB = await makeOrg('Org B');
    const product = await createProduct(orgB.id, { name: 'B Product' });

    await expect(deleteProduct(orgA.id, product.id)).rejects.toMatchObject({ status: 404 });
    await expect(getProduct(orgB.id, product.id)).resolves.toMatchObject({ id: product.id });
  });
});
