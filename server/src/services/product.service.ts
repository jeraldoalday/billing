import { ApiError } from '../middleware/errorHandler';
import { prisma } from '../lib/prisma';
import type { CreateProductInput, ListProductsQuery, UpdateProductInput } from '../validators/product';

export async function createProduct(organizationId: string, input: CreateProductInput) {
  return prisma.product.create({
    data: {
      organizationId,
      name: input.name,
      description: input.description,
      active: input.active ?? true,
    },
  });
}

export async function listProducts(organizationId: string, query: ListProductsQuery) {
  return prisma.product.findMany({
    where: {
      organizationId,
      active: query.active,
    },
    orderBy: { createdAt: 'desc' },
  });
}

// Scoping every lookup to organizationId (rather than fetching by id and
// checking the org after) means a product belonging to another org 404s
// exactly like one that doesn't exist, instead of leaking a 403 that would
// confirm the id is real.
export async function getProduct(organizationId: string, productId: string) {
  const product = await prisma.product.findFirst({
    where: { id: productId, organizationId },
  });

  if (!product) {
    throw ApiError.notFound('Product not found');
  }

  return product;
}

export async function updateProduct(organizationId: string, productId: string, input: UpdateProductInput) {
  await getProduct(organizationId, productId);

  return prisma.product.update({
    where: { id: productId },
    data: {
      name: input.name,
      description: input.description,
      active: input.active,
    },
  });
}

export async function deleteProduct(organizationId: string, productId: string): Promise<void> {
  await getProduct(organizationId, productId);

  await prisma.product.delete({ where: { id: productId } });
}
